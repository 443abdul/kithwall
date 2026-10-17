'use client';
// On-device password strength check (spec §3.2: zxcvbn score ≥ 3). The password protects the
// encryption keys, so a weak one weakens everything; Supabase's leaked-password check runs too.
import { ZxcvbnFactory } from '@zxcvbn-ts/core';

let factory: ZxcvbnFactory | null = null;

export const MIN_PASSWORD_LENGTH = 10;

export interface Strength { score: 0 | 1 | 2 | 3 | 4; ok: boolean; label: string; hint: string | null }

const LABELS = ['Too weak', 'Weak', 'Fair', 'Good', 'Strong'];

export function passwordStrength(pw: string, userInputs: string[] = []): Strength {
  if (!pw) return { score: 0, ok: false, label: '', hint: null };
  factory ??= new ZxcvbnFactory();
  const inputs = userInputs.flatMap((s) => [s, ...s.split(/[@.\s+_-]+/)]).filter((s) => s && s.length >= 3);
  const r = factory.check(pw.slice(0, 256), inputs);
  const score = r.score as Strength['score'];
  const longEnough = pw.length >= MIN_PASSWORD_LENGTH;
  const hint = !longEnough ? `Use at least ${MIN_PASSWORD_LENGTH} characters.`
    : score < 3 ? (r.feedback.warning || r.feedback.suggestions[0] || 'Add a few more uncommon words.') : null;
  return { score, ok: longEnough && score >= 3, label: LABELS[score]!, hint };
}

/** Throws a user-facing message when the password isn't strong enough. */
export function assertStrongPassword(pw: string, userInputs: string[] = []) {
  const s = passwordStrength(pw, userInputs);
  if (!s.ok) throw new Error(`Please choose a stronger password. ${s.hint ?? ''} It also protects your encrypted posts, so longer is better.`.trim());
}
