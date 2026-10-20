'use client';
// Avatar: a picture (blob:/data: URL of an already-decrypted image — never a network URL), else initials,
// else a neutral silhouette. The tint is picked from the name so people are easy to tell apart.

export interface AvatarProps {
  name?: string | null;
  /** Local object URL of a decrypted picture. */
  src?: string | null;
  size?: number;
  className?: string;
  /** Decorative by default (the name is usually printed next to it). */
  label?: string;
}

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  // Graphemes, so emoji and combining marks (Devanagari, Bengali) stay intact.
  const seg = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
  const first = (w: string) => (seg ? [...seg.segment(w)][0]?.segment ?? '' : Array.from(w)[0] ?? '');
  const a = first(words[0]!);
  const b = words.length > 1 ? first(words[words.length - 1]!) : '';
  return (a + b).toLocaleUpperCase();
}

function tone(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return h % 4;
}

export function Avatar({ name, src, size = 40, className, label }: AvatarProps) {
  const text = name ? initials(name) : '';
  return (
    <span
      className={className ? `k-avatar ${className}` : 'k-avatar'}
      style={{ ['--av' as string]: `${size}px` }}
      data-tone={name ? tone(name) : 1}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" width={size} height={size} />
      ) : text ? (
        <span>{text}</span>
      ) : (
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden><circle cx="12" cy="8.5" r="4.5" /><path d="M3.5 22c.6-5 4.1-8 8.5-8s7.9 3 8.5 8z" /></svg>
      )}
    </span>
  );
}
