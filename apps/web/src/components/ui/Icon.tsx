// Kithwall 2 icon set: 24px grid, 1.75 stroke, round caps/joins, currentColor. Inline SVG as JSX
// (no innerHTML, no network). Directional icons carry `flip` so they mirror in right-to-left layouts.
// The v1 16px icons stay in components/Icon.tsx until the v1 pages are deleted (phase 2).
import type { ReactElement } from 'react';

const P: Record<string, ReactElement> = {
  home: <><path d="M3.5 10.5 12 4l8.5 6.5" /><path d="M5.5 9v10.5h13V9" /><path d="M10 19.5v-5.5h4v5.5" /></>,
  circles: <><circle cx="9" cy="10" r="5" /><circle cx="15" cy="14" r="5" /></>,
  messages: <><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 3.5V17h0A2.5 2.5 0 0 1 4 14.5z" /><path d="M8.5 9.5h7M8.5 12.5h4.5" /></>,
  activity: <><path d="M6 10a6 6 0 1 1 12 0c0 4.5 2 6 2 6H4s2-1.5 2-6" /><path d="M10 19.5a2.2 2.2 0 0 0 4 0" /></>,
  you: <><circle cx="12" cy="8.5" r="4" /><path d="M4.5 20c.8-3.8 3.8-6 7.5-6s6.7 2.2 7.5 6" /></>,
  users: <><circle cx="9" cy="8.5" r="3.5" /><path d="M2.5 19.5c.6-3.3 3.2-5.5 6.5-5.5s5.9 2.2 6.5 5.5" /><path d="M15.5 5.2a3.5 3.5 0 0 1 0 6.6M17.5 14.3c2 .8 3.4 2.6 3.9 5.2" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.5A7.6 7.6 0 0 0 7 6.5l-2.4-1-2 3.4 2 1.6a7.6 7.6 0 0 0 0 3l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5a7.6 7.6 0 0 0 2.6-1.5l2.4 1 2-3.4z" /></>,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  back: <path d="M15 5l-7 7 7 7" />,
  forward: <path d="M9 5l7 7-7 7" />,
  down: <path d="M6 9l6 6 6-6" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  more: <><circle cx="5.5" cy="12" r="1.25" /><circle cx="12" cy="12" r="1.25" /><circle cx="18.5" cy="12" r="1.25" /></>,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  lock: <><rect x="5" y="10.5" width="14" height="10" rx="2.5" /><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" /><path d="M12 14.5v2" /></>,
  key: <><circle cx="8" cy="15" r="4" /><path d="M11 12l8.5-8.5M16.5 6.5l2.5 2.5M14.5 8.5l2 2" /></>,
  shield: <><path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.2-7.5 9.5-4.3-1.3-7.5-4.9-7.5-9.5V6z" /><path d="M9 12l2 2 4-4" /></>,
  fingerprint: <><path d="M6.5 7.5A7 7 0 0 1 19 11.5c0 1.6-.2 3.2-.6 4.7" /><path d="M5 11.5c0-.7.1-1.4.3-2M5 15c.2-1 .3-2.2.3-3.5" /><path d="M8.5 19a14 14 0 0 0 1-7.5 2.5 2.5 0 0 1 5 0c0 1.2-.1 2.4-.3 3.5" /><path d="M12 11.5c0 3.4-.7 6.4-2 8.5M13.8 18.5c-.2.7-.5 1.4-.8 2" /><path d="M8.6 5a7 7 0 0 1 2.4-.5" /></>,
  heart: <path d="M12 20s-7.5-4.6-7.5-10.1A4.2 4.2 0 0 1 12 7.5a4.2 4.2 0 0 1 7.5 2.4C19.5 15.4 12 20 12 20z" />,
  globe: <><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c-2.5 2.5-3.5 5.4-3.5 8.5s1 6 3.5 8.5c2.5-2.5 3.5-5.4 3.5-8.5s-1-6-3.5-8.5z" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4" /></>,
  moon: <path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z" />,
  monitor: <><rect x="3" y="4.5" width="18" height="12" rx="2" /><path d="M8.5 20h7M12 16.5V20" /></>,
  palette: <><path d="M12 3.5a8.5 8.5 0 0 0 0 17c1.2 0 1.8-.8 1.8-1.7 0-1.3-1.2-1.8-1.2-3 0-1 .8-1.8 1.8-1.8h2.4a3.7 3.7 0 0 0 3.7-3.7c0-3.8-3.8-6.8-8.5-6.8z" /><circle cx="7.5" cy="11.5" r="1" /><circle cx="10" cy="7.5" r="1" /><circle cx="14.5" cy="7.5" r="1" /></>,
  sparkle: <path d="M12 3.5l1.8 5.2 5.2 1.8-5.2 1.8L12 17.5l-1.8-5.2L5 10.5l5.2-1.8zM18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" />,
  link: <><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>,
  qr: <><rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" /><rect x="4" y="14" width="6" height="6" rx="1" /><path d="M14 14h2.5v2.5H14zM17.5 17.5H20V20h-2.5zM14 19.5h1M19.5 14v1" /></>,
  copy: <><rect x="8.5" y="8.5" width="11" height="11" rx="2" /><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" /></>,
  share: <><path d="M12 15V3.5M7.5 8 12 3.5 16.5 8" /><path d="M5 12.5v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" /></>,
  camera: <><path d="M4 8.5A2 2 0 0 1 6 6.5h2l1.5-2h5l1.5 2h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" /><circle cx="12" cy="13" r="3.5" /></>,
  image: <><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><circle cx="9" cy="10" r="1.8" /><path d="M20.5 16l-5-5-9 8.5" /></>,
  mail: <><rect x="3.5" y="5.5" width="17" height="13" rx="2.5" /><path d="M4 7l8 6 8-6" /></>,
  eye: <><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="3" /></>,
  eyeOff: <><path d="M4 4l16 16" /><path d="M10.6 6.6A9 9 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.8 3.6M6.4 7.5C3.9 9.3 2.5 12 2.5 12S6 18.5 12 18.5c1.6 0 3-.5 4.2-1.1" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></>,
  alert: <><path d="M12 4 2.8 19.5h18.4z" /><path d="M12 10v4M12 17v.01" /></>,
  info: <><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5.5M12 7.5v.01" /></>,
  logout: <><path d="M14 4.5H7A2.5 2.5 0 0 0 4.5 7v10A2.5 2.5 0 0 0 7 19.5h7" /><path d="M10.5 12h10M17 8.5l3.5 3.5-3.5 3.5" /></>,
  refresh: <><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" /><path d="M19.5 4.5v4h-4" /></>,
  gift: <><rect x="4" y="9" width="16" height="11" rx="2" /><path d="M3 9h18M12 9v11" /><path d="M12 9c-1.5-3.5-5.5-4.5-5.5-2S10 9 12 9zM12 9c1.5-3.5 5.5-4.5 5.5-2S14 9 12 9z" /></>,
  edit: <><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="M13.5 6.5l4 4" /></>,
  calendar: <><rect x="3.5" y="5" width="17" height="15" rx="2.5" /><path d="M3.5 9.5h17M8 3v4M16 3v4" /></>,
  sealed: <><rect x="3.5" y="5.5" width="17" height="13" rx="2.5" /><path d="M4 7l8 5.5L20 7" /><circle cx="17.5" cy="17" r="3.8" /><path d="M16 17l1.1 1.1 2-2" /></>,
  wave: <path d="M7.5 12.5V6.8a1.3 1.3 0 0 1 2.6 0v4.7M10.1 11V5.3a1.3 1.3 0 0 1 2.6 0V11M12.7 11V6.5a1.3 1.3 0 0 1 2.6 0V12M15.3 10a1.3 1.3 0 0 1 2.6 0v4a6.5 6.5 0 0 1-6.5 6.5h-.6a6 6 0 0 1-4.6-2.2L3.5 15a1.4 1.4 0 0 1 2-2l2 1.8" />,
  noAds: <><circle cx="12" cy="12" r="8.5" /><path d="M6 6l12 12" /></>,
  code: <path d="M8.5 7.5 4 12l4.5 4.5M15.5 7.5 20 12l-4.5 4.5M13.5 5l-3 14" />,
  phone: <><rect x="6.5" y="2.5" width="11" height="19" rx="2.5" /><path d="M10.5 18.5h3" /></>,
  layout: <><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><path d="M9 4.5v15M9 10h11.5" /></>,
  bolt: <path d="M13 2.5 4.5 13.5H11l-1 8 8.5-11H12z" />,
};

export type IconName = keyof typeof P;

const FLIP = new Set<string>(['back', 'forward', 'logout']);

export interface IconProps {
  name: IconName;
  /** Accessible name. Omit for decorative icons (the default: aria-hidden). */
  title?: string;
  size?: number;
  className?: string;
  strokeWidth?: number;
}

export function Icon({ name, title, size, className, strokeWidth = 1.75 }: IconProps) {
  const fillIcon = name === 'more';
  return (
    <svg
      className={className ? `k-icon ${className}` : 'k-icon'}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill={fillIcon ? 'currentColor' : 'none'}
      stroke={fillIcon ? 'none' : 'currentColor'}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      data-flip={FLIP.has(name) ? '' : undefined}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      {P[name]}
    </svg>
  );
}

export const ICON_NAMES = Object.keys(P) as IconName[];
