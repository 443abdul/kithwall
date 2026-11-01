'use client';
// Key transparency on the device (docs/v2/09-key-transparency.md). Pure checks: ./core.ts.
//
//   refreshHead()            fetch the log's head and accept it only if it extends the head this device
//                            verified before (stored per device in localStorage, "kw.kt.head"); a fork or a
//                            shrink raises a persistent alarm ("kw.kt.alarm") instead
//   checkKeys(people)        are these people's current identity keys in the log? Verifies openings and audit
//                            paths against a verified head; remembers the result per key in the encrypted
//                            vault (namespace "keylog") so each key is checked once per account
//   queueKeyCheck(people)    the same in the background, batched (first sight, key changes)
//   keyLogRefusesNow(...)    sealGate's rule: no new keys to keys the log can't vouch for
//   useKeyLog / useKeyLogAlarm / checkWitness / clearKeyLogAlarm   for the screens
//
// Results feed the existing safety-number warnings (components/verify/KeyChangeBanner.tsx), the verify
// screen ("Key log checked") and, for a forked log, the account notices on every screen.
import { useEffect, useSyncExternalStore } from 'react';
import { sb } from '../supabase';
import { getSession, useSession } from '../keys/session';
import { vaultGet, vaultUpdate } from '../settings';
import {
  cleanKeyLog, compareHeads, headsConsistent, KT_MAX_BATCH, logRefuses, markFor, nextMark, parseAlarm, parseHead,
  parseInclusionResult, sameHead, validKeys, verifyOpening,
  type KeyLogMap, type KeyLogMark, type KtAlarm, type KtHead, type KtVerdict, type PublishedKeys,
} from './core';
import { KT_WITNESS } from './witness';

const HEAD_KEY = 'kw.kt.head';
const ALARM_KEY = 'kw.kt.alarm';
const NS = 'keylog';
const TIMEOUT_MS = 8000;

let version = 0;
const listeners = new Set<() => void>();
const emit = () => { version++; listeners.forEach((l) => l()); };
function subscribe(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

// ---------------------------------------------------------------------------------------------
// The verified head and the alarm (device-local: they must survive a server that rolls back the vault)

export function storedHead(): KtHead | null {
  try { return parseHead(JSON.parse(localStorage.getItem(HEAD_KEY) ?? 'null')); } catch { return null; }
}
function storeHead(h: KtHead) {
  try { localStorage.setItem(HEAD_KEY, JSON.stringify(h)); } catch { /* storage blocked: nothing to remember */ }
  emit();
}
export function keyLogAlarm(): KtAlarm | null {
  try { return parseAlarm(JSON.parse(localStorage.getItem(ALARM_KEY) ?? 'null')); } catch { return null; }
}
function raise(alarm: KtAlarm) {
  console.error('Kithwall: the public key log is not consistent with what this device saw before', alarm);
  try { localStorage.setItem(ALARM_KEY, JSON.stringify(alarm)); } catch { /* ignore */ }
  emit();
}
/** The person read the warning and starts over with the log as it is now (forgets the stored head). */
export function clearKeyLogAlarm() {
  try { localStorage.removeItem(ALARM_KEY); localStorage.removeItem(HEAD_KEY); } catch { /* ignore */ }
  emit();
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => { if (e.key === HEAD_KEY || e.key === ALARM_KEY) emit(); });
}

type Fetched = { ok: true; status: number; body: unknown } | { ok: false };

async function getJson(url: string, init?: RequestInit): Promise<Fetched> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { cache: 'no-store', ...init, signal: ctl.signal });
    const body: unknown = await res.json().catch(() => null);
    return { ok: true, status: res.status, body };
  } catch { return { ok: false }; } finally { clearTimeout(timer); }
}

export type HeadResult = { ok: true; head: KtHead } | { ok: false; reason: 'alarm' | 'unavailable' };

/**
 * Move this device's verified head to `fresh` if (and only if) the server proves it extends the stored one.
 * `via` marks heads that came from the public witness rather than from the server.
 */
async function advanceTo(fresh: KtHead, via?: 'witness'): Promise<HeadResult> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (keyLogAlarm()) return { ok: false, reason: 'alarm' };
    const stored = storedHead();
    const step = compareHeads(stored, fresh);
    if (step === 'first') {
      if (fresh.size === 0) return { ok: true, head: fresh };
      storeHead(fresh);
      return { ok: true, head: fresh };
    }
    const seen = stored!;
    if (step === 'same') return { ok: true, head: seen };
    const alarm = (kind: KtAlarm['kind']): HeadResult => {
      raise({ kind, seen, got: fresh, at: new Date().toISOString(), ...(via ? { via } : {}) });
      return { ok: false, reason: 'alarm' };
    };
    if (step === 'forked') return alarm('forked');
    const [older, newer] = step === 'grow' ? [seen, fresh] : [fresh, seen];
    const r = await getJson(`/api/kt/consistency?from=${older.size}&to=${newer.size}`);
    if (!r.ok || r.status >= 500 || r.status === 429) return { ok: false, reason: 'unavailable' };
    if (r.status === 400) {
      // The server says one of the two sizes doesn't exist. If it is the size this device already saw
      // (or the witness saw), the log shrank.
      return step === 'older' || via ? alarm('shrunk') : { ok: false, reason: 'unavailable' };
    }
    const proof = r.status === 200 && r.body && typeof r.body === 'object' ? (r.body as { proof?: unknown }).proof : undefined;
    if (!headsConsistent(older, newer, proof)) return alarm('forked');
    if (step === 'older') return { ok: true, head: seen };
    // Compare-and-set: another tab may have moved the head meanwhile; then check again from there.
    const now = storedHead();
    if (now && !sameHead(now, seen)) continue;
    storeHead(fresh);
    return { ok: true, head: fresh };
  }
  return { ok: false, reason: 'unavailable' };
}

let headInflight: Promise<HeadResult> | null = null;
let headAt = 0;
let lastHead: HeadResult | null = null;

/** Fetch the latest head and verify it against this device's (deduplicated; cached for 20 s). */
export function refreshHead(force = false): Promise<HeadResult> {
  if (keyLogAlarm()) return Promise.resolve({ ok: false, reason: 'alarm' });
  if (!force && lastHead?.ok && Date.now() - headAt < 20_000) return Promise.resolve(lastHead);
  headInflight ??= (async () => {
    const r = await getJson('/api/kt/head');
    const fresh = r.ok && r.status === 200 ? parseHead(r.body) : null;
    const out: HeadResult = fresh ? await advanceTo(fresh) : { ok: false, reason: 'unavailable' };
    lastHead = out;
    headAt = Date.now();
    return out;
  })().finally(() => { headInflight = null; });
  return headInflight;
}

export type WitnessResult =
  | { ok: true; witnessed: KtHead; witnessedAt: string | null }
  | { ok: false; reason: 'none' | 'unavailable' | 'alarm' };

/**
 * Compare with the latest head the public witness committed to GitHub (only when the person asks: this is a
 * request to raw.githubusercontent.com). The witnessed head must be consistent with this device's head.
 */
export async function checkWitness(): Promise<WitnessResult> {
  if (!KT_WITNESS) return { ok: false, reason: 'none' };
  const mine = await refreshHead(true);
  if (!mine.ok && mine.reason === 'alarm') return { ok: false, reason: 'alarm' };
  const r = await getJson(KT_WITNESS.headUrl, { credentials: 'omit', referrerPolicy: 'no-referrer' });
  const w = r.ok && r.status === 200 ? parseHead(r.body) : null;
  if (!w || w.size === 0) return { ok: false, reason: 'unavailable' };
  const res = await advanceTo(w, 'witness');
  if (!res.ok) return { ok: false, reason: res.reason };
  const at = r.ok && r.body && typeof (r.body as { witnessedAt?: unknown }).witnessedAt === 'string' ? (r.body as { witnessedAt: string }).witnessedAt : null;
  return { ok: true, witnessed: w, witnessedAt: at };
}

// ---------------------------------------------------------------------------------------------
// What this account knows about people's keys (vault "keylog")

let marks: KeyLogMap | null = null;
let marksFor: string | null = null;
let marksLoading: Promise<KeyLogMap> | null = null;

function loadMarks(): Promise<KeyLogMap> {
  const s = getSession();
  if (s.status !== 'ready' || !s.userId) return Promise.resolve({});
  if (marksFor === s.userId && marks) return Promise.resolve(marks);
  const uid = s.userId;
  marksLoading ??= vaultGet<KeyLogMap>(NS)
    .then((v) => { const m = cleanKeyLog(v); if (getSession().userId === uid) { marks = m; marksFor = uid; emit(); } return m; })
    .finally(() => { marksLoading = null; });
  return marksLoading;
}

function currentMarks(): KeyLogMap | null {
  return marksFor && marksFor === getSession().userId ? marks : null;
}

async function saveMarks(updates: { id: string; s: string; x: string; verdict: KtVerdict; i?: number; n?: number }[]): Promise<void> {
  const uid = getSession().userId;
  const at = new Date().toISOString();
  const next = cleanKeyLog(await vaultUpdate<KeyLogMap>(NS, (prevRaw) => {
    const prev = cleanKeyLog(prevRaw);
    for (const u of updates) {
      const mark = nextMark(markFor(prev, u.id, u.s, u.x), u.verdict);
      if (!mark) continue;
      prev[u.id] = { s: u.s, x: u.x, r: mark, at, ...(u.i !== undefined ? { i: u.i } : {}), ...(u.n !== undefined ? { n: u.n } : {}) };
    }
    return prev;
  }));
  if (getSession().userId === uid) { marks = next; marksFor = uid; emit(); }
}

/** The person accepted keys the log couldn't vouch for: sharing resumes, the warning goes away. */
export async function acceptKeyLogFailure(id: string, s: string, x: string): Promise<void> {
  const uid = getSession().userId;
  const next = cleanKeyLog(await vaultUpdate<KeyLogMap>(NS, (prevRaw) => ({ ...cleanKeyLog(prevRaw), [id]: { s, x, r: 'accepted', at: new Date().toISOString() } })));
  if (getSession().userId === uid) { marks = next; marksFor = uid; emit(); }
}

// Results of this session that aren't remembered in the vault (couldn't check, hidden, alarm).
const live = new Map<string, { key: string; verdict: KtVerdict | 'checking'; at: number; i?: number; n?: number }>();
const inflight = new Map<string, Promise<KtVerdict>>();
const keyOf = (k: PublishedKeys) => `${k.userId}:${k.signPub}:${k.kxPub}`;

interface Checked { verdict: KtVerdict; i?: number; n?: number }

async function lookup(batch: PublishedKeys[], head: KtHead): Promise<Map<string, Checked> | null> {
  const token = (await sb().auth.getSession()).data.session?.access_token;
  if (!token) return null;
  const r = await getJson('/api/kt/inclusion', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ size: head.size, keys: batch.map((k) => ({ user: k.userId, signPub: k.signPub, kxPub: k.kxPub })) }),
  });
  if (!r.ok || r.status !== 200 || !r.body || typeof r.body !== 'object') return null;
  const reply = r.body as { head?: unknown; results?: unknown };
  const out = new Map<string, Checked>();
  const replyHead = parseHead(reply.head);
  const results = Array.isArray(reply.results) ? reply.results : [];
  for (const k of batch) {
    const raw = results.find((x) => x && typeof x === 'object' && (x as { user?: unknown }).user === k.userId);
    const res = raw ? parseInclusionResult(raw) : null;
    // The proof must be for the head this device verified; anything else proves nothing.
    if (!res || !replyHead || !sameHead(replyHead, head)) { out.set(k.userId, { verdict: 'bad' }); continue; }
    if (res.status === 'ok') {
      out.set(k.userId, verifyOpening(head, k, res) ? { verdict: 'ok', i: res.index, n: head.size } : { verdict: 'bad' });
    } else if (res.status === 'later') {
      out.set(k.userId, { verdict: 'unavailable' });   // retried by the caller with a newer head
    } else {
      out.set(k.userId, { verdict: res.status });
    }
  }
  return out;
}

async function checkBatch(batch: PublishedKeys[]): Promise<Map<string, Checked>> {
  const out = new Map<string, Checked>();
  const fill = (v: KtVerdict) => { for (const k of batch) out.set(k.userId, { verdict: v }); return out; };
  let head = await refreshHead();
  if (!head.ok) return fill(head.reason);
  const res = await lookup(batch, head.head);
  if (!res) return fill('unavailable');
  // Keys logged after the head we hold: verify a newer head first, then ask again once.
  const later = batch.filter((k) => res.get(k.userId)?.verdict === 'unavailable');
  if (later.length) {
    head = await refreshHead(true);
    if (head.ok) {
      const again = await lookup(later, head.head);
      if (again) for (const [id, v] of again) res.set(id, v);
    }
  }
  for (const [id, v] of res) out.set(id, v);
  return out;
}

/**
 * Check these people's current keys against the log (deduplicated, at most 50 per request). Definitive
 * results are remembered in the vault; `force` re-checks keys already marked.
 */
export async function checkKeys(people: PublishedKeys[], opts: { force?: boolean } = {}): Promise<Map<string, KtVerdict>> {
  const s = getSession();
  const out = new Map<string, KtVerdict>();
  if (s.status !== 'ready' || !s.userId) return out;
  const known = await loadMarks().catch(() => null);
  const todo: PublishedKeys[] = [];
  const waits: Promise<void>[] = [];
  for (const p of people) {
    if (!validKeys(p)) continue;
    const mark = markFor(known, p.userId, p.signPub, p.kxPub);
    if (!opts.force && mark && mark !== 'accepted') { out.set(p.userId, mark === 'ok' ? 'ok' : mark); continue; }
    const pending = inflight.get(keyOf(p));
    if (pending) { waits.push(pending.then((v) => { out.set(p.userId, v); })); continue; }
    if (!todo.some((t) => t.userId === p.userId)) todo.push(p);
  }
  for (let i = 0; i < todo.length; i += KT_MAX_BATCH) {
    const batch = todo.slice(i, i + KT_MAX_BATCH);
    for (const k of batch) live.set(k.userId, { key: keyOf(k), verdict: 'checking', at: Date.now() });
    emit();
    const run = checkBatch(batch).catch(() => new Map<string, Checked>());
    for (const k of batch) {
      const p = run.then((m) => m.get(k.userId)?.verdict ?? 'unavailable');
      inflight.set(keyOf(k), p);
      void p.finally(() => inflight.delete(keyOf(k)));
    }
    waits.push(run.then(async (m) => {
      const updates: Parameters<typeof saveMarks>[0] = [];
      for (const k of batch) {
        const c = m.get(k.userId) ?? { verdict: 'unavailable' as const };
        out.set(k.userId, c.verdict);
        live.set(k.userId, { key: keyOf(k), verdict: c.verdict, at: Date.now(), i: c.i, n: c.n });
        if (nextMark(null, c.verdict)) updates.push({ id: k.userId, s: k.signPub, x: k.kxPub, verdict: c.verdict, i: c.i, n: c.n });
      }
      emit();
      if (updates.length) await saveMarks(updates).catch((e) => console.warn('key log marks', e));
    }));
  }
  await Promise.all(waits);
  return out;
}

const queue = new Map<string, PublishedKeys>();
let timer: ReturnType<typeof setTimeout> | null = null;
/** Soft failures are retried at most every 10 minutes per key. */
const tried = new Map<string, number>();

/** Might this key be unchecked on this account? Cheap (no I/O); the marks are consulted again at flush. */
function mayNeedCheck(p: PublishedKeys): boolean {
  if (markFor(currentMarks(), p.userId, p.signPub, p.kxPub)) return false;
  const t = tried.get(keyOf(p));
  return !t || Date.now() - t > 10 * 60_000;
}

/** Check people's keys in the background (first sight, key changes), batched. Never throws. */
export function queueKeyCheck(people: PublishedKeys[]) {
  const me = getSession().userId;
  if (!me) return;
  for (const p of people) if (p.userId !== me && validKeys(p) && mayNeedCheck(p)) queue.set(p.userId, p);
  if (!queue.size || timer) return;
  timer = setTimeout(() => {
    timer = null;
    const batch = [...queue.values()];
    queue.clear();
    void loadMarks().then((m) => {
      const todo = batch.filter((p) => !markFor(m, p.userId, p.signPub, p.kxPub));
      for (const p of todo) tried.set(keyOf(p), Date.now());
      return todo.length ? checkKeys(todo) : undefined;
    }).catch(() => undefined);
  }, 400);
}

/**
 * Before sealing new keys to these recipients: check the ones never checked (bounded wait), then say which
 * to hold back. Never throws; when the log can't be reached, nothing is held back on its account.
 */
export async function keyLogGate(recipients: PublishedKeys[], waitMs = 6000): Promise<Set<string>> {
  const refused = new Set<string>();
  const me = getSession().userId;
  const others = recipients.filter((r) => r.userId !== me && validKeys(r));
  if (!others.length) return refused;
  const known = await loadMarks().catch(() => null);
  if (!known) return refused;
  // Keys that couldn't be checked a moment ago aren't retried on every delivery (at most every 10 minutes).
  const unchecked = others.filter((r) => !markFor(known, r.userId, r.signPub, r.kxPub) && mayNeedCheck(r));
  for (const r of unchecked) tried.set(keyOf(r), Date.now());
  if (unchecked.length) {
    await Promise.race([checkKeys(unchecked).catch(() => undefined), new Promise((r) => setTimeout(r, waitMs))]);
  }
  const alarm = !!keyLogAlarm();
  for (const r of others) if (logRefuses(markFor(currentMarks(), r.userId, r.signPub, r.kxPub), alarm)) refused.add(r.userId);
  return refused;
}

// ---------------------------------------------------------------------------------------------
// Hooks

export type KeyLogState = 'idle' | 'checking' | KtVerdict | 'accepted';
export interface KeyLogView { state: KeyLogState; index?: number; size?: number }

function view(userId: string, s: string, x: string): KeyLogView {
  const l = live.get(userId);
  const fresh = l && l.key === `${userId}:${s}:${x}` ? l : null;
  if (fresh?.verdict === 'checking') return { state: 'checking' };
  if (keyLogAlarm()) return { state: 'alarm' };
  const e = currentMarks()?.[userId];
  if (fresh && fresh.verdict !== 'ok' && fresh.verdict !== 'missing' && fresh.verdict !== 'bad') return { state: fresh.verdict };
  if (e && e.s === s && e.x === x) return { state: e.r, index: e.i, size: e.n };
  if (fresh) return { state: fresh.verdict, index: fresh.i, size: fresh.n };
  return { state: 'idle' };
}

/**
 * The key-log state of this person's CURRENT keys (from the server, e.g. useIdentityKey().data). Checks them
 * when this account never did; `force` checks again on every mount (the verify screen).
 */
export function useKeyLog(userId: string | null | undefined, keys: { sign_pub: string; kx_pub: string } | null | undefined, opts: { force?: boolean } = {}): KeyLogView {
  const { status, userId: me } = useSession();
  useSyncExternalStore(subscribe, () => version, () => 0);
  const s = keys?.sign_pub ?? '';
  const x = keys?.kx_pub ?? '';
  const force = !!opts.force;
  useEffect(() => {
    if (status !== 'ready' || !userId || !s || !x) return;
    const p = { userId, signPub: s, kxPub: x };
    if (force) void checkKeys([p], { force: true }).catch(() => undefined);
    else if (userId !== me) void loadMarks().then(() => queueKeyCheck([p])).catch(() => undefined);
  }, [status, userId, me, s, x, force]);
  if (status !== 'ready' || !userId || !s || !x) return { state: 'idle' };
  return view(userId, s, x);
}

let sessionHeadChecked = false;
/** The forked/shrunk-log alarm (device-wide). Also verifies the log's head once per session. */
export function useKeyLogAlarm(): KtAlarm | null {
  const { status } = useSession();
  useSyncExternalStore(subscribe, () => version, () => 0);
  useEffect(() => {
    if (status === 'ready' && !sessionHeadChecked) { sessionHeadChecked = true; void refreshHead().catch(() => undefined); }
  }, [status]);
  return typeof window === 'undefined' ? null : keyLogAlarm();
}

/** This device's verified head (re-renders when it moves). */
export function useStoredHead(): KtHead | null {
  useSyncExternalStore(subscribe, () => version, () => 0);
  return typeof window === 'undefined' ? null : storedHead();
}

export type { KeyLogMark };
