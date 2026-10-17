'use client';
// /events/new — private by default (encrypted to the guest list).
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AppPage, Title } from '@/components/Shell';
import { Icon } from '@/components/Icon';
import { FriendPicker } from '@/components/social/bits';
import { useAppSetting, useFriendIds } from '@/lib/hooks';
import { createEvent } from '@/lib/events';
import { EventForm } from './EventForm';

export function NewEvent() {
  const router = useRouter();
  const qc = useQueryClient();
  const friends = useFriendIds();
  const pub = useAppSetting('public_audience_enabled');
  const [invite, setInvite] = useState<string[]>([]);
  const [isPublic, setPublic] = useState(false);

  return (
    <AppPage active="events" right={null}>
      <Title icon="event">Create an Event</Title>
      <EventForm submitLabel="Create Event" isPublic={isPublic}
        onCancel={() => router.push('/events')}
        onSubmit={async (info) => {
          const id = await createEvent({ info, isPublic: isPublic && !!pub.data, invite });
          await qc.invalidateQueries({ queryKey: ['events'] });
          router.push(`/events/${id}`);
        }}
        extra={<>
          <tr><td className="l">Who&rsquo;s invited?</td><td style={{ maxWidth: 300 }}>
            {friends.isLoading ? <span className="gray">Loading friends…</span>
              : <FriendPicker friends={friends.data ?? []} value={invite} onChange={setInvite} max={500} label="Search friends to invite" />}
          </td></tr>
          <tr><td className="l">Privacy:</td><td className="cm-radio">
            <label><input type="radio" name="ev-priv" checked={!isPublic} onChange={() => setPublic(false)} /> <Icon name="lock" /> <b>Private</b> — only invited guests can see the details and wall (end-to-end encrypted).</label>
            {pub.data && <label><input type="radio" name="ev-priv" checked={isPublic} onChange={() => setPublic(true)} /> <Icon name="globe" /> <b>Public</b> — anyone on Kithwall can see it. Not encrypted.</label>}
          </td></tr>
        </>} />
    </AppPage>
  );
}
