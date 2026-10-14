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
  }
  return 'wrong';
}
