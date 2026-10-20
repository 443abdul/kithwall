import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

export interface EmptyStateProps {
  icon: IconName;
  title: ReactNode;
  body?: ReactNode;
  /** Buttons / links. */
  actions?: ReactNode;
  headingLevel?: 1 | 2 | 3;
}

/** Friendly "nothing here (yet)" panel with an illustration tile, copy and optional actions. */
export function EmptyState({ icon, title, body, actions, headingLevel = 2 }: EmptyStateProps) {
  const H = `h${headingLevel}` as const;
  return (
    <div className="k-empty">
      <div className="k-empty-art" aria-hidden><Icon name={icon} /></div>
      <H className="k-empty-title">{title}</H>
      {body ? <p className="k-empty-body">{body}</p> : null}
      {actions ? <div className="k-empty-actions">{actions}</div> : null}
    </div>
  );
}
