'use client';
// Publisher audience selector: Friends · Only Me · my friend lists · Public (only when the
// operator enabled it). Padlock for encrypted audiences, globe + "not encrypted" for Public.
import { useQuery } from '@tanstack/react-query';
import { Icon } from '@/components/Icon';
import { useAppSetting } from '@/lib/hooks';
import { useSession } from '@/lib/keys/session';
import { myLists } from '@/lib/social/lists';
import type { Audience } from '@/lib/content';

export type AudienceValue = string; // 'friends' | 'self' | 'public' | `list:<id>`

export function toAudience(v: AudienceValue): Audience {
  if (v === 'self') return { kind: 'self' };
  if (v === 'public') return { kind: 'public' };
  if (v.startsWith('list:')) return { kind: 'audience', id: v.slice(5) };
  return { kind: 'friends' };
}

export function useMyLists() {
  const { status } = useSession();
  return useQuery({ queryKey: ['lists'], enabled: status === 'ready', queryFn: myLists });
}

export function AudienceSelect({ value, onChange, id }: { value: AudienceValue; onChange: (v: AudienceValue) => void; id?: string }) {
  const pub = useAppSetting('public_audience_enabled');
  const lists = useMyLists();
  const isPublic = value === 'public';
  return (
    <span className="kw-aud">
      {isPublic ? <Icon name="globe" title="Public — not encrypted" /> : <Icon name="lock" title="Encrypted" />}
      <select id={id} aria-label="Who can see this" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="friends">Friends</option>
        <option value="self">Only Me</option>
        {(lists.data ?? []).length > 0 && (
          <optgroup label="Friend Lists">
            {(lists.data ?? []).map((l) => <option key={l.id} value={`list:${l.id}`}>{l.name}</option>)}
          </optgroup>
        )}
        {pub.data && <option value="public">Public (not encrypted)</option>}
      </select>
      {isPublic && <span className="kw-pubwarn">Public — not encrypted</span>}
    </span>
  );
}
