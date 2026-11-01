'use client';
// Shown when a session exists but the keys aren't in memory (after a reload without "Keep me signed in",
// or after auto-lock). Unlock with a passkey or the account passphrase.
// Self-contained Kithwall 2 screen (wraps itself in V2Root).
import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { signOut, unlock, useSession } from '@/lib/keys/session';
import { accountApi } from '@/lib/auth/account';
import { usePerson } from '@/lib/people';
import { useFileUrl } from '@/lib/media';
import { useT } from '@/i18n';
import { V2Root } from '@/components/shell/V2Root';
import { Logo } from '@/components/shell/Logo';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Switch } from '@/components/ui/Switch';
import { PassphraseField } from '@/components/onboarding/PassphraseField';
import { accountErrorMessage } from '@/components/onboarding/errors';
import { useDocumentTitle } from '@/components/onboarding/useDocumentTitle';

export function UnlockScreen() {
  return <V2Root><UnlockInner /></V2Root>;
}

function UnlockInner() {
  const t = useT();
  const { userId, profile, error: sessionError } = useSession();
  const person = usePerson(userId);
  const avatar = useFileUrl(person?.info?.avatar?.thumb);
  const [secret, setSecret] = useState('');
  const [keep, setKeep] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<'passkey' | 'secret' | null>(null);
  // Which unlock methods this account has (passkey and/or passphrase/password). Unknown → offer both.
  const [opts, setOpts] = useState<{ passkey: boolean; password: boolean }>({ passkey: true, password: true });
  useDocumentTitle(t('unlock.title'));
  useEffect(() => {
    let live = true;
    accountApi.unlockOptions().then((o) => { if (live && (o.passkey || o.password)) setOpts(o); }).catch(() => undefined);
    return () => { live = false; };
  }, []);

  async function withPasskey() {
    setBusy('passkey'); setErr(null);
    try { await accountApi.unlockWithPasskey(); }
    catch (e) { setErr(accountErrorMessage(t, e)); }
    finally { setBusy(null); }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy('secret'); setErr(null);
    try {
      await unlock(secret, keep);
    } catch {
      setErr(t('unlock.wrongPassword'));
    } finally { setBusy(null); }
  }

  const name = person?.name ?? profile?.username ?? '';
  return (
    <div className="k-auth">
      <header className="k-pub-head"><Logo size={32} /></header>
      <main id="main" className="k-auth-main">
        <div className="k-flow">
          <section className="k-flow-step k-unlock">
            <div className="k-unlock-who">
              <Avatar name={name} src={avatar} size={72} />
              <span className="k-unlock-lock" aria-hidden>
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="5" y="10.5" width="14" height="10" rx="2.5" /><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" /></svg>
              </span>
            </div>
            <h1>{t('unlock.title')}</h1>
            <p className="k-muted">{name ? t('unlock.bodyNamed', { name }) : t('unlock.body')}</p>
            {err ? <Callout tone="danger">{err}</Callout> : null}
            {/* Opened without a connection, and this device kept nothing to open the account with (lib/keys/offline). */}
            {!err && sessionError === 'offline_unavailable' ? <Callout tone="warning">{t('offline.unavailable')}</Callout> : null}
            {opts.passkey ? (
              <Button variant="primary" size="lg" block icon="fingerprint" busy={busy === 'passkey'} disabled={!!busy} onClick={() => void withPasskey()}>
                {t('unlock.passkey')}
              </Button>
            ) : null}
            {opts.passkey && opts.password ? <div className="k-divider"><span>{t('unlock.or')}</span></div> : null}
            {opts.password ? <form className="k-stack" onSubmit={onSubmit}>
              <PassphraseField
                label={t('unlock.secretLabel')}
                value={secret}
                onValue={setSecret}
                autoComplete="current-password"
                required
              />
              <Switch checked={keep} onChange={setKeep} label={t('unlock.keep')} description={t('unlock.keepHint')} />
              <Button type="submit" variant={opts.passkey ? 'secondary' : 'primary'} size="lg" block busy={busy === 'secret'} disabled={!!busy || !secret}>{t('unlock.submit')}</Button>
            </form> : null}
            <p className="k-center k-small k-muted">
              {t('unlock.notYou')}{' '}
              <button type="button" className="k-linkbtn" onClick={() => void signOut().then(() => { location.href = '/'; })}>{t('unlock.signOut')}</button>
              {' · '}<Link href="/recover">{t('recover.title')}</Link>
            </p>
          </section>
        </div>
      </main>
    </div>
  );
}
