'use client';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

export interface ListItemProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Leading icon (in a soft tile) or any node (e.g. an <Avatar/>). */
  icon?: IconName;
  leading?: ReactNode;
  trailing?: ReactNode;
  href?: string;
  onClick?: () => void;
  /** Show a chevron (navigation rows). Defaults to true when href is set. */
  chevron?: boolean;
}

/** A row in a list: settings entries, people, conversations. Renders a link, a button, or a plain row. */
export function ListItem({ title, subtitle, icon, leading, trailing, href, onClick, chevron }: ListItemProps) {
  const showChevron = chevron ?? !!href;
  const inner = (
    <>
      {icon ? <span className="k-item-lead k-item-icon"><Icon name={icon} /></span> : leading ? <span className="k-item-lead">{leading}</span> : null}
      <span className="k-item-body">
        <span className="k-item-title">{title}</span>
        {subtitle ? <span className="k-item-sub">{subtitle}</span> : null}
      </span>
      {trailing || showChevron ? (
        <span className="k-item-trail">{trailing}{showChevron ? <Icon name="forward" /> : null}</span>
      ) : null}
    </>
  );
  if (href) return <Link className="k-item" href={href}>{inner}</Link>;
  if (onClick) return <button type="button" className="k-item" onClick={onClick}>{inner}</button>;
  return <div className="k-item">{inner}</div>;
}

export function List({ children, label }: { children: ReactNode; label?: string }) {
  return <ul className="k-list" aria-label={label}>{children}</ul>;
}
