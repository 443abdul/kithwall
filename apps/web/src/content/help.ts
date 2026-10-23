// Help Center structure (Kithwall 2). The questions and answers themselves are translated messages
// (`help.<section>.q<n>` / `help.<section>.a<n>` in i18n/messages/*.json). Answers are a small
// Markdown subset rendered with components/auth/Markdown (React elements only, no HTML). Section ids
// are anchors used by links around the app (/help#recovery).
import type { MessageKey } from '@/i18n';

export interface HelpSection { id: string; title: MessageKey; items: { q: MessageKey; a: MessageKey }[] }

const SECTIONS = {
  start: 3,
  signin: 2,
  recovery: 4,
  people: 3,
  sharing: 3,
  privacy: 3,
  safety: 4,
  account: 4,
} as const;

type Id = keyof typeof SECTIONS;

export const HELP: HelpSection[] = (Object.keys(SECTIONS) as Id[]).map((id) => ({
  id,
  title: `help.${id}.title` as MessageKey,
  items: Array.from({ length: SECTIONS[id] }, (_, i) => ({
    q: `help.${id}.q${i + 1}` as MessageKey,
    a: `help.${id}.a${i + 1}` as MessageKey,
  })),
}));
