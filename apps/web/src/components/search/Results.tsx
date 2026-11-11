'use client';
// Search results (lib/search): found on this device, shown with the matching words marked. A message opens
// its chat at that message; a post or comment opens the post. Text is rendered as text (React escapes it);
// the highlight is a <mark> around pieces of it, never HTML built from content.
import Link from 'next/link';
import { useEffect, useMemo } from 'react';
import { useT } from '@/i18n';
import { useSession } from '@/lib/keys/session';
import { people } from '@/lib/people';
import type { ConversationSummary } from '@/lib/messages';
import type { SearchHit } from '@/lib/search';
import { excerpt } from '@/lib/search/text';
import { Icon } from '@/components/ui/Icon';
import { ConversationAvatar, PersonAvatar, useConversationTitle, useNameOf } from '@/components/messages/look';
import { RelativeTime } from '@/components/posts/bits';

/** The excerpt around the first match, with every match marked. */
export function Marked({ hit, max }: { hit: SearchHit; max?: number }) {
  const pieces = useMemo(() => excerpt(hit.doc.text, hit.words, max), [hit, max]);
  return (
    <span className="k-search-text" dir="auto">
      {pieces.map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}
    </span>
  );
}

/** Make sure the people in the results are known (names, pictures). Ids only; nothing about the query. */
function useAuthors(hits: readonly SearchHit[]) {
  const ids = useMemo(() => [...new Set(hits.map((h) => h.doc.author))].sort().join(','), [hits]);
  useEffect(() => { if (ids) void people.ensure(ids.split(',')).catch(() => undefined); }, [ids]);
}

function MessageRow({ hit, conv, onPick, inChat }: { hit: SearchHit; conv: ConversationSummary | null; onPick?: (hit: SearchHit) => void; inChat?: boolean }) {
  const t = useT();
  const { userId } = useSession();
  const nameOf = useNameOf();
  const title = useConversationTitle(conv);
  const d = hit.doc;
  const who = d.author === userId ? t('messages.you') : nameOf(d.author);
  const body = (
    <>
      {conv && !inChat ? <ConversationAvatar c={conv} size={40} /> : <PersonAvatar id={d.author} size={40} />}
      <span className="k-search-body">
        <span className="k-search-top">
          <span className="k-search-title" dir="auto">{inChat || !conv ? who : title}</span>
          <RelativeTime iso={d.at} className="k-search-time" />
        </span>
        <span className="k-search-line">
          {!inChat && conv && !(conv.isDm && d.author !== userId) ? <span className="k-search-who">{who}: </span> : null}
          <Marked hit={hit} />
        </span>
      </span>
    </>
  );
  const id = d.id.slice(2);
  return (
    <li>
      {onPick
        ? <button type="button" className="k-search-row" onClick={() => onPick(hit)}>{body}</button>
        : <Link className="k-search-row" href={`/messages/${d.ctx}?m=${id}`}>{body}</Link>}
    </li>
  );
}

/** Messages found, across chats or (with `onPick`) inside the open one. */
export function MessageResults({ hits, conversations, onPick, inChat, label }: {
  hits: readonly SearchHit[];
  conversations: readonly ConversationSummary[];
  /** Jump inside the open chat instead of navigating. */
  onPick?: (hit: SearchHit) => void;
  inChat?: boolean;
  label: string;
}) {
  useAuthors(hits);
  const byId = useMemo(() => new Map(conversations.map((c) => [c.id, c])), [conversations]);
  return (
    <ul className="k-search-rows" aria-label={label}>
      {hits.map((h) => <MessageRow key={h.doc.id} hit={h} conv={byId.get(h.doc.ctx) ?? null} onPick={onPick} inChat={inChat} />)}
    </ul>
  );
}

/** Posts and comments found. */
export function PostResults({ hits, label }: { hits: readonly SearchHit[]; label: string }) {
  const t = useT();
  const { userId } = useSession();
  const nameOf = useNameOf();
  useAuthors(hits);
  return (
    <ul className="k-search-rows" aria-label={label}>
      {hits.map((h) => {
        const d = h.doc;
        const href = d.kind === 'post' && d.sub === 'note' ? `/notes/${d.ctx}` : `/post/${d.ctx}`;
        return (
          <li key={d.id}>
            <Link className="k-search-row" href={href}>
              <PersonAvatar id={d.author} size={40} />
              <span className="k-search-body">
                <span className="k-search-top">
                  <span className="k-search-title" dir="auto">{d.author === userId ? t('messages.you') : nameOf(d.author)}</span>
                  <span className="k-search-kind"><Icon name={d.kind === 'comment' ? 'comment' : d.sub === 'note' ? 'book' : 'edit'} />{t(d.kind === 'comment' ? 'search.kind.comment' : d.sub === 'note' ? 'search.kind.note' : 'search.kind.post')}</span>
                  <RelativeTime iso={d.at} className="k-search-time" />
                </span>
                <span className="k-search-line"><Marked hit={h} max={200} /></span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
