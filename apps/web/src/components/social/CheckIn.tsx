'use client';
// Check in (reference vPlaces): a typed place name, optional address, optional "use my location"
// (only when you press it; coordinates are rounded to ~1 km and stored only inside the encrypted
// post), friends who are with you, and an audience.
import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Icon } from '@/components/Icon';
import { AudienceSelect, toAudience } from '@/components/feed/AudienceSelect';
import { FriendPicker } from './bits';
import { createPost } from '@/lib/content';
import { clean, notifySafe } from '@/lib/feed/feed';
import { useFriendIds } from '@/lib/hooks';

/** ~1.1 km at the equator (0.01°). */
const round = (x: number) => Math.round(x * 100) / 100;

export function CheckIn({ initialPlace = '' }: { initialPlace?: string }) {
  const qc = useQueryClient();
  const friends = useFriendIds();
  const [place, setPlace] = useState(initialPlace);
  const [address, setAddress] = useState('');
  const [text, setText] = useState('');
  const [withIds, setWith] = useState<string[]>([]);
  const [loc, setLoc] = useState<{ lat: number; lng: number } | null>(null);
  const [locMsg, setLocMsg] = useState<string | null>(null);
  const [aud, setAud] = useState('friends');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  const locate = () => {
    if (!('geolocation' in navigator)) { setLocMsg('Your browser can’t share your location.'); return; }
    setLocMsg('Finding you…');
    navigator.geolocation.getCurrentPosition(
      (p) => { setLoc({ lat: round(p.coords.latitude), lng: round(p.coords.longitude) }); setLocMsg(null); },
      () => setLocMsg('Couldn’t get your location. You can still check in by name.'),
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 300_000 },
    );
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const name = place.trim();
    if (!name) { setErr('Where are you? Type the name of the place.'); return; }
    setBusy(true); setErr(null); setOk(false);
    try {
      const row = await createPost({
        kind: 'checkin', audience: toAudience(aud),
        payload: clean({
          text: text.trim().slice(0, 2000) || undefined,
          checkin: { place: name.slice(0, 100), address: address.trim().slice(0, 200) || undefined, ...(loc ?? {}), with: withIds },
        }),
      });
      for (const f of withIds) await notifySafe(f, 'checkin_tag', 'post', row.id, name.slice(0, 60));
      setPlace(initialPlace); setAddress(''); setText(''); setWith([]); setLoc(null); setOk(true);
      await qc.invalidateQueries({ queryKey: ['kind', 'checkin'] });
      await qc.invalidateQueries({ queryKey: ['feed'] });
    } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  };

  return (
    <form className="kw-checkin" onSubmit={(e) => void submit(e)}>
      {err && <div className="err" role="alert">{err}</div>}
      {ok && <div className="ok" role="status">You checked in. Your friends can see it in their News Feed.</div>}
      <div style={{ marginBottom: 4 }}><label htmlFor="ci-place"><b>Check in at:</b></label></div>
      <input id="ci-place" type="text" placeholder="Name of the place, e.g. Main Quad" maxLength={100} value={place} onChange={(e) => setPlace(e.target.value)} />
      <input type="text" placeholder="Address or city (optional)" aria-label="Address (optional)" maxLength={200} value={address} onChange={(e) => setAddress(e.target.value)} />
      <input type="text" placeholder="What are you doing?" aria-label="What are you doing?" maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="kw-locrow">
        {loc ? <span><Icon name="place" /> Near {loc.lat.toFixed(2)}, {loc.lng.toFixed(2)} <button type="button" className="kw-link" onClick={() => setLoc(null)}>Remove</button></span>
          : <button type="button" className="btn" onClick={locate}><Icon name="place" /> Use my location</button>}
        <span className="gray small">{locMsg ?? 'Optional. Rounded to about 1 km and encrypted with your check-in. Never collected in the background.'}</span>
      </div>
      <div style={{ marginBottom: 6 }}><b>Who are you with?</b>
        <FriendPicker friends={friends.data ?? []} value={withIds} onChange={setWith} max={20} /></div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <AudienceSelect value={aud} onChange={setAud} />
        <button className="btn b" disabled={busy}>{busy ? 'Checking in…' : 'Check In'}</button>
      </div>
    </form>
  );
}
