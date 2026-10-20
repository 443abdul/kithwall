'use client';
// Helpers over decrypted profile info: birthdays, relationship text, People You May Know.
import { people, type Person } from '../people';
import type { ProfileInfo } from '../types';
import { MONTHS } from '../format';

/** Statuses that name a partner ("Engaged to Bob"). */
export const REL_WITH: Record<string, string> = {
  'In a Relationship': 'In a relationship with', Engaged: 'Engaged to', Married: 'Married to',
  'It\'s Complicated': 'It\'s complicated with', 'In an Open Relationship': 'In an open relationship with',
};

/**
 * Relationship as shown on a profile. The partner is only named when the partner's own
 * (decrypted) profile also names this person — a relationship must be confirmed by both.
 */
export function relationship(p: Person): { text: string; partner?: string; pending?: boolean } | null {
  const info = p.info;
  if (!info?.relationship) return null;
  const verb = REL_WITH[info.relationship];
  if (verb && info.relationshipWith) {
    const partner = people.person(info.relationshipWith);
    if (partner?.info?.relationshipWith === p.id) return { text: verb, partner: info.relationshipWith };
    return { text: info.relationship, pending: true };
  }
  return { text: info.relationship };
}

function parseBirthday(b?: string): { y?: number; m: number; d: number } | null {
  if (!b) return null;
  const m = /^(\d{4})?-?(\d{2})-(\d{2})$/.exec(b.trim());
  if (!m) return null;
  const mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y: m[1] ? Number(m[1]) : undefined, m: mo, d };
}

/** Birthday text respecting the owner's showBirthday choice. */
export function birthdayText(info: ProfileInfo | null | undefined): string | null {
  if (!info?.birthday || info.showBirthday === 'none') return null;
  const b = parseBirthday(info.birthday);
  if (!b) return null;
  const md = `${MONTHS[b.m - 1]} ${b.d}`;
  return info.showBirthday === 'month_day' || !b.y ? md : `${md}, ${b.y}`;
}

/** Days until the next birthday (0 = today), or null if unknown/hidden. */
export function daysUntilBirthday(info: ProfileInfo | null | undefined, now = new Date()): number | null {
  if (!info?.birthday || info.showBirthday === 'none') return null;
  const b = parseBirthday(info.birthday);
  if (!b) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let next = new Date(now.getFullYear(), b.m - 1, b.d);
  if (next < today) next = new Date(now.getFullYear() + 1, b.m - 1, b.d);
  return Math.round((next.getTime() - today.getTime()) / 86_400_000);
}
