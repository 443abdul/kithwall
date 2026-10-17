'use client';
// Edit My Profile (reference vEdit): Basic Information, Profile Picture, Featured People &
// Relationships, Education and Work, Philosophy, Arts and Entertainment, Sports, Activities and
// Interests, Contact Information. Everything is saved inside the encrypted profile envelope
// (lib/friends saveProfileInfo), readable only by your friends.
import Link from 'next/link';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { Icon } from '@/components/Icon';
import { Avatar } from '@/components/Avatar';
import { Title } from '@/components/Shell';
import { ChangeProfilePicture } from '@/components/photos/ChangeProfilePicture';
import { FriendPicker } from '@/components/social/bits';
import { saveProfileInfo } from '@/lib/friends';
import { useFriendIds } from '@/lib/hooks';
import { useSession } from '@/lib/keys/session';
import { people, usePeopleVersion, usePerson } from '@/lib/people';
import { REL_WITH, RELATIONSHIPS } from '@/lib/social/profile';
import { clean as stripUndefined, notifySafe } from '@/lib/feed/feed';
import type { ProfileInfo } from '@/lib/types';
import '@/styles/social.css';

const TABS: [string, string, string][] = [
  ['basic', 'Basic Information', 'info'], ['picture', 'Profile Picture', 'photo'], ['featured', 'Featured People', 'heart'],
  ['edu', 'Education and Work', 'edu'], ['phil', 'Philosophy', 'info'], ['arts', 'Arts and Entertainment', 'page'],
  ['sports', 'Sports', 'like'], ['acts', 'Activities and Interests', 'group'], ['contact', 'Contact Information', 'msg'],
];

type Likes = NonNullable<ProfileInfo['likes']>;
type Contact = NonNullable<ProfileInfo['contact']>;
type Edu = NonNullable<ProfileInfo['education']>[number];
type Work = NonNullable<ProfileInfo['work']>[number];

const L = 200;   // short field max
const LL = 2000; // long field max

function Row({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return <tr><td className="l">{htmlFor ? <label htmlFor={htmlFor}>{label}:</label> : `${label}:`}</td><td>{children}</td></tr>;
}

export function EditProfile() {
  usePeopleVersion();
  const params = useSearchParams();
  const router = useRouter();
  const tab = TABS.some(([k]) => k === params.get('tab')) ? params.get('tab')! : 'basic';
  const { userId, profile } = useSession();
  const me = usePerson(userId);
  const friends = useFriendIds();
  const qc = useQueryClient();
  const [d, setD] = useState<ProfileInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pic, setPic] = useState(false);

  const [loaded, setLoaded] = useState(false);
  // Load my latest profile info before showing the form, so saving never overwrites newer data.
  useEffect(() => {
    if (!userId) return;
    let live = true;
    void people.refreshInfo(userId).then(() => { if (live) setLoaded(true); }).catch(() => { if (live) setLoaded(true); });
    return () => { live = false; };
  }, [userId]);
  useEffect(() => {
    if (!d && loaded && me) setD(me.info ? structuredClone(me.info) : { name: me.name });
  }, [me, d, loaded]);
  useEffect(() => { setMsg(null); }, [tab]);

  if (!d) return <div className="gray">Loading your profile…</div>;
  const set = (patch: Partial<ProfileInfo>) => setD({ ...d, ...patch });
  const setLike = (k: keyof Likes, v: string) => set({ likes: { ...(d.likes ?? {}), [k]: v.slice(0, LL) } });
  const setContact = (k: keyof Contact, v: string) => set({ contact: { ...(d.contact ?? {}), [k]: v.slice(0, L) } });
  const text = (id: string, value: string | undefined, onChange: (v: string) => void, max = L) =>
    <input id={id} type="text" value={value ?? ''} maxLength={max} onChange={(e) => onChange(e.target.value)} />;
  const area = (id: string, value: string | undefined, onChange: (v: string) => void, hint?: string) => <>
    <textarea id={id} value={value ?? ''} maxLength={LL} onChange={(e) => onChange(e.target.value)} />
    {hint ? <div className="gray small">{hint}</div> : null}
  </>;
  const select = (id: string, value: string | undefined, opts: string[], onChange: (v: string) => void) =>
    <select id={id} className="w" value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
      {opts.map((o) => <option key={o} value={o}>{o || '--'}</option>)}
    </select>;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!d.name?.trim()) { setMsg({ ok: false, text: 'Please enter your name.' }); return; }
    setBusy(true); setMsg(null);
    const prevPartner = me?.info?.relationshipWith;
    const clean: ProfileInfo = {
      ...d, name: d.name.trim().slice(0, 80),
      relationshipWith: d.relationship && REL_WITH[d.relationship] ? d.relationshipWith || undefined : undefined,
      education: (d.education ?? []).filter((x) => x.school.trim()),
      work: (d.work ?? []).filter((x) => x.employer.trim()),
    };
    try {
      await saveProfileInfo(stripUndefined(clean));
      if (clean.relationshipWith && clean.relationshipWith !== prevPartner) {
        await notifySafe(clean.relationshipWith, 'relationship', 'profile', userId!);
      }
      setD(clean);
      setMsg({ ok: true, text: 'Your changes have been saved. Only your friends can see them.' });
      void qc.invalidateQueries({ queryKey: ['profile'] });
    } catch (x) { setMsg({ ok: false, text: (x as Error).message || 'Couldn’t save your profile.' }); } finally { setBusy(false); }
  };

  const buttons = <Row label=""><button className="btn b" disabled={busy}>{busy ? 'Saving…' : 'Save Changes'}</button>{' '}
    <Link className="btn" href={profile ? `/${profile.username}/info` : '/'}>Cancel</Link></Row>;

  const eduRow = (x: Edu, i: number) => (
    <div key={i} className="kw-listbox">
      <table className="form"><tbody>
        <Row label="School" htmlFor={`sch${i}`}>{text(`sch${i}`, x.school, (v) => set({ education: d.education!.map((y, j) => j === i ? { ...y, school: v } : y) }))}</Row>
        <Row label="Type" htmlFor={`kind${i}`}>
          <select id={`kind${i}`} className="w" value={x.kind} onChange={(e) => set({ education: d.education!.map((y, j) => j === i ? { ...y, kind: e.target.value as Edu['kind'] } : y) })}>
            <option value="college">College/University</option><option value="grad">Graduate School</option><option value="high_school">High School</option>
          </select></Row>
        <Row label="Class Year" htmlFor={`yr${i}`}>{text(`yr${i}`, x.year, (v) => set({ education: d.education!.map((y, j) => j === i ? { ...y, year: v.replace(/\D/g, '').slice(0, 4) } : y) }), 4)}</Row>
        <Row label="Concentration" htmlFor={`con${i}`}>{text(`con${i}`, x.concentration, (v) => set({ education: d.education!.map((y, j) => j === i ? { ...y, concentration: v } : y) }))}</Row>
        <Row label=""><button type="button" className="kw-link" onClick={() => set({ education: d.education!.filter((_, j) => j !== i) })}>Remove school</button></Row>
      </tbody></table>
    </div>
  );
  const workRow = (x: Work, i: number) => (
    <div key={i} className="kw-listbox">
      <table className="form"><tbody>
        <Row label="Employer" htmlFor={`emp${i}`}>{text(`emp${i}`, x.employer, (v) => set({ work: d.work!.map((y, j) => j === i ? { ...y, employer: v } : y) }))}</Row>
        <Row label="Position" htmlFor={`pos${i}`}>{text(`pos${i}`, x.position, (v) => set({ work: d.work!.map((y, j) => j === i ? { ...y, position: v } : y) }))}</Row>
        <Row label="City/Town" htmlFor={`city${i}`}>{text(`city${i}`, x.city, (v) => set({ work: d.work!.map((y, j) => j === i ? { ...y, city: v } : y) }))}</Row>
        <Row label="Time Period" htmlFor={`from${i}`}>
          <input id={`from${i}`} type="text" placeholder="From (e.g. 2008)" aria-label="From" style={{ width: 120 }} maxLength={20} value={x.from ?? ''}
            onChange={(e) => set({ work: d.work!.map((y, j) => j === i ? { ...y, from: e.target.value } : y) })} /> to{' '}
          <input type="text" placeholder="present" aria-label="To" style={{ width: 120 }} maxLength={20} value={x.to ?? ''}
            onChange={(e) => set({ work: d.work!.map((y, j) => j === i ? { ...y, to: e.target.value } : y) })} />
        </Row>
        <Row label=""><button type="button" className="kw-link" onClick={() => set({ work: d.work!.filter((_, j) => j !== i) })}>Remove job</button></Row>
      </tbody></table>
    </div>
  );

  let body: ReactNode;
  switch (tab) {
    case 'picture':
      body = (
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
          {userId && <Avatar id={userId} size={180} big />}
          <div>
            <p><b>Your profile picture</b><br /><span className="gray">It&rsquo;s encrypted and only your friends can see it.</span></p>
            <p style={{ marginTop: 8 }}><button type="button" className="btn b" onClick={() => setPic(true)}>Change Picture</button></p>
          </div>
          {pic && <ChangeProfilePicture onClose={() => setPic(false)} />}
        </div>
      );
      break;
    case 'featured': {
      const fl = friends.data ?? [];
      const withPartner = !!(d.relationship && REL_WITH[d.relationship]);
      const partner = d.relationshipWith ? people.person(d.relationshipWith) : null;
      const confirmed = !!partner && partner.info?.relationshipWith === userId;
      body = (
        <form onSubmit={(e) => void save(e)}><table className="form"><tbody>
          <Row label="Relationship Status" htmlFor="rel">{select('rel', d.relationship, ['', ...RELATIONSHIPS], (v) => set({ relationship: v || undefined }))}</Row>
          {withPartner && <Row label="With" htmlFor="relw">
            <select id="relw" className="w" value={d.relationshipWith ?? ''} onChange={(e) => set({ relationshipWith: e.target.value || undefined })}>
              <option value="">--</option>
              {[...fl].sort((a, b) => (people.person(a)?.name ?? '').localeCompare(people.person(b)?.name ?? '')).map((f) =>
                <option key={f} value={f}>{people.person(f)?.name ?? '…'}</option>)}
            </select>
            {d.relationshipWith && <div className="gray small">{confirmed ? 'Confirmed: you list each other.'
              : `Pending: shown on your profile once ${partner?.name.split(' ')[0] ?? 'they'} also lists you. They'll get a notification.`}</div>}
          </Row>}
          {withPartner && <Row label="Anniversary" htmlFor="anniv"><input id="anniv" type="date" value={d.anniversary ?? ''} onChange={(e) => set({ anniversary: e.target.value || undefined })} /></Row>}
          <Row label="Featured Friends"><FriendPicker friends={fl} value={d.featuredFriends ?? []} onChange={(v) => set({ featuredFriends: v })} max={6} />
            <div className="gray small">Up to 6 friends shown on your Info tab.</div></Row>
          <Row label="Friend List" htmlFor="hidef"><label><input id="hidef" type="checkbox" checked={!d.hideFriends} onChange={(e) => set({ hideFriends: !e.target.checked })} /> Show my friend list to my friends</label>
            <div className="gray small">Your friends also use it to work out &ldquo;People You May Know&rdquo; on their own devices.</div></Row>
          {buttons}
        </tbody></table></form>
      );
      break;
    }
    case 'edu':
      body = (
        <form onSubmit={(e) => void save(e)}>
          <div className="sub"><span>Education</span><button type="button" className="kw-link" onClick={() => set({ education: [...(d.education ?? []), { school: '', kind: 'college' }] })}>+ Add a school</button></div>
          {(d.education ?? []).map(eduRow)}
          {!(d.education ?? []).length && <div className="gray" style={{ marginBottom: 8 }}>No schools yet.</div>}
          <div className="sub"><span>Work</span><button type="button" className="kw-link" onClick={() => set({ work: [...(d.work ?? []), { employer: '' }] })}>+ Add a job</button></div>
          {(d.work ?? []).map(workRow)}
          {!(d.work ?? []).length && <div className="gray" style={{ marginBottom: 8 }}>No jobs yet.</div>}
          <table className="form"><tbody>{buttons}</tbody></table>
        </form>
      );
      break;
    case 'phil':
      body = (
        <form onSubmit={(e) => void save(e)}><table className="form"><tbody>
          <Row label="Religious Views" htmlFor="rv">{text('rv', d.religion, (v) => set({ religion: v }))}</Row>
          <Row label="Political Views" htmlFor="pv">{text('pv', d.political, (v) => set({ political: v }))}</Row>
          <Row label="People Who Inspire You" htmlFor="insp">{area('insp', d.likes?.inspirational, (v) => setLike('inspirational', v), 'Separate with commas.')}</Row>
          <Row label="Favorite Quotations" htmlFor="quo">{area('quo', d.quotes, (v) => set({ quotes: v }))}</Row>
          {buttons}
        </tbody></table></form>
      );
      break;
    case 'arts':
      body = (
        <form onSubmit={(e) => void save(e)}><table className="form"><tbody>
          {(['music', 'books', 'movies', 'tv', 'games'] as const).map((k) => (
            <Row key={k} label={{ music: 'Music', books: 'Books', movies: 'Movies', tv: 'Television', games: 'Games' }[k]} htmlFor={`a-${k}`}>
              {area(`a-${k}`, d.likes?.[k], (v) => setLike(k, v), 'Separate with commas.')}</Row>
          ))}
          {buttons}
        </tbody></table></form>
      );
      break;
    case 'sports':
      body = (
        <form onSubmit={(e) => void save(e)}><table className="form"><tbody>
          <Row label="Sports You Play" htmlFor="sp">{area('sp', d.likes?.sports, (v) => setLike('sports', v), 'Separate with commas.')}</Row>
          <Row label="Favorite Teams" htmlFor="tm">{area('tm', d.likes?.teams, (v) => setLike('teams', v))}</Row>
          <Row label="Favorite Athletes" htmlFor="ath">{area('ath', d.likes?.athletes, (v) => setLike('athletes', v))}</Row>
          {buttons}
        </tbody></table></form>
      );
      break;
    case 'acts':
      body = (
        <form onSubmit={(e) => void save(e)}><table className="form"><tbody>
          <Row label="Activities" htmlFor="act">{area('act', d.likes?.activities, (v) => setLike('activities', v), 'Separate with commas.')}</Row>
          <Row label="Interests" htmlFor="int">{area('int', d.likes?.interests, (v) => setLike('interests', v), 'Separate with commas.')}</Row>
          {buttons}
        </tbody></table></form>
      );
      break;
    case 'contact':
      body = (
        <form onSubmit={(e) => void save(e)}><table className="form"><tbody>
          <Row label="Email" htmlFor="ce">{text('ce', d.contact?.email, (v) => setContact('email', v))}</Row>
          <Row label="Mobile Phone" htmlFor="cp">{text('cp', d.contact?.phone, (v) => setContact('phone', v))}</Row>
          <Row label="Screen Name" htmlFor="ci">{text('ci', d.contact?.im, (v) => setContact('im', v))}</Row>
          <Row label="Address" htmlFor="ca">{area('ca', d.contact?.address, (v) => setContact('address', v))}</Row>
          <Row label="Website" htmlFor="cw">{text('cw', d.contact?.website, (v) => setContact('website', v))}</Row>
          {buttons}
        </tbody></table>
          <p className="gray small">Contact information is encrypted and shown only to your friends. Your login email isn&rsquo;t shown unless you add it here.</p></form>
      );
      break;
    default:
      body = (
        <form onSubmit={(e) => void save(e)}><table className="form"><tbody>
          <Row label="Name" htmlFor="nm">{text('nm', d.name, (v) => set({ name: v }), 80)}</Row>
          <Row label="Current City" htmlFor="cc">{text('cc', d.currentCity, (v) => set({ currentCity: v }))}</Row>
          <Row label="Hometown" htmlFor="ht">{text('ht', d.hometown, (v) => set({ hometown: v }))}</Row>
          <Row label="I Am" htmlFor="sx">{select('sx', d.sex, ['', 'Female', 'Male', 'Prefer not to say'], (v) => set({ sex: v || undefined }))}</Row>
          <Row label="Birthday" htmlFor="bd"><input id="bd" type="date" value={d.birthday ?? ''} onChange={(e) => set({ birthday: e.target.value || undefined })} />{' '}
            <select aria-label="Who sees your birthday" value={d.showBirthday ?? 'full'} onChange={(e) => set({ showBirthday: e.target.value as ProfileInfo['showBirthday'] })}>
              <option value="full">Show my full birthday</option><option value="month_day">Show only month &amp; day</option><option value="none">Don&rsquo;t show my birthday</option>
            </select></Row>
          <Row label="Interested In" htmlFor="ii">{select('ii', d.interestedIn, ['', 'Men', 'Women', 'Men and Women'], (v) => set({ interestedIn: v || undefined }))}</Row>
          <Row label="Looking For" htmlFor="lf">{text('lf', d.lookingFor, (v) => set({ lookingFor: v }))}</Row>
          <Row label="Languages" htmlFor="lg">{text('lg', d.languages, (v) => set({ languages: v }))}</Row>
          <Row label="About Me" htmlFor="bio">{area('bio', d.bio, (v) => set({ bio: v }))}</Row>
          {buttons}
        </tbody></table></form>
      );
  }

  return (
    <div className="kw-editwrap">
      <Title right={profile ? <Link href={`/${profile.username}`}>View My Profile</Link> : null}>Edit My Profile</Title>
      <div className="kw-edit">
        <ul className="enav">
          {TABS.map(([k, l, i]) => <li key={k}><Link className={k === tab ? 'on' : ''} aria-current={k === tab ? 'page' : undefined}
            href={`/settings/profile?tab=${k}`} onClick={(e) => { e.preventDefault(); router.replace(`/settings/profile?tab=${k}`); }}><Icon name={i} />{l}</Link></li>)}
        </ul>
        <div style={{ flex: 1, minWidth: 0 }}>
          {msg && <div className={msg.ok ? 'ok' : 'err'} role={msg.ok ? 'status' : 'alert'}>{msg.text}</div>}
          <div className="note small"><Icon name="lock" /> Your profile is encrypted on this device. Only your friends can read it.</div>
          {body}
        </div>
      </div>
    </div>
  );
}
