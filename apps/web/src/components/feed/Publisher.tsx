'use client';
// The 2010 publisher: "Share: Status · Photo · Link · Video · Question". Everything is built into
// a payload and encrypted on this device (lib/content createPost) before it is uploaded.
//
// Status: the first http(s) link typed or pasted is previewed automatically (through our no-log
// proxy) and attached as a link card or click-to-play video; "×" removes it.
// Video: the file is encrypted on this device and uploaded in parts (components/feed/VideoAttach).
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Icon } from '@/components/Icon';
import { PhotoAttach, type PhotoAttachHandle } from '@/components/photos/PhotoAttach';
import { AudienceSelect, toAudience } from './AudienceSelect';
import { EmbedView, LinkCardView } from './MediaAtt';
import { VideoAttach, type VideoAttachHandle } from './VideoAttach';
import { createPost, wallAudienceId } from '@/lib/content';
import { KeyWaitingError } from '@/lib/keys/keyring';
import { useSession } from '@/lib/keys/session';
import { usePerson } from '@/lib/people';
import { clean, linkPostMedia, notifySafe, snippet } from '@/lib/feed/feed';
import { loadLinkDraft, normalizeUrl, toPayloadLink, uploadPreparedImage, type LinkDraft } from '@/lib/feed/linkPreview';
import { firstUrl } from '@/lib/feed/linkMeta';
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
    // Photos/videos live in my own storage (readable by my friends only), so on a friend's Wall: Post and Link.
    : [['status', 'Post', 'status'], ['link', 'Link', 'link']]) as [Mode, string, string][];
  const shown = only ? modes.filter(([m]) => only.includes(m)) : modes;
  const [mode, setMode] = useState<Mode>(shown.some(([m]) => m === initialMode) ? initialMode : 'status');
  const [text, setText] = useState('');
  const [aud, setAud] = useState('friends');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [, setPhotoCount] = useState(0);
  const photos = useRef<PhotoAttachHandle | null>(null);
  // link tab
  const [url, setUrl] = useState('');
  const [preview, setPreview] = useState<LinkDraft | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  // status tab: automatic preview of the first link
  const [auto, setAuto] = useState<LinkDraft | null>(null);
  const [autoLoading, setAutoLoading] = useState<string | null>(null);
  const autoReq = useRef<{ url: string; ac: AbortController; p: Promise<LinkDraft | null> } | null>(null);
  const autoSkip = useRef(new Set<string>());
  const pasted = useRef(false);
  // video tab
  const video = useRef<VideoAttachHandle | null>(null);
  const [hasVideo, setHasVideo] = useState(false);
  const [progress, setProgress] = useState<{ label: string; pct?: number } | null>(null);
  // question
  const [q, setQ] = useState('');
  const [opts, setOpts] = useState(['', '', '']);
  const [allowAdd, setAllowAdd] = useState(true);

  const cancelAuto = () => { autoReq.current?.ac.abort(); autoReq.current = null; setAutoLoading(null); };

  const reset = () => {
    setText(''); setUrl(''); setPreview(null); setPreviewErr(null); setQ(''); setOpts(['', '', '']); setAllowAdd(true);
    photos.current?.clear(); setPhotoCount(0);
    video.current?.clear(); setHasVideo(false);
    cancelAuto(); setAuto(null); autoSkip.current.clear();
  };

  const loadPreview = async () => {
    const u = normalizeUrl(url);
    if (!u) { setPreviewErr('Please enter a valid http:// or https:// link.'); return; }
    setLoadingPreview(true); setPreviewErr(null); setPreview(null);
    try { setPreview(await loadLinkDraft(u)); }
    catch (e) { setPreviewErr((e as Error).message); }
    finally { setLoadingPreview(false); }
  };

  // Auto-preview after a short pause: sooner once the URL is followed by a space, or when pasted.
  useEffect(() => {
    if (mode !== 'status' || auto) return;
    const found = firstUrl(text);
    const u = found ? normalizeUrl(found.url) : null;
    if (autoReq.current && autoReq.current.url !== u) {
      autoReq.current.ac.abort();
      autoReq.current = null;
    }
    if (!found || !u || autoSkip.current.has(u) || autoReq.current) return;
    const delay = pasted.current ? 50 : found.complete ? 400 : 1200;
    pasted.current = false;
    const timer = setTimeout(() => {
      const ac = new AbortController();
      setAutoLoading(u);
      const p = loadLinkDraft(u, ac.signal).then((d) => {
        if (autoReq.current?.url === u) { autoReq.current = null; setAuto(d); setAutoLoading(null); }
        return d;
      }).catch(() => {
        autoSkip.current.add(u);
        if (autoReq.current?.url === u) { autoReq.current = null; setAutoLoading(null); }
        return null;
      });
      autoReq.current = { url: u, ac, p };
    }, delay);
    return () => clearTimeout(timer);
  }, [text, mode, auto]);

  useEffect(() => () => autoReq.current?.ac.abort(), []);

  const removeAuto = () => {
    if (auto) autoSkip.current.add(auto.preview.url);
    const f = firstUrl(text);
    const u = f ? normalizeUrl(f.url) : null;
    if (u) autoSkip.current.add(u);
    setAuto(null);
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
        // A preview that is still loading is awaited, so the link isn't posted bare.
        const pending = autoReq.current;
        const d = auto ?? (pending ? await pending.p : null);
        if (pending && autoReq.current === pending) { autoReq.current = null; setAutoLoading(null); }
        if (!t && !d) throw new Error('Write something first.');
        if (d) {
          kind = 'link';
          const image = d.image ? await uploadPreparedImage(d.image).catch(() => undefined) : undefined;
          if (image) uploaded = [image.path];
          payload.link = toPayloadLink(d.preview, image, d.embed);
        }
        if (t) payload.text = t;
      } else if (mode === 'photo') {
        if (!photos.current?.hasFiles()) throw new Error('Choose a photo to upload.');
        kind = 'photo';
        // On a friend's wall the photos go to the same audience as the post: the wall owner's friends.
        payload.photos = await photos.current.upload({ audience: own ? toAudience(aud) : { kind: 'audience', id: await wallAudienceId(target) } });
        if (t) payload.text = t;
      } else if (mode === 'link') {
        const u = preview?.preview.url ?? normalizeUrl(url);
        if (!u) throw new Error('Please enter a valid http:// or https:// link.');
        kind = 'link';
        const image = preview?.image ? await uploadPreparedImage(preview.image).catch(() => undefined) : undefined;
        if (image) uploaded = [image.path];
        payload.link = toPayloadLink(preview?.preview ?? { url: u }, image, preview?.embed);
        if (t) payload.text = t;
      } else if (mode === 'video') {
        if (!video.current?.hasFile()) throw new Error('Choose a video to upload.');
        kind = 'video';
        setProgress({ label: 'Encrypting on your device…' });
        const r = await video.current.upload((sent, total) => setProgress({ label: 'Uploading', pct: Math.min(100, Math.floor((sent / total) * 100)) }));
        uploaded = r.paths;
        payload.video = r.video;
        if (t) payload.text = t;
        setProgress({ label: 'Sharing…', pct: 100 });
      } else if (mode === 'question') {
        const qt = q.trim();
        if (!qt) throw new Error('Ask a question first.');
        const options = [...new Set(opts.map((o) => o.trim().slice(0, 80)).filter(Boolean))].slice(0, 10);
        kind = 'question';
        payload.question = { text: qt.slice(0, 300), options, allowAdd: allowAdd || options.length === 0 };
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
    } finally { setBusy(false); setProgress(null); }
  };

  const pick = (k: Mode) => { if (busy) return; setMode(k); setErr(null); };
  const placeholder = own ? 'What’s on your mind?' : 'Write something...';
  const uploading = progress?.label === 'Uploading' && progress.pct !== undefined;
  return (
    <div className="pub">
      <div className="tabs" role="tablist" aria-label="Share">
        <b>Share:</b>
        {shown.map(([k, l, i]) => (
          <a key={k} role="tab" tabIndex={0} aria-selected={k === mode} className={k === mode ? 'on' : ''}
            onClick={() => pick(k)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(k); } }}>
            <Icon name={i} />{l}
          </a>
        ))}
      </div>
      <form onSubmit={(e) => void submit(e)}>
        <div className="box">
          {err && <div className="err" role="alert" style={{ margin: '0 0 4px' }}>{err}</div>}
          {mode === 'status' && (
            <>
              <textarea aria-label={placeholder} placeholder={placeholder} value={text} maxLength={MAX_TEXT}
                onPaste={() => { pasted.current = true; }} onChange={(e) => setText(e.target.value)} />
              {autoLoading && !auto && <div className="kw-pub-note" role="status">Loading link preview…</div>}
              {auto && <DraftCard draft={auto} onRemove={removeAuto} />}
            </>
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
              {preview && <DraftCard draft={preview} onRemove={() => setPreview(null)} />}
              <textarea aria-label="Say something about this link" placeholder="Say something about this link..." value={text} maxLength={MAX_TEXT} onChange={(e) => setText(e.target.value)} />
              {!preview && <div className="row small">Previews are fetched through Kithwall so the site never sees your IP address.</div>}
            </>
          )}
          {mode === 'video' && (
            <>
              <VideoAttach handleRef={video} disabled={busy} onChange={setHasVideo} />
              {progress && (
                <div role="status" aria-live="polite">
                  <div className="kw-pub-note">{progress.label}{uploading ? ` ${progress.pct}%` : ''}</div>
                  <div className="kw-upbar"><span style={{ width: `${progress.pct ?? 0}%` }} /></div>
                </div>
              )}
              {hasVideo && (
                <textarea aria-label="Say something about this video" placeholder="Say something about this video..." value={text} maxLength={MAX_TEXT}
                  disabled={busy} onChange={(e) => setText(e.target.value)} />
              )}
            </>
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
          <button className="btn b" disabled={busy || (mode === 'video' && !hasVideo)}>
            {busy ? (uploading ? `Uploading ${progress.pct}%` : 'Sharing…') : mode === 'question' ? 'Ask Question' : own ? 'Share' : 'Post'}
          </button>
        </div>
      </form>
    </div>
  );
}

/** A link preview attached to the post being written (its image was already re-encoded on this device). */
function DraftCard({ draft, onRemove }: { draft: LinkDraft; onRemove: () => void }) {
  const [img, setImg] = useState<string | null>(null);
  const blob = draft.image?.blob;
  useEffect(() => {
    if (!blob) return;
    const u = URL.createObjectURL(blob);
    setImg(u);
    return () => { URL.revokeObjectURL(u); setImg(null); };
  }, [blob]);
  const p = draft.preview;
  return (
    <>
      {draft.embed
        ? <EmbedView embed={draft.embed} url={p.url} title={p.title} description={p.description} img={img} hasImage={!!draft.image} onRemove={onRemove} />
        : <LinkCardView url={p.url} title={p.title} description={p.description} site={p.site} img={img} hasImage={!!draft.image}
            imgW={draft.image?.w} imgH={draft.image?.h} onRemove={onRemove} />}
      <div className="kw-pub-note">Previews are fetched through Kithwall, so the site never sees your IP address.</div>
    </>
  );
}
