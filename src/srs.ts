// Anki-style scheduler: learning steps in minutes, then SM-2 intervals in days.
export type Grade = 1 | 2 | 3 | 4; // Again, Hard, Good, Easy
export type Phase = 'learning' | 'review' | 'relearning';

export interface CardState {
  phase: Phase;
  /** ms timestamp when the card is next due */
  due: number;
  /** current review interval in days (0 while still learning) */
  ivl: number;
  ease: number;
  step: number;
  reps: number;
  lapses: number;
}

export interface SchedOptions {
  /** ISO date (YYYY-MM-DD); no review is scheduled past it */
  testDate?: string;
}

const MIN = 60_000;
const DAY = 86_400_000;
export const LEARN_STEPS = [1, 10];
export const RELEARN_STEPS = [10];
const GRADUATE_IVL = 1;
const EASY_IVL = 4;
const START_EASE = 2.5;
const MIN_EASE = 1.3;
/** Anki's day rolls over at 4am local time, so late-night study counts toward the same day */
const ROLLOVER_HOUR = 4;

export function dayStart(now: number): number {
  const d = new Date(now);
  d.setHours(ROLLOVER_HOUR, 0, 0, 0);
  if (d.getTime() > now) d.setDate(d.getDate() - 1);
  return d.getTime();
}
export const dayEnd = (now: number) => dayStart(now) + DAY;

/** Whole days from today's rollover to the test date's rollover; undefined once the test has passed. */
export function daysUntilTest(now: number, testDate?: string): number | undefined {
  if (!testDate) return undefined;
  const [y, m, d] = testDate.split('-').map(Number);
  const test = new Date(y, m - 1, d, ROLLOVER_HOUR).getTime();
  const days = Math.round((test - dayStart(now)) / DAY);
  return days > 0 ? days : undefined;
}

function review(s: CardState, ivl: number, ease: number, now: number, opts: SchedOptions): CardState {
  const cap = daysUntilTest(now, opts.testDate);
  const days = Math.max(1, Math.round(cap === undefined ? ivl : Math.min(ivl, cap)));
  // due at the rollover `days` days from today, so a review is never shown mid-afternoon "early"
  return { ...s, phase: 'review', ivl: days, ease, step: 0, due: dayStart(now) + days * DAY };
}

const stepped = (s: CardState, phase: Phase, step: number, minutes: number, now: number): CardState =>
  ({ ...s, phase, step, due: now + minutes * MIN });

export function schedule(prev: CardState | undefined, grade: Grade, now: number, opts: SchedOptions = {}): CardState {
  const s: CardState = { phase: 'learning', due: now, ivl: 0, ease: START_EASE, step: 0, reps: 0, lapses: 0, ...prev };
  s.reps += 1;

  if (s.phase === 'review') {
    if (grade === 1) {
      const lapsed = { ...s, lapses: s.lapses + 1, ease: Math.max(MIN_EASE, s.ease - 0.2), ivl: 1 };
      return stepped(lapsed, 'relearning', 0, RELEARN_STEPS[0], now);
    }
    if (grade === 2) return review(s, Math.max(s.ivl + 1, s.ivl * 1.2), Math.max(MIN_EASE, s.ease - 0.15), now, opts);
    if (grade === 3) return review(s, Math.max(s.ivl + 1, s.ivl * s.ease), s.ease, now, opts);
    return review(s, Math.max(s.ivl + 1, s.ivl * s.ease * 1.3), s.ease + 0.15, now, opts);
  }

  // learning and relearning walk through their steps
  const steps = s.phase === 'learning' ? LEARN_STEPS : RELEARN_STEPS;
  const graduate = s.phase === 'learning' ? GRADUATE_IVL : Math.max(1, s.ivl);
  if (grade === 1) return stepped(s, s.phase, 0, steps[0], now);
  if (grade === 2) {
    // Hard repeats the step; on the first step it waits halfway between the first two
    const wait = s.step === 0 && steps.length > 1 ? (steps[0] + steps[1]) / 2 : steps[s.step];
    return stepped(s, s.phase, s.step, wait, now);
  }
  if (grade === 3) {
    const next = s.step + 1;
    return next < steps.length ? stepped(s, s.phase, next, steps[next], now) : review(s, graduate, s.ease, now, opts);
  }
  return review(s, s.phase === 'learning' ? EASY_IVL : graduate + 1, s.ease, now, opts);
}

/** Short label for the wait a grade would produce: "1m", "10m", "3d", "2mo". */
export function waitLabel(prev: CardState | undefined, grade: Grade, now: number, opts: SchedOptions = {}): string {
  const next = schedule(prev, grade, now, opts);
  if (next.phase !== 'review') return `${Math.round((next.due - now) / MIN)}m`;
  if (next.ivl < 30) return `${next.ivl}d`;
  if (next.ivl < 365) return `${Math.round(next.ivl / 30)}mo`;
  return `${(next.ivl / 365).toFixed(1)}y`;
}
