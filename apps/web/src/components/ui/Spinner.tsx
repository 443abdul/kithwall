'use client';
import { useT } from '@/i18n';

/** Indeterminate progress. Announced to screen readers with `label` (default "Loading…"). */
export function Spinner({ label, size }: { label?: string; size?: number }) {
  const t = useT();
  return (
    <svg className="k-spinner" viewBox="0 0 24 24" width={size} height={size} role="img" aria-label={label ?? t('common.loading')}>
      <circle className="k-spinner-track" cx="12" cy="12" r="9" />
      <circle className="k-spinner-arc" cx="12" cy="12" r="9" />
    </svg>
  );
}

/** Full-area centred spinner for loading screens. */
export function LoadingScreen({ label }: { label?: string }) {
  return (
    <div className="k-loading" role="status">
      <Spinner label={label} size={32} />
    </div>
  );
}
