import { describe, expect, it } from 'vitest';
import { isUnconfirmedEmailError } from './login-errors';

describe('legacy sign-in with an unconfirmed email', () => {
  it('recognises GoTrue\'s refusal (login.ts turns it into AccountError "email_unconfirmed")', () => {
    expect(isUnconfirmedEmailError(new Error('Email not confirmed'))).toBe(true);
    expect(isUnconfirmedEmailError(Object.assign(new Error('x'), { code: 'email_not_confirmed' }))).toBe(true);
  });

  it('does not mistake other failures for it', () => {
    expect(isUnconfirmedEmailError(new Error('The email or password you entered is incorrect.'))).toBe(false);
    expect(isUnconfirmedEmailError(new Error('Failed to fetch'))).toBe(false);
    expect(isUnconfirmedEmailError(null)).toBe(false);
  });
});