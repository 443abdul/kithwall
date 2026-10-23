import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { supabaseNetOptions } from './net/runtime';

export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
export const SUPABASE_PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '';

let client: SupabaseClient | null = null;

/** Browser Supabase client. Only ever sees ciphertext and routing metadata. */
export function sb(): SupabaseClient {
  if (!client) {
    if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
      throw new Error('Supabase is not configured (NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY).');
    }
    // Censorship resistance (lib/net, docs/v2/08-censorship.md): when mirrors / a proxy are configured,
    // requests and the Realtime socket are rewritten from SUPABASE_URL onto the route that currently
    // works. Not configured: `net` is {} and the client is exactly the default one.
    const net = supabaseNetOptions();
    client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
      realtime: { params: { eventsPerSecond: 10 }, ...net.realtime },
      ...(net.global ? { global: net.global } : {}),
    });
  }
  return client;
}

/** Throw on Supabase errors with a readable message. */
export function must<T>(res: { data: T; error: { message: string; code?: string } | null }): T {
  if (res.error) {
    const e = new Error(res.error.message) as Error & { code?: string };
    e.code = res.error.code;
    throw e;
  }
  return res.data;
}
