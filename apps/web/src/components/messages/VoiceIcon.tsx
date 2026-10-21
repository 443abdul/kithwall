// Voice-note icons in the Kithwall 2 icon style (24px grid, 1.75 stroke, currentColor). Kept beside the
// recorder and player so the shared sets stay small. The chevron points to the inline start (flips in RTL).
import type { ReactElement } from 'react';

const P = {
  mic: <><rect x="9" y="3" width="6" height="11.5" rx="3" /><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3" /></>,
  stop: <rect x="6.5" y="6.5" width="11" height="11" rx="2.5" />,
  play: <path d="M8 5.5v13l10-6.5z" />,
  pause: <><rect x="6.5" y="5.5" width="4" height="13" rx="1.2" /><rect x="13.5" y="5.5" width="4" height="13" rx="1.2" /></>,
  lock: <><rect x="5.5" y="10.5" width="13" height="9.5" rx="2.5" /><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" /></>,
  trash: <><path d="M4.5 6.5h15M9.5 6.5V4.5h5v2M6.5 6.5l1 13h9l1-13" /><path d="M10 10.5v6M14 10.5v6" /></>,
  chevron: <path d="M14.5 6 8.5 12l6 6" />,
  up: <path d="M6 14.5 12 8.5l6 6" />,
  send: <path d="M4.5 12 3 4.5 20.5 12 3 19.5zM4.5 12h7" />,
} satisfies Record<string, ReactElement>;

export type VoiceIconName = keyof typeof P;
const FLIP = new Set<VoiceIconName>(['chevron', 'send']);
const FILLED = new Set<VoiceIconName>(['play', 'pause', 'stop']);

export function VoiceIcon({ name, size }: { name: VoiceIconName; size?: number }) {
  const fill = FILLED.has(name);
  return (
    <svg
      className="k-icon" viewBox="0 0 24 24" width={size} height={size}
      fill={fill ? 'currentColor' : 'none'} stroke={fill ? 'none' : 'currentColor'} strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" focusable="false" aria-hidden
      data-flip={FLIP.has(name) ? '' : undefined}
    >
      {P[name]}
    </svg>
  );
}
