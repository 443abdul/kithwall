// Messenger-specific icons in the Kithwall 2 icon style (24px grid, 1.75 stroke, currentColor), kept
// beside the messenger so the shared set in components/ui/Icon.tsx stays small. Directional ones flip in RTL.
import type { ReactElement } from 'react';

const P = {
  send: <path d="M4.5 12 3 4.5 20.5 12 3 19.5zM4.5 12h7" />,
  attach: <path d="M20 11.5l-7.8 7.8a5 5 0 0 1-7.1-7.1l8.1-8.1a3.3 3.3 0 0 1 4.7 4.7l-8.1 8.1a1.7 1.7 0 0 1-2.4-2.4l7.4-7.4" />,
  reply: <><path d="M9.5 6 4 11.5 9.5 17" /><path d="M4.5 11.5h9a6.5 6.5 0 0 1 6.5 6.5v.5" /></>,
  smile: <><circle cx="12" cy="12" r="8.5" /><path d="M8.5 14.2a4.2 4.2 0 0 0 7 0" /><path d="M9 9.8v.01M15 9.8v.01" /></>,
  pin: <><path d="M9 3.5h6l-1 5.5 3.5 3v1.5h-11V12L10 9z" /><path d="M12 13.5v7" /></>,
  trash: <><path d="M4.5 6.5h15M9.5 6.5V4.5h5v2M6.5 6.5l1 13h9l1-13" /><path d="M10 10.5v6M14 10.5v6" /></>,
  flag: <><path d="M5.5 21V4M5.5 4.5h11l-2 4 2 4h-11" /></>,
  video: <><rect x="3" y="6" width="13" height="12" rx="2.5" /><path d="M16 10.5 21 7.5v9l-5-3" /></>,
  play: <path d="M8 5.5v13l10-6.5z" />,
  archive: <><rect x="3.5" y="4.5" width="17" height="4.5" rx="1.5" /><path d="M5 9v9.5a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5V9M10 13h4" /></>,
  doubleCheck: <path d="M2.5 12.5l4 4L15 8M10.5 15.5l1 1L21 7.5" />,
  download: <><path d="M12 4v11.5M7.5 11l4.5 4.5 4.5-4.5" /><path d="M5 19.5h14" /></>,
} satisfies Record<string, ReactElement>;

export type ChatIconName = keyof typeof P;
const FLIP = new Set<ChatIconName>(['send', 'reply']);
const FILLED = new Set<ChatIconName>(['play']);

export function ChatIcon({ name, size, title }: { name: ChatIconName; size?: number; title?: string }) {
  const fill = FILLED.has(name);
  return (
    <svg
      className="k-icon" viewBox="0 0 24 24" width={size} height={size}
      fill={fill ? 'currentColor' : 'none'} stroke={fill ? 'none' : 'currentColor'} strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" focusable="false"
      aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}
      data-flip={FLIP.has(name) ? '' : undefined}
    >
      {title ? <title>{title}</title> : null}
      {P[name]}
    </svg>
  );
}
