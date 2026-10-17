'use client';
// Choose images (file input + drag & drop), preview them locally, caption them, pick a cover.
// Nothing leaves the device here; uploading (re-encode → encrypt → upload) happens in lib/photos.
import '@/styles/photos.css';
import { useEffect, useId, useRef, useState } from 'react';

import { MAX_PHOTO_BYTES } from '@/lib/media';

export interface PickedPhoto { key: string; file: File; url: string; caption: string }

const ACCEPT = 'image/jpeg,image/png,image/gif,image/webp,image/avif,image/bmp';

export function revokePicked(items: PickedPhoto[]) { items.forEach((p) => URL.revokeObjectURL(p.url)); }

/** Owner-side state for picked photos; previews are revoked on unmount. */
export function usePicked() {
  const [items, setItems] = useState<PickedPhoto[]>([]);
  const latest = useRef(items);
  useEffect(() => { latest.current = items; });
  useEffect(() => () => revokePicked(latest.current), []);
  return [items, setItems] as const;
}

/** Turn chosen files into picked items (validated). Returns the items and any error messages. */
export function pickFiles(files: Iterable<File>, already: number, max: number): { items: PickedPhoto[]; errors: string[] } {
  const items: PickedPhoto[] = [];
  const errors: string[] = [];
  for (const f of files) {
    if (!f.type.startsWith('image/')) { errors.push(`${f.name}: not an image.`); continue; }
    if (f.size > MAX_PHOTO_BYTES) { errors.push(`${f.name}: photos must be 20 MB or smaller.`); continue; }
    if (already + items.length >= max) { errors.push(`You can add up to ${max} photos at a time.`); break; }
    items.push({ key: crypto.randomUUID(), file: f, url: URL.createObjectURL(f), caption: '' });
  }
  return { items, errors };
}

export function PhotoPicker({ items, onItems, max = 200, cover, onCover, disabled = false, compact = false, progress }: {
  items: PickedPhoto[];
  onItems: (next: PickedPhoto[]) => void;
  max?: number;
  cover?: string | null;
  onCover?: (key: string) => void;
  disabled?: boolean;
  compact?: boolean;
  progress?: { done: number; total: number } | null;
}) {
  const [over, setOver] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();

  const add = (files: FileList | File[] | null) => {
    if (!files || disabled) return;
    const { items: next, errors: errs } = pickFiles([...files], items.length, max);
    setErrors(errs);
    if (next.length) onItems([...items, ...next]);
  };
  const remove = (key: string) => {
    const it = items.find((p) => p.key === key);
    if (it) URL.revokeObjectURL(it.url);
    onItems(items.filter((p) => p.key !== key));
  };

  return (
    <div>
      <div className={`kp-drop${over ? ' on' : ''}`}
        onDragOver={(e) => { e.preventDefault(); if (!disabled) setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); add(e.dataTransfer.files); }}>
        <input ref={input} id={id} type="file" accept={ACCEPT} multiple disabled={disabled}
          onChange={(e) => { add(e.target.files); e.target.value = ''; }} />
        <button type="button" className="btn" disabled={disabled} onClick={() => input.current?.click()}>
          {items.length ? 'Add More Photos' : 'Select Photos'}
        </button>
        {!compact && <span> or drag photos here.</span>}
        <div className="small" style={{ marginTop: 4 }}>
          Up to {max} photos, 20 MB each. Location and camera details are removed and photos are encrypted on this device before upload.
        </div>
      </div>
      {errors.length ? <div className="kp-errs" role="alert">{errors.map((e, i) => <div key={i}>{e}</div>)}</div> : null}
      {progress ? (
        <div aria-live="polite">
          <div className="kp-bar" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}>
            <i style={{ width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` }} />
          </div>
          <div className="gray">Encrypting and uploading photo {Math.min(progress.done + 1, progress.total)} of {progress.total}…</div>
        </div>
      ) : null}
      {items.length > 0 && (
        <div className="kp-picks">
          {items.map((p, i) => (
            <div className="kp-pick" key={p.key}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={p.url} alt={p.caption || `Selected photo ${i + 1}`} />
              <button type="button" className="x" aria-label={`Remove photo ${i + 1}`} title="Remove" disabled={disabled} onClick={() => remove(p.key)}>&times;</button>
              <textarea aria-label={`Caption for photo ${i + 1}`} placeholder="Say something about this photo…" value={p.caption}
                maxLength={2000} disabled={disabled}
                onChange={(e) => onItems(items.map((q) => (q.key === p.key ? { ...q, caption: e.target.value } : q)))} />
              {onCover && (
                <label className="cv"><input type="radio" name={`${id}-cover`} checked={cover === p.key} disabled={disabled}
                  onChange={() => onCover(p.key)} /> Album cover</label>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
