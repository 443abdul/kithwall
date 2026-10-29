'use client';
// Settings → Privacy (Kithwall 2). Strong defaults (brief §3): read receipts off, typing indicators off.
// Preferences live in the encrypted vault (lib/settings.ts); the two the server must enforce (read
// receipts, who may send connection requests) are mirrored to privacy_prefs (lib/chat/privacy.ts).
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useT } from '@/i18n';
import { refreshProfile, useSession } from '@/lib/keys/session';
import { saveSettings, setChatVisible, useSettings, type DefaultAudience } from '@/lib/settings';
import { saveServerPrivacy, useServerPrivacy, type RequestsFrom } from '@/lib/chat/privacy';
import { myInfo, unblock } from '@/lib/friends';
import { people, usePeopleVersion } from '@/lib/people';
import { useAppSetting } from '@/lib/hooks';
import { sb, must } from '@/lib/supabase';
import { Switch } from '@/components/ui/Switch';
import { Segmented } from '@/components/ui/Segmented';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Skeleton } from '@/components/ui/Skeleton';
import { useToast } from '@/components/ui/Toast';
import { PersonAvatar } from '@/components/messages/look';
import { SettingsPage, Section } from './shared';
import { loadCallPrefs, saveCallPrefs, useCallPrefs } from '@/lib/calls/prefs';
import { CallCheck } from '@/components/calls/CallCheck';
import { CloseFriendsSection, MutedSection, ProfileVisibilitySection } from './ProfileVisibility';

function useSaver() {
  const t = useT();
  const toast = useToast();
  return async (fn: () => Promise<unknown>) => {
    try { await fn(); toast({ message: t('settings.saved') }); }
    catch { toast({ message: t('settings.saveFailed'), tone: 'danger' }); }
  };
}

function MessagesPrivacy() {
  const t = useT();
  const s = useSettings();
  const qc = useQueryClient();
  const { userId } = useSession();
  const server = useServerPrivacy();
  const save = useSaver();
  // The encrypted setting is the source of truth on this device; repair the server copy if it drifted.
  useEffect(() => {
    if (server.data && server.data.readReceipts !== s.readReceipts) void saveServerPrivacy({ readReceipts: s.readReceipts }).catch(() => undefined);
  }, [server.data, s.readReceipts]);
  return (
    <Section id="messages" title={t('settings.privacy.messages')}>
      <Switch checked={s.readReceipts} label={t('settings.privacy.receipts')} description={t('settings.privacy.receiptsBody')}
        onChange={(v) => void save(async () => {
          await saveSettings({ readReceipts: v });
          await saveServerPrivacy({ readReceipts: v });
          await qc.invalidateQueries({ queryKey: ['privacy', userId] });
          await qc.invalidateQueries({ queryKey: ['receipts'] });
        })} />
      <Switch checked={s.typingIndicator} label={t('settings.privacy.typing')} description={t('settings.privacy.typingBody')}
        onChange={(v) => void save(() => saveSettings({ typingIndicator: v }))} />
      <Switch checked={s.chatLinkPreviews} label={t('security.chatLinkPreviews')} description={t('security.chatLinkPreviewsBody')}
        onChange={(v) => void save(() => saveSettings({ chatLinkPreviews: v }))} />
      <Switch checked={s.chatVisible} label={t('settings.privacy.online')} description={t('settings.privacy.onlineBody')}
        onChange={(v) => setChatVisible(v)} />
    </Section>
  );
}

// Calls (phase 4, docs/v2/04-calls.md §2): relay-only by default, so the people you call never see your IP.
function CallsPrivacy() {
  const t = useT();
  const p = useCallPrefs();
  const { status } = useSession();
  const save = useSaver();
  const [check, setCheck] = useState(false);
  useEffect(() => { if (status === 'ready') void loadCallPrefs().catch(() => undefined); }, [status]);
  return (
    <Section id="calls" title={t('calls.settings.title')}>
      <div>
        <Button size="sm" icon="camera" onClick={() => setCheck(true)}>{t('calls.check.open')}</Button>
        <CallCheck open={check} onClose={() => setCheck(false)} />
      </div>
      <Switch checked={p.relay} label={t('calls.settings.relay')} description={t('calls.settings.relayBody')}
        onChange={(v) => void save(() => saveCallPrefs({ relay: v }))} />
      <Switch checked={p.saver} label={t('calls.settings.saver')} description={t('calls.settings.saverBody')}
        onChange={(v) => void save(() => saveCallPrefs({ saver: v }))} />
      <Switch checked={p.camOff} label={t('calls.settings.camOff')} description={t('calls.settings.camOffBody')}
        onChange={(v) => void save(() => saveCallPrefs({ camOff: v }))} />
    </Section>
  );
}

function ConnectionsPrivacy() {
  const t = useT();
  const qc = useQueryClient();
  const { profile, userId } = useSession();
  usePeopleVersion();
  const server = useServerPrivacy();
  const save = useSaver();
  const [dirErr, setDirErr] = useState(false);
  const from = server.data?.requestsFrom ?? 'everyone';
  async function setDirectory(on: boolean) {
    setDirErr(false);
    const name = myInfo()?.name?.trim().slice(0, 80);
    if (on && !name) { setDirErr(true); return; }
    await save(async () => {
      if (!profile) throw new Error('no profile');
      // The CHECK constraint keeps display_name_public null unless discoverable.
      const { error } = await sb().from('profiles').update(on ? { discoverable: true, display_name_public: name } : { discoverable: false, display_name_public: null }).eq('id', profile.id);
      if (error) throw error;
      await refreshProfile();
    });
  }
  return (
    <Section id="connections" title={t('settings.privacy.connections')}>
      <div className="k-stack-sm">
        <span className="k-label">{t('settings.privacy.requests')}</span>
        {server.isLoading ? <Skeleton height={40} /> : (
          <Segmented<RequestsFrom> block label={t('settings.privacy.requests')} value={from}
            onChange={(v) => void save(async () => { await saveServerPrivacy({ requestsFrom: v }); await qc.invalidateQueries({ queryKey: ['privacy', userId] }); })}
            options={[
              { value: 'everyone', label: t('settings.privacy.fromEveryone') },
              { value: 'mutual', label: t('settings.privacy.fromMutual') },
              { value: 'nobody', label: t('settings.privacy.fromNobody') },
            ]} />
        )}
        <p className="k-hint">{t(from === 'mutual' ? 'settings.privacy.fromMutualBody' : from === 'nobody' ? 'settings.privacy.fromNobodyBody' : 'settings.privacy.fromEveryoneBody')}</p>
      </div>
      <Switch checked={!!profile?.discoverable} label={t('settings.privacy.directory')} description={t('settings.privacy.directoryBody')}
        onChange={(v) => void setDirectory(v)} />
      {dirErr ? <Callout tone="warning">{t('settings.privacy.directoryNoName')}</Callout> : null}
      {profile?.discoverable ? <Callout tone="warning">{t('settings.privacy.directoryOn', { name: profile.display_name_public ?? '' })}</Callout> : null}
      <p className="k-small k-muted">{t('settings.privacy.handleNote', { handle: profile?.username ?? '' })}</p>
    </Section>
  );
}

function PostsPrivacy() {
  const t = useT();
  const s = useSettings();
  const pub = useAppSetting('public_audience_enabled');
  const save = useSaver();
  const options: { value: DefaultAudience; label: string }[] = [
    { value: 'friends', label: t('settings.privacy.audConnections') },
    { value: 'self', label: t('settings.privacy.audMe') },
    ...(pub.data === true ? [{ value: 'public' as DefaultAudience, label: t('settings.privacy.audPublic') }] : []),
  ];
  return (
    <Section id="posts" title={t('settings.privacy.posts')} description={t('settings.privacy.postsBody')}>
      <Segmented<DefaultAudience> block label={t('settings.privacy.defaultAudience')} value={s.defaultAudience}
        onChange={(v) => void save(() => saveSettings({ defaultAudience: v }))} options={options} />
      {s.defaultAudience === 'public' ? <Callout tone="warning">{t('settings.privacy.publicWarning')}</Callout> : null}
    </Section>
  );
}

function Blocked() {
  const t = useT();
  const toast = useToast();
  const { userId } = useSession();
  usePeopleVersion();
  const [rows, setRows] = useState<string[] | null>(null);
  async function load() {
    try {
      const r = must(await sb().from('blocks').select('blocked').eq('blocker', userId!).order('created_at', { ascending: false })) as { blocked: string }[];
      await people.ensure(r.map((x) => x.blocked));
      setRows(r.map((x) => x.blocked));
    } catch { setRows([]); }
  }
  useEffect(() => { if (userId) void load(); }, [userId]); // eslint-disable-line react-hooks/exhaustive-deps
  async function un(id: string) {
    try { await unblock(id); toast({ message: t('settings.privacy.unblocked') }); await load(); }
    catch { toast({ message: t('settings.saveFailed'), tone: 'danger' }); }
  }
  return (
    <Section id="blocked" title={t('settings.privacy.blocked')} description={t('settings.privacy.blockedBody')}>
      {rows === null ? <Skeleton height={40} /> : rows.length ? (
        <ul className="k-set-items">
          {rows.map((id) => (
            <li key={id}>
              <PersonAvatar id={id} size={36} />
              <span className="k-set-item-body"><span className="k-set-item-title k-ltr">@{people.get(id)?.username ?? '…'}</span></span>
              <Button size="sm" variant="ghost" onClick={() => void un(id)}>{t('settings.privacy.unblock')}</Button>
            </li>
          ))}
        </ul>
      ) : <p className="k-muted">{t('settings.privacy.noBlocked')}</p>}
    </Section>
  );
}

export function PrivacySettings() {
  const t = useT();
  return (
    <SettingsPage title={t('settings.privacy.title')} description={t('settings.privacy.description')}>
      <MessagesPrivacy />
      <CallsPrivacy />
      <ConnectionsPrivacy />
      <ProfileVisibilitySection />
      <CloseFriendsSection />
      <PostsPrivacy />
      <MutedSection />
      <Blocked />
    </SettingsPage>
  );
}
