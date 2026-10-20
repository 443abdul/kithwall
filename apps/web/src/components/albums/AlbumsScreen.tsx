'use client';
// Albums: mine and shared with me, plus the Photos tab of a circle. Covers are decrypted on device.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useT } from '@/i18n';
import { useFileUrl } from '@/lib/media';
import { Page } from '@/components/shell/AppShell';
import { useDocumentTitle } from '@/components/onboarding/useDocumentTitle';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { Segmented } from '@/components/ui/Segmented';
import { TextField, Textarea } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { MoreLinks } from '@/components/circles/CirclesScreen';
import { useCircleOptions, type CircleRow } from '@/components/circles/data';
import { AudiencePicker, E2eeLine, Loading, usePersonName, type ShareAudience } from '@/components/circles/shared';
import { me } from '@/lib/keys/session';
import {
  albumAudienceKind, newAlbum, readAlbum, readMedia, toAlbumAudience, useAlbumCover, useAlbumsList, useCircleAlbums,
  type AlbumRow,
} from './data';

/** "Connections", "Only me" or the circle's name. */
export function useAudienceLabel(row: AlbumRow): { icon: 'users' | 'lock' | 'circles'; label: string } {
  const t = useT();
  const { options } = useCircleOptions();
  const k = albumAudienceKind(row);
  if (k.kind === 'connections') return { icon: 'users', label: t('circles.aud.connections') };
  if (k.kind === 'only_me') return { icon: 'lock', label: t('circles.aud.onlyMe') };
  if (k.kind === 'circle') {
    const c = options.find((o) => o.audienceId === k.audienceId);
    if (c) return { icon: 'circles', label: c.info?.name ?? t('circles.ui.sealedCircle') };
  }
  return { icon: 'lock', label: t('albums.encrypted') };
}

export function AlbumTile({ album }: { album: AlbumRow }) {
  const t = useT();
  const cover = useAlbumCover(album);
  const d = readAlbum(album);
  const c = cover.data?.cover ? readMedia(cover.data.cover) : null;
  const url = useFileUrl(c?.ok ? c.value.files.med : null);
  const aud = useAudienceLabel(album);
  const owner = usePersonName(album.owner_id);
  return (
    <li>
      <Link href={`/albums/${album.id}`} className="ka-tile">
        <span className="ka-cover">
          {url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={url} alt="" loading="lazy" />
          ) : <Icon name={d.ok ? 'image' : 'lock'} />}
        </span>
        <span className="ka-tile-body">
          <span dir="auto" className="ka-tile-title">{d.ok ? d.value.name : t('albums.sealed')}</span>
          <span className="ka-tile-sub">
            <Icon name={aud.icon} /> {album.owner_id === me() ? aud.label : owner}
            {' · '}{t('albums.count', { count: cover.data?.count ?? 0 })}
          </span>
        </span>
      </Link>
    </li>
  );
}

export function AlbumGrid({ albums }: { albums: AlbumRow[] }) {
  return <ul className="ka-grid" role="list">{albums.map((a) => <AlbumTile key={a.id} album={a} />)}</ul>;
}

export function AlbumsScreen() {
  const t = useT();
  useDocumentTitle(t('albums.title'));
  const [which, setWhich] = useState<'mine' | 'shared'>('mine');
  const q = useAlbumsList(which);
  return (
    <Page title={t('albums.title')} description={t('albums.description')}
      actions={<ButtonLink href="/albums/new" variant="primary" icon="plus" size="sm">{t('albums.create')}</ButtonLink>}
      context={<MoreLinks />}>
      <Segmented label={t('albums.title')} value={which} onChange={setWhich} options={[
        { value: 'mine', label: t('albums.mine') }, { value: 'shared', label: t('albums.shared') },
      ]} />
      {q.isLoading ? <Loading /> : q.data?.length ? <AlbumGrid albums={q.data} /> : (
        <Card><EmptyState icon="image" title={which === 'mine' ? t('albums.emptyMine') : t('albums.emptyShared')}
          body={which === 'mine' ? t('albums.emptyMineBody') : t('albums.emptySharedBody')}
          actions={which === 'mine' ? <ButtonLink href="/albums/new" variant="primary" icon="plus">{t('albums.create')}</ButtonLink> : undefined} /></Card>
      )}
      <E2eeLine>{t('albums.e2ee')}</E2eeLine>
    </Page>
  );
}

/** The Photos tab of a circle: albums shared with it. */
export function CircleAlbums({ circle }: { circle: CircleRow }) {
  const t = useT();
  const q = useCircleAlbums(circle);
  if (q.isLoading) return <Loading />;
  return (
    <div className="k-stack">
      <div className="k-row-wrap"><ButtonLink href={`/albums/new?circle=${circle.id}`} variant="soft" icon="plus">{t('albums.createInCircle')}</ButtonLink></div>
      {q.data?.length ? <AlbumGrid albums={q.data} /> : <Card><EmptyState icon="image" title={t('albums.emptyCircle')} body={t('albums.emptyCircleBody')} /></Card>}
    </div>
  );
}

export function NewAlbumScreen({ circleId }: { circleId?: string }) {
  const t = useT();
  useDocumentTitle(t('albums.create'));
  const router = useRouter();
  const toast = useToast();
  const qc = useQueryClient();
  const circles = useCircleOptions();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [aud, setAud] = useState<ShareAudience>(circleId ? { kind: 'circle', circleId } : { kind: 'connections' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setErr(t('albums.nameRequired')); return; }
    setBusy(true);
    try {
      const row = await newAlbum({ name, description }, toAlbumAudience(aud, circles.options));
      void qc.invalidateQueries({ queryKey: ['albums'] });
      router.replace(`/albums/${row.id}?upload=1`);
    } catch {
      toast({ message: t('circles.ui.error'), tone: 'danger' });
      setBusy(false);
    }
  };
  if (circles.isLoading) return <Page title={t('albums.create')}><Loading /></Page>;
  return (
    <Page title={t('albums.create')} back={{ href: circleId ? `/circles/${circleId}?tab=photos` : '/albums', label: t('common.back') }}>
      <form className="k-stack" onSubmit={(e) => void submit(e)} noValidate>
        <Card>
          <div className="k-stack">
            <TextField label={t('albums.name')} value={name} maxLength={120} required error={err} placeholder={t('albums.namePh')}
              onChange={(e) => { setName(e.target.value); setErr(undefined); }} />
            <Textarea label={t('albums.descriptionLabel')} value={description} maxLength={2000} rows={3} onChange={(e) => setDescription(e.target.value)} />
            <AudiencePicker value={aud} onChange={setAud} label={t('albums.whoCanSee')} />
          </div>
        </Card>
        <div className="kc-form-actions"><Button type="submit" variant="primary" icon="check" busy={busy}>{t('albums.createSubmit')}</Button></div>
        <E2eeLine>{t('albums.e2ee')}</E2eeLine>
      </form>
    </Page>
  );
}
