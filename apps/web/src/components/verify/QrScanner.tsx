'use client';
// Camera QR scanner for safety numbers, using the browser's own BarcodeDetector (Chrome on Android,
// ChromeOS and macOS, Safari 17+ on some devices). Nothing is uploaded: frames stay in the browser.
// Where BarcodeDetector or a camera isn't available, the verify screen offers comparing digits instead.
import { useEffect, useRef, useState } from 'react';
import { useT } from '@/i18n';
import { Callout } from '@/components/ui/Callout';

interface DetectedCode { rawValue: string }
interface Detector { detect(source: CanvasImageSource): Promise<DetectedCode[]> }
interface DetectorClass { new (opts: { formats: string[] }): Detector; getSupportedFormats?: () => Promise<string[]> }

function detectorClass(): DetectorClass | null {
  if (typeof window === 'undefined') return null;
  const C = (window as unknown as { BarcodeDetector?: DetectorClass }).BarcodeDetector;
  return typeof C === 'function' ? C : null;
}

/** True when this browser can scan QR codes with the camera. */
export async function canScanQr(): Promise<boolean> {
  const C = detectorClass();
  if (!C || !navigator.mediaDevices?.getUserMedia) return false;
  try {
    const formats = (await C.getSupportedFormats?.()) ?? ['qr_code'];
    return formats.includes('qr_code');
  } catch { return false; }
}

export function QrScanner({ onResult, label }: { onResult: (text: string) => void; label: string }) {
  const t = useT();
  const video = useRef<HTMLVideoElement>(null);
  const done = useRef(onResult);
  const [error, setError] = useState<'denied' | 'failed' | null>(null);
  useEffect(() => { done.current = onResult; }, [onResult]);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const el = video.current;
    const C = detectorClass();
    if (!C) { queueMicrotask(() => setError('failed')); return; }
    const detector = new C({ formats: ['qr_code'] });

    const tick = async () => {
      if (stopped) return;
      if (el && el.readyState >= 2) {
        try {
          const codes = await detector.detect(el);
          const hit = codes.find((c) => typeof c.rawValue === 'string' && c.rawValue.length > 0);
          if (hit && !stopped) { stopped = true; done.current(hit.rawValue); return; }
        } catch { /* a frame that couldn't be read: try the next one */ }
      }
      timer = setTimeout(() => void tick(), 250);
    };

    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      .then(async (s) => {
        if (stopped) { s.getTracks().forEach((tr) => tr.stop()); return; }
        stream = s;
        if (!el) return;
        el.srcObject = s;
        await el.play().catch(() => undefined);
        void tick();
      })
      .catch((e: unknown) => {
        const name = (e as { name?: string } | null)?.name;
        setError(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'failed');
      });

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      stream?.getTracks().forEach((tr) => tr.stop());
      if (el) el.srcObject = null;
    };
  }, []);

  if (error) return <Callout tone="warning">{error === 'denied' ? t('verify.cameraDenied') : t('verify.cameraFailed')}</Callout>;
  return (
    <div className="k-verify-scan">
      <video ref={video} className="k-verify-video" muted playsInline aria-label={label} />
      <span className="k-verify-scan-frame" aria-hidden="true" />
    </div>
  );
}
