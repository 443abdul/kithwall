'use client';
// Small shared pieces for the community area (groups, events, pages, games).
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { keyring } from '@/lib/keys/keyring';
import { Icon } from '@/components/Icon';
import type { GroupPrivacy } from '@/lib/groups';
import '@/styles/community.css';

export function GroupIcon({ color, size = 50, href, label }: { color?: string; size?: number; href?: string; label?: string }) {
  const svg = (
    <svg className="av cm-gicon" width={size} height={size} viewBox="0 0 16 16" role={label ? 'img' : undefined} aria-hidden={label ? undefined : true}>
      {label ? <title>{label}</title> : null}
      <rect width="16" height="16" fill={/^#[0-9a-f]{6}$/i.test(color ?? '') ? color : '#6d84b4'} />
      <g transform="translate(2 2) scale(.75)">
        <circle cx="3.8" cy="6" r="2" fill="#fff" opacity=".7" /><circle cx="12.2" cy="6" r="2" fill="#fff" opacity=".7" />
        <circle cx="8" cy="5" r="2.4" fill="#fff" /><path d="M4 14.5c0-3.5 1.8-5 4-5s4 1.5 4 5z" fill="#fff" />
      </g>
    </svg>
  );
  return href ? <Link className="avl" href={href} aria-label={label}>{svg}</Link> : svg;
}

export const PRIVACY_LABEL: Record<GroupPrivacy, string> = { open: 'Open Group', closed: 'Closed Group', secret: 'Secret Group' };

export function PrivacyLabel({ privacy }: { privacy: GroupPrivacy }) {
  if (privacy === 'open') return <span className="cm-enc" title="Public — not encrypted"><Icon name="globe" /> Open Group &middot; Public — not encrypted</span>;
  return <span className="cm-enc" title="End-to-end encrypted to members"><Icon name="lock" /> {PRIVACY_LABEL[privacy]} &middot; Encrypted</span>;
}

export function PublicWarning({ what }: { what: string }) {
  return (
    <div className="cm-pubwarn" role="note">
      <Icon name="globe" /><b>Public — not encrypted.</b> {what} can be read by anyone on Kithwall and by the Kithwall
      operator. Don&rsquo;t share anything here you wouldn&rsquo;t put on a noticeboard.
    </div>
  );
}

/** Run an async action with a busy flag and a readable error. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await fn(); return true; } catch (e) { setError(friendlyError(e)); return false; } finally { setBusy(false); }
  }, []);
  return { busy, error, setError, run };
}

export function friendlyError(e: unknown): string {
  const m = (e as Error)?.message ?? String(e);
  if (/rate limit/i.test(m)) return 'You\'re doing that too often. Please try again later.';
  if (/Waiting for a key/i.test(m)) return 'This group\'s newest key hasn\'t reached your device yet. An admin\'s device needs to come online to share it — please try again shortly.';
  if (/row-level security|not authori[sz]ed|permission/i.test(m)) return 'You don\'t have permission to do that.';
  if (/only add your friends/i.test(m)) return 'You can only add your friends.';
  return m || 'Something went wrong.';
}

export function ErrorBox({ error }: { error: string | null }) {
  if (!error) return null;
  return <div className="err" role="alert">{error}</div>;
}

export function DateBox({ iso }: { iso: string }) {
  const d = new Date(iso);
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
  return <div className="datebox" aria-hidden><div className="m">{mon}</div><div className="d">{d.getDate()}</div></div>;
}

/**
 * If something on screen is waiting for a key, fetch our sealed keys once more (they may have
 * arrived while this page was loading) and refresh the given query so it re-renders.
 */
export function useRetryKeys(waiting: boolean, queryKey: readonly unknown[]) {
  const qc = useQueryClient();
  const tried = useRef(false);
  const key = JSON.stringify(queryKey);
  useEffect(() => {
    if (!waiting || tried.current) return;
    tried.current = true;
    void keyring.load().catch(() => undefined).then(() => qc.invalidateQueries({ queryKey: JSON.parse(key) as unknown[] }));
  }, [waiting, key, qc]);
}
