import { unzipSync, strFromU8 } from 'fflate';
import type { Database, SqlJsStatic } from 'sql.js';
import type { Deck, Note } from './cards';

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Anki fields are HTML; we keep plain text only (no markup survives, so imported decks can't inject script). */
export function htmlToText(html: string): string {
  return html
    .replace(/\[sound:[^\]]*\]/g, '')
    .replace(/<(br|\/div|\/p|\/li|\/tr|hr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const deckId = () => `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const kindOf = (front: string, reversed: boolean): Note['kind'] =>
  /\{\{c\d+::/.test(front) ? 'cloze' : reversed ? 'reversed' : 'basic';

/* ---------- CSV / tab-separated text ---------- */

function splitRows(text: string, sep: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** One card per line: front, back. Tab-separated if the first line has a tab, else comma. Lines starting "#" are skipped (Anki export headers). */
export function parseDelimited(text: string, name: string, reversed = false): Deck {
  const lines = text.replace(/^﻿/, '');
  const firstData = lines.split(/\r?\n/).find((l) => l && !l.startsWith('#')) ?? '';
  const sep = firstData.includes('\t') ? '\t' : ',';
  const rows = splitRows(lines, sep).filter((r) => r.length && !r[0].startsWith('#') && r.some((c) => c.trim()));
  // a header row like "front,back" or "Question,Answer" names the columns; it is not a card
  if (/^(front|question|term)$/i.test(rows[0]?.[0]?.trim() ?? '') && /^(back|answer|definition)$/i.test(rows[0]?.[1]?.trim() ?? '')) rows.shift();
  const notes = rows
    .map((r, i): Note => {
      const [front = '', back = ''] = r.map((c) => htmlToText(c));
      return { id: String(i), kind: kindOf(front, reversed), fields: [front, back] };
    })
    .filter((n) => n.fields[0]);
  if (!notes.length) throw new Error('No cards found. Expected one card per line: front, back.');
  return { id: deckId(), name, notes };
}

/* ---------- JSON ---------- */

type JsonCard = { front?: unknown; back?: unknown; kind?: unknown; fields?: unknown; text?: unknown; extra?: unknown };

/** Accepts {name?, notes|cards: [...]} or a bare array; items are {front, back}, {text, extra} (cloze) or {kind, fields}. */
export function parseJson(text: string, name: string): Deck {
  const raw = JSON.parse(text) as unknown;
  const obj = (Array.isArray(raw) ? { cards: raw } : raw) as { name?: unknown; notes?: unknown; cards?: unknown };
  const items = (Array.isArray(obj?.notes) ? obj.notes : Array.isArray(obj?.cards) ? obj.cards : []) as JsonCard[];
  const str = (v: unknown) => (typeof v === 'string' ? htmlToText(v) : typeof v === 'number' ? String(v) : '');
  const notes = items.flatMap((it, i): Note[] => {
    if (!it || typeof it !== 'object') return [];
    const fields = Array.isArray(it.fields) ? it.fields.map(str)
      : it.text !== undefined ? [str(it.text), str(it.extra)]
      : [str(it.front), str(it.back)];
    const kind = it.kind === 'basic' || it.kind === 'reversed' || it.kind === 'cloze' ? it.kind : kindOf(fields[0], false);
    return fields[0] ? [{ id: String(i), kind, fields }] : [];
  });
  if (!notes.length) throw new Error('No cards found in that JSON file.');
  return { id: deckId(), name: typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : name, notes };
}

/* ---------- Anki .apkg / .colpkg ---------- */

interface Model { cloze: boolean; fields: string[]; tmpls: { q: string; a: string }[] }

/** Minimal protobuf reader: field number → values (varints as numbers, length-delimited as bytes). */
function protoFields(buf: Uint8Array): Map<number, (number | Uint8Array)[]> {
  const out = new Map<number, (number | Uint8Array)[]>();
  let i = 0;
  const varint = () => {
    let n = 0, mul = 1, b: number;
    do { b = buf[i++]; n += (b & 0x7f) * mul; mul *= 128; } while (b & 0x80);
    return n;
  };
  while (i < buf.length) {
    const key = varint();
    const wire = key & 7;
    let v: number | Uint8Array;
    if (wire === 0) v = varint();
    else if (wire === 2) { const len = varint(); v = buf.subarray(i, i + len); i += len; }
    else if (wire === 1) { i += 8; continue; }
    else if (wire === 5) { i += 4; continue; }
    else break;
    const k = Math.floor(key / 8);
    out.set(k, [...(out.get(k) ?? []), v]);
  }
  return out;
}

const rows = (db: Database, sql: string) => db.exec(sql)[0]?.values ?? [];
const hasTable = (db: Database, t: string) => rows(db, `select 1 from sqlite_master where type='table' and name='${t}'`).length > 0;

function readModels(db: Database): Map<string, Model> {
  const models = new Map<string, Model>();
  if (hasTable(db, 'notetypes')) {
    // schema 18+: note types live in their own tables, with protobuf config blobs
    for (const [id, config] of rows(db, 'select id, config from notetypes')) {
      models.set(String(id), { cloze: protoFields(config as Uint8Array).get(1)?.[0] === 1, fields: [], tmpls: [] });
    }
    for (const [ntid, name] of rows(db, 'select ntid, name from fields order by ntid, ord')) models.get(String(ntid))?.fields.push(String(name));
    for (const [ntid, config] of rows(db, 'select ntid, config from templates order by ntid, ord')) {
      const f = protoFields(config as Uint8Array);
      const s = (n: number) => { const v = f.get(n)?.[0]; return v instanceof Uint8Array ? strFromU8(v) : ''; };
      models.get(String(ntid))?.tmpls.push({ q: s(1), a: s(2) });
    }
  } else {
    const json = JSON.parse(String(rows(db, 'select models from col')[0][0])) as Record<string, {
      type: number; flds: { name: string }[]; tmpls: { qfmt: string; afmt: string }[];
    }>;
    for (const [id, m] of Object.entries(json)) {
      models.set(id, { cloze: m.type === 1, fields: m.flds.map((f) => f.name), tmpls: m.tmpls.map((t) => ({ q: t.qfmt, a: t.afmt })) });
    }
  }
  return models;
}

function readDeckNames(db: Database): Map<string, string> {
  const names = new Map<string, string>();
  if (hasTable(db, 'decks')) {
    for (const [id, name] of rows(db, 'select id, name from decks')) names.set(String(id), String(name).replaceAll('\x1f', '::'));
  } else {
    const json = JSON.parse(String(rows(db, 'select decks from col')[0][0])) as Record<string, { name: string }>;
    for (const [id, d] of Object.entries(json)) names.set(id, d.name);
  }
  return names;
}

const SPECIAL = new Set(['FrontSide', 'Tags', 'Type', 'Deck', 'Subdeck', 'Card', 'CardFlag']);
/** field names a template shows, in order */
function refs(tmpl: string): string[] {
  const names = [...tmpl.matchAll(/\{\{(?![#^/])([^}]+)\}\}/g)].map((m) => m[1].split(':').pop()!.trim());
  return [...new Set(names.filter((n) => !SPECIAL.has(n)))];
}

function renderTemplate(tmpl: string, f: Record<string, string>): string {
  const sections = tmpl.replace(/\{\{([#^])([^}]+)\}\}([\s\S]*?)\{\{\/\2\}\}/g,
    (_, k: string, name: string, body: string) => (!!f[name.trim()]?.trim() === (k === '#') ? body : ''));
  return sections.replace(/\{\{([^}]+)\}\}/g, (_, ref: string) => f[ref.split(':').pop()!.trim()] ?? '');
}

/** One Anki note → our notes. Known shapes keep their kind; anything else becomes one basic note per card. */
function convertNote(nid: string, m: Model, raw: string[], ords: number[]): Note[] {
  const f = Object.fromEntries(m.fields.map((n, i) => [n, raw[i] ?? '']));
  const text = (name: string) => htmlToText(f[name] ?? '');
  if (m.cloze) {
    const clozeField = m.tmpls[0]?.q.match(/\{\{cloze:([^}]+)\}\}/)?.[1].trim() ?? m.fields[0];
    const extra = refs(m.tmpls[0]?.a ?? '').filter((n) => n !== clozeField).map(text).filter(Boolean).join('\n');
    return [{ id: nid, kind: 'cloze', fields: [text(clozeField), extra] }];
  }
  const shapes = m.tmpls.map((t) => { const q = refs(t.q); return { q, a: refs(t.a).filter((n) => !q.includes(n)) }; });
  const single = shapes.every((s) => s.q.length === 1 && s.a.length === 1);
  if (single && shapes.length === 1) return [{ id: nid, kind: 'basic', fields: [text(shapes[0].q[0]), text(shapes[0].a[0])] }];
  if (single && shapes.length === 2 && shapes[0].q[0] === shapes[1].a[0] && shapes[0].a[0] === shapes[1].q[0]) {
    return [{ id: nid, kind: 'reversed', fields: [text(shapes[0].q[0]), text(shapes[0].a[0])] }];
  }
  return ords.flatMap((ord) => {
    const t = m.tmpls[ord];
    if (!t) return [];
    const back = t.a.replace('{{FrontSide}}', '').replace(/<hr id=["']?answer["']?\s*\/?>/i, '');
    const front = htmlToText(renderTemplate(t.q, f));
    return front ? [{ id: `${nid}.${ord}`, group: nid, kind: 'basic' as const, fields: [front, htmlToText(renderTemplate(back, f))] }] : [];
  });
}

/** Reads every deck that has cards. Pass a sql.js instance (the browser loads one lazily via loadSql). */
export async function parseAnki(bytes: Uint8Array, SQL: SqlJsStatic): Promise<Deck[]> {
  let files: Record<string, Uint8Array>;
  try { files = unzipSync(bytes); } catch { throw new Error('That file is not a valid Anki package.'); }
  // newer exports put a "please update Anki" stub in collection.anki2, so prefer the newest format present
  let col = files['collection.anki21b'];
  if (col) col = (await import('fzstd')).decompress(col);
  else col = files['collection.anki21'] ?? files['collection.anki2'];
  if (!col) throw new Error('No collection found inside that Anki package.');

  const db = new SQL.Database(col);
  try {
    const models = readModels(db);
    const deckNames = readDeckNames(db);
    const cardRows = rows(db, 'select nid, did, ord from cards order by nid, ord');
    const ordsByNote = new Map<string, number[]>();
    const deckOfNote = new Map<string, string>();
    for (const [nid, did, ord] of cardRows) {
      const k = String(nid);
      ordsByNote.set(k, [...(ordsByNote.get(k) ?? []), Number(ord)]);
      if (!deckOfNote.has(k)) deckOfNote.set(k, String(did));
    }
    const byDeck = new Map<string, Note[]>();
    for (const [id, mid, flds] of rows(db, 'select id, mid, flds from notes order by id')) {
      const nid = String(id);
      const m = models.get(String(mid));
      const did = deckOfNote.get(nid);
      if (!m || !did) continue;
      const notes = convertNote(nid, m, String(flds).split('\x1f'), ordsByNote.get(nid) ?? []);
      byDeck.set(did, [...(byDeck.get(did) ?? []), ...notes]);
    }
    const decks = [...byDeck].map(([did, notes]) => ({ id: deckId() + did.slice(-4), name: deckNames.get(did) ?? 'Imported', notes }));
    if (!decks.length) throw new Error('That Anki package has no cards.');
    return decks;
  } finally {
    db.close();
  }
}

/** Loads sql.js and its wasm only when someone imports an Anki file. */
export async function loadSql(): Promise<SqlJsStatic> {
  const [{ default: init }, { default: wasmUrl }] = await Promise.all([
    import('sql.js'),
    import('sql.js/dist/sql-wasm.wasm?url'),
  ]);
  return init({ locateFile: () => wasmUrl });
}

/** Picks a parser by file extension. */
export async function importFile(file: File, reversed: boolean): Promise<Deck[]> {
  const name = file.name.replace(/\.[^.]+$/, '');
  const ext = file.name.split('.').pop()?.toLowerCase();
  if (ext === 'apkg' || ext === 'colpkg') return parseAnki(new Uint8Array(await file.arrayBuffer()), await loadSql());
  const text = await file.text();
  if (ext === 'json') return [parseJson(text, name)];
  return [parseDelimited(text, name, reversed)];
}
