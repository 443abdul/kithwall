'use client';
// /photos/new — create an album (encrypted name/location/description), then upload photos.
import '@/styles/photos.css';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AppPage, Title } from '@/components/Shell';
import { Icon } from '@/components/Icon';
import { useAppSetting } from '@/lib/hooks';
import { addPhotos, createAlbum, myLists, updateAlbum, type AlbumAudience, type AlbumPayload } from '@/lib/photos';
import { PhotoPicker, usePicked } from './PhotoPicker';
import { errText, useKeysReady } from './common';

export function AudienceSelect({ value, onChange, disabled, id }: { value: string; onChange: (v: string) => void; disabled?: boolean; id?: string }) {
  const ready = useKeysReady();
  const lists = useQuery({ queryKey: ['photos', 'lists'], enabled: ready, queryFn: () => myLists() });
  const pub = useAppSetting('public_audience_enabled');
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
      <select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        <option value="friends">Friends</option>
        <option value="self">Only Me</option>
        {(lists.data ?? []).length ? (
          <optgroup label="Friend lists">
            {lists.data!.map((l) => <option key={l.id} value={`list:${l.id}`}>{l.name}</option>)}
          </optgroup>
        ) : null}
        {pub.data ? <option value="public">Public — not encrypted</option> : null}
      </select>
      {value === 'public'
        ? <span className="gray"><Icon name="globe" /> Public — not encrypted</span>
        : <span className="gray"><Icon name="lock" /> Encrypted</span>}
    </span>
  );
}

export function toAudience(v: string): AlbumAudience {
  if (v === 'self') return { kind: 'self' };
  if (v === 'public') return { kind: 'public' };
  if (v.startsWith('list:')) return { kind: 'audience', id: v.slice(5) };
  return { kind: 'friends' };
}

export function NewAlbum() {
  const router = useRouter();
  const qc = useQueryClient();
  const ready = useKeysReady();
  const [name, setName] = useState('');
  const [location, setLocation] = useState('');
  const [description, setDescription] = useState('');
  const [aud, setAud] = useState('friends');
  const [items, setItems] = usePicked();
  const [cover, setCover] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { document.title = 'Create a Photo Album | Kithwall'; }, []);
  const coverKey = cover && items.some((p) => p.key === cover) ? cover : items[0]?.key ?? null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setErr('Please give your album a name.'); return; }
    setBusy(true); setErr(null);
    try {
      const payload: AlbumPayload = { name: name.trim().slice(0, 200), kind: 'normal',
        ...(location.trim() ? { location: location.trim().slice(0, 200) } : {}),
        ...(description.trim() ? { description: description.trim().slice(0, 5000) } : {}) };
      const album = await createAlbum(payload, toAudience(aud));
      if (items.length) {
        setProgress({ done: 0, total: items.length });
        const out = await addPhotos(album, items.map((p) => p.file), items.map((p) => p.caption), (done) => setProgress({ done, total: items.length }));
        const ci = items.findIndex((p) => p.key === coverKey);
        const coverRow = out[ci >= 0 ? ci : 0]?.row;
        if (coverRow && ci > 0) await updateAlbum(album, { ...payload, coverId: coverRow.id });
      }
      await qc.invalidateQueries({ queryKey: ['photos'] });
      router.push(`/photos/album/${album.id}`);
    } catch (e2) {
      setErr(errText(e2));
      setBusy(false);
      setProgress(null);
    }
  };

  return (
    <AppPage active="photos">
      <Title icon="photo">Create a Photo Album</Title>
      {!ready ? <div className="gray">Loading…</div> : (
        <form onSubmit={submit}>
          {err ? <div className="err" role="alert"><b>Couldn&rsquo;t create the album</b>{err}</div> : null}
          <table className="form" role="presentation"><tbody>
            <tr><td className="l"><label htmlFor="kp-an">Album Name:</label></td>
              <td><input id="kp-an" type="text" value={name} maxLength={200} required disabled={busy} onChange={(e) => setName(e.target.value)} /></td></tr>
            <tr><td className="l"><label htmlFor="kp-al">Location:</label></td>
              <td><input id="kp-al" type="text" value={location} maxLength={200} disabled={busy} onChange={(e) => setLocation(e.target.value)} /></td></tr>
            <tr><td className="l"><label htmlFor="kp-ad">Description:</label></td>
              <td><textarea id="kp-ad" value={description} maxLength={5000} disabled={busy} onChange={(e) => setDescription(e.target.value)} /></td></tr>
            <tr><td className="l"><label htmlFor="kp-aa">Privacy:</label></td>
              <td><AudienceSelect id="kp-aa" value={aud} onChange={setAud} disabled={busy} /></td></tr>
            <tr><td className="l">Photos:</td>
              <td><PhotoPicker items={items} onItems={setItems} cover={coverKey} onCover={setCover} disabled={busy} progress={progress} /></td></tr>
            <tr><td></td><td><button className="btn b" disabled={busy}>{busy ? 'Creating…' : 'Create Album'}</button>{' '}
              <button type="button" className="btn" disabled={busy} onClick={() => router.push('/photos')}>Cancel</button></td></tr>
          </tbody></table>
        </form>
      )}
    </AppPage>
  );
}
