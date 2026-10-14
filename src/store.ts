import type { Deck } from './cards';
import type { CardState, Grade } from './srs';

export type SprintMode = 'type' | 'choice' | 'flip';

export interface LogEntry {
  card: string;
  t: number;
  grade: Grade;
  /** state before this grade, so undo can put it back (undefined = the card was new) */
  prev?: CardState;
}

export interface Settings {
  newPerDay: number;
  testDate?: string;
  /** deck ids switched off for Study and Sprint */
  off: string[];
  sprintMode: SprintMode;
  sprintSeconds: number;
  theme?: 'light' | 'dark';
}

export interface Data {
  v: 1;
  /** imported decks; the bundled deck is not stored */
  decks: Deck[];
  states: Record<string, CardState>;
  log: LogEntry[];
  settings: Settings;
  /** best sprint score per setting key */
  best: Record<string, number>;
}

const KEY = 'card-sprint:v1';
const LOG_LIMIT = 5000;

export const fresh = (): Data => ({
  v: 1, decks: [], states: {}, log: [], best: {},
  settings: { newPerDay: 20, off: [], sprintMode: 'type', sprintSeconds: 120 },
});

/** Accepts anything shaped like Data (a backup file or old storage); throws on anything else. */
export function parseData(raw: unknown): Data {
  const d = raw as Partial<Data> | null;
  if (!d || d.v !== 1 || !Array.isArray(d.decks) || typeof d.states !== 'object' || !Array.isArray(d.log)) {
    throw new Error('Not a card/sprint backup.');
  }
  const base = fresh();
  return { ...base, ...d, settings: { ...base.settings, ...d.settings }, best: { ...d.best } } as Data;
}

export function load(): Data {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? parseData(JSON.parse(raw)) : fresh();
  } catch {
    return fresh();
  }
}

/** Returns false when the browser refuses (quota full or storage blocked). */
export function save(data: Data): boolean {
  if (data.log.length > LOG_LIMIT) data.log = data.log.slice(-LOG_LIMIT);
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}
