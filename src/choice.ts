import { plainText, type Card } from './cards';
import { normalize } from './match';

export interface Options {
  /** answers as stored (render with renderText) */
  options: string[];
  right: number;
}

/** What shape an answer has: a term, a definition, or a cloze word. Wrong options should share it. */
const answerType = (c: Card) => (c.kind === 'cloze' ? 'cloze' : c.kind === 'reversed' && c.ord === 1 ? 'term' : 'back');

/** The right answer plus up to three wrong ones that look like it, in random order. */
export function pickOptions(card: Card, pool: Card[], count = 4, rand: () => number = Math.random): Options {
  const rightText = normalize(plainText(card.answer));
  const len = Math.max(1, plainText(card.answer).length);
  const seen = new Set([rightText]);
  const ranked = pool
    // a sibling's answer is this card's own question, so it would give the game away
    .filter((c) => c.sibling !== card.sibling)
    .map((c) => {
      const lenGap = Math.abs(Math.log(Math.max(1, plainText(c.answer).length) / len));
      const score = (c.deckId === card.deckId ? 0 : 100) + (answerType(c) === answerType(card) ? 0 : 50) + lenGap * 10 + rand() * 8;
      return { c, score };
    })
    .sort((a, b) => a.score - b.score);

  const wrong: string[] = [];
  for (const { c } of ranked) {
    const key = normalize(plainText(c.answer));
    if (!key || seen.has(key)) continue;
    seen.add(key);
    wrong.push(c.answer);
    if (wrong.length === count - 1) break;
  }
  const right = Math.floor(rand() * (wrong.length + 1));
  const options = [...wrong];
  options.splice(right, 0, card.answer);
  return { options, right };
}
