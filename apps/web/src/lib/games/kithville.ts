'use client';
// Kithville (the 2010 farm game, renamed). Game state is private: one blob encrypted with the
// vault key derived from the account master key (never readable by the server). Neighbor
// actions (water their crops, send a gift) are sealed to the recipient and signed by the sender.
import { b64u, decryptBlob, deriveVaultKey, encryptBlob, openSealed, seal, type Sealed } from '@kithwall/crypto';
import { sb, must } from '../supabase';
import { amk, identity, me } from '../keys/session';
import { people } from '../people';
import { notify } from '../friends';
import { createPost } from '../content';

// ---------------------------------------------------------------------------------------
// Rules

export type CropKey = 'straw' | 'soy' | 'pump' | 'squash' | 'corn' | 'roses';
export interface Crop { name: string; cost: number; secs: number; sell: number; xp: number; color: string; level: number }

export const CROPS: Record<CropKey, Crop> = {
  straw: { name: 'Strawberries', cost: 10, secs: 30, sell: 35, xp: 2, color: '#e74c3c', level: 1 },
  soy: { name: 'Soybeans', cost: 15, secs: 60, sell: 50, xp: 3, color: '#9acd32', level: 1 },
  pump: { name: 'Pumpkins', cost: 30, secs: 120, sell: 110, xp: 6, color: '#e67e22', level: 2 },
  squash: { name: 'Squash', cost: 45, secs: 240, sell: 180, xp: 9, color: '#f1c40f', level: 3 },
  corn: { name: 'Corn', cost: 60, secs: 900, sell: 280, xp: 15, color: '#f7dc6f', level: 5 },
  roses: { name: 'Pink Roses', cost: 100, secs: 3600, sell: 520, xp: 30, color: '#f19cbb', level: 7 },
};
export const CROP_KEYS = Object.keys(CROPS) as CropKey[];

export const GIFTS: Record<string, { color: string; coins?: number; animal?: boolean }> = {
  'Bale of Hay': { color: '#e0c060', coins: 25 },
  'Mystery Gift': { color: '#e2a400', coins: 0 },  // random 15–75 coins when opened
  'Pumpkin': { color: '#e67e22', coins: 40 },
  'Lonely Pink Cow': { color: '#f4a6c6', animal: true },
  'Lonely Black Sheep': { color: '#333333', animal: true },
  'Lost Duckling': { color: '#f4d03f', animal: true },
};
export const GIFT_NAMES = Object.keys(GIFTS);

export const ANIMAL_COOLDOWN_MS = 5 * 60_000;
export const ANIMAL_COINS = 15;
export const HELP_BONUS = 0.5;          // watering skips half of a growing crop's time
export const HELP_COINS_IF_NOTHING = 20;
export const DAY_MS = 20 * 3600_000;    // one help + one gift per neighbor per "day" (matches the server)

export const levelOf = (xp: number) => 1 + Math.floor(Math.sqrt(xp / 12));
export const xpForLevel = (lvl: number) => 12 * (lvl - 1) * (lvl - 1);
export const plotCount = (lvl: number) => (lvl >= 8 ? 18 : lvl >= 6 ? 15 : lvl >= 3 ? 12 : 9);

export interface Plot { c: CropKey; t0: number }
export interface Animal { item: string; last: number }
export interface FarmState {
  v: 1;
  coins: number;
  xp: number;
  plots: (Plot | null)[];
  sel: CropKey;
  animals: Animal[];
  helped: Record<string, number>;   // friend id -> last time I watered their crops
  gifted: Record<string, number>;   // friend id -> last time I sent a gift
  log: { t: number; text: string }[];
}

export function newFarm(): FarmState {
  return { v: 1, coins: 200, xp: 0, plots: Array(9).fill(null), sel: 'straw', animals: [], helped: {}, gifted: {}, log: [] };
}

function sanitize(s: Partial<FarmState>): FarmState {
  const base = newFarm();
  const out: FarmState = {
    v: 1,
    coins: Number.isFinite(s.coins) ? Math.max(0, Math.floor(s.coins!)) : base.coins,
    xp: Number.isFinite(s.xp) ? Math.max(0, Math.floor(s.xp!)) : 0,
    plots: Array.isArray(s.plots) ? s.plots.slice(0, 18).map((p) => (p && CROPS[p.c] && Number.isFinite(p.t0) ? { c: p.c, t0: p.t0 } : null)) : base.plots,
    sel: s.sel && CROPS[s.sel] ? s.sel : 'straw',
    animals: Array.isArray(s.animals) ? s.animals.filter((a) => a && typeof a.item === 'string' && GIFTS[a.item]?.animal).slice(0, 12) : [],
    helped: s.helped && typeof s.helped === 'object' ? s.helped : {},
    gifted: s.gifted && typeof s.gifted === 'object' ? s.gifted : {},
    log: Array.isArray(s.log) ? s.log.slice(0, 20) : [],
  };
  const n = plotCount(levelOf(out.xp));
  while (out.plots.length < n) out.plots.push(null);
  return out;
}

export function growth(p: Plot, now = Date.now()) {
  const c = CROPS[p.c];
  const el = (now - p.t0) / 1000;
  return { pct: Math.min(1, Math.max(0, el / c.secs)), left: Math.max(0, Math.ceil(c.secs - el)), ready: el >= c.secs };
}

export function fmtLeft(secs: number) {
  if (secs >= 3600) return `${Math.floor(secs / 3600)}h ${Math.ceil((secs % 3600) / 60)}m`;
  if (secs >= 60) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  return `${secs}s`;
}

/** Pure game moves. Each returns a message for the player (or null if nothing happened). */
export const moves = {
  plant(s: FarmState, i: number, now = Date.now()): string | null {
    if (s.plots[i]) return null;
    const c = CROPS[s.sel];
    if (levelOf(s.xp) < c.level) return `${c.name} unlock at level ${c.level}.`;
    if (s.coins < c.cost) return 'You don\'t have enough coins. Harvest some crops or ask your neighbors for gifts!';
    s.coins -= c.cost; s.plots[i] = { c: s.sel, t0: now }; s.xp += 1;
    return null;
  },
  harvest(s: FarmState, i: number, now = Date.now()): { coins: number; xp: number; crop: string } | null {
    const p = s.plots[i];
    if (!p || !growth(p, now).ready) return null;
    const c = CROPS[p.c];
    s.coins += c.sell; s.xp += c.xp; s.plots[i] = null;
    return { coins: c.sell, xp: c.xp, crop: c.name };
  },
  plow(s: FarmState, i: number) { s.plots[i] = null; },
  collect(s: FarmState, i: number, now = Date.now()): boolean {
    const a = s.animals[i];
    if (!a || now - a.last < ANIMAL_COOLDOWN_MS) return false;
    a.last = now; s.coins += ANIMAL_COINS; s.xp += 1;
    return true;
  },
  /** A neighbor watered our crops: the first growing crop skips half its time (or coins). */
  applyHelp(s: FarmState, now = Date.now()): string {
    const i = s.plots.findIndex((p) => p && !growth(p, now).ready);
    if (i >= 0) {
      const p = s.plots[i]!;
      p.t0 -= CROPS[p.c].secs * 1000 * HELP_BONUS;
      return `watered your ${CROPS[p.c].name}. They grew faster!`;
    }
    s.coins += HELP_COINS_IF_NOTHING;
    return `helped out on your farm (+${HELP_COINS_IF_NOTHING} coins).`;
  },
  applyGift(s: FarmState, item: string, now = Date.now()): string {
    const g = GIFTS[item];
    if (!g) return 'sent you something we couldn\'t open.';
    if (g.animal) {
      if (s.animals.length >= 12) { s.coins += 30; return `sent you a ${item}, but your barn is full (+30 coins).`; }
      s.animals.push({ item, last: now - ANIMAL_COOLDOWN_MS });
      return `sent you a ${item}! It now lives on your farm.`;
    }
    const coins = g.coins || 15 + Math.floor(Math.random() * 61);
    s.coins += coins;
    return `sent you a ${item} (+${coins} coins).`;
  },
};

/** After XP changes: grow the farm when a new level unlocks more plots. */
export function settleLevel(s: FarmState) {
  const n = plotCount(levelOf(s.xp));
  while (s.plots.length < n) s.plots.push(null);
}

// ---------------------------------------------------------------------------------------
// Encrypted storage

const aad = () => `kithville/${me()}`;

export interface Saved { state: FarmState; version: number | null }

export async function loadFarm(): Promise<Saved> {
  const { data, error } = await sb().from('game_state').select('blob, version').eq('user_id', me()).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return { state: newFarm(), version: null };
  const key = deriveVaultKey(amk());
  const plain = decryptBlob(key, data.blob as string, aad());
  return { state: sanitize(JSON.parse(new TextDecoder().decode(plain)) as Partial<FarmState>), version: data.version as number };
}

export class StaleFarmError extends Error { constructor() { super('Your farm changed on another device or tab.'); } }

/** Save with optimistic concurrency. Returns the new version. */
export async function saveFarm(state: FarmState, version: number | null): Promise<number> {
  const key = deriveVaultKey(amk());
  const blob = encryptBlob(key, new TextEncoder().encode(JSON.stringify(state)), aad());
  if (version === null) {
    const r = await sb().from('game_state').insert({ user_id: me(), blob, version: 1 });
    if (r.error) { if (r.error.code === '23505') throw new StaleFarmError(); throw new Error(r.error.message); }
    return 1;
  }
  const r = await sb().from('game_state').update({ blob, version: version + 1 }).eq('user_id', me()).eq('version', version).select('version');
  if (r.error) { if (r.error.code === '40001') throw new StaleFarmError(); throw new Error(r.error.message); }
  if (!r.data?.length) throw new StaleFarmError();
  return version + 1;
}

// ---------------------------------------------------------------------------------------
// Neighbor actions

export interface ActionRow { id: string; from_id: string; to_id: string; kind: 'help' | 'gift'; sealed: Sealed; created_at: string; claimed_at: string | null }
export interface ActionPayload { kind: 'help' | 'gift'; item?: string; note?: string }

const actionCtx = (r: { id: string; kind: string; to_id: string }) => `kithville/${r.kind}/${r.id}/${r.to_id}`;

export async function sendAction(to: string, kind: 'help' | 'gift', item?: string): Promise<void> {
  await people.ensure([to]);
  const r = people.get(to);
  if (!r) throw new Error('Unknown neighbor');
  const id = crypto.randomUUID();
  const payload: ActionPayload = { kind, ...(item ? { item } : {}) };
  const sealed = seal({ recipientKxPub: b64u.decode(r.kx_pub), senderSignPriv: identity().signPriv, context: actionCtx({ id, kind, to_id: to }), plaintext: new TextEncoder().encode(JSON.stringify(payload)) });
  const res = await sb().from('game_actions').insert({ id, from_id: me(), to_id: to, kind, sealed });
  if (res.error) {
    if (res.error.code === 'P0429' || /already sent|rate limit/i.test(res.error.message)) throw new Error('You already did that for this neighbor today.');
    throw new Error(res.error.message);
  }
  const text = kind === 'gift' ? `sent you a ${item} in Kithville.` : 'watered your crops in Kithville.';
  await notify(to, 'game', undefined, undefined, text).catch(() => undefined);
}

export async function incomingActions(): Promise<ActionRow[]> {
  const rows = must(await sb().from('game_actions').select('*').eq('to_id', me()).is('claimed_at', null)
    .order('created_at', { ascending: false }).limit(50)) as ActionRow[];
  await people.ensure(rows.map((r) => r.from_id));
  return rows;
}

/** Verify (signature first) and open an action sealed to me. */
export function openAction(r: ActionRow): ActionPayload | null {
  const sender = people.get(r.from_id);
  if (!sender) return null;
  try {
    const id = identity();
    const bytes = openSealed({ sealed: r.sealed, recipientKxPriv: id.kxPriv, recipientKxPub: id.kxPub, senderSignPub: b64u.decode(sender.sign_pub), context: actionCtx(r) });
    const p = JSON.parse(new TextDecoder().decode(bytes)) as ActionPayload;
    if (p.kind !== r.kind) return null;
    return p;
  } catch { return null; }
}

/** Mark an action claimed (server allows it once). Returns false if it was already claimed. */
export async function claimAction(id: string): Promise<boolean> {
  const r = await sb().from('game_actions').update({ claimed_at: new Date().toISOString() }).eq('id', id).is('claimed_at', null).select('id');
  if (r.error) return false;
  return (r.data?.length ?? 0) > 0;
}

export async function ignoreAction(id: string) {
  await sb().from('game_actions').delete().eq('id', id);
}

/** Opt-in story on my Wall (friends only, encrypted like any post). */
export async function publishStory(text: string, reward?: string) {
  await createPost({ kind: 'game', payload: { game: { app: 'kithville', text, ...(reward ? { reward } : {}) } } });
}
