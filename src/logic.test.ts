import { describe, expect, it } from 'vitest';
import initSqlJs from 'sql.js';
import { zipSync, strToU8 } from 'fflate';
import { expandDeck, expandNote, plainText, renderText, type Deck } from './cards';
import { dayStart, schedule, waitLabel, type CardState } from './srs';
import { buildQueue } from './queue';
import { check, normalize } from './match';
import { htmlToText, parseAnki, parseDelimited, parseJson } from './importers';
import { parseData, fresh } from './store';
import fir from './fir-deck.json';

const MIN = 60_000;
const DAY = 86_400_000;
// a fixed local noon, so day rollovers are predictable
const NOW = new Date(2026, 9, 14, 12).getTime();

describe('cards', () => {
  it('expands the bundled FIR deck to 108 notes and 165 cards', () => {
    const deck = fir as Deck;
    expect(deck.notes).toHaveLength(108);
    expect(expandDeck(deck)).toHaveLength(165);
  });

  it('makes one card per cloze number, hiding only that blank', () => {
    const cards = expandNote('d', { id: 'n', kind: 'cloze', fields: ['{{c1::Debt}} first, {{c2::equity::who?}} last'] }, 0);
    expect(cards.map((c) => plainText(c.front))).toEqual(['[…] first, equity last', 'Debt first, [who?] last']);
    expect(cards.map((c) => c.answer)).toEqual(['Debt', 'equity']);
    expect(cards[0].sibling).toBe(cards[1].sibling);
  });

  it('reverses a reversed note and skips an empty side', () => {
    const [a, b] = expandNote('d', { id: 'n', kind: 'reversed', fields: ['Q', 'A'] }, 0);
    expect([a.front, a.back, b.front, b.back]).toEqual(['Q', 'A', 'A', 'Q']);
    expect(expandNote('d', { id: 'n', kind: 'reversed', fields: ['Q', ''] }, 0)).toHaveLength(1);
  });

  it('renders math and escapes everything else', () => {
    expect(renderText('\\(PV = FV / (1+r)^n\\)')).toContain('(1+r)<sup>n</sup>');
    expect(renderText('\\(UFCF_5\\)')).toContain('UFCF<sub>5</sub>');
    expect(renderText('<img src=x onerror=alert(1)>')).not.toContain('<img');
  });
});

describe('scheduler', () => {
  it('walks the 1 and 10 minute learning steps, then graduates to one day', () => {
    const s1 = schedule(undefined, 3, NOW);
    expect([s1.phase, s1.due - NOW]).toEqual(['learning', 10 * MIN]);
    const s2 = schedule(s1, 3, NOW);
    expect([s2.phase, s2.ivl]).toEqual(['review', 1]);
    expect(schedule(undefined, 1, NOW).due - NOW).toBe(1 * MIN);
    expect(schedule(undefined, 4, NOW).ivl).toBe(4);
  });

  it('grows review intervals by ease and lapses on Again', () => {
    const rev: CardState = { phase: 'review', due: NOW, ivl: 10, ease: 2.5, step: 0, reps: 3, lapses: 0 };
    expect(schedule(rev, 3, NOW).ivl).toBe(25);
    expect(schedule(rev, 2, NOW).ivl).toBe(12);
    expect(schedule(rev, 4, NOW).ivl).toBe(33);
    const lapsed = schedule(rev, 1, NOW);
    expect([lapsed.phase, lapsed.lapses, lapsed.ease, lapsed.due - NOW]).toEqual(['relearning', 1, 2.3, 10 * MIN]);
    expect(schedule(lapsed, 3, NOW).ivl).toBe(1);
  });

  it('never schedules past the test date', () => {
    const rev: CardState = { phase: 'review', due: NOW, ivl: 30, ease: 2.5, step: 0, reps: 5, lapses: 0 };
    const capped = schedule(rev, 4, NOW, { testDate: '2026-10-20' });
    expect(capped.ivl).toBe(6);
    expect(capped.due).toBe(dayStart(NOW) + 6 * DAY);
    // a test date already passed is ignored
    expect(schedule(rev, 3, NOW, { testDate: '2026-10-01' }).ivl).toBe(75);
  });

  it('labels the wait each grade would produce', () => {
    expect([1, 2, 3, 4].map((g) => waitLabel(undefined, g as 1, NOW))).toEqual(['1m', '6m', '10m', '4d']);
  });
});

describe('queue', () => {
  const deck: Deck = { id: 'd', name: 'D', notes: [
    { id: 'a', kind: 'reversed', fields: ['A1', 'A2'] },
    { id: 'b', kind: 'basic', fields: ['B', 'b'] },
  ] };
  const cards = expandDeck(deck);

  it('starts the bundled deck on "Accounting equation"', () => {
    const q = buildQueue(expandDeck(fir as Deck), {}, [], NOW, 20);
    expect(q.next?.front).toBe('Accounting equation');
  });

  it('puts due learning cards first and buries a new sibling for the day', () => {
    const states = { 'd/a/0': schedule(undefined, 1, NOW - 5 * MIN) };
    const log = [{ card: 'd/a/0', t: NOW - 5 * MIN, grade: 1 as const }];
    const q = buildQueue(cards, states, log, NOW, 20);
    expect(q.next?.id).toBe('d/a/0');
    expect(q.counts).toEqual({ new: 1, learning: 1, review: 0 });
  });

  it('stops new cards at the daily limit and reports when the next card is due', () => {
    const states = { 'd/b/0': schedule(undefined, 4, NOW) };
    const log = [{ card: 'd/b/0', t: NOW, grade: 4 as const }];
    const q = buildQueue(cards, states, log, NOW, 1);
    expect(q.next).toBeUndefined();
    expect(q.nextDue).toBe(states['d/b/0'].due);
  });
});

describe('typed answers', () => {
  it('ignores case, punctuation, articles and spacing', () => {
    expect(normalize('  The  Fiduciary Duty! ')).toBe('fiduciary duty');
    expect(check('assets=liabilities+equity', 'Assets = Liabilities + Equity')).toBe('exact');
  });

  it('accepts alternatives and drops parentheticals', () => {
    expect(check('dividends', 'Dividends (profit share)')).toBe('exact');
    expect(check('npv', 'Net present value; NPV')).toBe('exact');
  });

  it('forgives typos and word order on Enter, but not on short answers', () => {
    expect(check('fiduciray duty', 'Fiduciary duty')).toBe('close');
    expect(check('interest and principal', 'Principal and interest')).toBe('close');
    expect(check('debit', 'Debt')).toBe('wrong');
    expect(check('', 'Debt')).toBe('wrong');
  });
});

describe('importers', () => {
  it('turns Anki HTML into plain text', () => {
    expect(htmlToText('a<br>b&nbsp;&amp;&#36;<b>c</b>[sound:x.mp3]')).toBe('a\nb &$c');
  });

  it('reads CSV with quotes and tab-separated text with Anki headers', () => {
    const csv = parseDelimited('front,back\n"Q, with comma","A ""quoted"""\n', 'csv');
    expect(csv.notes.map((n) => n.fields)).toEqual([['Q, with comma', 'A "quoted"']]);
    const tsv = parseDelimited('#separator:tab\nQ1\tA1\n{{c1::cloze}} me\t\n', 'tsv', true);
    expect(tsv.notes.map((n) => n.kind)).toEqual(['reversed', 'cloze']);
  });

  it('reads JSON arrays and deck objects', () => {
    expect(parseJson('[{"front":"Q","back":"A"}]', 'j').notes[0].fields).toEqual(['Q', 'A']);
    const d = parseJson('{"name":"Mine","notes":[{"kind":"cloze","text":"{{c1::x}}"}]}', 'j');
    expect([d.name, d.notes[0].kind]).toEqual(['Mine', 'cloze']);
    expect(() => parseJson('{}', 'j')).toThrow();
  });

  it('imports a legacy .apkg with basic, reversed and cloze note types', async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    const models = {
      1: { type: 0, flds: [{ name: 'Front' }, { name: 'Back' }], tmpls: [{ qfmt: '{{Front}}', afmt: '{{FrontSide}}<hr id=answer>{{Back}}' }] },
      2: { type: 0, flds: [{ name: 'Front' }, { name: 'Back' }], tmpls: [
        { qfmt: '{{Front}}', afmt: '{{FrontSide}}<hr id=answer>{{Back}}' },
        { qfmt: '{{Back}}', afmt: '{{FrontSide}}<hr id=answer>{{Front}}' }] },
      3: { type: 1, flds: [{ name: 'Text' }, { name: 'Extra' }], tmpls: [{ qfmt: '{{cloze:Text}}', afmt: '{{cloze:Text}}<br>{{Extra}}' }] },
    };
    db.run('create table col (models text, decks text); create table notes (id int, mid int, flds text); create table cards (nid int, did int, ord int)');
    db.run('insert into col values (?, ?)', [JSON.stringify(models), JSON.stringify({ 9: { name: 'Test::Deck' } })]);
    db.run(`insert into notes values (10, 1, 'Q<br>1\x1fA&amp;1'), (11, 2, 'F\x1fB'), (12, 3, '{{c1::x}} {{c2::y}}\x1fnote')`);
    db.run('insert into cards values (10, 9, 0), (11, 9, 0), (11, 9, 1), (12, 9, 0), (12, 9, 1)');
    const apkg = zipSync({ 'collection.anki2': db.export(), media: strToU8('{}') });
    const [deck] = await parseAnki(apkg, SQL);
    expect(deck.name).toBe('Test::Deck');
    expect(deck.notes.map((n) => [n.kind, n.fields[0]])).toEqual([['basic', 'Q\n1'], ['reversed', 'F'], ['cloze', '{{c1::x}} {{c2::y}}']]);
    expect(expandDeck(deck)).toHaveLength(5);
  });

  it('rejects files that are not Anki packages', async () => {
    await expect(parseAnki(strToU8('nope'), await initSqlJs())).rejects.toThrow(/not a valid Anki/);
  });
});

describe('store', () => {
  it('restores a backup and fills in missing settings', () => {
    const d = parseData({ v: 1, decks: [], states: {}, log: [], settings: { newPerDay: 5 } });
    expect(d.settings).toEqual({ ...fresh().settings, newPerDay: 5 });
    expect(() => parseData({ hello: 1 })).toThrow();
  });
});
