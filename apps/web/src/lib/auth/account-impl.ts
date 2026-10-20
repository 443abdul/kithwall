'use client';
// TEMPORARY MOCK of AccountApi so the onboarding UI can be built in parallel.
// Replaced by the real passkey implementation (owned by the accounts work stream).
import { AccountError, type AccountApi } from './account';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const accountApi: AccountApi = {
  async capabilities() {
    const passkey = typeof window !== 'undefined' && 'PublicKeyCredential' in window;
    return { passkey, prf: 'unknown' };
  },
  async handleProblem(handle) {
    if (!/^[a-z0-9_.]{3,30}$/.test(handle)) return 'invalid';
    if (['admin', 'kithwall', 'support'].includes(handle)) return 'reserved';
    return null;
  },
  async createAccount() { await wait(600); return { recoveryNudge: true }; },
  async signInWithPasskey() { await wait(400); throw new AccountError('no_account_for_passkey'); },
  async signInWithPassphrase() { await wait(400); throw new AccountError('wrong_passphrase'); },
  async signInLegacy() { await wait(400); return 'ready'; },
  async addPasskey() { await wait(400); },
  async listPasskeys() { return []; },
  async removePasskey() { /* mock */ },
  async setNoticeEmail() { /* mock */ },
};
