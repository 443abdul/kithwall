'use client';
// On-device password strength check (zxcvbn score 4, security review L12; was 3 in spec §3.2). The
// password protects the encryption keys, and the server sees a slow hash of it it could attack offline,
// so a weak one weakens everything; Supabase's leaked-password check runs too. Existing passwords keep
// working: the floor applies when a password or passphrase is set or changed.
// The common-password and English dictionaries (~1.5 MB) load lazily, only where a password is set
// (loadPasswordDictionaries); without them zxcvbn rates "password12345" as strong.
import { ZxcvbnFactory } from '@zxcvbn-ts/core';

let factory: ZxcvbnFactory | null = null;
let full = false;
let loading: Promise<void> | null = null;

/** Load the dictionaries once; safe to call often. Checks made before it resolves are without them. */
export function loadPasswordDictionaries(): Promise<void> {
  loading ??= Promise.all([import('@zxcvbn-ts/language-common'), import('@zxcvbn-ts/language-en')]).then(([common, en]) => {
    factory = new ZxcvbnFactory({
      dictionary: { ...common.dictionary, ...en.dictionary },
      graphs: common.adjacencyGraphs,
      translations: en.translations,
    });
    full = true;
  }, (e: unknown) => { loading = null; throw e; });
  return loading;
}

export const passwordDictionariesLoaded = () => full;

export const MIN_PASSWORD_LENGTH = 10;
export const MIN_PASSWORD_SCORE = 4;

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
    : score < MIN_PASSWORD_SCORE ? (r.feedback.warning || r.feedback.suggestions[0] || 'Add a few more uncommon words.') : null;
  return { score, ok: longEnough && score >= MIN_PASSWORD_SCORE, label: LABELS[score]!, hint };
}

/** Full check (dictionaries loaded first): what a new password must pass. */
export async function strongPassword(pw: string, userInputs: string[] = []): Promise<Strength> {
  await loadPasswordDictionaries();
  return passwordStrength(pw, userInputs);
}

/** Throws a user-facing message when the password isn't strong enough. */
export async function assertStrongPassword(pw: string, userInputs: string[] = []) {
  const s = await strongPassword(pw, userInputs);
  if (!s.ok) throw new Error(`Please choose a stronger password. ${s.hint ?? ''} It also protects your encrypted posts, so longer is better.`.trim());
}
