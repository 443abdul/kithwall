'use client';
import type { ReactNode } from 'react';
import { useFormat, useT } from '@/i18n';
import { cx } from './cx';

export interface BadgeProps {
  /** A number (shows "99+" above 99) — or use `children` for a text label. */
  count?: number;
  dot?: boolean;
  tone?: 'danger' | 'accent' | 'soft' | 'neutral' | 'success';
  children?: ReactNode;
  className?: string;
}

export function Badge({ count, dot, tone = 'danger', children, className }: BadgeProps) {
  const t = useT();
  const f = useFormat();
  const cls = cx('k-badge', tone !== 'danger' && `k-badge-${tone}`, dot && 'k-badge-dot', children != null && 'k-badge-label', className);
  if (dot) return <span className={cls} role="status" aria-label={t('common.new')} />;
  if (children != null) return <span className={cls}>{children}</span>;
  if (!count) return null;
  const shown = count > 99 ? `${f.number(99)}+` : f.number(count);
  return <span className={cls} aria-label={t('common.unread', { count })}>{shown}</span>;
}
