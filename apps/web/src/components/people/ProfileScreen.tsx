'use client';
// A person's profile (/u/[handle]): header (avatar, name, @handle, short bio, connection action) and
// tabs Posts / Photos / About. Everything but the handle is end-to-end encrypted to the person's
// connections (profile_info), so strangers only see the handle and a Connect button.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useT } from '@/i18n';
import { Avatar } from '@/components/ui/Avatar';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon, type IconName } from '@/components/ui/Icon';
import { Spinner } from '@/components/ui/Spinner';
import { Tabs } from '@/components/ui/Tabs';
import { Page } from '@/components/shell/AppShell';
import { useDocumentTitle } from '@/components/onboarding/useDocumentTitle';
import { Feed } from '@/components/posts';
import { ExternalLink } from '@/components/links/ExternalLink';
import { Lightbox } from '@/components/posts/Media';
import { safeHref } from '@/components/posts/logic';
import { readPost } from '@/lib/content';
import { fetchByKind } from '@/lib/feed/feed';
import { useKeyringVersion } from '@/lib/hooks';
import { useSession } from '@/lib/keys/session';
import { useFileUrl } from '@/lib/media';
import { people, usePeopleVersion, usePerson, type Person } from '@/lib/people';
import { birthdayText } from '@/lib/social/profile';
import type { PhotoFiles } from '@/lib/types';
import { normalizeHandle } from './data';
import { KeyChangeBanner } from '@/components/verify/KeyChangeBanner';
import { VerifiedBadge } from '@/components/verify/VerifiedBadge';
import { EditProfileDialog } from './EditProfile';
import { PersonActions } from './PersonActions';
import { RequestSafety } from './RequestSafety';

type Tab = 'posts' | 'photos' | 'about';

export function ProfileScreen({ handle }: { handle: string }) {
  const t = useT();
  const { status } = useSession();
  const h = normalizeHandle(decodeURIComponent(handle));
  const q = useQuery({ queryKey: ['profile-by-handle', h], enabled: status === 'ready', queryFn: async () => (await people.byUsername(h)) ?? null });
  useDocumentTitle(q.data ? `@${q.data.username}` : t('nav.you'));
  if (q.isPending) return <Page title={<span className="k-ltr">@{h}</span>}><div className="k-center"><Spinner size={28} /></div></Page>;
  if (!q.data) {
    return (
      <Page title={<span className="k-ltr">@{h}</span>} back={{ href: '/people', label: t('common.back') }}>
        <Card><EmptyState icon="search" title={t('profile.notFoundTitle')} body={t('profile.notFoundBody')} /></Card>
      </Page>
    );
  }
  return <Profile id={q.data.id} />;
}

function Profile({ id }: { id: string }) {
  const t = useT();
  const { userId } = useSession();
  useKeyringVersion();
  usePeopleVersion();
  const p = usePerson(id);
  const avatar = useFileUrl(p?.info?.avatar?.med ?? p?.info?.avatar?.thumb);
  const [tab, setTab] = useState<Tab>('posts');
  const [editing, setEditing] = useState(false);
  if (!p) return <Page title="…"><div className="k-center"><Spinner size={28} /></div></Page>;
  const self = id === userId;
  const canRead = self || !!p.info;
  return (
    <Page title={p.name} back={self ? { href: '/you', label: t('common.back') } : undefined}>
      {!self ? <KeyChangeBanner userId={id} name={p.name} handle={p.username} /> : null}
      {!self ? <RequestSafety userId={id} /> : null}
      {p.memorialised_at ? (
        // Chosen by their legacy contact after a long absence (lib/legacy); undone if they come back.
        <Callout tone="accent" icon="heart">
          <b>{t('legacy.profile.remembering', { name: p.name })}</b> {t('legacy.profile.rememberingBody', { name: p.name })}
        </Callout>
      ) : null}
      <Card className="k-profile-head">
        <Avatar name={p.name} src={avatar} size={96} />
        <div className="k-profile-head-text">
          <h2 className="k-profile-name">{p.name}{!self ? <> <VerifiedBadge userId={id} /></> : null}</h2>
          <p className="k-muted k-ltr">@{p.username}</p>
          {p.info?.bio ? <p className="k-profile-bio" dir="auto">{p.info.bio}</p> : null}
        </div>
        <div className="k-profile-head-actions">
          {self ? <Button variant="secondary" size="sm" icon="edit" onClick={() => setEditing(true)}>{t('profile.edit')}</Button>
            : <PersonActions userId={id} name={p.name} />}
          {!self ? <ButtonLink href={`/u/${encodeURIComponent(p.username)}/verify`} variant="ghost" size="sm" icon="shield">{t('verify.profileLink')}</ButtonLink> : null}
        </div>
      </Card>
      {canRead ? (
        <Tabs label={t('profile.tabs')} value={tab} onChange={setTab} items={[
          { value: 'posts', label: t('profile.posts'), panel: <Feed scope={{ kind: 'profile', userId: id }} empty={<Card><EmptyState icon="edit" title={t('profile.noPosts')} /></Card>} /> },
          { value: 'photos', label: t('profile.photos'), panel: <ProfilePhotos userId={id} /> },
          { value: 'about', label: t('profile.about'), panel: <About person={p} /> },
        ]} />
      ) : (
        <Card>
          <EmptyState icon="lock" title={t('profile.privateTitle', { handle: p.username })} body={t('profile.privateBody')} />
        </Card>
      )}
      {self && editing ? <EditProfileDialog onClose={() => setEditing(false)} /> : null}
    </Page>
  );
}

function ProfilePhotos({ userId }: { userId: string }) {
  const t = useT();
  useKeyringVersion();
  const q = useQuery({ queryKey: ['v2feed', 'profile-photos', userId], queryFn: () => fetchByKind('photo', [userId], undefined, 30) });
  const [open, setOpen] = useState<number | null>(null);
  if (q.isPending) return <div className="k-center"><Spinner /></div>;
  const photos: { files: PhotoFiles; caption?: string; key: string }[] = [];
  for (const row of q.data ?? []) {
    const d = readPost(row);
    if (d.ok) for (const ph of d.value.photos ?? []) photos.push({ files: ph.files, caption: ph.caption, key: `${row.id}:${ph.id}` });
  }
  if (!photos.length) return <Card><EmptyState icon="image" title={t('profile.noPhotos')} /></Card>;
  return (
    <>
      <ul className="k-photo-wall" role="list">
        {photos.map((ph, i) => (
          <li key={ph.key}>
            <button type="button" onClick={() => setOpen(i)} aria-label={ph.caption || t('feed.photoAlt', { n: i + 1, total: photos.length })}>
              <Thumb files={ph.files} />
            </button>
          </li>
        ))}
      </ul>
      {open !== null ? <Lightbox photos={photos} index={open} onClose={() => setOpen(null)} /> : null}
    </>
  );
}

function Thumb({ files }: { files: PhotoFiles }) {
  const url = useFileUrl(files.med);
  // eslint-disable-next-line @next/next/no-img-element
  return url ? <img src={url} alt="" loading="lazy" decoding="async" /> : <span className="k-media-ph" />;
}

function About({ person }: { person: Person }) {
  const t = useT();
  const info = person.info;
  const rows: { icon: IconName; label: string; value: React.ReactNode }[] = [];
  if (info?.currentCity) rows.push({ icon: 'home', label: t('profile.city'), value: info.currentCity });
  if (info?.hometown) rows.push({ icon: 'globe', label: t('profile.hometown'), value: info.hometown });
  const work = info?.work?.[0];
  if (work?.employer) rows.push({ icon: 'layout', label: t('profile.work'), value: [work.position, work.employer].filter(Boolean).join(' · ') });
  const edu = info?.education?.[0];
  if (edu?.school) rows.push({ icon: 'sparkle', label: t('profile.education'), value: edu.school });
  if (info?.languages) rows.push({ icon: 'messages', label: t('profile.languages'), value: info.languages });
  const bday = birthdayText(info);
  if (bday) rows.push({ icon: 'gift', label: t('profile.birthday'), value: bday });
  const site = info?.contact?.website ? safeHref(info.contact.website) : null;
  if (site) rows.push({ icon: 'link', label: t('profile.website'), value: <ExternalLink href={site} className="k-ltr">{site.replace(/^https?:\/\//, '').replace(/\/$/, '')}</ExternalLink> });
  if (!rows.length && !info?.bio) return <Card><EmptyState icon="info" title={t('profile.noAbout')} /></Card>;
  return (
    <Card padding="flush">
      {info?.bio ? <p className="k-about-bio" dir="auto">{info.bio}</p> : null}
      <dl className="k-about">
        {rows.map((r) => (
          <div key={r.label} className="k-about-row">
            <dt><Icon name={r.icon} /><span>{r.label}</span></dt>
            <dd dir="auto">{r.value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
