import './styles.css';
import firDeck from './fir-deck.json';
import { escapeHtml, expandDeck, plainText, renderText, type Card, type Deck } from './cards';
import { schedule, waitLabel, type CardState, type Grade } from './srs';
import { buildQueue } from './queue';
import { check } from './match';
import { pickOptions, type Options } from './choice';
import { importFile } from './importers';
import { load, parseData, save, type Data, type SprintMode } from './store';

const BUILTIN = firDeck as Deck;
let data: Data = load();
let cards: Card[] = [];
let cardById = new Map<string, Card>();

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const allDecks = (): Deck[] => [BUILTIN, ...data.decks];
const activeCards = () => cards.filter((c) => !data.settings.off.includes(c.deckId));
const deckName = (id: string) => allDecks().find((d) => d.id === id)?.name ?? '';

function rebuild() {
  cards = allDecks().flatMap(expandDeck);
  cardById = new Map(cards.map((c) => [c.id, c]));
}

let toastTimer = 0;
function toast(msg: string) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), 2600);
}

function persist() {
  if (!save(data)) toast('Could not save: browser storage is full or blocked. Back up from Decks.');
}

/* ---------- tabs and theme ---------- */

type Tab = 'study' | 'sprint' | 'decks';
let tab: Tab = 'study';

function showTab(next: Tab) {
  if (tab === 'sprint' && next !== 'sprint' && sprint.phase === 'play') endSprint();
  tab = next;
  for (const t of ['study', 'sprint', 'decks'] as const) {
    $(t).hidden = t !== next;
    $(`tab-${t}`).toggleAttribute('aria-current', t === next);
    if (t === next) $(`tab-${t}`).setAttribute('aria-current', 'page');
  }
  ({ study: renderStudy, sprint: renderSprintSetup, decks: renderDecks })[next]();
  // so Enter starts a sprint right after clicking the tab
  if (next === 'sprint' && sprint.phase === 'setup') $('sprintStart').focus();
}

function applyTheme() {
  const theme = data.settings.theme;
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  $('theme').textContent = theme ?? 'auto';
}

/* ---------- study ---------- */

let current: Card | undefined;
let revealed = false;
let wakeTimer = 0;

const timeOf = (t: number) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function renderStudy(pick?: Card) {
  const now = Date.now();
  const q = buildQueue(activeCards(), data.states, data.log, now, data.settings.newPerDay);
  const { new: n, learning: l, review: r } = q.counts;
  $('counts').innerHTML = `<span class="cn">${n}</span> · <span class="cl">${l}</span> · <span class="cr">${r}</span>`;
  current = pick ?? q.next;
  revealed = false;
  clearTimeout(wakeTimer);
  $('studyCard').hidden = !current;
  $('studyDone').hidden = !!current;
  if (!current) {
    const next = q.nextDue;
    $('studyDeck').textContent = '';
    $('studyDone').innerHTML = `<h2>Done for now.</h2><p class="hint">${
      next ? `Next card ${next - now < 86_400_000 ? `at ${timeOf(next)}` : `on ${new Date(next).toLocaleDateString()}`}.` : 'Nothing is scheduled.'
    } Try a <button class="link" data-goto="sprint" type="button">sprint</button> in the meantime.</p>`;
    // wake up when a learning card comes due later today
    if (next && next - now < 3_600_000) wakeTimer = window.setTimeout(() => tab === 'study' && renderStudy(), next - now + 500);
    return;
  }
  $('studyDeck').textContent = deckName(current.deckId);
  $('front').innerHTML = renderText(current.front);
  $('back').hidden = true;
  $('show').hidden = false;
  $('grades').hidden = true;
}

function reveal() {
  if (!current || revealed) return;
  revealed = true;
  const now = Date.now();
  $('back').innerHTML = renderText(current.back);
  $('back').hidden = false;
  $('show').hidden = true;
  $('grades').hidden = false;
  const prev = data.states[current.id];
  $('grades').querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
    b.querySelector('span')!.textContent = waitLabel(prev, Number(b.dataset.grade) as Grade, now, data.settings);
  });
}

function grade(g: Grade) {
  if (!current || !revealed) return;
  const now = Date.now();
  const prev = data.states[current.id];
  data.states[current.id] = schedule(prev, g, now, data.settings);
  data.log.push({ card: current.id, t: now, grade: g, prev });
  persist();
  renderStudy();
}

function undo() {
  const last = data.log.pop();
  if (!last) return toast('Nothing to undo.');
  if (last.prev) data.states[last.card] = last.prev;
  else delete data.states[last.card];
  persist();
  renderStudy(cardById.get(last.card));
}

/* ---------- sprint ---------- */

interface Sprint {
  phase: 'setup' | 'play' | 'results';
  order: Card[];
  idx: number;
  score: number;
  misses: Map<string, Card>;
  endsAt: number;
  /** drills of past misses don't set best scores */
  drill: boolean;
  shown: boolean;
  /** multiple-choice options for the current card */
  choice?: Options;
  /** set while a wrong choice shows the right one, so extra key presses don't count */
  locked: boolean;
  timer: number;
}
const sprint: Sprint = { phase: 'setup', order: [], idx: 0, score: 0, misses: new Map(), endsAt: 0, drill: false, shown: false, locked: false, timer: 0 };

const sprintKey = () =>
  `${data.settings.sprintMode}|${data.settings.sprintSeconds}|${allDecks().filter((d) => !data.settings.off.includes(d.id)).map((d) => d.id).sort().join(',')}`;

function shuffle<T>(xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function chips<T extends string | number>(el: HTMLElement, name: string, opts: [T, string][], value: T, onPick: (v: T) => void) {
  el.innerHTML = opts.map(([v, label]) =>
    `<label class="chip"><input type="radio" name="${name}" value="${v}"${v === value ? ' checked' : ''}><span>${label}</span></label>`).join('');
  el.querySelectorAll('input').forEach((input, i) => input.addEventListener('change', () => onPick(opts[i][0])));
}

function renderSprintSetup() {
  if (sprint.phase !== 'setup') return;
  $('sprintSetup').hidden = false;
  $('sprintPlay').hidden = true;
  $('sprintResults').hidden = true;
  chips($('sprintMode'), 'mode', [['type', 'Typing'], ['choice', 'Multiple choice'], ['flip', 'Flip']] as [SprintMode, string][], data.settings.sprintMode, (v) => {
    data.settings.sprintMode = v; persist(); renderSprintSetup();
  });
  chips($('sprintSeconds'), 'secs', [[60, '1 min'], [120, '2 min'], [300, '5 min']], data.settings.sprintSeconds, (v) => {
    data.settings.sprintSeconds = v; persist(); renderSprintSetup();
  });
  const pool = activeCards().length;
  const best = data.best[sprintKey()];
  $('sprintInfo').textContent = pool
    ? `${pool} cards from your active decks.${best ? ` Best at this setting: ${best}.` : ''}`
    : 'No active decks. Switch one on under Decks.';
  $<HTMLButtonElement>('sprintStart').disabled = !pool;
}

function startSprint(pool: Card[], drill: boolean) {
  if (!pool.length) return;
  Object.assign(sprint, { phase: 'play', order: shuffle(pool), idx: 0, score: 0, misses: new Map(), drill, endsAt: Date.now() + data.settings.sprintSeconds * 1000 });
  const mode = data.settings.sprintMode;
  $('sprintSetup').hidden = true;
  $('sprintResults').hidden = true;
  $('sprintPlay').hidden = false;
  $('answer').hidden = mode !== 'type';
  $('choices').hidden = mode !== 'choice';
  $('flipKeys').hidden = mode !== 'flip';
  $('sprintLast').textContent = '';
  $('sprintKeys').innerHTML = {
    type: 'Exact answers count as you type · <kbd>Enter</kbd> check · <kbd>Tab</kbd> skip · <kbd>Esc</kbd> stop',
    choice: '<kbd>1</kbd>–<kbd>4</kbd> choose · <kbd>Esc</kbd> stop',
    flip: '<kbd>Space</kbd> show · <kbd>J</kbd> got it · <kbd>F</kbd> missed · <kbd>Esc</kbd> stop',
  }[mode];
  showSprintCard();
  tick();
  sprint.timer = window.setInterval(tick, 200);
}

function tick() {
  const left = Math.max(0, sprint.endsAt - Date.now());
  const total = data.settings.sprintSeconds * 1000;
  $('sprintTime').textContent = String(Math.ceil(left / 1000));
  $('sprintTime').parentElement!.classList.toggle('low', left < 10_000);
  $('sprintScore').textContent = String(sprint.score);
  $('sprintBar').style.transform = `scaleX(${left / total})`;
  if (!left) endSprint();
}

const sprintCard = () => sprint.order[sprint.idx % sprint.order.length];

function showSprintCard() {
  const c = sprintCard();
  sprint.shown = false;
  $('sprintFront').innerHTML = renderText(c.front);
  $('sprintBack').hidden = true;
  $('flipShow').hidden = false;
  $('flipGot').hidden = $('flipMiss').hidden = true;
  const input = $<HTMLInputElement>('answer');
  input.value = '';
  if (data.settings.sprintMode === 'type') input.focus();
  if (data.settings.sprintMode === 'choice') {
    // wrong options come from every active card, even in a drill of a few misses
    sprint.choice = pickOptions(c, activeCards());
    sprint.locked = false;
    $('choices').innerHTML = sprint.choice.options.map((o, i) =>
      `<button type="button" data-choice="${i}"><kbd>${i + 1}</kbd><span>${renderText(o)}</span></button>`).join('');
  }
}

function choose(i: number) {
  const opts = sprint.choice;
  if (!opts || sprint.locked || i >= opts.options.length) return;
  if (i === opts.right) return advance(true);
  // show the right answer for a moment, then move on
  sprint.locked = true;
  const buttons = $('choices').querySelectorAll('button');
  buttons[i].classList.add('wrong');
  buttons[opts.right].classList.add('right');
  flash('no');
  window.setTimeout(() => {
    if (sprint.phase === 'play') advance(false, `Answer: ${plainText(sprintCard().answer)}`);
  }, 900);
}

function flash(cls: 'ok' | 'no') {
  const f = $('sprintFront');
  f.classList.remove('ok', 'no');
  void f.offsetWidth; // restart the animation
  f.classList.add(cls);
}

function advance(correct: boolean, note = '') {
  const c = sprintCard();
  if (correct) sprint.score++;
  else sprint.misses.set(c.id, c);
  flash(correct ? 'ok' : 'no');
  $('sprintLast').textContent = note;
  sprint.idx++;
  if (sprint.idx % sprint.order.length === 0) sprint.order = shuffle(sprint.order);
  $('sprintScore').textContent = String(sprint.score);
  showSprintCard();
}

function onTyped() {
  const input = $<HTMLInputElement>('answer');
  if (check(input.value, plainText(sprintCard().answer)) === 'exact') advance(true);
}

function onEnter() {
  const input = $<HTMLInputElement>('answer');
  if (!input.value.trim()) return;
  const answer = plainText(sprintCard().answer);
  const v = check(input.value, answer);
  if (v === 'wrong') {
    sprint.misses.set(sprintCard().id, sprintCard());
    flash('no');
    input.select();
  } else advance(true, v === 'close' ? `Accepted. Exact answer: ${answer}` : '');
}

function skip() {
  const c = sprintCard();
  advance(false, `Skipped: ${plainText(c.front).slice(0, 60)} → ${plainText(c.answer)}`);
}

function flipShow() {
  if (sprint.shown) return;
  sprint.shown = true;
  $('sprintBack').innerHTML = renderText(sprintCard().back);
  $('sprintBack').hidden = false;
  $('flipShow').hidden = true;
  $('flipGot').hidden = $('flipMiss').hidden = false;
}

function endSprint() {
  clearInterval(sprint.timer);
  if (sprint.phase !== 'play') return;
  sprint.phase = 'results';
  const key = sprintKey();
  const prevBest = data.best[key] ?? 0;
  const isBest = !sprint.drill && sprint.score > prevBest;
  if (isBest) { data.best[key] = sprint.score; persist(); }
  const misses = [...sprint.misses.values()];
  $('sprintPlay').hidden = true;
  const r = $('sprintResults');
  r.hidden = false;
  r.innerHTML = `
    <div class="result"><span class="big">${sprint.score}</span>
      <span class="sub">${sprint.drill ? 'drill of misses' : isBest ? 'new best' : `best ${prevBest}`}</span></div>
    ${misses.length ? `<p class="lbl">Missed (${misses.length})</p><ul class="misses">${misses.map((c) =>
      `<li><span>${renderText(c.front)}</span><b>${renderText(c.back)}</b></li>`).join('')}</ul>` : '<p class="hint">No misses.</p>'}
    <div class="row">
      <button class="primary" id="again" type="button">Again <kbd>Enter</kbd></button>
      ${misses.length ? '<button id="drill" type="button">Drill misses</button><button id="toStudy" type="button">Send misses to Study</button>' : ''}
      <button class="link" id="sprintBack2" type="button">Settings</button>
    </div>`;
  $('again').addEventListener('click', () => startSprint(activeCards(), false));
  $('sprintBack2').addEventListener('click', () => { sprint.phase = 'setup'; renderSprintSetup(); });
  if (misses.length) {
    $('drill').addEventListener('click', () => startSprint(misses, true));
    $('toStudy').addEventListener('click', () => sendToStudy(misses));
  }
  $('again').focus();
}

/** Makes cards due right now in Study, as learning cards; review cards keep their interval and ease. */
function sendToStudy(list: Card[]) {
  const now = Date.now();
  for (const c of list) {
    const s: CardState | undefined = data.states[c.id];
    data.states[c.id] = s
      ? { ...s, phase: s.phase === 'review' ? 'relearning' : s.phase, step: 0, due: now }
      : { phase: 'learning', due: now, ivl: 0, ease: 2.5, step: 0, reps: 0, lapses: 0 };
  }
  persist();
  toast(`Sent ${list.length} card${list.length === 1 ? '' : 's'} to Study.`);
  $<HTMLButtonElement>('toStudy').disabled = true;
}

/* ---------- decks ---------- */

function renderDecks() {
  const now = Date.now();
  const list = $('deckList');
  list.innerHTML = allDecks().map((d) => {
    const deckCards = cards.filter((c) => c.deckId === d.id);
    const q = buildQueue(deckCards, data.states, data.log, now, Infinity);
    const on = !data.settings.off.includes(d.id);
    return `<li><label class="check"><input type="checkbox" data-deck="${escapeHtml(d.id)}"${on ? ' checked' : ''}>
      <span><b>${renderText(d.name)}</b><span class="sub">${deckCards.length} cards · ${q.counts.new} new · ${q.counts.review + q.counts.learning} due</span></span></label>
      ${d.id === BUILTIN.id ? '' : `<button class="link danger" data-remove="${escapeHtml(d.id)}" type="button">remove</button>`}</li>`;
  }).join('');
  $<HTMLInputElement>('newPerDay').value = String(data.settings.newPerDay);
  $<HTMLInputElement>('testDate').value = data.settings.testDate ?? '';
}

async function onImport(files: FileList) {
  const status = $('importStatus');
  const reversed = $<HTMLInputElement>('importReversed').checked;
  for (const file of files) {
    status.textContent = `Importing ${file.name}…`;
    try {
      const decks = await importFile(file, reversed);
      data.decks.push(...decks);
      if (!save(data)) {
        data.decks.splice(-decks.length);
        throw new Error('That deck is too big for browser storage.');
      }
      rebuild();
      const count = decks.reduce((n, d) => n + expandDeck(d).length, 0);
      status.textContent = `Imported ${decks.map((d) => d.name).join(', ')}: ${count} cards.`;
    } catch (e) {
      status.textContent = `${file.name}: ${e instanceof Error ? e.message : 'could not import.'}`;
    }
  }
  renderDecks();
}

function backup() {
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `card-sprint-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function restore(file: File) {
  try {
    const next = parseData(JSON.parse(await file.text()));
    if (!confirm('Replace all decks and progress in this browser with the backup?')) return;
    data = next;
    persist();
    rebuild();
    applyTheme();
    toast('Backup restored.');
    renderDecks();
  } catch (e) {
    toast(e instanceof Error ? e.message : 'Could not read that backup.');
  }
}

/* ---------- wiring ---------- */

document.querySelector('nav')!.addEventListener('click', (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]');
  if (t) showTab(t.dataset.tab as Tab);
});
document.addEventListener('click', (e) => {
  const go = (e.target as HTMLElement).closest<HTMLElement>('[data-goto]');
  if (go) showTab(go.dataset.goto as Tab);
});
$('theme').addEventListener('click', () => {
  const order = [undefined, 'light', 'dark'] as const;
  data.settings.theme = order[(order.indexOf(data.settings.theme) + 1) % order.length];
  persist();
  applyTheme();
});

$('show').addEventListener('click', reveal);
$('grades').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-grade]');
  if (b) grade(Number(b.dataset.grade) as Grade);
});
$('undo').addEventListener('click', undo);

$('sprintStart').addEventListener('click', () => startSprint(activeCards(), false));
$('answer').addEventListener('input', onTyped);
$('flipShow').addEventListener('click', flipShow);
$('choices').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-choice]');
  if (b) choose(Number(b.dataset.choice));
});
$('flipGot').addEventListener('click', () => advance(true));
$('flipMiss').addEventListener('click', () => advance(false, `Missed: ${plainText(sprintCard().answer)}`));

$('deckList').addEventListener('change', (e) => {
  const id = (e.target as HTMLInputElement).dataset.deck;
  if (!id) return;
  const off = new Set(data.settings.off);
  if ((e.target as HTMLInputElement).checked) off.delete(id); else off.add(id);
  data.settings.off = [...off];
  persist();
});
$('deckList').addEventListener('click', (e) => {
  const id = (e.target as HTMLElement).closest<HTMLElement>('[data-remove]')?.dataset.remove;
  if (!id || !confirm(`Remove “${deckName(id)}” and its progress?`)) return;
  data.decks = data.decks.filter((d) => d.id !== id);
  for (const key of Object.keys(data.states)) if (key.startsWith(`${id}/`)) delete data.states[key];
  data.log = data.log.filter((l) => !l.card.startsWith(`${id}/`));
  persist();
  rebuild();
  renderDecks();
});
$<HTMLInputElement>('newPerDay').addEventListener('change', (e) => {
  const n = Math.round(Number((e.target as HTMLInputElement).value));
  data.settings.newPerDay = Number.isFinite(n) ? Math.min(999, Math.max(0, n)) : 20;
  persist();
  renderDecks();
});
$<HTMLInputElement>('testDate').addEventListener('change', (e) => {
  data.settings.testDate = (e.target as HTMLInputElement).value || undefined;
  persist();
});
$('clearTest').addEventListener('click', () => {
  data.settings.testDate = undefined;
  persist();
  renderDecks();
});
$<HTMLInputElement>('importFile').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  if (input.files?.length) await onImport(input.files);
  input.value = '';
});
$('backup').addEventListener('click', backup);
$<HTMLInputElement>('restore').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  if (input.files?.[0]) await restore(input.files[0]);
  input.value = '';
});
$('reset').addEventListener('click', () => {
  if (!confirm('Erase all study progress and best scores? Imported decks stay.')) return;
  Object.assign(data, { states: {}, log: [], best: {} });
  persist();
  toast('Progress reset.');
  renderDecks();
});

const typingField = (t: EventTarget | null) =>
  t instanceof HTMLInputElement && t.id !== 'answer' && t.type !== 'checkbox' && t.type !== 'radio';

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || typingField(e.target)) return;
  if (tab === 'study') {
    if ((e.key === ' ' || e.key === 'Enter') && !revealed && current) { e.preventDefault(); reveal(); }
    else if (e.key === ' ' && revealed) { e.preventDefault(); grade(3); }
    else if (/^[1-4]$/.test(e.key)) grade(Number(e.key) as Grade);
    else if (e.key === 'z' || e.key === 'Z') undo();
  } else if (tab === 'sprint') {
    if (sprint.phase !== 'play') {
      if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        startSprint(activeCards(), false);
      }
      return;
    }
    if (e.key === 'Escape') return endSprint();
    if (data.settings.sprintMode === 'choice') {
      if (/^[1-9]$/.test(e.key)) choose(Number(e.key) - 1);
    } else if (data.settings.sprintMode === 'type') {
      if (e.key === 'Enter') { e.preventDefault(); onEnter(); }
      else if (e.key === 'Tab') { e.preventDefault(); skip(); }
    } else if (e.key === ' ') { e.preventDefault(); flipShow(); }
    else if (sprint.shown && (e.key === 'j' || e.key === 'J')) advance(true);
    else if (sprint.shown && (e.key === 'f' || e.key === 'F')) advance(false, `Missed: ${plainText(sprintCard().answer)}`);
  }
});

// another tab may have studied; pick up its progress when this one regains focus
window.addEventListener('storage', () => {
  data = load();
  rebuild();
  if (tab === 'study') renderStudy(); else if (tab === 'decks') renderDecks();
});

rebuild();
applyTheme();
showTab('study');
