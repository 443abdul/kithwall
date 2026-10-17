'use client';
// A person in a list (reference personRow): avatar, name, a line of info and actions.
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AvatarLink } from '@/components/Avatar';
import { Icon } from '@/components/Icon';
import { AddFriendDialog } from '@/components/profile/ProfileButtons';
import { ConfirmDialog } from './Dialog';
import { people, usePeopleVersion } from '@/lib/people';
import { unfriendFully } from '@/lib/social/graph';

export function personLine(id: string): string {
  const i = people.person(id)?.info;
  return [i?.work?.[0]?.employer, i?.currentCity].filter(Boolean).join(' · ');
}

export function PersonRow({ id, rel, extra, self }: { id: string; rel: 'friends' | 'sent' | 'none' | 'self' | 'received'; extra?: ReactNode; self?: string | null }) {
  usePeopleVersion();
  const qc = useQueryClient();
  const [dialog, setDialog] = useState<'add' | 'unfriend' | null>(null);
  const p = people.person(id);
  const name = p?.name ?? '…';
  const line = personLine(id);
  return (
    <div className="it" data-n={name.toLowerCase()}>
      <AvatarLink id={id} size={50} />
      <div className="d">
        <b>{p ? <Link href={`/${p.username}`}>{name}</Link> : name}</b>
        {p && p.name !== p.username ? <span className="gray"> @{p.username}</span> : null}
        {line ? <><br /><span className="gray">{line}</span></> : null}
        {extra ? <><br />{extra}</> : null}
      </div>
      <div className="x">
        {id === self || rel === 'self' ? <span className="gray">That&rsquo;s you!</span>
          : rel === 'friends' ? <>
            <Link className="btn" href={`/messages/new?to=${encodeURIComponent(p?.username ?? '')}`}>Message</Link>{' '}
            <button type="button" className="kw-x" title="Remove from friends" aria-label={`Unfriend ${name}`} onClick={() => setDialog('unfriend')}>&times;</button>
          </>
            : rel === 'sent' ? <span className="gray">Friend Request Sent</span>
              : rel === 'received' ? <Link className="btn b" href="/requests">Respond to Request</Link>
                : <button type="button" className="btn" onClick={() => setDialog('add')}><Icon name="friends" /> Add as Friend</button>}
      </div>
      {dialog === 'add' && <AddFriendDialog id={id} name={name} onClose={() => setDialog(null)} onDone={() => void qc.invalidateQueries({ queryKey: ['friends'] })} />}
      {dialog === 'unfriend' && (
        <ConfirmDialog title={`Unfriend ${name}?`} confirmLabel="Unfriend" onClose={() => setDialog(null)}
          onConfirm={async () => { await unfriendFully(id); await qc.invalidateQueries({ queryKey: ['friends'] }); await qc.invalidateQueries({ queryKey: ['lists'] }); }}>
          <p style={{ marginBottom: 6 }}>{name} will be removed from your friends and your friend lists.</p>
          <p className="gray">Your device will change your encryption key and share the new one only with your remaining friends, so {name.split(' ')[0]} can&rsquo;t read anything you post from now on.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
