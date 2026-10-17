'use client';
// Small shared pieces for the social area: safe auto-linking, audience labels, map art,
// friend picker, name lists.
import Link from 'next/link';
import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { Icon } from '@/components/Icon';
import { people, usePeopleVersion } from '@/lib/people';
import '@/styles/social.css';

// ---------------------------------------------------------------------------------------
// Text with safe links: only http(s) URLs become links (dev-guide rule 4); everything else is
// plain React text (escaped). Newlines become <br>.
const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;

function trimUrl(u: string): [string, string] {
  let url = u, rest = '';
  while (/[.,!?;:)\]}'"]$/.test(url)) {
    const ch = url.slice(-1);
    if (ch === ')' && (url.match(/\(/g)?.length ?? 0) >= (url.match(/\)/g)?.length ?? 0)) break;
    rest = ch + rest; url = url.slice(0, -1);
  }
  return [url, rest];
}

export function safeHref(u: string): string | null {
  try { const x = new URL(u); return x.protocol === 'http:' || x.protocol === 'https:' ? x.toString() : null; } catch { return null; }
}

export function ExternalLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  const h = safeHref(href);
  if (!h) return <span className={className}>{children}</span>;
  return <a className={className} href={h} target="_blank" rel="noopener noreferrer nofollow">{children}</a>;
}

export function Linkify({ text }: { text: string }) {
  const lines = text.split('\n');
  return (
    <>
      {lines.map((line, li) => {
        const out: ReactNode[] = [];
        let last = 0;
        for (const m of line.matchAll(URL_RE)) {
          const [url, rest] = trimUrl(m[0]);
          if (m.index! > last) out.push(line.slice(last, m.index));
          out.push(<ExternalLink key={`${li}-${m.index}`} href={url}>{url}</ExternalLink>);
          if (rest) out.push(rest);
          last = m.index! + m[0].length;
        }
        if (last < line.length) out.push(line.slice(last));
        return <Fragment key={li}>{li > 0 && <br />}{out}</Fragment>;
      })}
    </>
  );
}

// ---------------------------------------------------------------------------------------
// Audience marker (spec §6.2): padlock for encrypted audiences, globe + "Public — not encrypted".
export function AudienceMark({ isPublic, label }: { isPublic: boolean; label?: string }) {
  if (isPublic) return <span className="lock aud-pub" title="Public — not encrypted"><Icon name="globe" /> Public — not encrypted</span>;
  return <span className="lock" title={label ? `Encrypted · ${label}` : 'Encrypted'}><Icon name="lock" />{label ? <span className="aud-l">{label}</span> : null}</span>;
}

export function AudienceIcon({ isPublic, label }: { isPublic: boolean; label?: string }) {
  return isPublic
    ? <span title="Public — not encrypted"><Icon name="globe" title="Public — not encrypted" /></span>
    : <span title={label ? `Encrypted · ${label}` : 'Encrypted'}><Icon name="lock" title={label ? `Encrypted · ${label}` : 'Encrypted'} /></span>;
}

// ---------------------------------------------------------------------------------------
// Map art for check-ins (port of the reference mapImg). Purely decorative and derived from a
// hash of the place name, so no map tiles are fetched from anywhere.
export function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 10000;
}

export function MapArt({ seed, width, height, label }: { seed: number; width: number | string; height: number | string; label?: string }) {
  const r = (n: number) => { const x = Math.sin(seed * 57 + n) * 10000; return x - Math.floor(x); };
  return (
    <svg viewBox="0 0 200 120" width={width} height={height} preserveAspectRatio="xMidYMid slice" role="img" aria-label={label ? `Map: ${label}` : 'Map'}>
      <rect width="200" height="120" fill="#ece8de" />
      <rect x={10 + r(1) * 60} y={10 + r(2) * 30} width="50" height="35" fill="#c8dfb0" />
      <path d={`M${150 + r(3) * 30} 0 Q${130 + r(4) * 30} 60 170 120 H200 V0z`} fill="#a9cdea" />
      <path d={`M0 ${40 + r(5) * 20}H200M0 ${85 + r(6) * 15}H200M${50 + r(7) * 20} 0V120M${110 + r(8) * 20} 0V120`} stroke="#fff" strokeWidth="6" />
      <path d="M0 62H200" stroke="#f6d77c" strokeWidth="4" />
      <path d="M100 64c-6 0-10-4-10-10 0-8 10-18 10-18s10 10 10 18c0 6-4 10-10 10z" fill="#d93a2b" stroke="#8c1d12" />
      <circle cx="100" cy="51" r="3.5" fill="#fff" />
    </svg>
  );
}

// ---------------------------------------------------------------------------------------
// "Alice, Bob and Carol" with links.
export function NameList({ ids, max = 3 }: { ids: string[]; max?: number }) {
  usePeopleVersion();
  const shown = ids.slice(0, max);
  const rest = ids.length - shown.length;
  const parts: ReactNode[] = shown.map((id) => {
    const p = people.person(id);
    return p ? <Link key={id} href={`/${p.username}`}>{p.name}</Link> : <span key={id} className="gray">someone</span>;
  });
  if (rest > 0) parts.push(<span key="rest">{rest} other{rest > 1 ? 's' : ''}</span>);
  return <>{parts.map((p, i) => <Fragment key={i}>{i > 0 && (i === parts.length - 1 ? ' and ' : ', ')}{p}</Fragment>)}</>;
}

// ---------------------------------------------------------------------------------------
// Friend picker: a filterable checkbox list of my friends (tagging, list members, check-ins).
export function FriendPicker({ friends, value, onChange, max = 50, label = 'Search friends' }:
  { friends: string[]; value: string[]; onChange: (ids: string[]) => void; max?: number; label?: string }) {
  usePeopleVersion();
  const [q, setQ] = useState('');
  const sorted = useMemo(() => [...friends].sort((a, b) => (people.person(a)?.name ?? '').localeCompare(people.person(b)?.name ?? '')),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [friends, people.version]);
  const ql = q.trim().toLowerCase();
  const list = sorted.filter((f) => !ql || (people.person(f)?.name ?? '').toLowerCase().includes(ql));
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : value.length >= max ? value : [...value, id]);
  if (!friends.length) return <div className="gray">You don&rsquo;t have any friends to choose yet.</div>;
  return (
    <div className="fpick">
      <input type="text" placeholder={label} aria-label={label} value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="fpick-l">
        {list.map((f) => (
          <label key={f}><input type="checkbox" checked={value.includes(f)} onChange={() => toggle(f)} /> {people.person(f)?.name ?? '…'}</label>
        ))}
        {!list.length && <span className="gray">No matches.</span>}
      </div>
    </div>
  );
}

export function Waiting({ authorId, what = 'this' }: { authorId: string; what?: string }) {
  usePeopleVersion();
  const p = people.person(authorId);
  const first = p?.name?.split(' ')[0] ?? 'the author';
  return <div className="kw-wait"><Icon name="lock" /> Waiting for {first}&rsquo;s device to share {what} with you.</div>;
}

export function Unverified() {
  return <div className="kw-wait kw-bad"><Icon name="shield" /> This item couldn&rsquo;t be verified.</div>;
}
