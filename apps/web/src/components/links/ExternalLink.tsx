'use client';
// A user-supplied link. The real address stays in href (status bar, long-press, screen readers), but a tap,
// Enter or middle-click opens the "Leaving Kithwall" sheet first (lib/links/leave.ts). Anything that isn't
// http(s) — data:, javascript:, file: … — is rendered as plain text and can never be followed.
import type { MouseEvent, ReactNode } from 'react';
import { EXTERNAL_REL, isNavigableHref, prefetchLeaveSheet, requestLeave } from '@/lib/links/leave';

export interface ExternalLinkProps {
  href: string | null | undefined;
  /** The text the person sees, when it isn't simply `children` (used to spot text/address mismatches). */
  text?: string | null;
  children: ReactNode;
  className?: string;
  dir?: 'ltr' | 'rtl' | 'auto';
  title?: string;
  'aria-label'?: string;
}

export function ExternalLink({ href, text, children, className, dir, title, 'aria-label': ariaLabel }: ExternalLinkProps) {
  if (!isNavigableHref(href)) return <span className={className} dir={dir}>{children}</span>;
  const shown = text ?? (typeof children === 'string' ? children : null);
  const go = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented) return;
    if (requestLeave(href, shown)) { e.preventDefault(); e.stopPropagation(); }
  };
  return (
    <a href={href} target="_blank" rel={EXTERNAL_REL} referrerPolicy="no-referrer" className={className} dir={dir} title={title}
      aria-label={ariaLabel} onClick={go} onAuxClick={(e) => { if (e.button === 1) go(e); }}
      onPointerEnter={prefetchLeaveSheet} onFocus={prefetchLeaveSheet}>
      {children}
    </a>
  );
}
