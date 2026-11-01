// Call icons in the Kithwall 2 icon style (24px grid, 1.75 stroke, round caps, currentColor).
import type { ReactElement } from 'react';

const P = {
  phone: <path d="M6.6 3.5h2.6l1.6 4.2-2 1.4a11 11 0 0 0 6.1 6.1l1.4-2 4.2 1.6v2.6a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.5 5.7a2 2 0 0 1 2.1-2.2z" />,
  hangup: <path d="M3.2 14.2c-.6-1.1-.5-2.5.6-3.3C6 9.3 8.9 8.5 12 8.5s6 .8 8.2 2.4c1.1.8 1.2 2.2.6 3.3l-.9 1.5-4.1-1.1-.3-2.4a10 10 0 0 0-7 0l-.3 2.4-4.1 1.1z" />,
  video: <><rect x="3" y="6" width="13" height="12" rx="2.5" /><path d="M16 10.5 21 7.5v9l-5-3" /></>,
  videoOff: <><path d="M10 6h3.5A2.5 2.5 0 0 1 16 8.5v3M16 15.5A2.5 2.5 0 0 1 13.5 18h-8A2.5 2.5 0 0 1 3 15.5v-7A2.5 2.5 0 0 1 5 6" /><path d="M16 10.5 21 7.5v9l-3-1.8" /><path d="M3 3l18 18" /></>,
  mic: <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7" /></>,
  micOff: <><path d="M15 10V6a3 3 0 0 0-5.6-1.5M9 9v2a3 3 0 0 0 4.6 2.5" /><path d="M18.5 11a6.5 6.5 0 0 1-1.2 3.8M5.5 11a6.5 6.5 0 0 0 10 5.5M12 17.5V21M8.5 21h7" /><path d="M3 3l18 18" /></>,
  flip: <><path d="M4 9.5V8a2 2 0 0 1 2-2h2l1.5-2h5L16 6h2a2 2 0 0 1 2 2v1.5" /><path d="M20 14.5V16a2 2 0 0 1-2 2h-6" /><path d="M4 14.5V16a2 2 0 0 0 2 2" /><path d="M14 16l-2 2 2 2M17 9.5l3 0M7 14.5H4" /></>,
  speaker: <><path d="M4 9.5h3l5-4v13l-5-4H4z" /><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" /></>,
  minimize: <><path d="M4 14h6v6M20 10h-6V4" /><path d="M10 14 4 20M14 10l6-6" /></>,
  expand: <><path d="M14 4h6v6M10 20H4v-6" /><path d="M20 4l-6 6M4 20l6-6" /></>,
  shield: <><path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.2-7.5 9.5-4.3-1.3-7.5-4.9-7.5-9.5V6z" /><path d="M9 12l2 2 4-4" /></>,
  /** Devices (microphone, camera, speaker): two sliders. */
  devices: <><path d="M4 7.5h8.5M17.5 7.5H20M4 16.5h2.5M11.5 16.5H20" /><circle cx="15" cy="7.5" r="2.5" /><circle cx="9" cy="16.5" r="2.5" /></>,
  /** Data saver: a gauge turned down. */
  saver: <><path d="M3.5 16.5a8.5 8.5 0 0 1 17 0" /><path d="M12 16.5 8.2 11.6" /><circle cx="12" cy="16.5" r="1.3" /><path d="M5.5 20h13" /></>,
} satisfies Record<string, ReactElement>;

export type CallIconName = keyof typeof P;

export function CallIcon({ name, size }: { name: CallIconName; size?: number }) {
  const fill = name === 'hangup' || name === 'phone';
  return (
    <svg className="k-icon" viewBox="0 0 24 24" width={size} height={size} fill={fill ? 'currentColor' : 'none'} stroke={fill ? 'none' : 'currentColor'}
      strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" focusable="false" aria-hidden>
      {P[name]}
    </svg>
  );
}
