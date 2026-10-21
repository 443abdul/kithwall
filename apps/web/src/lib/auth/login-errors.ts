// Telling sign-in failures apart (lib/auth/login.ts). Pure, so it is unit-tested.

/** GoTrue's refusal for an address that was never confirmed (error code email_not_confirmed). */
export function isUnconfirmedEmailError(e: unknown): boolean {
  const m = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  const code = e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : '';
  return code === 'email_not_confirmed' || /email[ _]not[ _]confirmed|not confirmed/i.test(m);
}