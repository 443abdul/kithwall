'use client';
// Per-user preferences that never leave the device unencrypted. Owned by the auth/account work.
// Contract used by others: chatVisible()/setChatVisible() — whether friends can see me online.
const KEY = 'kw.chatVisible';

export function chatVisible(): boolean {
  try { return localStorage.getItem(KEY) !== 'false'; } catch { return true; }
}
export function setChatVisible(v: boolean) {
  try { localStorage.setItem(KEY, String(v)); } catch { /* ignore */ }
  window.dispatchEvent(new Event('kw:settings'));
}
