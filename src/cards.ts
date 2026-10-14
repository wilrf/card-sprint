// Notes are what you write; cards are what you study. One note expands to one or more cards.
export type NoteKind = 'basic' | 'reversed' | 'cloze';

export interface Note {
  id: string;
  kind: NoteKind;
  /** basic/reversed: [front, back]; cloze: [text, extra?]. Plain text, never HTML. */
  fields: string[];
  /** cards sharing a group are siblings (defaults to the note id) */
  group?: string;
}

export interface Deck {
  id: string;
  name: string;
  notes: Note[];
}

export interface Card {
  id: string;
  deckId: string;
  sibling: string;
  /** position of the note in its deck; new cards are introduced in this order */
  pos: number;
  ord: number;
  kind: NoteKind;
  front: string;
  back: string;
  /** what a typed answer is checked against */
  answer: string;
}

// Private-use code points wrap highlighted cloze text so the markers survive HTML escaping.
export const HL_OPEN = '';
export const HL_CLOSE = '';
const CLOZE = /\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g;

export function clozeNumbers(text: string): number[] {
  const nums = new Set<number>();
  for (const m of text.matchAll(CLOZE)) nums.add(Number(m[1]));
  return [...nums].sort((a, b) => a - b);
}

function clozeSide(text: string, n: number, reveal: boolean): string {
  return text.replace(CLOZE, (_, num: string, body: string, hint?: string) => {
    if (Number(num) !== n) return body;
    return HL_OPEN + (reveal ? body : `[${hint ?? '…'}]`) + HL_CLOSE;
  });
}

export function expandNote(deckId: string, note: Note, pos: number): Card[] {
  const sibling = `${deckId}/${note.group ?? note.id}`;
  const make = (ord: number, front: string, back: string, answer: string): Card => ({
    id: `${deckId}/${note.id}/${ord}`, deckId, sibling, pos, ord, kind: note.kind, front, back, answer,
  });
  const [a = '', b = ''] = note.fields;
  switch (note.kind) {
    case 'basic':
      return a.trim() ? [make(0, a, b, b)] : [];
    case 'reversed':
      return [a.trim() && make(0, a, b, b), b.trim() && make(1, b, a, a)].filter((c): c is Card => !!c);
    case 'cloze':
      return clozeNumbers(a).map((n) => {
        const answer = [...a.matchAll(CLOZE)].filter((m) => Number(m[1]) === n).map((m) => m[2]).join(', ');
        const back = clozeSide(a, n, true) + (b.trim() ? `\n\n${b}` : '');
        return make(n - 1, clozeSide(a, n, false), back, answer);
      });
  }
}

export const expandDeck = (deck: Deck): Card[] => deck.notes.flatMap((n, i) => expandNote(deck.id, n, i));

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

// Tiny math renderer for \( … \): x^2, x^{n+1}, x_5, x_{t} become <sup>/<sub>; the rest stays as text.
function renderMath(src: string): string {
  return src.replace(/([\^_])(?:\{([^{}]*)\}|([A-Za-z0-9]+))/g, (_, op: string, braced?: string, bare?: string) => {
    const tag = op === '^' ? 'sup' : 'sub';
    return `<${tag}>${braced ?? bare}</${tag}>`;
  });
}

/** Safe HTML for display: escapes everything, then adds only our own markup. */
export function renderText(text: string): string {
  return escapeHtml(text)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_, m: string) => `<span class="math">${renderMath(m)}</span>`)
    .replaceAll(HL_OPEN, '<mark>')
    .replaceAll(HL_CLOSE, '</mark>')
    .replace(/\n/g, '<br>');
}

/** The answer as a person would type it: no math delimiters or highlight markers. */
export const plainText = (text: string): string =>
  text.replace(/\\\(|\\\)/g, '').replaceAll(HL_OPEN, '').replaceAll(HL_CLOSE, '').trim();
