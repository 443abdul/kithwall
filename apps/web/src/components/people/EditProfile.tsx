'use client';
// Edit my profile: photo (re-encoded, encrypted, readable by my connections), name, short bio and a few
// About fields. Each field goes to whoever Settings → Privacy → Profile allows (connections, close friends or
// only me; lib/friends saveProfileInfo). 'Only me' fields come from the vault, so they are merged in here.
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useT } from '@/i18n';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Textarea, TextField } from '@/components/ui/Field';
import { Icon } from '@/components/ui/Icon';
import { useToast } from '@/components/ui/Toast';
import { useMe } from '@/components/shell/AppShell';
import { myInfo, saveProfileInfo } from '@/lib/friends';
import { getSession, me as myId } from '@/lib/keys/session';
import { people, usePeopleVersion } from '@/lib/people';
import { Spinner } from '@/components/ui/Spinner';
import { saveAvatar, setProfilePicture } from '@/lib/photos';
import { clean } from '@/lib/feed/feed';
import type { ProfileInfo } from '@/lib/types';
import { myPrivateFields } from '@/lib/social/visibility';

const BIO_MAX = 160;

export function EditProfileDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const me = useMe();
  usePeopleVersion();
  // Never start from a placeholder: until my own (encrypted) profile has been read on this device, the
  // form waits — saving defaults over it would overwrite my real name and details.
  const loaded = myInfo();
  const start: ProfileInfo = loaded ?? { name: getSession().profile?.display_name_public || getSession().profile?.username || '' };
  const [name, setName] = useState(start.name ?? '');
  const [bio, setBio] = useState(start.bio ?? '');
  const [city, setCity] = useState(start.currentCity ?? '');
  const [hometown, setHometown] = useState(start.hometown ?? '');
  const [work, setWork] = useState(start.work?.[0]?.employer ?? '');
  const [school, setSchool] = useState(start.education?.[0]?.school ?? '');
  const [languages, setLanguages] = useState(start.languages ?? '');
  const [website, setWebsite] = useState(start.contact?.website ?? '');
  const [birthday, setBirthday] = useState(start.birthday ?? '');
  const [priv, setPriv] = useState<Partial<ProfileInfo> | null>(null);
  const [busy, setBusy] = useState<null | 'save' | 'photo'>(null);
  const [err, setErr] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const [filled, setFilled] = useState(!!loaded);
  const [noInfo, setNoInfo] = useState(false);

  // 'Only me' fields live in my vault, not in the envelope myInfo() reads.
  useEffect(() => {
    let live = true;
    myPrivateFields().then((p) => {
      if (!live) return;
      setPriv(p);
      if (p.bio) setBio(p.bio);
      if (p.currentCity) setCity(p.currentCity);
      if (p.hometown) setHometown(p.hometown);
      if (p.work?.[0]?.employer) setWork(p.work[0].employer);
      if (p.education?.[0]?.school) setSchool(p.education[0].school);
      if (p.languages) setLanguages(p.languages);
      if (p.contact?.website) setWebsite(p.contact.website);
      if (p.birthday) setBirthday(p.birthday);
    }).catch(() => { if (live) setPriv({}); });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (filled) return;
    let live = true;
    let tries = 0;
    const timer = setInterval(() => {
      const info = myInfo();
      if (info && live) {
        setName(info.name ?? ''); setBio(info.bio ?? ''); setCity(info.currentCity ?? ''); setHometown(info.hometown ?? '');
        setWork(info.work?.[0]?.employer ?? ''); setSchool(info.education?.[0]?.school ?? ''); setLanguages(info.languages ?? '');
        setWebsite(info.contact?.website ?? ''); setBirthday(info.birthday ?? ''); setFilled(true);
        clearInterval(timer);
      } else if (++tries % 3 === 1) void people.refreshInfo(myId()).catch(() => undefined);
      // A brand-new account may have no profile yet: after a while, let it be created from scratch.
      if (tries > 20 && live) { setNoInfo(true); clearInterval(timer); }
    }, 500);
    return () => { live = false; clearInterval(timer); };
  }, [filled]);
  const ready = (filled || noInfo) && priv !== null;

  async function changePhoto(f: File | undefined) {
    if (file.current) file.current.value = '';
    if (!f) return;
    setBusy('photo'); setErr(null);
    try { await saveAvatar(await setProfilePicture(f)); toast({ message: t('profile.saved') }); }
    catch { setErr(t('feed.failed')); }
    finally { setBusy(null); }
  }

  async function removePhoto() {
    setBusy('photo');
    try { await saveAvatar(undefined); } catch { setErr(t('feed.failed')); } finally { setBusy(null); }
  }

  async function save() {
    if (!ready) return;
    if (!name.trim()) { setErr(t('profile.nameRequired')); return; }
    setBusy('save'); setErr(null);
    try {
      const cur: ProfileInfo = { ...(priv ?? {}), ...(myInfo() ?? start) }; // re-read: the photo may have changed meanwhile
      const next: ProfileInfo = { ...cur, name: name.trim().slice(0, 80) };
      const set = <K extends keyof ProfileInfo>(k: K, v: ProfileInfo[K] | undefined) => { if (v) next[k] = v; else delete next[k]; };
      set('bio', bio.trim().slice(0, BIO_MAX) || undefined);
      set('currentCity', city.trim().slice(0, 100) || undefined);
      set('hometown', hometown.trim().slice(0, 100) || undefined);
      set('languages', languages.trim().slice(0, 200) || undefined);
      set('birthday', /^\d{4}-\d{2}-\d{2}$/.test(birthday) ? birthday : undefined);
      const w = work.trim().slice(0, 100);
      set('work', w ? [{ ...(cur.work?.[0] ?? {}), employer: w }, ...(cur.work?.slice(1) ?? [])] : cur.work?.slice(1).length ? cur.work.slice(1) : undefined);
      const s = school.trim().slice(0, 100);
      set('education', s ? [{ ...(cur.education?.[0] ?? { kind: 'college' as const }), school: s }, ...(cur.education?.slice(1) ?? [])] : cur.education?.slice(1).length ? cur.education.slice(1) : undefined);
      const site = website.trim().slice(0, 200);
      const contact = { ...(cur.contact ?? {}) };
      if (site) contact.website = site; else delete contact.website;
      set('contact', Object.keys(contact).length ? contact : undefined);
      await saveProfileInfo(clean(next), { replacePrivate: true });
      await qc.invalidateQueries({ queryKey: ['profile-by-handle'] });
      toast({ message: t('profile.saved') });
      onClose();
    } catch {
      setErr(t('feed.failed'));
    } finally { setBusy(null); }
  }

  return (
    <Dialog open onClose={onClose} title={t('profile.edit')} sheet dismissible={!busy}
      footer={<>
        <Button variant="ghost" onClick={onClose} disabled={!!busy}>{t('feed.cancel')}</Button>
        <Button variant="primary" onClick={() => void save()} busy={busy === 'save'} disabled={busy === 'photo' || !ready}>{t('feed.save')}</Button>
      </>}>
      <div className="k-stack" aria-busy={!ready || undefined}>
        {!ready ? <div className="k-center"><Spinner /></div> : null}
        <div className="k-row">
          <Avatar name={name || me.name} src={me.avatar} size={72} />
          <div className="k-row-wrap">
            <input ref={file} type="file" accept="image/*" hidden onChange={(e) => void changePhoto(e.target.files?.[0])} />
            <Button size="sm" variant="soft" icon="camera" busy={busy === 'photo'} disabled={!ready} onClick={() => file.current?.click()}>{t('profile.changePhoto')}</Button>
            {me.avatar ? <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void removePhoto()}>{t('profile.removePhoto')}</Button> : null}
          </div>
        </div>
        <TextField label={t('profile.name')} value={name} maxLength={80} autoComplete="name" dir="auto" onChange={(e) => setName(e.target.value)} />
        <Textarea label={t('profile.bio')} hint={t('profile.bioHint')} value={bio} maxLength={BIO_MAX} rows={2} dir="auto" onChange={(e) => setBio(e.target.value)} />
        <TextField label={t('profile.city')} value={city} maxLength={100} dir="auto" onChange={(e) => setCity(e.target.value)} />
        <TextField label={t('profile.hometown')} value={hometown} maxLength={100} dir="auto" onChange={(e) => setHometown(e.target.value)} />
        <TextField label={t('profile.work')} value={work} maxLength={100} dir="auto" onChange={(e) => setWork(e.target.value)} />
        <TextField label={t('profile.education')} value={school} maxLength={100} dir="auto" onChange={(e) => setSchool(e.target.value)} />
        <TextField label={t('profile.languages')} value={languages} maxLength={200} dir="auto" onChange={(e) => setLanguages(e.target.value)} />
        <TextField label={t('profile.birthday')} type="date" value={birthday} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setBirthday(e.target.value)} />
        <TextField label={t('profile.website')} value={website} maxLength={200} type="url" inputMode="url" dir="ltr" onChange={(e) => setWebsite(e.target.value)} />
        <p className="k-muted k-small"><Icon name="lock" /> {t('profile.encryptedNote')} <Link href="/you/settings/privacy#profile">{t('visibility.manage')}</Link></p>
        {err ? <p className="k-error" role="alert"><Icon name="alert" />{err}</p> : null}
      </div>
    </Dialog>
  );
}
