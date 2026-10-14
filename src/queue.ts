import type { Card } from './cards';
import type { LogEntry } from './store';
import { dayStart, type CardState } from './srs';

/** Anki's "learn ahead" limit: with nothing else left, show a learning card this early. */
const LEARN_AHEAD = 20 * 60_000;

export interface Queue {
  next?: Card;
  counts: { new: number; learning: number; review: number };
  /** when the next learning or review card comes due, if nothing is due now */
  nextDue?: number;
}

export function buildQueue(
  cards: Card[], states: Record<string, CardState>, log: LogEntry[], now: number, newPerDay: number,
): Queue {
  const today = dayStart(now);
  const byId = new Map(cards.map((c) => [c.id, c]));
  const todays = log.filter((e) => e.t >= today);
  const newSeen = new Set(todays.filter((e) => !e.prev).map((e) => e.card));
  // a sibling studied today buries its new partners until tomorrow, so a reverse card never follows its own front
  const touched = new Set(todays.map((e) => byId.get(e.card)?.sibling));

  const learning: Card[] = [];
  const reviews: Card[] = [];
  const fresh: Card[] = [];
  for (const c of cards) {
    const s = states[c.id];
    if (!s) {
      if (!touched.has(c.sibling)) fresh.push(c);
    } else if (s.phase === 'review') {
      if (s.due <= now) reviews.push(c);
    } else if (s.due < today + 86_400_000) {
      learning.push(c);
    }
  }
  const due = (c: Card) => states[c.id].due;
  learning.sort((a, b) => due(a) - due(b));
  reviews.sort((a, b) => due(a) - due(b));
  fresh.sort((a, b) => a.pos - b.pos || a.ord - b.ord);
  const newCards = fresh.slice(0, Math.max(0, newPerDay - newSeen.size));

  const counts = { new: newCards.length, learning: learning.length, review: reviews.length };
  const ready = learning.find((c) => due(c) <= now) ?? reviews[0] ?? newCards[0]
    ?? learning.find((c) => due(c) <= now + LEARN_AHEAD);
  if (ready) return { next: ready, counts };

  const later = cards.map((c) => states[c.id]?.due).filter((d): d is number => d !== undefined && d > now);
  return { counts, nextDue: later.length ? Math.min(...later) : undefined };
}
