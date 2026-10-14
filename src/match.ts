// Typed-answer checking. "exact" is safe to accept on every keystroke; "close" only on Enter.
export type Verdict = 'exact' | 'close' | 'wrong';

/** Case, accents, punctuation, "&", leading articles and spacing don't count. */
export function normalize(s: string): string {
  return s
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9+\-*/=^%.()$ ]+/g, ' ')
    .replace(/\s*([+\-*/=^()])\s*/g, '$1')
    .replace(/\.(?!\d)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(the|a|an) /, '');
}

/** Every acceptable spelling: the whole answer, each ";" alternative, and each without its (parenthetical). */
export function accepted(answer: string): string[] {
  const parts = [answer, ...answer.split(';')];
  const all = parts.flatMap((p) => [p, p.replace(/\([^)]*\)/g, ' ')]);
  return [...new Set(all.map(normalize).filter(Boolean))];
}

function distance(a: string, b: string): number {
  // Damerau-Levenshtein (optimal string alignment): swapped letters cost one edit, as typos do
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

const words = (s: string) => s.split(/ |\band\b|,/).filter(Boolean).sort().join(' ');

const STOP = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'by', 'for', 'with', 'as', 'at', 'is', 'are',
  'be', 'it', 'its', 'from', 'into', 'that', 'this', 'their', 'than', 'vs', 'was', 'were', 'which', 'who', 'what']);
/** "Bonds" and "bond" are the same key word; "gross" keeps its s. */
const stem = (w: string) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
const keyWords = (s: string) => [...new Set(s.split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w)).map(stem))];
/** Long answers need only this share of their key words */
const KEYWORD_SHARE = 0.6;
/** Answers with fewer key words than this must match as a whole */
const KEYWORD_MIN = 4;

function hasKeyWords(got: string, target: string): boolean {
  const want = keyWords(target);
  if (want.length < KEYWORD_MIN) return false;
  const have = keyWords(got);
  // a one-letter slip in a longer word still counts as the word
  const hits = want.filter((w) => have.some((h) => h === w || (w.length >= 5 && distance(h, w) <= 1)));
  return hits.length / want.length >= KEYWORD_SHARE;
}

export function check(input: string, answer: string): Verdict {
  const got = normalize(input);
  if (!got) return 'wrong';
  const targets = accepted(answer);
  if (targets.includes(got)) return 'exact';
  for (const t of targets) {
    // one typo per six letters, never more than three; short answers must be spelled right
    const allowed = Math.min(3, Math.floor(t.length / 6));
    if (distance(got, t) <= allowed) return 'close';
    // "interest and principal" for "principal and interest"
    if (words(got) === words(t)) return 'close';
    // sentence answers: most of the key words, in any order, is enough
    if (hasKeyWords(got, t)) return 'close';
  }
  return 'wrong';
}
