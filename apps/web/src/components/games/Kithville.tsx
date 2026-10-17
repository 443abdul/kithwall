'use client';
// /games/kithville — reference vAssville. The farm lives in an encrypted blob only this account
// can open; neighbor actions are sealed to the recipient. Fully keyboard playable: plots are
// buttons in a grid (arrow keys move between them), seeds are a radio group.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AppPage, RightBox, Title } from '@/components/Shell';
import { Icon } from '@/components/Icon';
import { AvatarLink, NameLink } from '@/components/Avatar';
import { Dialog } from '@/components/social/Dialog';
import { ErrorBox, friendlyError } from '@/components/groups/bits';
import { useFriendIds } from '@/lib/hooks';
import { useSession } from '@/lib/keys/session';
import { people, usePeopleVersion } from '@/lib/people';
import { sb } from '@/lib/supabase';
import { when } from '@/lib/format';
import {
  ANIMAL_COOLDOWN_MS, CROP_KEYS, CROPS, DAY_MS, GIFT_NAMES, GIFTS, StaleFarmError, claimAction, fmtLeft, growth, ignoreAction,
  incomingActions, levelOf, loadFarm, moves, openAction, plotCount, publishStory, saveFarm, sendAction, settleLevel, xpForLevel,
  type FarmState,
} from '@/lib/games/kithville';

function Art({ item, w = 60 }: { item: string; w?: number }) {
  const c = GIFTS[item]?.color ?? '#c98bb0';
  return (
    <svg width={w} height={w * 0.75} viewBox="0 0 80 60" aria-hidden>
      <rect width="80" height="60" fill="#a6dcf2" /><rect y="38" width="80" height="22" fill="#6ab03c" />
      <ellipse cx="40" cy="38" rx="18" ry="11" fill={c} /><circle cx="56" cy="31" r="7" fill={c} />
      <rect x="28" y="44" width="4" height="9" fill="#555" /><rect x="47" y="44" width="4" height="9" fill="#555" />
      <circle cx="58" cy="30" r="1.3" fill="#000" />
    </svg>
  );
}

type Share = { title: string; text: string; body: string } | null;

export function Kithville() {
  const { status, userId } = useSession();
  usePeopleVersion();
  const [farm, setFarm] = useState<FarmState | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [share, setShare] = useState<Share>(null);
  const [help, setHelp] = useState(false);
  const [giftTo, setGiftTo] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const version = useRef<number | null>(null);
  const latest = useRef<FarmState | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saving = useRef<Promise<void> | null>(null);
  const plotRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const reload = useCallback(async (note?: string) => {
    try {
      const s = await loadFarm();
      version.current = s.version; latest.current = s.state; setFarm(s.state); setLoadErr(null);
      if (note) setFlash(note);
    } catch (e) {
      setLoadErr((e as Error).message?.includes('decrypt') ? 'Your farm couldn’t be decrypted on this device.' : friendlyError(e));
    }
  }, []);

  useEffect(() => { if (status === 'ready') void Promise.resolve().then(() => reload()); }, [status, reload]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  const flush = useCallback(async () => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    if (saving.current) await saving.current;
    const s = latest.current;
    if (!s) return;
    saving.current = (async () => {
      try { version.current = await saveFarm(s, version.current); }
      catch (e) {
        if (e instanceof StaleFarmError) await reload('Your farm changed in another tab or device, so we reloaded it.');
        else setErr(friendlyError(e));
      } finally { saving.current = null; }
    })();
    await saving.current;
  }, [reload]);

  useEffect(() => () => { if (saveTimer.current) { clearTimeout(saveTimer.current); void flush(); } }, [flush]);

  /** Apply a move to a copy of the farm, then save shortly after (batched). */
  const mutate = useCallback((fn: (s: FarmState) => void) => {
    const cur = latest.current;
    if (!cur) return;
    const next = structuredClone(cur);
    const before = levelOf(next.xp);
    fn(next);
    settleLevel(next);
    const after = levelOf(next.xp);
    latest.current = next; setFarm(next); setErr(null);
    if (after > before) {
      const extra = plotCount(after) > plotCount(before) ? ' You unlocked more land!' : '';
      setFlash(`Level up! You're now level ${after}.${extra}`);
      setShare({ title: 'Level Up!', text: `reached level ${after} in Kithville!`, body: `You reached level ${after}. Share it with your friends?` });
    }
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void flush(); }, 600);
  }, [flush]);

  // Neighbor requests (help/gifts sent to me), refreshed live.
  const qc = useQueryClient();
  const actions = useQuery({ queryKey: ['kithville', 'actions'], enabled: status === 'ready', queryFn: incomingActions, refetchInterval: 60_000 });
  useEffect(() => {
    if (status !== 'ready' || !userId) return;
    const ch = sb().channel(`kithville:${userId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'game_actions', filter: `to_id=eq.${userId}` },
        () => { void qc.invalidateQueries({ queryKey: ['kithville', 'actions'] }); })
      .subscribe();
    return () => { void sb().removeChannel(ch); };
  }, [status, userId, qc]);
  const friends = useFriendIds();

  if (loadErr) return <AppPage active="kithville" right={null}><Title icon="game">Kithville</Title><div className="err">{loadErr}</div></AppPage>;
  if (!farm) return <AppPage active="kithville" right={null}><Title icon="game">Kithville</Title><div className="gray">Loading your farm&hellip;</div></AppPage>;

  const lvl = levelOf(farm.xp);
  const lo = xpForLevel(lvl), hi = xpForLevel(lvl + 1);
  const pct = Math.round(((farm.xp - lo) / Math.max(1, hi - lo)) * 100);
  const sel = CROPS[farm.sel];
  const first = (userId && people.person(userId)?.name.split(' ')[0]) || 'Your';

  const clickPlot = (i: number) => {
    const p = farm.plots[i];
    if (!p) {
      let msg: string | null = null;
      mutate((s) => { msg = moves.plant(s, i, Date.now()); });
      if (msg) setFlash(msg);
      return;
    }
    const g = growth(p, now);
    if (!g.ready) { setFlash(`${CROPS[p.c].name} will be ready in ${fmtLeft(g.left)}.`); return; }
    mutate((s) => { const r = moves.harvest(s, i, Date.now()); if (r) setFlash(`You harvested ${r.crop} (+${r.coins} coins, +${r.xp} XP).`); });
  };

  const plantAll = () => {
    let n = 0, msg: string | null = null;
    mutate((s) => { s.plots.forEach((p, i) => { if (!p && !msg) { const m = moves.plant(s, i, Date.now()); if (m) msg = m; else n++; } }); });
    setFlash(n ? `You planted ${n} plot${n === 1 ? '' : 's'} of ${sel.name}.` : msg ?? 'All your plots are already planted.');
  };

  const harvestAll = () => {
    let n = 0, coins = 0, last = '';
    mutate((s) => { s.plots.forEach((_, i) => { const r = moves.harvest(s, i, Date.now()); if (r) { n++; coins += r.coins; last = r.crop; } }); });
    if (!n) { setFlash('Nothing is ready to harvest yet.'); return; }
    setFlash(`You harvested ${n} plot${n === 1 ? '' : 's'} (+${coins} coins).`);
    if (n >= 3) setShare({ title: 'Bumper Crop!', text: `harvested ${n} plots of ${last} in Kithville!`, body: `You harvested ${n} plots! Share some ${last} with your friends?` });
  };

  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = plotRefs.current.findIndex((b) => b === document.activeElement);
    if (i < 0) return;
    const cols = 3;
    const map: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols };
    const d = map[e.key];
    if (d === undefined) return;
    e.preventDefault();
    const j = Math.min(farm.plots.length - 1, Math.max(0, i + d));
    plotRefs.current[j]?.focus();
  };

  const onSeedKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const keys = CROP_KEYS.filter((k) => CROPS[k].level <= lvl);
    const i = keys.indexOf(farm.sel);
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const k = keys[(i + d + keys.length) % keys.length]!;
    mutate((s) => { s.sel = k; });
    (e.currentTarget.querySelector(`[data-crop="${k}"]`) as HTMLElement | null)?.focus();
  };

  const neighborAct = async (f: string, kind: 'help' | 'gift', item?: string) => {
    setErr(null);
    try {
      await sendAction(f, kind, item);
      const name = people.person(f)?.name ?? 'your neighbor';
      mutate((s) => {
        if (kind === 'help') { s.helped[f] = Date.now(); s.coins += 5; s.xp += 1; }
        else s.gifted[f] = Date.now();
        s.log = [{ t: Date.now(), text: kind === 'help' ? `You watered ${name}'s crops (+5 coins).` : `You sent ${name} a ${item}.` }, ...s.log].slice(0, 20);
      });
      setFlash(kind === 'help' ? `You watered ${name}'s crops. Thanks for being a good neighbor! (+5 coins)` : `You sent ${name} a ${item}!`);
    } catch (e) { setErr(friendlyError(e)); }
  };

  const accept = async (id: string, from: string, payload: { kind: 'help' | 'gift'; item?: string }) => {
    setErr(null);
    if (!(await claimAction(id))) { void qc.invalidateQueries({ queryKey: ['kithville', 'actions'] }); return; }
    const name = people.person(from)?.name ?? 'A neighbor';
    let text = '';
    mutate((s) => {
      text = payload.kind === 'help' ? moves.applyHelp(s, Date.now()) : moves.applyGift(s, payload.item ?? '', Date.now());
      s.xp += 1;
      s.log = [{ t: Date.now(), text: `${name} ${text}` }, ...s.log].slice(0, 20);
    });
    setFlash(`${name} ${text}`);
    void qc.invalidateQueries({ queryKey: ['kithville', 'actions'] });
  };

  const right = (
    <>
      <RightBox title={`Kithville Requests (${actions.data?.length ?? 0})`}>
        {(actions.data ?? []).map((r) => {
          const p = openAction(r);
          return (
            <div className="rr" key={r.id}>
              <AvatarLink id={r.from_id} size={32} />
              <div>
                {p ? <><NameLink id={r.from_id} /> {p.kind === 'help' ? 'watered your crops.' : <>sent you a <b>{p.item}</b>.</>}</>
                  : <span className="gray">A request that couldn&rsquo;t be verified.</span>}
                <div className="gray">{when(r.created_at)}</div>
                {p && <><a role="button" tabIndex={0} onClick={() => void accept(r.id, r.from_id, p)} onKeyDown={(e) => { if (e.key === 'Enter') void accept(r.id, r.from_id, p); }}>Accept</a> &middot; </>}
                <a role="button" tabIndex={0} onClick={() => void ignoreAction(r.id).then(() => qc.invalidateQueries({ queryKey: ['kithville', 'actions'] }))}
                  onKeyDown={(e) => { if (e.key === 'Enter') void ignoreAction(r.id).then(() => qc.invalidateQueries({ queryKey: ['kithville', 'actions'] })); }}>Ignore</a>
              </div>
            </div>
          );
        })}
        {actions.data && !actions.data.length && <span className="gray">No requests.</span>}
      </RightBox>
      <RightBox title={`Neighbors (${friends.data?.length ?? 0})`}>
        {(friends.data ?? []).map((f) => {
          const helped = now - (farm.helped[f] ?? 0) < DAY_MS;
          const gifted = now - (farm.gifted[f] ?? 0) < DAY_MS;
          return (
            <div className="rr" key={f}>
              <AvatarLink id={f} size={32} />
              <div>
                <NameLink id={f} /><br />
                {helped ? <span className="gray">Watered today</span>
                  : <a role="button" tabIndex={0} onClick={() => void neighborAct(f, 'help')} onKeyDown={(e) => { if (e.key === 'Enter') void neighborAct(f, 'help'); }}>Water Crops</a>}
                {' '}&middot;{' '}
                {gifted ? <span className="gray">Gift sent</span>
                  : <a role="button" tabIndex={0} onClick={() => setGiftTo(f)} onKeyDown={(e) => { if (e.key === 'Enter') setGiftTo(f); }}>Send Gift</a>}
              </div>
            </div>
          );
        })}
        {friends.data && !friends.data.length && <span className="gray">Add friends to get neighbors.</span>}
      </RightBox>
      {farm.log.length > 0 && <RightBox title="Recent Activity"><ul className="kv-log">{farm.log.slice(0, 6).map((l, i) => <li key={i}>{l.text}</li>)}</ul></RightBox>}
    </>
  );

  return (
    <AppPage active="kithville" right={right}>
      <Title icon="game" right={<a role="button" tabIndex={0} onClick={() => setHelp(true)} onKeyDown={(e) => { if (e.key === 'Enter') setHelp(true); }}>How to Play</a>}>Kithville</Title>
      <ErrorBox error={err} />
      <div className="farm">
        <div className="fstat">
          <span><Icon name="game" /> {first === 'Your' ? 'Your' : `${first}'s`} Farm</span>
          <span>Coins: <span style={{ color: '#8a6500' }}>{farm.coins.toLocaleString('en-US')}</span></span>
          <span>Level {lvl}{' '}
            <span className="xpbar" role="progressbar" aria-label="Progress to next level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><i style={{ width: `${pct}%` }} /></span>{' '}
            <span className="gray">{farm.xp} XP</span></span>
          <span className="kv-tools">
            <button type="button" className="btn" onClick={plantAll}>Plant All</button>
            <button type="button" className="btn" onClick={harvestAll}>Harvest All</button>
          </span>
        </div>
        {flash && <div className="kv-flash" role="status" aria-live="polite">{flash}</div>}
        <div className="plots" role="group" aria-label="Your plots (use arrow keys to move)" onKeyDown={onGridKey}>
          {farm.plots.map((p, i) => {
            if (!p) return (
              <button type="button" key={i} ref={(el) => { plotRefs.current[i] = el; }} className="plot kv-plot"
                aria-label={`Plot ${i + 1}: empty. Plant ${sel.name} for ${sel.cost} coins`} onClick={() => clickPlot(i)}>
                Plow &amp; Plant<br /><span className="kv-sub">{sel.name}</span>
              </button>
            );
            const c = CROPS[p.c];
            const g = growth(p, now);
            if (g.ready) return (
              <button type="button" key={i} ref={(el) => { plotRefs.current[i] = el; }} className="plot ready kv-plot"
                aria-label={`Plot ${i + 1}: ${c.name} ready. Harvest for ${c.sell} coins`} onClick={() => clickPlot(i)}>
                <svg width="60" height="30" viewBox="0 0 60 30" aria-hidden>{[8, 20, 32, 44, 14, 26, 38, 50].map((x, k) => <circle key={k} cx={x + 2} cy={k < 4 ? 10 : 21} r="5" fill={c.color} stroke="rgba(0,0,0,.3)" />)}</svg>
                Harvest!<br /><span className="kv-sub">{c.name}</span>
              </button>
            );
            return (
              <button type="button" key={i} ref={(el) => { plotRefs.current[i] = el; }} className="plot kv-plot"
                aria-label={`Plot ${i + 1}: ${c.name}, ${Math.round(g.pct * 100)}% grown, ${fmtLeft(g.left)} left`} onClick={() => clickPlot(i)}>
                <svg width="60" height="22" viewBox="0 0 60 22" aria-hidden>{[10, 25, 40, 52].map((x) => <g key={x}><path d={`M${x} 22v-${4 + g.pct * 14}`} stroke="#5cb82e" strokeWidth="2" /><circle cx={x} cy={18 - g.pct * 14} r={1 + g.pct * 3} fill="#7ed957" /></g>)}</svg>
                {c.name}
                <span className="pb" aria-hidden><i style={{ width: `${Math.round(g.pct * 100)}%` }} /></span>
                <span className="kv-sub">{fmtLeft(g.left)} left</span>
              </button>
            );
          })}
        </div>
        {farm.animals.length > 0 && (
          <div className="kv-animals"><b>Animals:</b>
            {farm.animals.map((a, i) => {
              const wait = ANIMAL_COOLDOWN_MS - (now - a.last);
              const ready = wait <= 0;
              const label = a.item.replace(/^Lonely |^Lost /, '');
              return (
                <button type="button" key={i} className="kv-animal" disabled={!ready}
                  aria-label={ready ? `Collect from your ${label}` : `${label}: ready in ${fmtLeft(Math.ceil(wait / 1000))}`}
                  onClick={() => { mutate((s) => { if (moves.collect(s, i, Date.now())) setFlash(`You collected from your ${label} (+15 coins).`); }); }}>
                  <Art item={a.item} /><br />{label}<br />{ready ? <b>Collect!</b> : <span className="gray">{fmtLeft(Math.ceil(wait / 1000))}</span>}
                </button>
              );
            })}
          </div>
        )}
        <div className="seeds" role="radiogroup" aria-label="Market: choose a seed" onKeyDown={onSeedKey}>
          <b style={{ alignSelf: 'center' }}>Market:</b>
          {CROP_KEYS.map((k) => {
            const c = CROPS[k];
            const locked = c.level > lvl;
            return (
              <button type="button" key={k} data-crop={k} role="radio" aria-checked={farm.sel === k} disabled={locked}
                tabIndex={farm.sel === k ? 0 : -1} className={`seed kv-seed${farm.sel === k ? ' on' : ''}`}
                onClick={() => mutate((s) => { s.sel = k; })}>
                <span style={{ display: 'inline-block', width: 12, height: 12, borderRadius: '50%', background: c.color, verticalAlign: -2 }} /> <b>{c.name}</b><br />
                {locked ? <>Unlocks at level {c.level}</> : <>Cost: {c.cost} &middot; {fmtLeft(c.secs)}<br />Sells for {c.sell}</>}
              </button>
            );
          })}
        </div>
      </div>
      <div className="gray" style={{ marginTop: 6, lineHeight: '15px' }}>
        Tip: choose a seed, then click (or press Enter on) an empty plot to plant it. Crops grow even while you&rsquo;re away.<br />
        <Icon name="lock" /> Your farm is encrypted with your own key — Kithwall can&rsquo;t see your crops, coins or level. Neighbors only
        see what you send them, and nothing is posted to your Wall unless you choose to share it.
      </div>

      {help && <Dialog title="How to Play Kithville" onClose={() => setHelp(false)} buttons={<button type="button" className="btn b" onClick={() => setHelp(false)}>Okay</button>}>
        <ol style={{ margin: 0, paddingLeft: 18, lineHeight: '17px' }}>
          <li>Pick a seed from the Market (arrow keys work too).</li>
          <li>Click an empty plot to plant it. Seeds cost coins.</li>
          <li>Wait for it to grow, then click it to harvest for coins and XP. New levels unlock new crops and more land.</li>
          <li>Water your neighbors&rsquo; crops and send them gifts once a day. Lonely animals you receive can be collected from every few minutes.</li>
        </ol>
      </Dialog>}

      {giftTo && <Dialog title={`Send ${people.person(giftTo)?.name ?? 'your neighbor'} a Gift`} onClose={() => setGiftTo(null)}
        buttons={<button type="button" className="btn" onClick={() => setGiftTo(null)}>Cancel</button>}>
        <div className="seeds" style={{ border: 0, background: 'none', padding: 0 }}>
          {GIFT_NAMES.map((g) => (
            <button type="button" key={g} className="seed kv-seed" onClick={() => { const f = giftTo; setGiftTo(null); void neighborAct(f, 'gift', g); }}>
              <Art item={g} /><br /><b>{g}</b>
            </button>
          ))}
        </div>
      </Dialog>}

      {share && <Dialog title={share.title} onClose={() => setShare(null)} buttons={<>
        <button type="button" className="btn b" onClick={() => {
          const s = share; setShare(null);
          void publishStory(s.text).then(() => setFlash('Shared on your Wall with your friends.')).catch((e) => setErr(friendlyError(e)));
        }}>Share on My Wall</button>
        <button type="button" className="btn" onClick={() => setShare(null)}>No Thanks</button>
      </>}>
        {share.body}
        <div className="gray" style={{ marginTop: 6 }}><Icon name="lock" /> Your friends will see: &ldquo;{people.person(userId ?? '')?.name ?? 'You'} {share.text}&rdquo;</div>
      </Dialog>}
    </AppPage>
  );
}
