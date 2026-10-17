'use client';
// Pokes (reference vPokes): pokes you received (Poke Back / remove), pokes you sent, suggestions.
import Link from 'next/link';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AppPage, Title } from '@/components/Shell';
import { TipsBox } from '@/components/feed/RightColumn';
import { AvatarLink } from '@/components/Avatar';
import { useFriendIds, usePokes } from '@/lib/hooks';
import { useSession } from '@/lib/keys/session';
import { people, usePeopleVersion } from '@/lib/people';
import { poke } from '@/lib/friends';
import { sb, must } from '@/lib/supabase';
import { when } from '@/lib/format';
import '@/styles/social.css';

function Name({ id }: { id: string }) {
  const p = people.person(id);
  return p ? <b><Link href={`/${p.username}`}>{p.name}</Link></b> : <b className="gray">…</b>;
}

function Pokes() {
  usePeopleVersion();
  const { userId, status } = useSession();
  const qc = useQueryClient();
  const got = usePokes();
  const friends = useFriendIds();
  const sent = useQuery({
    queryKey: ['pokes', 'sent'], enabled: status === 'ready',
    queryFn: async () => {
      const rows = must(await sb().from('pokes').select('*').eq('from_id', userId!).order('created_at', { ascending: false })) as { from_id: string; to_id: string; created_at: string }[];
      await people.ensure(rows.map((r) => r.to_id));
      return rows;
    },
  });
  const [err, setErr] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try { await fn(); } catch (e) { setErr((e as Error).message); }
    await qc.invalidateQueries({ queryKey: ['pokes'] });
  };
  const sentTo = new Set((sent.data ?? []).map((p) => p.to_id));
  const suggestions = (friends.data ?? []).filter((f) => !sentTo.has(f)).slice(0, 5);
  return (
    <>
      <Title icon="poke">Pokes</Title>
      {err && <div className="err" role="alert">{err}</div>}
      <div className="list">
        {(got.data ?? []).map((p) => (
          <div className="it" key={p.from_id}>
            <AvatarLink id={p.from_id} size={50} />
            <div className="d"><Name id={p.from_id} /> poked you.<br /><span className="gray">{when(p.created_at)}</span></div>
            <div className="x">
              <button type="button" className="btn" onClick={() => void act(() => poke(p.from_id))}>Poke Back</button>{' '}
              <button type="button" className="kw-x" title="Remove" aria-label="Remove poke"
                onClick={() => void act(async () => must(await sb().from('pokes').delete().match({ from_id: p.from_id, to_id: userId! })))}>&times;</button>
            </div>
          </div>
        ))}
        {!got.isLoading && !(got.data ?? []).length && <div className="gray kw-pad">No new pokes.</div>}
      </div>
      {(sent.data ?? []).length > 0 && <>
        <div className="sub"><span>Pokes You&rsquo;ve Sent</span></div>
        <div className="list">
          {(sent.data ?? []).map((p) => (
            <div className="it" key={p.to_id}><AvatarLink id={p.to_id} size={32} /><div className="d">You poked <Name id={p.to_id} />. <span className="gray">{when(p.created_at)}</span></div></div>
          ))}
        </div>
      </>}
      {suggestions.length > 0 && <>
        <div className="sub"><span>Poke Suggestions</span></div>
        <div className="list">
          {suggestions.map((f) => (
            <div className="it" key={f}><AvatarLink id={f} size={32} /><div className="d"><Name id={f} /></div>
              <div className="x"><button type="button" className="btn" onClick={() => void act(() => poke(f))}>Poke</button></div></div>
          ))}
        </div>
      </>}
    </>
  );
}

export default function Page() {
  return <AppPage active="pokes" right={<TipsBox />}><Pokes /></AppPage>;
}
