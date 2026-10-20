import type { CSSProperties } from 'react';

/** Placeholder shape while content loads. Decorative; pair with a status message for screen readers. */
export function Skeleton({ width, height, circle, text, style }: {
  width?: number | string; height?: number | string; circle?: boolean; text?: boolean; style?: CSSProperties;
}) {
  return (
    <span
      className={`k-skel${circle ? ' k-skel-circle' : ''}${text ? ' k-skel-text' : ''}`}
      style={{ inlineSize: width, blockSize: height, ...style }}
      aria-hidden
    />
  );
}
