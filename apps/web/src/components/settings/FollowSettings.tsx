'use client';
// Settings → Following and public posts (docs/v2/10-follow-public.md). Everything here is off or at its most
// private until the person chooses otherwise:
//   - "Let people follow me" (off): on needs a public name, creates my followers audience and its first key;
//   - "Let search engines show my public posts" (off) and "Show who I follow to my connections" (on);
//   - who can comment on my posts and who can mention me (the database enforces both);
//   - hidden words (kept only in my encrypted vault, applied on this device);
//   - the people I restricted.
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useT } from '@/i18n';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Dialog } from '@/components/ui/Dialog';
import { TextField, Textarea } from '@/components/ui/Field';
import { Skeleton } from '@/components/ui/Skeleton';
import { Switch } from '@/components/ui/Switch';
import { useToast } from '@/components/ui/Toast';
import { Avatar } from '@/components/ui/Avatar';
import { CommentPolicySelect } from '@/components/posts/PostOptions';
import { saveServerPrivacy, useServerPrivacy } from '@/lib/chat/privacy';
import { myRestricted, restrictedKey, setFollowEnabled, unrestrict, useFollowInfo } from '@/lib/follow/follow';
import { myInfo } from '@/lib/friends';
import { useAppNumber, useAppSetting } from '@/lib/hooks';
import { useSession } from '@/lib/keys/session';
import { saveHiddenWords, useHiddenStore } from '@/lib/social/hiddenStore';
import { MAX_HIDDEN_WORDS, parseHiddenInput } from '@/lib/social/hiddenWords';
import { SettingsPage, Section } from './shared';

function useSaver() {
  const t = useT();
  const toast = useToast();
  return async (fn: () => Promise<unknown>) => {
    try { await fn(); toast({ message: t('settings.saved') }); return true; }
    catch { toast({ message: t('settings.saveFailed'), tone: 'danger' }); return false; }
  };
}

function FollowSwitch() {
  const t = useT();
  const qc = useQueryClient();
  const { profile, userId } = useSession();
  const save = useSaver();
  const server = useServerPrivacy();
  const info = useFollowInfo(userId).data ?? null;
  const publicOn = useAppSetting('public_posts_enabled').data === true;
  const minAge = useAppNumber('public_post_min_age_hours', 24);
  const on = !!profile?.follow_enabled;
  const [asking, setAsking] = useState<'on' | 'off' | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  function toggle(next: boolean) {
    setName((profile?.display_name_public ?? myInfo()?.name ?? '').slice(0, 80));
    setAsking(next ? 'on' : 'off');
  }
  async function confirm() {
    setBusy(true);
    const ok = await save(async () => {
      if (asking === 'on') await setFollowEnabled(true, name);
      else await setFollowEnabled(false, undefined, !!profile?.discoverable);
      await Promise.all([qc.invalidateQueries({ queryKey: ['follows'] }), qc.invalidateQueries({ queryKey: ['v2feed'] }), qc.invalidateQueries({ queryKey: ['public-posts'] })]);
    });
    setBusy(false);
    if (ok) setAsking(null);
  }
  const savePrivacy = (patch: Parameters<typeof saveServerPrivacy>[0]) => save(async () => { await saveServerPrivacy(patch); await qc.invalidateQueries({ queryKey: ['privacy', userId] }); });

  return (
    <Section id="follow" title={t('follow.settings.followTitle')} description={t('follow.settings.followBody')}>
      <Switch checked={on} label={t('follow.settings.allow')} description={t('follow.settings.allowBody')} onChange={toggle} />
      {on ? (
        <>
          <Callout tone="accent" icon="userCheck">
            {t('follow.settings.onNote', { name: profile?.display_name_public ?? '' })}
            {info?.followers != null ? <> {t('follow.count', { count: info.followers })}. <Link href="/people?tab=followers">{t('follow.settings.seeFollowers')}</Link></> : null}
          </Callout>
          <Button size="sm" variant="ghost" icon="edit" onClick={() => toggle(true)}>{t('follow.settings.changeName')}</Button>
          {publicOn ? <p className="k-small k-muted">{t('follow.settings.publicNote', { count: minAge })}</p> : null}
          {server.isLoading ? <Skeleton height={40} /> : (
            <Switch checked={!!server.data?.indexPublic} label={t('follow.settings.index')} description={t('follow.settings.indexBody')}
              onChange={(v) => void savePrivacy({ indexPublic: v })} />
          )}
        </>
      ) : null}
      {server.isLoading ? <Skeleton height={40} /> : (
        <Switch checked={server.data?.showFollowing !== false} label={t('follow.settings.showFollowing')} description={t('follow.settings.showFollowingBody')}
          onChange={(v) => void savePrivacy({ showFollowing: v })} />
      )}

      <Dialog open={asking !== null} onClose={() => setAsking(null)} dismissible={!busy}
        title={asking === 'off' ? t('follow.settings.offTitle') : t('follow.settings.onTitle')}
        footer={<>
          <Button variant="ghost" onClick={() => setAsking(null)} disabled={busy}>{t('feed.cancel')}</Button>
          <Button variant={asking === 'off' ? 'danger' : 'primary'} busy={busy} disabled={asking === 'on' && !name.trim()} onClick={() => void confirm()}>
            {asking === 'off' ? t('follow.settings.offConfirm') : on ? t('feed.save') : t('follow.settings.onConfirm')}
          </Button>
        </>}>
        {asking === 'off' ? <p>{t('follow.settings.offBody')}</p> : (
          <div className="k-stack">
            <p>{t('follow.settings.onBody')}</p>
            <TextField label={t('follow.settings.publicName')} hint={t('follow.settings.publicNameHint')} value={name} maxLength={80} dir="auto"
              autoComplete="off" onChange={(e) => setName(e.target.value)} />
          </div>
        )}
      </Dialog>
    </Section>
  );
}

function CommentControls() {
  const t = useT();
  const qc = useQueryClient();
  const { userId } = useSession();
  const server = useServerPrivacy();
  const save = useSaver();
  const savePrivacy = (patch: Parameters<typeof saveServerPrivacy>[0]) => save(async () => { await saveServerPrivacy(patch); await qc.invalidateQueries({ queryKey: ['privacy', userId] }); });
  return (
    <Section id="comments" title={t('follow.settings.commentsTitle')} description={t('follow.settings.commentsBody')}>
      {server.isLoading ? <Skeleton height={80} /> : (
        <>
          <CommentPolicySelect label={t('comments.policy.account')} allowDefault={false} value={server.data?.commentPolicy ?? 'everyone'}
            onChange={(v) => void savePrivacy({ commentPolicy: v ?? 'everyone' })} />
          <CommentPolicySelect label={t('comments.policy.mention')} allowDefault={false} everyone={t('comments.policy.anyone')} value={server.data?.mentionPolicy ?? 'everyone'}
            onChange={(v) => void savePrivacy({ mentionPolicy: v ?? 'everyone' })} />
          <p className="k-small k-muted">{t('follow.settings.commentsNote')}</p>
        </>
      )}
    </Section>
  );
}

function HiddenWords() {
  const t = useT();
  const store = useHiddenStore();
  const save = useSaver();
  // Null until the person types: the box then shows the stored list, afterwards what they typed.
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const value = text ?? store.words.join(', ');
  async function submit() {
    setBusy(true);
    await save(async () => { await saveHiddenWords(parseHiddenInput(value)); setText(null); });
    setBusy(false);
  }
  return (
    <Section id="hidden" title={t('hidden.title')} description={t('hidden.body')}>
      {!store.loaded ? <Skeleton height={80} /> : (
        <>
          <Textarea label={t('hidden.label')} hint={t('hidden.hint', { count: MAX_HIDDEN_WORDS })} value={value} rows={3} dir="auto" maxLength={8000}
            onChange={(e) => setText(e.target.value)} />
          <div><Button variant="primary" size="sm" busy={busy} onClick={() => void submit()}>{t('feed.save')}</Button></div>
        </>
      )}
    </Section>
  );
}

function Restricted() {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const { status } = useSession();
  const q = useQuery({ queryKey: ['follows', 'restricted-list'], enabled: status === 'ready', queryFn: myRestricted });
  async function undo(id: string, name: string) {
    try {
      await unrestrict(id);
      await Promise.all([qc.invalidateQueries({ queryKey: ['follows', 'restricted-list'] }), qc.invalidateQueries({ queryKey: restrictedKey })]);
      toast({ message: t('restrict.undone', { name }) });
    } catch { toast({ message: t('settings.saveFailed'), tone: 'danger' }); }
  }
  return (
    <Section id="restricted" title={t('restrict.title')} description={t('restrict.body')}>
      {q.isPending ? <Skeleton height={40} /> : q.data?.length ? (
        <ul className="k-set-items">
          {q.data.map((p) => {
            const name = p.name?.trim() || (p.username ? `@${p.username}` : '…');
            return (
              <li key={p.id}>
                <Avatar name={name} size={36} />
                <span className="k-set-item-body"><span className="k-set-item-title">{name}</span></span>
                <Button size="sm" variant="ghost" onClick={() => void undo(p.id, name)}>{t('restrict.stop')}</Button>
              </li>
            );
          })}
        </ul>
      ) : <p className="k-muted">{t('restrict.none')}</p>}
    </Section>
  );
}

export function FollowSettings() {
  const t = useT();
  return (
    <SettingsPage title={t('follow.settings.title')} description={t('follow.settings.description')}>
      <FollowSwitch />
      <CommentControls />
      <HiddenWords />
      <Restricted />
    </SettingsPage>
  );
}
