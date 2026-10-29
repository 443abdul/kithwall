// Pure helpers for per-field profile visibility (lib/social/visibility.ts): splitting a profile by tier and
// sealing / opening the close-friends part. No session or network imports (lib/people uses openExtra).
import { decryptBlob, encryptBlob } from '@kithwall/crypto';
import type { ProfileInfo } from '../types';

export type FieldTier = 'connections' | 'close' | 'me';
export const PROFILE_FIELDS = ['bio', 'currentCity', 'hometown', 'work', 'education', 'languages', 'birthday', 'relationship', 'contact', 'friends'] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];
export type VisibilityMap = Partial<Record<ProfileField, FieldTier>>;

/** Fields stored inside the profile envelope for close friends: { a: audience, e: epoch, c: ciphertext }. */
export interface SealedExtra { a: string; e: number; c: string }

export const tierOf = (m: VisibilityMap, f: ProfileField): FieldTier => m[f] ?? 'connections';

/** The profile split by tier ('friends' is handled by the caller: it is a computed list). */
export function splitProfile(info: ProfileInfo, m: VisibilityMap): { open: ProfileInfo; close: Partial<ProfileInfo>; mine: Partial<ProfileInfo> } {
  const open: ProfileInfo = { ...info };
  const close: Partial<ProfileInfo> = {};
  const mine: Partial<ProfileInfo> = {};
  delete (open as { x?: unknown }).x;
  for (const f of PROFILE_FIELDS) {
    if (f === 'friends') continue;
    const v = info[f];
    if (v === undefined) continue;
    const tier = tierOf(m, f);
    if (tier === 'connections') continue;
    delete open[f];
    if (tier === 'close') (close as Record<string, unknown>)[f] = v;
    else (mine as Record<string, unknown>)[f] = v;
  }
  // The birthday's display setting follows the birthday.
  if (info.showBirthday && tierOf(m, 'birthday') !== 'connections') {
    delete open.showBirthday;
    if (tierOf(m, 'birthday') === 'close') close.showBirthday = info.showBirthday; else mine.showBirthday = info.showBirthday;
  }
  return { open, close, mine };
}

const extraAad = (userId: string, aud: string, epoch: number) => `profile_extra/${userId}/${aud}/${epoch}`;

export function sealExtra(userId: string, aud: string, epoch: number, key: Uint8Array, fields: Partial<ProfileInfo>): SealedExtra {
  return { a: aud, e: epoch, c: encryptBlob(key, new TextEncoder().encode(JSON.stringify(fields)), extraAad(userId, aud, epoch)) };
}

/** The close-friends fields, if this device holds that key; null otherwise (or if tampered with). */
export function openExtra(userId: string, x: unknown, keyLookup: (aud: string, epoch: number) => Uint8Array | null | undefined): Partial<ProfileInfo> | null {
  if (!x || typeof x !== 'object') return null;
  const { a, e, c } = x as Partial<SealedExtra>;
  if (typeof a !== 'string' || typeof e !== 'number' || typeof c !== 'string') return null;
  const key = keyLookup(a, e);
  if (!key) return null;
  try {
    const v = JSON.parse(new TextDecoder().decode(decryptBlob(key, c, extraAad(userId, a, e)))) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    // Only known profile fields may come from here (never name, avatar or the envelope's own fields).
    const out: Partial<ProfileInfo> = {};
    for (const [k, val] of Object.entries(v)) if ((PROFILE_FIELDS as readonly string[]).includes(k) || k === 'showBirthday') (out as Record<string, unknown>)[k] = val;
    return out;
  } catch { return null; }
}

