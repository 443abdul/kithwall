'use client';
// Private chat preferences kept in the encrypted vault (spec §4: vault = owner-only blob):
// which conversations I've archived. Never stored in the clear.
//
// Vault format (shared with other areas): blob = encryptBlob(deriveVaultKey(AMK), utf8(JSON), "vault/<userId>")
// where the JSON is an object of namespaced sections ({ v: 1, messages: {...}, ... }). This module
// only touches `messages` and preserves every other section; writes are compare-and-swap on
// `updated_at`, retried on conflict. If the blob can't be read, nothing is overwritten.
import { decryptBlob, deriveVaultKey, encryptBlob } from '@kithwall/crypto';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { sb } from '../supabase';
import { amk, me, useSession } from '../keys/session';

interface VaultDoc { v: 1; messages?: MessagesPrefs; [section: string]: unknown }
export interface MessagesPrefs {
  /** conversation id → ISO time it was archived */ hidden?: Record<string, string>;
  /** conversation id → ISO time it was pinned (Kithwall 2) */ pinned?: Record<string, string>;
}

const aad = (uid: string) => `vault/${uid}`;

class VaultUnreadable extends Error {}

async function readVault(): Promise<{ doc: VaultDoc; updatedAt: string | null }> {
  const res = await sb().from('vault').select('blob, updated_at').eq('user_id', me()).maybeSingle();
  if (res.error) throw new Error(res.error.message);
  if (!res.data) return { doc: { v: 1 }, updatedAt: null };
  try {
    const json = JSON.parse(new TextDecoder().decode(decryptBlob(deriveVaultKey(amk()), res.data.blob as string, aad(me()))));
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('not an object');
    return { doc: json as VaultDoc, updatedAt: res.data.updated_at as string };
  } catch (e) {
    throw new VaultUnreadable(`Your private settings couldn't be read (${(e as Error).message}).`);
  }
}

async function updateVault(fn: (doc: VaultDoc) => VaultDoc): Promise<VaultDoc> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { doc, updatedAt } = await readVault();
    const next = fn(structuredClone(doc));
    const blob = encryptBlob(deriveVaultKey(amk()), new TextEncoder().encode(JSON.stringify(next)), aad(me()));
    const now = new Date().toISOString();
    if (!updatedAt) {
      const ins = await sb().from('vault').insert({ user_id: me(), blob, updated_at: now });
      if (!ins.error) return next;
      if (ins.error.code !== '23505') throw new Error(ins.error.message);
    } else {
      const up = await sb().from('vault').update({ blob, updated_at: now }).eq('user_id', me()).eq('updated_at', updatedAt).select('user_id');
      if (up.error) throw new Error(up.error.message);
      if (up.data?.length) return next;
    }
  }
  throw new Error('Couldn\'t save your settings. Please try again.');
}

export async function loadMessagesPrefs(): Promise<MessagesPrefs> {
  return (await readVault()).doc.messages ?? {};
}

/** Archive (hide) or unarchive a conversation for me. It comes back when a new message arrives. */
export async function setArchived(convId: string, archived: boolean): Promise<MessagesPrefs> {
  const doc = await updateVault((d) => {
    const hidden = { ...(d.messages?.hidden ?? {}) };
    if (archived) hidden[convId] = new Date().toISOString(); else delete hidden[convId];
    // Keep the list bounded.
    const entries = Object.entries(hidden).sort((a, b) => b[1].localeCompare(a[1])).slice(0, 2000);
    return { ...d, v: 1, messages: { ...(d.messages ?? {}), hidden: Object.fromEntries(entries) } };
  });
  return doc.messages ?? {};
}

/** Is this conversation archived (and nothing new arrived since)? */
export function isArchived(prefs: MessagesPrefs | undefined, convId: string, lastMessageAt: string): boolean {
  const at = prefs?.hidden?.[convId];
  return !!at && at >= lastMessageAt;
}

export function useMessagesPrefs() {
  const { status, userId } = useSession();
  return useQuery({ queryKey: ['vault', 'messages', userId], enabled: status === 'ready', queryFn: loadMessagesPrefs, staleTime: 60_000, retry: false });
}

export function useSetArchived() {
  const qc = useQueryClient();
  const { userId } = useSession();
  return async (convId: string, archived: boolean) => {
    const prefs = await setArchived(convId, archived);
    qc.setQueryData(['vault', 'messages', userId], prefs);
  };
}

/** Pin or unpin a conversation to the top of my list (encrypted in the vault, like archiving). */
export async function setPinned(convId: string, pinned: boolean): Promise<MessagesPrefs> {
  const doc = await updateVault((d) => {
    const pins = { ...(d.messages?.pinned ?? {}) };
    if (pinned) pins[convId] = new Date().toISOString(); else delete pins[convId];
    const entries = Object.entries(pins).sort((a, b) => b[1].localeCompare(a[1])).slice(0, 50);
    return { ...d, v: 1, messages: { ...(d.messages ?? {}), pinned: Object.fromEntries(entries) } };
  });
  return doc.messages ?? {};
}

export function isPinned(prefs: MessagesPrefs | undefined, convId: string): boolean {
  return !!prefs?.pinned?.[convId];
}

export function useSetPinned() {
  const qc = useQueryClient();
  const { userId } = useSession();
  return async (convId: string, pinned: boolean) => {
    const prefs = await setPinned(convId, pinned);
    qc.setQueryData(['vault', 'messages', userId], prefs);
  };
}
