'use client';
// The 2010 publisher: "Share: Status · Photo · Link · Video · Question". Everything is built into
// a payload and encrypted on this device (lib/content createPost) before it is uploaded.
import { useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Icon } from '@/components/Icon';
import { PhotoAttach, type PhotoAttachHandle } from '@/components/photos/PhotoAttach';
import { AudienceSelect, toAudience } from './AudienceSelect';
import { createPost, wallAudienceId } from '@/lib/content';
import { KeyWaitingError } from '@/lib/keys/keyring';
import { useSession } from '@/lib/keys/session';
import { usePerson } from '@/lib/people';
import { clean, linkPostMedia, notifySafe, snippet } from '@/lib/feed/feed';
import { fetchLinkPreview, normalizeUrl, toPayloadLink, uploadPreviewImage, type LinkPreviewResult } from '@/lib/feed/linkPreview';
import { deleteMedia } from '@/lib/media';
import type { PostKind, PostPayload, PostRow } from '@/lib/types';

type Mode = 'status' | 'photo' | 'link' | 'video' | 'question';
const MAX_TEXT = 8000;

export function Publisher({ wallOwnerId, onPosted, initialMode = 'status', only }:
  { wallOwnerId?: string; onPosted?: (row: PostRow) => void; initialMode?: Mode; only?: Mode[] }) {
  const { userId } = useSession();
  const qc = useQueryClient();
  const target = wallOwnerId ?? userId ?? '';
  const own = target === userId;
  const owner = usePerson(target);
  const modes: [Mode, string, string][] = (own
    ? [['status', 'Status', 'status'], ['photo', 'Photo', 'photo'], ['link', 'Link', 'link'], ['video', 'Video', 'video'], ['question', 'Question', 'question']]
    // Photos live in my own albums (readable by my friends only), so on a friend's Wall: Post and Link.
    : [['status', 'Post', 'status'], ['link', 'Link', 'link']]) as [Mode, string, string][];
  const shown = only ? modes.filter(([m]) => only.includes(m)) : modes;
  const [mode, setMode] = useState<Mode>(shown.some(([m]) => m === initialMode) ? initialMode : 'status');
  const [text, setText] = useState('');
  const [aud, setAud] = useState('friends');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [, setPhotoCount] = useState(0);
  const photos = useRef<PhotoAttachHandle | null>(null);
  // link
  const [url, setUrl] = useState('');
  const [preview, setPreview] = useState<LinkPreviewResult | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  // question
  const [q, setQ] = useState('');
  const [opts, setOpts] = useState(['', '', '']);
  const [allowAdd, setAllowAdd] = useState(true);


  const reset = () => {
    setText(''); setUrl(''); setPreview(null); setPreviewErr(null); setQ(''); setOpts(['', '', '']); setAllowAdd(true);
    photos.current?.clear(); setPhotoCount(0);
  };

  const loadPreview = async () => {
    const u = normalizeUrl(url);
    if (!u) { setPreviewErr('Please enter a valid http:// or https:// link.'); return; }
    setLoadingPreview(true); setPreviewErr(null); setPreview(null);
    try { setPreview(await fetchLinkPreview(u)); }
    catch (e) { setPreviewErr((e as Error).message); setPreview({ url: u }); }
    finally { setLoadingPreview(false); }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !userId) return;
    setErr(null);
    const t = text.trim().slice(0, MAX_TEXT);
    let kind: PostKind = 'status';
    const payload: PostPayload = {};
    const id = crypto.randomUUID();
    let uploaded: string[] = [];
    setBusy(true);
    try {
      if (mode === 'status') {
        if (!t) throw new Error('Write something first.');
        payload.text = t;
      } else if (mode === 'photo') {
        if (!photos.current?.hasFiles()) throw new Error('Choose a photo to upload.');
        kind = 'photo';
        // On a friend's wall the photos go to the same audience as the post: the wall owner's friends.
        payload.photos = await photos.current.upload({ audience: own ? toAudience(aud) : { kind: 'audience', id: await wallAudienceId(target) } });
        if (t) payload.text = t;
      } else if (mode === 'link') {
        const u = preview?.url ?? normalizeUrl(url);
        if (!u) throw new Error('Please enter a valid http:// or https:// link.');
        kind = 'link';
        const image = preview?.image ? await uploadPreviewImage(preview.image).catch(() => undefined) : undefined;
        if (image) uploaded = [image.path];
        payload.link = toPayloadLink(preview ?? { url: u }, image);
        if (t) payload.text = t;
      } else if (mode === 'question') {
        const qt = q.trim();
        if (!qt) throw new Error('Ask a question first.');
        const options = [...new Set(opts.map((o) => o.trim().slice(0, 80)).filter(Boolean))].slice(0, 10);
        kind = 'question';
        payload.question = { text: qt.slice(0, 300), options, allowAdd: allowAdd || options.length === 0 };
      } else {
        throw new Error('Video sharing is coming soon.');
      }
      const row = await createPost({ id, kind, payload: clean(payload), wallOwnerId: own ? undefined : target, audience: own ? toAudience(aud) : { kind: 'friends' } });
      if (uploaded.length) await linkPostMedia(uploaded, row.id);
      if (!own) await notifySafe(target, 'wall_post', 'post', row.id, snippet(payload.text ?? payload.link?.title, 60));
      reset();
      onPosted?.(row);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['feed'] }), qc.invalidateQueries({ queryKey: ['wall'] }), qc.invalidateQueries({ queryKey: ['kind'] }),
      ]);
    } catch (x) {
      if (uploaded.length) await deleteMedia(uploaded).catch(() => undefined);
      if (x instanceof KeyWaitingError) {
        setErr(`You can write on ${owner?.name ?? 'this'}'s Wall once ${owner?.name?.split(' ')[0] ?? 'their'} device has shared their key with you. Try again soon.`);
      } else setErr((x as Error).message || 'Something went wrong. Please try again.');
    } finally { setBusy(false); }
  };

  const placeholder = own ? 'What’s on your mind?' : 'Write something...';
  return (
    <div className="pub">
      <div className="tabs" role="tablist" aria-label="Share">
        <b>Share:</b>
        {shown.map(([k, l, i]) => (
          <a key={k} role="tab" tabIndex={0} aria-selected={k === mode} className={k === mode ? 'on' : ''}
            onClick={() => { setMode(k); setErr(null); }} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setMode(k); setErr(null); } }}>
            <Icon name={i} />{l}
          </a>
        ))}
      </div>
      <form onSubmit={(e) => void submit(e)}>
        <div className="box">
          {err && <div className="err" role="alert" style={{ margin: '0 0 4px' }}>{err}</div>}
          {mode === 'status' && (
            <textarea aria-label={placeholder} placeholder={placeholder} value={text} maxLength={MAX_TEXT} onChange={(e) => setText(e.target.value)} />
          )}
          {mode === 'photo' && (
            <>
              <PhotoAttach handleRef={photos} onChange={setPhotoCount} />
              <textarea aria-label="Say something about this photo" placeholder="Say something about this photo..." value={text} maxLength={MAX_TEXT} onChange={(e) => setText(e.target.value)} />
            </>
          )}
          {mode === 'link' && (
            <>
              <div className="kw-linkrow">
                <input type="text" inputMode="url" placeholder="http://" aria-label="Link" value={url}
                  onChange={(e) => { setUrl(e.target.value); setPreview(null); setPreviewErr(null); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void loadPreview(); } }} />
                <button type="button" className="btn" disabled={loadingPreview || !url.trim()} onClick={() => void loadPreview()}>{loadingPreview ? 'Loading…' : 'Attach'}</button>
              </div>
              {previewErr && <div className="row">{previewErr} You can still share the link without a preview.</div>}
              {preview && (preview.title || preview.description) && <PreviewCard p={preview} />}
              <textarea aria-label="Say something about this link" placeholder="Say something about this link..." value={text} maxLength={MAX_TEXT} onChange={(e) => setText(e.target.value)} />
              <div className="row small">Previews are fetched through Kithwall so the site never sees your IP address.</div>
            </>
          )}
          {mode === 'video' && (
            <div className="row"><Icon name="video" /> Video sharing is coming soon. Videos will be encrypted on your device, just like photos.</div>
          )}
          {mode === 'question' && (
            <>
              <input type="text" placeholder="Ask something..." aria-label="Question" value={q} maxLength={300} onChange={(e) => setQ(e.target.value)} />
              <div className="row">Poll options (optional):</div>
              {opts.map((o, i) => (
                <input key={i} type="text" placeholder="+ Add an option" aria-label={`Option ${i + 1}`} value={o} maxLength={80}
                  onChange={(e) => { const n = [...opts]; n[i] = e.target.value; if (i === n.length - 1 && e.target.value && n.length < 10) n.push(''); setOpts(n); }} />
              ))}
              <label className="row"><input type="checkbox" checked={allowAdd} onChange={(e) => setAllowAdd(e.target.checked)} /> Allow friends to add options</label>
            </>
          )}
        </div>
        <div className="bar">
          {own ? <AudienceSelect value={aud} onChange={setAud} />
            : <span className="lock"><Icon name="lock" /> {owner ? `${owner.name}'s friends` : 'Friends'}</span>}
          <button className="btn b" disabled={busy || mode === 'video'}>
            {busy ? 'Sharing…' : mode === 'question' ? 'Ask Question' : own ? 'Share' : 'Post'}
          </button>
        </div>
      </form>
    </div>
  );
}

function PreviewCard({ p }: { p: LinkPreviewResult }) {
  const src = p.image ? `data:${p.image.mime};base64,${p.image.data}` : null;
  return (
    <div className="att kw-preview">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {src && /^image\/(jpeg|png|gif|webp)$/.test(p.image!.mime) ? <span className="th"><img src={src} width={90} height={68} alt="" style={{ objectFit: 'cover' }} /></span> : null}
      <div className="ad"><b className="at">{p.title}</b>{p.site}{p.description ? <><br />{p.description}</> : null}</div>
    </div>
  );
}

