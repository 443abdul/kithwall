'use client';
// Calls to our own route handlers with the user's access token (no cookies, so no CSRF surface).
import { sb } from '../supabase';

export async function authedPost<T>(path: string, body: unknown, method: 'POST' | 'DELETE' = 'POST'): Promise<T> {
  const { data } = await sb().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Please log in again.');
  const res = await fetch(path, {
    method, cache: 'no-store',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body ?? {}),
  });
  let out: unknown = null;
  try { out = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw new Error((out as { error?: string } | null)?.error ?? `Request failed (${res.status})`);
  return out as T;
}
