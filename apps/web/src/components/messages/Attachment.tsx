'use client';
// An encrypted photo attached to a message: downloaded, decrypted on device, shown from a blob:
// URL. Retries for a short while, because the sender links the file to the message right after
// the message row is created and we may have been faster.
import { useEffect, useState } from 'react';
import { fileUrl } from '@/lib/media';
import type { FileRef } from '@/lib/types';

const DELAYS = [700, 1500, 3000, 6000];

/** Parents key this by `file.path`, so state resets when the file changes. */
export function Attachment({ file, small = false }: { file: FileRef; small?: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = (n: number) => {
      fileUrl(file).then((u) => { if (live) setUrl(u); }).catch(() => {
        if (!live) return;
        if (n < DELAYS.length) timer = setTimeout(() => attempt(n + 1), DELAYS[n]);
        else setFailed(true);
      });
    };
    attempt(0);
    return () => { live = false; if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.path]);
  const box = small ? 120 : 240;
  const ratio = file.w && file.h ? file.h / file.w : 0.75;
  const w = Math.min(box, file.w ?? box);
  const h = Math.round(w * ratio);
  if (failed) return <span className="kwm-att kwm-att-x" style={{ width: w, height: Math.max(40, Math.min(h, box)) }}>Photo unavailable</span>;
  if (!url) return <span className="kwm-att kwm-att-wait" style={{ width: w, height: Math.min(h, box * 1.4) }} aria-label="Loading photo" />;
  return (
    <a className="kwm-att" href={url} target="_blank" rel="noopener noreferrer" title="Open full size">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt="Photo attachment" width={w} height={h} style={{ maxHeight: box * 1.4, objectFit: 'cover' }} />
    </a>
  );
}
