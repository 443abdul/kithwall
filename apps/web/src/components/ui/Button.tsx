'use client';
import Link from 'next/link';
import type { ButtonHTMLAttributes, ComponentProps, ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { Spinner } from './Spinner';
import { Badge } from './Badge';
import { cx } from './cx';

export type ButtonVariant = 'primary' | 'secondary' | 'soft' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

interface CommonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  icon?: IconName;
  iconEnd?: IconName;
  children?: ReactNode;
  className?: string;
}

function classes({ variant = 'secondary', size = 'md', block, className }: CommonProps) {
  return cx('k-btn', `k-btn-${variant}`, size !== 'md' && `k-btn-${size}`, block && 'k-btn-block', className);
}

function Inner({ icon, iconEnd, children }: CommonProps) {
  return (
    <>
      {icon ? <Icon name={icon} /> : null}
      {children != null ? <span>{children}</span> : null}
      {iconEnd ? <Icon name={iconEnd} /> : null}
    </>
  );
}

export interface ButtonProps extends CommonProps, Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'className'> {
  /** Shows a spinner, keeps the width, and blocks clicks. */
  busy?: boolean;
  busyLabel?: string;
}

export function Button({ variant, size, block, icon, iconEnd, children, className, busy, busyLabel, type = 'button', disabled, ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={classes({ variant, size, block, className })}
      disabled={disabled || busy}
      data-busy={busy ? '' : undefined}
      aria-busy={busy || undefined}
      {...rest}
    >
      <Inner icon={icon} iconEnd={iconEnd}>{children}</Inner>
      {busy ? <span className="k-btn-spin"><Spinner label={busyLabel} /></span> : null}
    </button>
  );
}

export interface ButtonLinkProps extends CommonProps, Omit<ComponentProps<typeof Link>, 'children' | 'className'> {}

/** A link that looks like a button (navigation, not an action). */
export function ButtonLink({ variant, size, block, icon, iconEnd, children, className, ...rest }: ButtonLinkProps) {
  return (
    <Link className={classes({ variant, size, block, className })} {...rest}>
      <Inner icon={icon} iconEnd={iconEnd}>{children}</Inner>
    </Link>
  );
}

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon: IconName;
  /** Required accessible name (also the tooltip). */
  label: string;
  variant?: 'ghost' | 'soft' | 'primary';
  size?: 'sm' | 'md';
  badge?: number | boolean;
}

export function IconButton({ icon, label, variant = 'ghost', size = 'md', badge, className, type = 'button', ...rest }: IconButtonProps) {
  return (
    <button
      type={type}
      className={cx('k-iconbtn', variant !== 'ghost' && `k-iconbtn-${variant}`, size === 'sm' && 'k-iconbtn-sm', className)}
      aria-label={label}
      title={label}
      {...rest}
    >
      <Icon name={icon} />
      {badge ? <Badge count={typeof badge === 'number' ? badge : undefined} dot={badge === true} /> : null}
    </button>
  );
}
