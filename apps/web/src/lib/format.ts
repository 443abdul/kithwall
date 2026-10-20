// 2010-style relative times: "about a minute ago", "2 hours ago", "Yesterday at 4:12pm", "October 12 at 9:03am".
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function clock(d: Date): string {
  let h = d.getHours();
  const ap = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return `${h}:${String(d.getMinutes()).padStart(2, '0')}${ap}`;
}

export function when(iso: string | number | Date): string {
  const d = new Date(iso);
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 45) return 'a few seconds ago';
  if (s < 90) return 'about a minute ago';
  if (s < 3600) return `${Math.round(s / 60)} minutes ago`;
  if (s < 5400) return 'about an hour ago';
  if (s < 86400 && new Date().getDate() === d.getDate()) return `${Math.round(s / 3600)} hours ago`;
  const y = new Date(Date.now() - 86400000);
  if (d.toDateString() === y.toDateString()) return `Yesterday at ${clock(d)}`;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${sameYear ? '' : `, ${d.getFullYear()}`} at ${clock(d)}`;
}

export const plural = (n: number, word: string, pl?: string) => `${n} ${n === 1 ? word : pl ?? `${word}s`}`;
export { MONTHS };
