// 16px icons from the 2010 reference, as JSX (no innerHTML: the CSP enforces Trusted Types).
import type { ReactElement } from 'react';

const I: Record<string, ReactElement> = {
  feed: <><rect x="1.5" y="2.5" width="13" height="11" fill="#fff" stroke="#6d84b4" /><path d="M4 5.5h8M4 8h8M4 10.5h5" stroke="#3b5998" strokeWidth="1.3" /></>,
  msg: <><rect x="1.5" y="3.5" width="13" height="9" fill="#fff" stroke="#6d84b4" /><path d="M1.5 3.5l6.5 5 6.5-5" fill="none" stroke="#6d84b4" /></>,
  event: <><rect x="1.5" y="2.5" width="13" height="12" fill="#fff" stroke="#999" /><rect x="1.5" y="2.5" width="13" height="3.5" fill="#d33" /><text x="8" y="13" fontSize="7" textAnchor="middle" fill="#333" fontFamily="tahoma" fontWeight="bold">17</text></>,
  photo: <><rect x="1.5" y="3.5" width="13" height="10" fill="#bfe0f5" stroke="#6d84b4" /><path d="M2 13l4-5 3 3 2-2 3 4z" fill="#5a9a3a" /><circle cx="11.5" cy="6.5" r="1.3" fill="#f5d34b" /></>,
  friends: <><circle cx="6" cy="5.5" r="2.6" fill="#6d84b4" /><path d="M1.5 14c0-3.5 2-5 4.5-5s4.5 1.5 4.5 5z" fill="#6d84b4" /><circle cx="11" cy="6" r="2.2" fill="#9cb0d6" /><path d="M9.5 9.4c2.6-.6 5 .6 5 4.6h-3z" fill="#9cb0d6" /></>,
  group: <><circle cx="3.8" cy="6" r="2" fill="#9cb0d6" /><circle cx="12.2" cy="6" r="2" fill="#9cb0d6" /><path d="M0.5 13c0-3 1.5-4 3.3-4s3 1 3.5 2zM15.5 13c0-3-1.5-4-3.3-4s-3 1-3.5 2z" fill="#9cb0d6" /><circle cx="8" cy="5" r="2.4" fill="#3b5998" /><path d="M4 14.5c0-3.5 1.8-5 4-5s4 1.5 4 5z" fill="#3b5998" /></>,
  place: <><path d="M8 1.5a4.5 4.5 0 0 0-4.5 4.5c0 3.5 4.5 8.5 4.5 8.5s4.5-5 4.5-8.5A4.5 4.5 0 0 0 8 1.5z" fill="#3b5998" /><circle cx="8" cy="6" r="1.8" fill="#fff" /></>,
  game: <><path d="M2 7l6-4.5L14 7v7.5H2z" fill="#c0392b" /><rect x="6" y="9.5" width="4" height="5" fill="#fff" /><path d="M6 9.5l4 5M10 9.5l-4 5" stroke="#c0392b" /></>,
  question: <><circle cx="8" cy="8" r="6.5" fill="#3b5998" /><text x="8" y="11.5" textAnchor="middle" fontSize="10" fontWeight="bold" fill="#fff" fontFamily="tahoma">?</text></>,
  page: <><path d="M3 1.5v13" stroke="#666" strokeWidth="1.4" /><path d="M3.5 2.5h9l-2 3 2 3h-9z" fill="#e2a400" /></>,
  note: <><path d="M3 1.5h7l3 3v10H3z" fill="#fff" stroke="#999" /><path d="M5 6h6M5 8.5h6M5 11h4" stroke="#6d84b4" /></>,
  poke: <><circle cx="8" cy="8" r="6.5" fill="#f2c94c" /><path d="M5.5 10c1.5 1.3 3.5 1.3 5 0" stroke="#7a5a00" fill="none" /><circle cx="6" cy="6.5" r=".9" fill="#7a5a00" /><circle cx="10" cy="6.5" r=".9" fill="#7a5a00" /></>,
  app: <><rect x="2" y="2" width="5" height="5" fill="#6d84b4" /><rect x="9" y="2" width="5" height="5" fill="#9cb0d6" /><rect x="2" y="9" width="5" height="5" fill="#9cb0d6" /><rect x="9" y="9" width="5" height="5" fill="#6d84b4" /></>,
  like: <path d="M2 7h2.5v7H2zM5.5 7.5l3-5c1 0 1.7.7 1.4 2L9.4 7H13c.8 0 1.4.8 1.2 1.6l-1.1 4.6c-.2.6-.7.8-1.2.8H5.5z" fill="#5f78ab" />,
  comment: <path d="M2 3h12v8H7l-3 3v-3H2z" fill="#fff" stroke="#6d84b4" />,
  info: <><circle cx="8" cy="8" r="6.5" fill="#6d84b4" /><rect x="7.2" y="7" width="1.6" height="5" fill="#fff" /><circle cx="8" cy="4.8" r="1" fill="#fff" /></>,
  wall: <><rect x="1.5" y="2.5" width="13" height="11" fill="#fff" stroke="#6d84b4" /><path d="M4 6h8M4 9h6" stroke="#6d84b4" /></>,
  work: <><rect x="1.5" y="5" width="13" height="8.5" rx="1" fill="#a0784a" /><rect x="5.5" y="2.5" width="5" height="3" fill="none" stroke="#7a5a3a" strokeWidth="1.2" /></>,
  edu: <><path d="M8 3L1 6.5 8 10l7-3.5z" fill="#333" /><path d="M4 8v3c2 1.5 6 1.5 8 0V8l-4 2z" fill="#555" /></>,
  home: <path d="M8 2L1.5 8h2v6H7v-4h2v4h3.5V8h2z" fill="#6d84b4" />,
  cake: <><rect x="2.5" y="8" width="11" height="6" fill="#e9a3c9" /><rect x="2.5" y="8" width="11" height="2" fill="#fff" /><path d="M8 4.5v3.5" stroke="#999" /><path d="M8 2c.8.8.8 1.6 0 2-.8-.4-.8-1.2 0-2z" fill="#f39c12" /></>,
  heart: <path d="M8 14S1.5 9.8 1.5 5.6A3.3 3.3 0 0 1 8 4.3a3.3 3.3 0 0 1 6.5 1.3C14.5 9.8 8 14 8 14z" fill="#e0457b" />,
  lock: <><rect x="3" y="7" width="10" height="7.5" fill="#888" /><path d="M5 7V5a3 3 0 0 1 6 0v2" fill="none" stroke="#888" strokeWidth="1.6" /></>,
  globe: <><circle cx="8" cy="8" r="6.5" fill="#6d84b4" /><path d="M1.5 8h13M8 1.5c-3 3.5-3 9.5 0 13M8 1.5c3 3.5 3 9.5 0 13" stroke="#fff" fill="none" strokeWidth=".9" /></>,
  link: <path d="M6.5 9.5l3-3M5 8l-1.5 1.5a2.1 2.1 0 0 0 3 3L8 11M11 8l1.5-1.5a2.1 2.1 0 0 0-3-3L8 5" stroke="#6d84b4" strokeWidth="1.5" fill="none" />,
  video: <><rect x="1.5" y="4" width="9.5" height="8" rx="1" fill="#6d84b4" /><path d="M11 7l3.5-2v6L11 9z" fill="#6d84b4" /></>,
  status: <path d="M2 14l1-3.5L11 2.5l2.5 2.5-8 8z" fill="#6d84b4" />,
  share: <path d="M9 2.5l5 4.5-5 4.5V9C5.5 9 3.5 10 2 13c.5-4 2.5-7 7-7.5z" fill="#6d84b4" />,
  more: <path d="M4 6l4 4 4-4" stroke="#666" strokeWidth="1.6" fill="none" />,
  mag: <><circle cx="6.5" cy="6.5" r="4.2" fill="none" stroke="#3b5998" strokeWidth="1.8" /><path d="M9.6 9.6l4.6 4.6" stroke="#3b5998" strokeWidth="2.2" /></>,
  ring: <><circle cx="8" cy="10" r="4.5" fill="none" stroke="#d4a017" strokeWidth="1.8" /><path d="M6 4l2-2.5L10 4l-2 1.5z" fill="#9fd3f5" stroke="#6aa9d1" strokeWidth=".6" /></>,
  shield: <path d="M8 1.5l5.5 2v4c0 3.5-2.4 6-5.5 7-3.1-1-5.5-3.5-5.5-7v-4z" fill="#6d84b4" />,
  key: <><circle cx="5" cy="8" r="3" fill="none" stroke="#6d84b4" strokeWidth="1.8" /><path d="M8 8h6.5M12 8v2.5M14 8v2" stroke="#6d84b4" strokeWidth="1.8" /></>,
  flag: <><path d="M3 1.5v13" stroke="#666" strokeWidth="1.4" /><path d="M3.5 2.5h9l-2 3 2 3h-9z" fill="#c33" /></>,
};

export type IconName = keyof typeof I;

export function Icon({ name, title }: { name: string; title?: string }) {
  return (
    <svg className="i16" viewBox="0 0 16 16" width={16} height={16} aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title ? <title>{title}</title> : null}
      {I[name] ?? null}
    </svg>
  );
}

export const JewelIcon = {
  req: () => <svg width="20" height="18" viewBox="0 0 20 18" aria-hidden><circle cx="7" cy="5" r="3.6" fill="currentColor" /><path d="M0 17c0-5 3-7 7-7s7 2 7 7z" fill="currentColor" /><circle cx="14" cy="5.5" r="3" fill="currentColor" opacity=".7" /><path d="M13 10.5c4-.6 7 1.4 7 6.5h-5z" fill="currentColor" opacity=".7" /></svg>,
  msg: () => <svg width="20" height="18" viewBox="0 0 20 18" aria-hidden><path d="M1 2h12v8H6l-3 3v-3H1z" fill="currentColor" /><path d="M14 5h5v7h-2v3l-3-3H8v-1h6z" fill="currentColor" opacity=".7" /></svg>,
  notif: () => <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden><circle cx="9" cy="9" r="8" fill="currentColor" /><path d="M3.5 5c2 0 3 1 2.5 2.5S8 9 7.5 11 5 12 4.5 14M11 2.3c-.5 1.5.5 2.5 2 2.5s2 1.5 1.5 3-1.5 2-1 4" stroke="#3b5998" strokeWidth="1.6" fill="none" /></svg>,
};
