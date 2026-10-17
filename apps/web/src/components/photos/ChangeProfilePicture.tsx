'use client';
// "Change Picture" dialog: upload a new profile picture or choose an existing photo.
// Owned by the photos work; used by the profile page and Edit Profile.
import '@/styles/photos.css';
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '@/lib/keys/session';
import { usePerson } from '@/lib/people';
import { MAX_PHOTO_BYTES } from '@/lib/media';
import {
  albumPhotos, listAlbums, profilePictureFromPhoto, readAlbum, readPhoto, saveAvatar, setProfilePicture,
  type AlbumRow, type PhotoRow,
} from '@/lib/photos';
import { Dialog, LazyImg, errText, useKeysReady } from './common';

type Step = { k: 'menu' } | { k: 'crop'; file: File } | { k: 'albums' } | { k: 'album'; album: AlbumRow };

export function ChangeProfilePicture({ onClose }: { onClose: () => void }) {
  const { userId } = useSession();
  const me = usePerson(userId);
  const [step, setStep] = useState<Step>({ k: 'menu' });
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const hasAvatar = !!me?.info?.avatar;

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label); setErr(null);
    try { await fn(); onClose(); } catch (e) { setErr(errText(e)); setBusy(null); }
  };

  const onFile = (f: File | undefined) => {
    if (!f) return;
    if (!f.type.startsWith('image/')) { setErr('Please choose an image file.'); return; }
    if (f.size > MAX_PHOTO_BYTES) { setErr('Photos must be 20 MB or smaller.'); return; }
    setErr(null);
    setStep({ k: 'crop', file: f });
  };

  let body: React.ReactNode;
  let buttons: React.ReactNode = <button className="btn" disabled={!!busy} onClick={onClose}>Cancel</button>;
  if (step.k === 'menu') {
    body = (
      <div className="kp-cpp-opts">
        <div>
          <h5>Upload a Photo</h5>
          <div className="gray" style={{ marginBottom: 6 }}>Choose a picture from your computer or phone (JPG, PNG or GIF, up to 20 MB). It&rsquo;s encrypted on this device and only your friends can see it.</div>
          <input ref={fileInput} type="file" accept="image/*" aria-label="Choose a profile picture" disabled={!!busy}
            onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ''; }} />
        </div>
        <div>
          <h5>Choose from your photos</h5>
          <button className="btn" disabled={!!busy} onClick={() => setStep({ k: 'albums' })}>Choose from My Albums</button>
        </div>
        {hasAvatar && (
          <div>
            <h5>Remove your picture</h5>
            <button className="btn" disabled={!!busy} onClick={() => run('Removing…', () => saveAvatar(undefined))}>Remove Your Picture</button>
          </div>
        )}
      </div>
    );
  } else if (step.k === 'crop') {
    body = <Cropper file={step.file} busy={!!busy} onCancel={() => setStep({ k: 'menu' })}
      onDone={(blob) => run('Encrypting and uploading…', async () => { const files = await setProfilePicture(blob); await saveAvatar(files); })} />;
    buttons = null;
  } else if (step.k === 'albums') {
    body = <AlbumChooser onPick={(a) => setStep({ k: 'album', album: a })} />;
    buttons = <><button className="btn" disabled={!!busy} onClick={() => setStep({ k: 'menu' })}>Back</button>{buttons}</>;
  } else {
    body = <PhotoChooser album={step.album} disabled={!!busy}
      onPick={(row) => run('Saving…', async () => {
        const d = readPhoto(row);
        if (!d.ok) throw new Error('This photo couldn’t be opened.');
        const files = await profilePictureFromPhoto(row, d.value);
        await saveAvatar(files);
      })} />;
    buttons = <><button className="btn" disabled={!!busy} onClick={() => setStep({ k: 'albums' })}>Back</button>{buttons}</>;
  }

  return (
    <Dialog title="Change Profile Picture" onClose={onClose} busy={!!busy} wide buttons={buttons}>
      {body}
      {busy ? <div className="gray" role="status" style={{ marginTop: 8 }}>{busy}</div> : null}
      {err ? <div className="kp-errs" role="alert">{err}</div> : null}
    </Dialog>
  );
}

function AlbumChooser({ onPick }: { onPick: (a: AlbumRow) => void }) {
  const ready = useKeysReady();
  const { userId } = useSession();
  const q = useQuery({ queryKey: ['photos', 'albums', 'owner', userId], enabled: ready && !!userId, queryFn: () => listAlbums({ ownerId: userId! }) });
  if (q.isLoading) return <div className="gray">Loading your albums…</div>;
  const albums = (q.data ?? []).map((a) => ({ a, d: readAlbum(a) })).filter((x) => x.d.ok);
  if (!albums.length) return <div className="gray">You don&rsquo;t have any albums yet.</div>;
  return (
    <div className="kp-pickgrid" role="list">
      {albums.map(({ a, d }) => (
        <button key={a.id} role="listitem" onClick={() => onPick(a)}>
          <AlbumCoverThumb album={a} />
          <div style={{ padding: 3 }}><b>{d.ok ? d.value.name : ''}</b></div>
        </button>
      ))}
    </div>
  );
}

function AlbumCoverThumb({ album }: { album: AlbumRow }) {
  const ready = useKeysReady();
  const q = useQuery({ queryKey: ['photos', 'albumPhotos', album.id], enabled: ready, queryFn: () => albumPhotos(album.id) });
  const first = (q.data ?? []).map((r) => readPhoto(r)).find((d) => d.ok);
  return <LazyImg file={first && first.ok ? first.value.files.thumb : null} alt="" />;
}

function PhotoChooser({ album, onPick, disabled }: { album: AlbumRow; onPick: (r: PhotoRow) => void; disabled: boolean }) {
  const ready = useKeysReady();
  const q = useQuery({ queryKey: ['photos', 'albumPhotos', album.id], enabled: ready, queryFn: () => albumPhotos(album.id) });
  if (q.isLoading) return <div className="gray">Loading photos…</div>;
  const rows = (q.data ?? []).map((r) => ({ r, d: readPhoto(r) })).filter((x) => x.d.ok);
  if (!rows.length) return <div className="gray">This album is empty.</div>;
  return (
    <>
      <div className="gray" style={{ marginBottom: 6 }}>Click a photo to make it your profile picture.</div>
      <div className="kp-pickgrid">
        {rows.map(({ r, d }, i) => (
          <button key={r.id} disabled={disabled} aria-label={(d.ok && d.value.caption) || `Photo ${i + 1}`} onClick={() => onPick(r)}>
            <LazyImg file={d.ok ? d.value.files.thumb : null} alt={d.ok ? d.value.caption ?? '' : ''} />
          </button>
        ))}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------------------
// Square crop: drag to move, slider / +/- to zoom, arrow keys to nudge. Output 720×720 JPEG
// (re-encoded again by the uploader, which also strips metadata).
const VIEW = 240;
const OUT = 720;

function Cropper({ file, onDone, onCancel, busy }: { file: File; onDone: (b: Blob) => void; onCancel: () => void; busy: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [bmp, setBmp] = useState<ImageBitmap | null>(null);
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [off, setOff] = useState({ x: 0, y: 0 }); // top-left of the scaled image relative to the view (≤ 0)
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  useEffect(() => {
    let live = true;
    let made: ImageBitmap | null = null;
    createImageBitmap(file, { imageOrientation: 'from-image' })
      .then((b) => { made = b; if (live) setBmp(b); else b.close(); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; made?.close(); };
  }, [file]);

  const base = bmp ? VIEW / Math.min(bmp.width, bmp.height) : 1;
  const scale = base * zoom;
  const clamp = (o: { x: number; y: number }, s = scale) => {
    if (!bmp) return o;
    const w = bmp.width * s, h = bmp.height * s;
    return { x: Math.min(0, Math.max(VIEW - w, o.x)), y: Math.min(0, Math.max(VIEW - h, o.y)) };
  };

  // Centre the image when it loads.
  useEffect(() => {
    if (!bmp) return;
    const s = VIEW / Math.min(bmp.width, bmp.height);
    setOff({ x: (VIEW - bmp.width * s) / 2, y: (VIEW - bmp.height * s) / 2 });
  }, [bmp]);

  useEffect(() => {
    const c = canvas.current;
    if (!c || !bmp) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = VIEW * dpr; c.height = VIEW * dpr;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#eee'; ctx.fillRect(0, 0, VIEW, VIEW);
    ctx.drawImage(bmp, off.x, off.y, bmp.width * scale, bmp.height * scale);
  }, [bmp, off, scale]);

  const setZoomKeep = (z: number) => {
    const nz = Math.min(4, Math.max(1, z));
    // keep the centre of the view fixed while zooming
    const cx = (VIEW / 2 - off.x) / scale, cy = (VIEW / 2 - off.y) / scale;
    const ns = base * nz;
    setZoom(nz);
    setOff(clamp({ x: VIEW / 2 - cx * ns, y: VIEW / 2 - cy * ns }, ns));
  };

  const finish = async () => {
    if (!bmp) return;
    const c = document.createElement('canvas');
    c.width = OUT; c.height = OUT;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const k = OUT / VIEW;
    ctx.drawImage(bmp, off.x * k, off.y * k, bmp.width * scale * k, bmp.height * scale * k);
    const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/jpeg', 0.9));
    if (blob) onDone(blob);
  };

  if (failed) return <div className="kp-errs" role="alert">This image couldn&rsquo;t be read. Try a JPG or PNG. <button className="btn" onClick={onCancel}>Back</button></div>;
  return (
    <div>
      <div className="kp-crop">
        <div>
          <canvas ref={canvas} tabIndex={0} role="img" aria-label="Crop preview. Drag or use the arrow keys to move, plus and minus to zoom."
            style={{ width: VIEW, height: VIEW }}
            onPointerDown={(e) => { (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, ox: off.x, oy: off.y }; }}
            onPointerMove={(e) => { const d = drag.current; if (d) setOff(clamp({ x: d.ox + e.clientX - d.x, y: d.oy + e.clientY - d.y })); }}
            onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
            onWheel={(e) => setZoomKeep(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1))}
            onKeyDown={(e) => {
              const step = e.shiftKey ? 20 : 5;
              const m: Record<string, [number, number]> = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
              if (m[e.key]) { e.preventDefault(); setOff(clamp({ x: off.x + m[e.key]![0], y: off.y + m[e.key]![1] })); }
              else if (e.key === '+' || e.key === '=') { e.preventDefault(); setZoomKeep(zoom * 1.1); }
              else if (e.key === '-') { e.preventDefault(); setZoomKeep(zoom / 1.1); }
            }} />
          <div className="z">
            <label htmlFor="kp-zoom" className="gray">Zoom</label>
            <input id="kp-zoom" type="range" min={1} max={4} step={0.01} value={zoom} onChange={(e) => setZoomKeep(Number(e.target.value))} />
          </div>
        </div>
        <div style={{ flex: 1, minWidth: 160 }} className="gray">
          Drag the picture to choose the square part that will be shown as your profile picture.
          {!bmp && <div style={{ marginTop: 8 }}>Loading…</div>}
        </div>
      </div>
      <div style={{ marginTop: 10, textAlign: 'right' }}>
        <button className="btn b" disabled={!bmp || busy} onClick={() => void finish()}>Save Picture</button>{' '}
        <button className="btn" disabled={busy} onClick={onCancel}>Back</button>
      </div>
    </div>
  );
}
