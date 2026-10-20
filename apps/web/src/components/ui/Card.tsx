import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from './cx';

export interface CardProps extends HTMLAttributes<HTMLElement> {
  as?: 'div' | 'section' | 'article' | 'aside' | 'li';
  padding?: 'normal' | 'tight' | 'flush';
  tone?: 'default' | 'raised' | 'accent';
  title?: string;
  children?: ReactNode;
}

export function Card({ as: Tag = 'div', padding = 'normal', tone = 'default', title, className, children, ...rest }: CardProps) {
  return (
    <Tag
      className={cx('k-card', padding !== 'normal' && `k-card-${padding}`, tone !== 'default' && `k-card-${tone}`, className)}
      {...rest}
    >
      {title ? <h2 className="k-card-title">{title}</h2> : null}
      {children}
    </Tag>
  );
}
