'use client';
// Settings → Privacy: who sees each profile field (connections / close friends / only me) and who is on my
// close friends list. Changing either re-seals my profile at once (lib/friends saveProfileInfo).
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useT, type MessageKey } from '@/i18n';
import { republishProfileInfo, myFriendIds } from '@/lib/friends';
import { people, usePeopleVersion } from '@/lib/people';
import { useSession } from '@/lib/keys/session';
import { addCloseFriend, removeCloseFriend, useCloseFriends, useCloseFriendsInvalidate } from '@/lib/social/closeFriends';
import { loadVisibility, PROFILE_FIELDS, saveVisibility, tierOf, useVisibility, type FieldTier, type ProfileField } from '@/lib/social/visibility';
import { Segmented } from '@/components/ui/Segmented';
import { Switch } from '@/components/ui/Switch';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { PersonAvatar } from '@/components/messages/look';
import { Section } from './shared';
import { Button } from '@/components/ui/Button';
import { isMuted, loadSocialPrefs, setMuted, useSocialPrefs } from '@/lib/social/prefs';

const LABELS: Record<ProfileField, MessageKey> = {
  bio: 'profile.bio', currentCity: 'profile.city', hometown: 'profile.hometown', work: 'profile.work', education: 'profile.education',
  languages: 'profile.languages', birthday: 'profile.birthday', relationship: 'visibility.relationship', contact: 'profile.website', friends: 'visibility.friendsList',
};

export function ProfileVisibilitySection() {
  const t = useT();
  const toast = useToast();
  const { status } = useSession();
  const vis = useVisibility();
  const [busy, setBusy] = useState<ProfileField | null>(null);
  useEffect(() => { if (status === 'ready') void loadVisibility().catch(() => undefined); }, [status]);
  async function change(f: ProfileField, tier: FieldTier) {
    setBusy(f);
    try {
      await saveVisibility({ [f]: tier });
      await republishProfileInfo();
      toast({ message: t('settings.saved') });
    } catch { toast({ message: t('settings.saveFailed'), tone: 'danger' }); } finally { setBusy(null); }
  }
  return (
    <Section id="profile" title={t('visibility.title')} description={t('visibility.body')}>
      {PROFILE_FIELDS.map((f) => (
        <div key={f} className="k-stack-sm">
          <span className="k-label">{t(LABELS[f])}</span>
          <Segmented<FieldTier> block label={t(LABELS[f])} value={tierOf(vis, f)} onChange={(v) => { if (busy === null) void change(f, v); }}
            options={[
              { value: 'connections', label: t('visibility.connections') },
              { value: 'close', label: t('visibility.close') },
              { value: 'me', label: t('visibility.me') },
            ]} />
        </div>
      ))}
    </Section>
  );
}

export function CloseFriendsSection() {
  const t = useT();
  const toast = useToast();
  const { status } = useSession();
  usePeopleVersion();
  const close = useCloseFriends(status === 'ready');
  const invalidate = useCloseFriendsInvalidate();
  const friends = useQuery({
    queryKey: ['friend-ids'], enabled: status === 'ready',
    queryFn: async () => { const ids = await myFriendIds(); await people.ensure(ids); return ids; },
  });
  const [busy, setBusy] = useState<string | null>(null);
  const on = new Set(close.data ?? []);
  async function toggle(id: string, v: boolean) {
    setBusy(id);
    try {
      if (v) await addCloseFriend(id); else await removeCloseFriend(id);
      await invalidate();
    } catch { toast({ message: t('settings.saveFailed'), tone: 'danger' }); } finally { setBusy(null); }
  }
  const sorted = [...(friends.data ?? [])].sort((a, b) => (people.person(a)?.name ?? '').localeCompare(people.person(b)?.name ?? ''));
  return (
    <Section id="close" title={t('close.title')} description={t('close.body')}>
      {friends.isPending || close.isPending ? <Skeleton height={40} /> : sorted.length ? (
        <ul className="k-set-items">
          {sorted.map((id) => (
            <li key={id}>
              <PersonAvatar id={id} size={36} />
              <Switch checked={on.has(id)} disabled={busy !== null} label={people.person(id)?.name ?? '…'}
                description={`@${people.get(id)?.username ?? '…'}`} onChange={(v) => void toggle(id, v)} />
            </li>
          ))}
        </ul>
      ) : <p className="k-muted">{t('close.empty')}</p>}
    </Section>
  );
}

/** People I muted (their posts are left out of Home until the mute ends). Kept in the vault only. */
export function MutedSection() {
  const t = useT();
  const toast = useToast();
  const { status } = useSession();
  usePeopleVersion();
  const prefs = useSocialPrefs();
  useEffect(() => { if (status === 'ready') void loadSocialPrefs().catch(() => undefined); }, [status]);
  const ids = Object.keys(prefs.muted).filter((id) => isMuted(prefs.muted, id));
  useEffect(() => { if (ids.length) void people.ensure(ids); }, [ids.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  async function unmute(id: string) {
    try { await setMuted(id, null); toast({ message: t('mute.unmuted') }); }
    catch { toast({ message: t('settings.saveFailed'), tone: 'danger' }); }
  }
  return (
    <Section id="muted" title={t('mute.title')} description={t('mute.body')}>
      {!prefs.loaded ? <Skeleton height={40} /> : ids.length ? (
        <ul className="k-set-items">
          {ids.map((id) => (
            <li key={id}>
              <PersonAvatar id={id} size={36} />
              <span className="k-set-item-body"><span className="k-set-item-title">{people.person(id)?.name ?? '…'}</span></span>
              <Button size="sm" variant="ghost" onClick={() => void unmute(id)}>{t('mute.unmute')}</Button>
            </li>
          ))}
        </ul>
      ) : <p className="k-muted">{t('mute.none')}</p>}
    </Section>
  );
}
