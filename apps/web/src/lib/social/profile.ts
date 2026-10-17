'use client';
// Helpers over decrypted profile info: birthdays, relationship text, People You May Know.
import { people, type Person } from '../people';
import type { ProfileInfo } from '../types';
import { MONTHS } from '../format';

export const RELATIONSHIPS = ['Single', 'In a Relationship', 'Engaged', 'Married', 'It\'s Complicated',
  'In an Open Relationship', 'Widowed', 'Separated', 'Divorced'] as const;

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

/** Friends whose decrypted friend lists contain this person (mutual friends). */
export function mutualFriends(myFriends: string[], target: string): string[] {
  return myFriends.filter((f) => {
    const info = people.person(f)?.info;
    if (info?.friends?.includes(target)) return true;
    const t = people.person(target)?.info;
    return !!t?.friends?.includes(f);
  });
}

/**
 * People You May Know, computed on this device only: people who appear in my friends'
 * (decrypted) friend lists, ranked by how many of my friends know them.
 */
export function peopleYouMayKnow(self: string, myFriends: string[], exclude: Set<string>): { id: string; mutual: number }[] {
  const mine = new Set(myFriends);
  const counts = new Map<string, number>();
  for (const f of myFriends) {
    const list = people.person(f)?.info?.friends ?? [];
    for (const x of list) {
      if (x === self || mine.has(x) || exclude.has(x)) continue;
      counts.set(x, (counts.get(x) ?? 0) + 1);
    }
  }
  return [...counts.entries()].map(([id, mutual]) => ({ id, mutual })).sort((a, b) => b.mutual - a.mutual);
}

/** Friends-of-friends ids to preload (profile rows) for suggestions. */
export function friendsOfFriends(myFriends: string[]): string[] {
  const out = new Set<string>();
  for (const f of myFriends) for (const x of people.person(f)?.info?.friends ?? []) out.add(x);
  return [...out];
}

export function splitList(s?: string): string[] {
  return String(s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
}
