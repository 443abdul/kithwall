'use client';
// Search on your phone: the index (docs/v2/03-safety.md §14). The server never sees a query or any part of
// this: content is found by looking through what THIS device has already decrypted.
//
// What is kept: one record per message, post or comment this device decrypted: its text, who wrote it, when,
// where it belongs (the chat or post) and when it disappears. Nothing else (no photos, no reactions).
//
// At rest (IndexedDB "kw-search", store "docs"): every record is its own XChaCha20-Poly1305 blob under a key
// derived from the account master key (HKDF label "kithwall/v1/search-index", @kithwall/crypto
// deriveSearchKey), padded to 64-byte steps, bound to the account. A record's NAME is a keyed one-way image
// of the item's id (searchRecordName), so the device's storage holds no message, post or chat id in the
// clear, yet the same item always lands on the same record: edits overwrite, unsends delete, and two open
// tabs can't disagree. Without the unlocked account the database is a list of opaque names and ciphertext;
// what it does show is how many records there are and roughly how long each is.
//
// In memory (only while the app is unlocked): the decrypted records, loaded once in small slices, searched by
// a plain scan over folded text (./text.ts). Locking the app reloads the page, which empties it.
//
// Leaving: a record goes when its message is unsent, edited (replaced) or expires, when its post or comment
// is deleted, when its chat is left; the whole database is deleted on sign-out, by the panic wipe and the
// duress wipe (lib/safety/wipe.ts), and when "Search on this phone" is switched off.
import { decryptBlob, deriveSearchKey, encryptBlob, searchRecordName } from '@kithwall/crypto';
import { matches, prepare, queryWords, type QueryWord } from './text';

export type DocKind = 'message' | 'post' | 'comment';

export interface SearchDoc {
  /** "m:<message id>", "p:<post id>" or "c:<comment id>". */
  id: string;
  kind: DocKind;
  /** The chat (messages) or the post (posts, and the post a comment is under). */
  ctx: string;
  author: string;
  /** created_at of the item (ISO). */
  at: string;
  /** When it disappears (ISO), for disappearing messages and posts. */
  exp?: string;
  /** Posts: 'note' opens in Notes. */
  sub?: string;
  text: string;
}

export interface SearchHit { doc: SearchDoc; words: QueryWord[] }
export interface SearchOptions {
  kinds?: readonly DocKind[];
  /** Only this chat or post. */
  ctx?: string;
  /** Left out of the results (hidden chats that aren't revealed). */
  exclude?: (doc: SearchDoc) => boolean;
  limit?: number;
}

const DB = 'kw-search';
const STORE = 'docs';
/** Longest text kept per item (the rest of a very long note isn't searchable). */
export const MAX_TEXT = 4000;
/** Most records kept; beyond it the oldest items leave first. */
export const MAX_DOCS = 30_000;
const FLUSH_MS = 1200;
const SLICE = 120;

interface Entry { doc: SearchDoc; folded: string; name: string }

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const done = (t: IDBTransaction) => new Promise<void>((resolve, reject) => {
  t.oncomplete = () => resolve();
  t.onerror = t.onabort = () => reject(t.error);
});

const pauseBriefly = () => new Promise<void>((r) => setTimeout(r, 0));

/** Pad to the next 64 bytes with spaces (JSON ignores them), so a record's size says less about its text. */
function pad(json: string): Uint8Array {
  const bytes = new TextEncoder().encode(json);
  const out = new Uint8Array(Math.ceil((bytes.length + 1) / 64) * 64).fill(0x20);
  out.set(bytes);
  return out;
}

export class SearchIndex {
  private key: Uint8Array | null = null;
  private userId: string | null = null;
  private mem = new Map<string, Entry>();
  private loaded = false;
  private loading: Promise<void> | null = null;
  private puts = new Map<string, SearchDoc>();
  private dels = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> = Promise.resolve();
  private sweeper: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<() => void>();
  private version = 0;
  /** Bumped by destroy(): work started before it must not write anything afterwards. */
  private generation = 0;

  private aad() { return `search-index/${this.userId}`; }
  private emit() { this.version++; this.listeners.forEach((l) => l()); }
  subscribe = (l: () => void) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  getVersion = () => this.version;

  /** The account was unlocked: from now on content it decrypts may be noted. Nothing is read yet. */
  open(userId: string, amk: Uint8Array) {
    if (this.userId === userId && this.key) return;
    this.close();
    this.userId = userId;
    this.key = deriveSearchKey(amk);
    this.emit();
  }

  get isOpen() { return !!this.key; }
  get isLoaded() { return this.loaded; }
  get size() { return this.mem.size; }

  /** Forget the key and everything decrypted (the app locked). The encrypted records stay on the device. */
  close() {
    if (this.timer) clearTimeout(this.timer);
    if (this.sweeper) clearInterval(this.sweeper);
    this.timer = null; this.sweeper = null;
    this.key?.fill(0);
    this.key = null; this.userId = null;
    this.mem.clear(); this.puts.clear(); this.dels.clear();
    this.loaded = false; this.loading = null;
    this.generation++;
    this.emit();
  }

  /** Delete the index from this device (sign-out, panic wipe, "Delete the search index", switching search off). */
  async destroy(): Promise<void> {
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.mem.clear(); this.puts.clear(); this.dels.clear();
    this.loaded = this.isOpen; // nothing left to load
    this.loading = null;
    await this.flushing.catch(() => undefined);
    await deleteSearchDatabase();
    this.emit();
  }

  /** Add or replace an item (as soon as content is decrypted). Cheap: the work happens a moment later. */
  note(doc: SearchDoc) {
    if (!this.key) return;
    // Nothing to search for (a photo with no words, or a message edited down to nothing): no record.
    if (!doc.text.trim()) { this.forget([doc.id]); return; }
    this.dels.delete(doc.id);
    this.puts.set(doc.id, doc.text.length > MAX_TEXT ? { ...doc, text: doc.text.slice(0, MAX_TEXT) } : doc);
    this.schedule();
  }

  /** Remove items (unsent, deleted, expired). */
  forget(ids: readonly string[]) {
    if (!this.key || !ids.length) return;
    for (const id of ids) { this.puts.delete(id); this.dels.add(id); }
    this.schedule();
  }

  /** Remove every item that matches (a chat that was left, a post's comments, someone's posts after a block). */
  async forgetWhere(pred: (doc: SearchDoc) => boolean): Promise<void> {
    if (!this.key) return;
    await this.ready();
    const ids: string[] = [];
    for (const e of this.mem.values()) if (pred(e.doc)) ids.push(e.doc.id);
    for (const [id, doc] of this.puts) if (pred(doc)) ids.push(id);
    this.forget(ids);
  }

  /** Items of one chat or post that are in the index (for reconciling with what the server still has). */
  async idsWhere(pred: (doc: SearchDoc) => boolean): Promise<string[]> {
    if (!this.key) return [];
    await this.ready();
    const ids: string[] = [];
    for (const e of this.mem.values()) if (pred(e.doc)) ids.push(e.doc.id);
    return ids;
  }

  private schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, FLUSH_MS);
  }

  /** Write what is waiting (also called before a search, so fresh content is found). */
  flush(): Promise<void> {
    this.flushing = this.flushing.catch(() => undefined).then(() => this.flushNow());
    return this.flushing;
  }

  private async flushNow(): Promise<void> {
    const key = this.key;
    const gen = this.generation;
    if (!key || (!this.puts.size && !this.dels.size)) return;
    await this.ready();
    if (gen !== this.generation || !this.key) return;
    const puts = [...this.puts.values()];
    const dels = [...this.dels];
    this.puts.clear(); this.dels.clear();
    const writes: { name: string; blob: string | null }[] = [];
    let changed = false;
    for (const id of dels) {
      const e = this.mem.get(id);
      this.mem.delete(id);
      changed ||= !!e;
      // Deleted by name even when this tab never loaded it (another tab may have written it).
      writes.push({ name: e?.name ?? searchRecordName(key, id), blob: null });
    }
    let n = 0;
    for (const doc of puts) {
      const old = this.mem.get(doc.id);
      if (old && old.doc.text === doc.text && old.doc.exp === doc.exp && old.doc.ctx === doc.ctx) continue;
      const name = old?.name ?? searchRecordName(key, doc.id);
      this.mem.set(doc.id, { doc, folded: prepare(doc.text), name });
      writes.push({ name, blob: encryptBlob(key, pad(JSON.stringify(doc)), this.aad()) });
      changed = true;
      if (++n % SLICE === 0) await pauseBriefly();
    }
    // Over the limit: the oldest items leave.
    if (this.mem.size > MAX_DOCS) {
      const oldest = [...this.mem.values()].sort((a, b) => (a.doc.at < b.doc.at ? -1 : 1)).slice(0, this.mem.size - MAX_DOCS);
      for (const e of oldest) { this.mem.delete(e.doc.id); writes.push({ name: e.name, blob: null }); }
    }
    if (gen !== this.generation) return;
    if (writes.length) {
      try {
        const db = await openDb();
        try {
          const t = db.transaction(STORE, 'readwrite');
          const s = t.objectStore(STORE);
          for (const w of writes) { if (w.blob === null) s.delete(w.name); else s.put(w.blob, w.name); }
          await done(t);
        } finally { db.close(); }
      } catch (e) {
        // Private browsing or a full disk: search still works for this visit, from memory.
        console.warn('search index', (e as Error)?.message);
      }
    }
    if (changed) this.emit();
  }

  /** Load and decrypt the stored records (once per unlock), in slices so the page stays responsive. */
  ready(): Promise<void> {
    if (this.loaded || !this.key) return Promise.resolve();
    this.loading ??= this.load().finally(() => { this.loading = null; });
    return this.loading;
  }

  private async load(): Promise<void> {
    const key = this.key!;
    const gen = this.generation;
    const aad = this.aad();
    const stale: IDBValidKey[] = [];
    try {
      const db = await openDb();
      try {
        const t = db.transaction(STORE, 'readonly');
        const s = t.objectStore(STORE);
        const [names, blobs] = await Promise.all([
          new Promise<IDBValidKey[]>((res, rej) => { const r = s.getAllKeys(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }),
          new Promise<unknown[]>((res, rej) => { const r = s.getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }),
        ]);
        const now = Date.now();
        for (let i = 0; i < names.length; i++) {
          if (i && i % SLICE === 0) { await pauseBriefly(); if (gen !== this.generation) return; }
          try {
            const doc = JSON.parse(new TextDecoder().decode(decryptBlob(key, blobs[i] as string, aad))) as SearchDoc;
            if (typeof doc?.id !== 'string' || typeof doc.text !== 'string' || (doc.exp && Date.parse(doc.exp) <= now)) { stale.push(names[i]!); continue; }
            // What was noted since the app opened is newer than the stored copy.
            if (!this.mem.has(doc.id)) this.mem.set(doc.id, { doc, folded: prepare(doc.text), name: String(names[i]) });
          } catch {
            // Another account's record, or damage: it can't be read, so it goes.
            stale.push(names[i]!);
          }
        }
        if (stale.length && gen === this.generation) {
          const w = db.transaction(STORE, 'readwrite');
          for (const n of stale) w.objectStore(STORE).delete(n);
          await done(w).catch(() => undefined);
        }
      } finally { db.close(); }
    } catch (e) {
      console.warn('search index', (e as Error)?.message);
    }
    if (gen !== this.generation) return;
    this.loaded = true;
    // Disappearing messages and posts leave the index when their time is up, also while nobody searches.
    this.sweeper ??= setInterval(() => this.sweep(), 60_000);
    this.emit();
  }

  /** Drop what has expired. */
  sweep(now = Date.now()) {
    const gone: string[] = [];
    for (const e of this.mem.values()) if (e.doc.exp && Date.parse(e.doc.exp) <= now) gone.push(e.doc.id);
    if (gone.length) this.forget(gone);
  }

  /** Items containing every word of the query, newest first. */
  async search(query: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
    const words = queryWords(query);
    if (!this.key || !words.length) return [];
    await this.flush();
    await this.ready();
    const now = Date.now();
    const out: SearchDoc[] = [];
    for (const e of this.mem.values()) {
      const d = e.doc;
      if (opts.kinds && !opts.kinds.includes(d.kind)) continue;
      if (opts.ctx && d.ctx !== opts.ctx) continue;
      if (!matches(e.folded, words)) continue;
      if (d.exp && Date.parse(d.exp) <= now) continue;
      if (opts.exclude?.(d)) continue;
      out.push(d);
    }
    out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    return out.slice(0, opts.limit ?? 50).map((doc) => ({ doc, words }));
  }
}

/** Delete the search database (also used by the panic wipe, which runs without an unlocked account). */
export function deleteSearchDatabase(): Promise<void> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(DB);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    } catch { resolve(); }
  });
}
