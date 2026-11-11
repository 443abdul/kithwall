'use client';
// "Blur faces" for a photo that is about to be posted or sent (post composer, chat attachments).
//
// Opening it looks for faces on this device (lib/photo/faces.ts) and covers each one; tapping a face shows
// it again, and dragging on the photo adds a box of your own (number plates, documents and house numbers
// are NOT found automatically, and the screen says so). The picture on screen is the real result: the
// boxes are already replaced by the mosaic that will be in the file (lib/photo/blur.ts). "Use this photo"
// makes that file from the full-size original and hands it back; the caller swaps it in, so only the covered
// picture is ever encrypted and uploaded.
//
// Keyboard and screen readers: every box is a button in reading order. A face is a toggle (covered / shown).
// One of your own boxes moves with the arrow keys, resizes with Shift + arrow keys and goes away with Delete
// or its "Remove" button; "Add a box" makes one without dragging.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useT } from '@/i18n';
import { clampBox, coverBoxes, coverPhoto, photoCanvas, type Box } from '@/lib/photo/blur';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { Spinner } from '@/components/ui/Spinner';
import { cx } from '@/components/ui/cx';

interface Region { id: number; kind: 'face' | 'own'; box: Box; on: boolean }
type Finding = 'working' | 'done' | 'unavailable';

/** The working copy shown on screen: plenty for judging the cover, small enough to redraw at once. */
const VIEW_SIDE = 1280;
const MIN_BOX = 0.03;
const STEP = 0.01;

function Editor({ file, busy, setBusy, onClose, onDone }: {
  file: File; busy: boolean; setBusy: (b: boolean) => void; onClose: () => void; onDone: (covered: File) => void;
}) {
  const t = useT();
  const view = useRef<HTMLCanvasElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const base = useRef<HTMLCanvasElement | null>(null);
  const nextId = useRef(1);
  const [ready, setReady] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [finding, setFinding] = useState<Finding>('working');
  const [regions, setRegions] = useState<Region[]>([]);
  const [draft, setDraft] = useState<Box | null>(null);
  const [failed, setFailed] = useState(false);
  const focusNext = useRef<number | null>(null);

  // Decode the photo once, then look for faces (the detector's data is fetched now, not before).
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const { canvas } = await photoCanvas(file, VIEW_SIDE);
        if (!live) return;
        base.current = canvas;
        setReady('ready');
        const { detectFaces } = await import('@/lib/photo/faces');
        const found = await detectFaces(canvas);
        if (!live) return;
        setRegions((own) => [...found.faces.map((box) => ({ id: nextId.current++, kind: 'face' as const, box, on: true })), ...own]);
        setFinding(found.engine === 'none' ? 'unavailable' : 'done');
      } catch {
        if (live) { if (!base.current) setReady('failed'); setFinding('unavailable'); }
      }
    })();
    return () => { live = false; const c = base.current; if (c) { c.width = c.height = 0; } base.current = null; };
  }, [file]);

  // The canvas always shows the actual result: the photo with every active box already covered.
  useEffect(() => {
    const src = base.current;
    const dst = view.current;
    if (ready !== 'ready' || !src || !dst) return;
    if (dst.width !== src.width || dst.height !== src.height) { dst.width = src.width; dst.height = src.height; }
    const ctx = dst.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    ctx.drawImage(src, 0, 0);
    const boxes = regions.filter((r) => r.on).map((r) => r.box);
    if (draft && draft.w >= MIN_BOX / 2 && draft.h >= MIN_BOX / 2) boxes.push(draft);
    coverBoxes(ctx, dst.width, dst.height, boxes);
  }, [ready, regions, draft]);

  useEffect(() => {
    if (focusNext.current === null) return;
    stage.current?.querySelector<HTMLElement>(`[data-region="${focusNext.current}"]`)?.focus();
    focusNext.current = null;
  }, [regions]);

  const point = useCallback((e: PointerEvent) => {
    const r = stage.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  }, []);

  // Dragging on the photo itself draws a new box.
  const drawFrom = useRef<{ x: number; y: number } | null>(null);
  function stageDown(e: PointerEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget || busy || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drawFrom.current = point(e);
    setDraft({ ...drawFrom.current, w: 0, h: 0 });
  }
  function stageMove(e: PointerEvent<HTMLDivElement>) {
    const from = drawFrom.current;
    if (!from) return;
    const p = point(e);
    setDraft(clampBox({ x: from.x, y: from.y, w: p.x - from.x, h: p.y - from.y }));
  }
  function stageUp() {
    const d = draft;
    drawFrom.current = null;
    setDraft(null);
    if (!d || d.w < MIN_BOX || d.h < MIN_BOX) return;
    const id = nextId.current++;
    focusNext.current = id;
    setRegions((rs) => [...rs, { id, kind: 'own', box: d, on: true }]);
  }

  // Dragging one of your own boxes moves it; dragging its corner resizes it.
  const drag = useRef<{ id: number; mode: 'move' | 'size'; from: { x: number; y: number }; box: Box } | null>(null);
  function boxDown(e: PointerEvent<HTMLElement>, r: Region, mode: 'move' | 'size') {
    if (r.kind !== 'own' || busy) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: r.id, mode, from: point(e), box: r.box };
  }
  function boxMove(e: PointerEvent<HTMLElement>) {
    const d = drag.current;
    if (!d) return;
    const p = point(e);
    const dx = p.x - d.from.x;
    const dy = p.y - d.from.y;
    const box = d.mode === 'move'
      ? { ...d.box, x: Math.min(1 - d.box.w, Math.max(0, d.box.x + dx)), y: Math.min(1 - d.box.h, Math.max(0, d.box.y + dy)) }
      : clampBox({ ...d.box, w: Math.max(MIN_BOX, d.box.w + dx), h: Math.max(MIN_BOX, d.box.h + dy) });
    setRegions((rs) => rs.map((r) => (r.id === d.id ? { ...r, box } : r)));
  }
  const boxUp = () => { drag.current = null; };

  const remove = (id: number) => setRegions((rs) => rs.filter((r) => r.id !== id));
  const toggle = (id: number) => setRegions((rs) => rs.map((r) => (r.id === id ? { ...r, on: !r.on } : r)));

  function boxKey(e: KeyboardEvent<HTMLElement>, r: Region) {
    if (r.kind !== 'own') return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); remove(r.id); return; }
    const dx = e.key === 'ArrowLeft' ? -STEP : e.key === 'ArrowRight' ? STEP : 0;
    const dy = e.key === 'ArrowUp' ? -STEP : e.key === 'ArrowDown' ? STEP : 0;
    if (!dx && !dy) return;
    e.preventDefault();
    const b = r.box;
    const box = e.shiftKey
      ? clampBox({ ...b, w: Math.max(MIN_BOX, b.w + dx), h: Math.max(MIN_BOX, b.h + dy) })
      : { ...b, x: Math.min(1 - b.w, Math.max(0, b.x + dx)), y: Math.min(1 - b.h, Math.max(0, b.y + dy)) };
    setRegions((rs) => rs.map((x) => (x.id === r.id ? { ...x, box } : x)));
  }

  function addBox() {
    const id = nextId.current++;
    focusNext.current = id;
    setRegions((rs) => [...rs, { id, kind: 'own', box: { x: 0.35, y: 0.35, w: 0.3, h: 0.3 }, on: true }]);
  }

  async function use() {
    const boxes = regions.filter((r) => r.on).map((r) => r.box);
    if (!boxes.length) { onClose(); return; }
    setBusy(true);
    setFailed(false);
    try { onDone(await coverPhoto(file, boxes)); }
    catch { setFailed(true); setBusy(false); }
  }

  const faces = regions.filter((r) => r.kind === 'face');
  const own = regions.filter((r) => r.kind === 'own');
  const covered = regions.filter((r) => r.on).length;
  const status = ready === 'failed' ? t('blur.photoFailed')
    : finding === 'working' ? t('blur.finding')
    : finding === 'unavailable' ? t('blur.unavailable')
    : faces.length ? t('blur.found', { count: faces.length }) : t('blur.none');

  return (
      <div className="k-stack">
        <p className="k-blur-status" role="status" aria-live="polite">
          {finding === 'working' && ready !== 'failed' ? <Spinner size={16} /> : null}<span>{status}</span>
        </p>
        {failed ? <Callout tone="danger">{t('blur.failed')}</Callout> : null}
        {ready === 'failed' ? null : (
          <div className="k-blur-frame">
            <div className="k-blur-stage" dir="ltr">
              <canvas ref={view} className="k-blur-canvas" role="img" aria-label={t('blur.canvas', { count: covered })} />
              <div ref={stage} className="k-blur-boxes" onPointerDown={stageDown} onPointerMove={stageMove} onPointerUp={stageUp} onPointerCancel={stageUp}>
                {regions.map((r) => {
                  const n = (r.kind === 'face' ? faces : own).indexOf(r) + 1;
                  const style = { left: `${r.box.x * 100}%`, top: `${r.box.y * 100}%`, width: `${r.box.w * 100}%`, height: `${r.box.h * 100}%` };
                  return r.kind === 'face' ? (
                    <button key={r.id} type="button" data-region={r.id} className={cx('k-blur-box is-face', !r.on && 'is-off')} style={style} disabled={busy}
                      aria-pressed={r.on} aria-label={t('blur.face', { n, total: faces.length })} title={r.on ? t('blur.faceShow') : t('blur.faceCover')}
                      onClick={() => toggle(r.id)}>
                      {r.on ? null : <Icon name="eye" />}
                    </button>
                  ) : (
                    <div key={r.id} className="k-blur-box is-own" style={style}>
                      <button type="button" data-region={r.id} className="k-blur-own" disabled={busy} aria-label={t('blur.own', { n })}
                        onKeyDown={(e) => boxKey(e, r)} onPointerDown={(e) => boxDown(e, r, 'move')} onPointerMove={boxMove} onPointerUp={boxUp} onPointerCancel={boxUp} />
                      <button type="button" className="k-blur-x" disabled={busy} aria-label={t('blur.remove', { n })} title={t('blur.remove', { n })} onClick={() => remove(r.id)}>
                        <Icon name="close" />
                      </button>
                      <span className="k-blur-grip" aria-hidden onPointerDown={(e) => boxDown(e, r, 'size')} onPointerMove={boxMove} onPointerUp={boxUp} onPointerCancel={boxUp} />
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
        <div className="k-row-wrap">
          <Button size="sm" variant="secondary" icon="plus" disabled={busy || ready !== 'ready'} onClick={addBox}>{t('blur.add')}</Button>
          {regions.length ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRegions([])}>{t('blur.clear')}</Button> : null}
        </div>
        <ul className="k-safety-bullets k-small k-muted">
          <li>{t('blur.hintFaces')}</li>
          <li>{t('blur.hintOwn')}</li>
          <li>{t('blur.hintKeys')}</li>
        </ul>
        <Callout tone="warning">{t('blur.limits')}</Callout>
        <div className="k-blur-actions">
          <Button variant="ghost" disabled={busy} onClick={onClose}>{t('blur.cancel')}</Button>
          <Button variant="primary" busy={busy} disabled={ready !== 'ready' || finding === 'working' || !covered} onClick={() => void use()}>{t('blur.use')}</Button>
        </div>
      </div>
  );
}

/**
 * The editor for one photo (null: closed). Nothing of it, the detector included, is loaded or drawn until
 * a photo is opened in it; the dialog stays in the document afterwards so focus returns to where it was.
 */
export function BlurEditor({ file, onClose, onDone }: { file: File | null; onClose: () => void; onDone: (covered: File) => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={!!file} onClose={onClose} title={t('blur.title')} dismissible={!busy} className="k-blur-dialog">
      {file ? (
        <Editor key={`${file.name}:${file.size}:${file.lastModified}`} file={file} busy={busy} setBusy={setBusy} onClose={onClose}
          onDone={(f) => { setBusy(false); onDone(f); }} />
      ) : null}
    </Dialog>
  );
}
