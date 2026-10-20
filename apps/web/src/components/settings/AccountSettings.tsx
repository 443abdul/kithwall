'use client';
// Settings → Account: who you are here (name and handle, read-only for now) and the optional notice email.
import { useEffect, useState, type FormEvent } from 'react';
import { useT } from '@/i18n';
import { useSession } from '@/lib/keys/session';
import { accountApi, AccountError } from '@/lib/auth/account';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/Field';
import { Callout } from '@/components/ui/Callout';
import { Badge } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';
import { useMe } from '@/components/shell/AppShell';
import { SettingsPage, Section } from './shared';

type Status = Awaited<ReturnType<typeof accountApi.accountStatus>>;

export function AccountSettings() {
  const t = useT();
  const me = useMe();
  const { status, email } = useSession();
  const [st, setSt] = useState<Status | null>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  useEffect(() => {
    if (status !== 'ready') return;
    let live = true;
    accountApi.accountStatus().then((s) => { if (live) setSt(s); }).catch(() => undefined);
    return () => { live = false; };
  }, [status]);

  const legacy = !!email && !email.endsWith('@id.kithwall.invalid');

  async function save(e: FormEvent) {
    e.preventDefault();
    const v = value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { setMsg({ tone: 'danger', text: t('settings.account.emailInvalid') }); return; }
    setBusy(true); setMsg(null);
    try {
      await accountApi.setNoticeEmail(v);
      setMsg({ tone: 'success', text: t('settings.account.emailSent', { email: v }) });
      setValue('');
    } catch (x) {
      setMsg({ tone: 'danger', text: x instanceof AccountError && x.code === 'rate_limited' ? t('errors.rate_limited') : t('settings.account.emailFailed') });
    } finally { setBusy(false); }
  }

  async function remove() {
    setBusy(true); setMsg(null);
    try {
      await accountApi.setNoticeEmail(null);
      setSt((s) => (s ? { ...s, noticeEmail: null } : s));
      setMsg({ tone: 'success', text: t('settings.account.emailRemoved') });
    } catch { setMsg({ tone: 'danger', text: t('settings.account.emailFailed') }); }
    finally { setBusy(false); }
  }

  return (
    <SettingsPage title={t('settings.account.title')}>
      <Section id="profile" title={t('settings.account.profile')} description={t('settings.account.profileNote')}>
        <div className="k-set-about">
          <Avatar name={me.name || '?'} src={me.avatar} size={64} />
          <dl className="k-set-kv">
            <dt>{t('settings.account.name')}</dt><dd>{me.name || '—'}</dd>
            <dt>{t('settings.account.handle')}</dt><dd className="k-ltr">@{me.handle}</dd>
          </dl>
        </div>
      </Section>

      <Section id="signin" title={t('settings.account.signin')}>
        {st ? (
          <dl className="k-set-kv">
            <dt>{t('settings.account.passkeys')}</dt><dd>{t('settings.account.passkeyCount', { count: st.passkeys })}</dd>
            <dt>{t('settings.account.passphrase')}</dt><dd>{st.hasPassphrase ? t('settings.account.yes') : t('settings.account.no')}</dd>
            {legacy ? <><dt>{t('settings.account.loginEmail')}</dt><dd className="k-ltr">{email}</dd></> : null}
          </dl>
        ) : <Skeleton height={48} />}
      </Section>

      <Section id="email" title={t('settings.account.emailTitle')} description={t('settings.account.emailBody')}>
        {msg ? <Callout tone={msg.tone}>{msg.text}</Callout> : null}
        {st?.noticeEmail ? (
          <div className="k-set-row">
            <span><span className="k-ltr">{st.noticeEmail}</span> <Badge tone="success">{t('settings.account.verified')}</Badge></span>
            <Button variant="secondary" size="sm" busy={busy} onClick={() => void remove()}>{t('settings.account.emailRemove')}</Button>
          </div>
        ) : null}
        <form className="k-stack-sm" onSubmit={(e) => void save(e)}>
          <TextField type="email" dir="ltr" autoComplete="email" inputMode="email" label={st?.noticeEmail ? t('settings.account.emailChange') : t('settings.account.emailLabel')}
            hint={t('settings.account.emailHint')} value={value} onChange={(e) => setValue(e.target.value)} />
          <div><Button type="submit" variant="primary" busy={busy} disabled={!value.trim()}>{t('settings.account.emailSave')}</Button></div>
        </form>
      </Section>
    </SettingsPage>
  );
}
