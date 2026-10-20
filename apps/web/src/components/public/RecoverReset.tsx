'use client';
// /recover/reset: where the v1 "forgot password" email lands. The link opened a session that proves
// email control but can't unlock anything; we find the account's @handle and continue with the same
// recovery flow (recovery key or trusted friends), plus "I've lost everything" (delayed deletion),
// which needs this proof of email control.
import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { useT } from '@/i18n';
import { sb } from '@/lib/supabase';
import { initSession, useSession } from '@/lib/keys/session';
import { mfaRequired, verifyTotp } from '@/lib/auth/login';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { TextField } from '@/components/ui/Field';
import { LoadingScreen } from '@/components/ui/Spinner';
import { AuthFrame } from '@/components/onboarding/PublicChrome';
import { RecoverFlow } from './RecoverFlow';

export function RecoverReset() {
  const t = useT();
  const { status, userId } = useSession();
  const [mfa, setMfa] = useState<boolean | null>(null);
  const [handle, setHandle] = useState<string | null | undefined>(undefined);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (status === 'loading' || status === 'signed_out' || !userId) return;
    let live = true;
    void (async () => {
      const m = await mfaRequired();
      if (!live) return;
      setMfa(m);
      if (m) return;
      const { data } = await sb().from('profiles').select('username').eq('id', userId).maybeSingle();
      if (live) setHandle((data?.username as string | undefined) ?? null);
    })();
    return () => { live = false; };
  }, [status, userId]);

  async function onCode(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try { await verifyTotp(code); await initSession(); setMfa(false); } catch { setErr(t('signin.mfaWrong')); } finally { setBusy(false); }
  }

  if (status === 'loading') return <LoadingScreen />;
  if (status === 'signed_out') {
    return (
      <AuthFrame>
        <div className="k-flow"><section className="k-flow-step">
          <h1>{t('recover.resetExpiredTitle')}</h1>
          <Callout tone="warning">{t('recover.resetExpiredBody')}</Callout>
          <ButtonLink href="/recover" variant="primary" block>{t('recover.title')}</ButtonLink>
        </section></div>
      </AuthFrame>
    );
  }
  if (mfa) {
    return (
      <AuthFrame>
        <div className="k-flow"><section className="k-flow-step">
          <h1>{t('signin.mfaTitle')}</h1>
          <p className="k-muted">{t('signin.mfaBody')}</p>
          <form className="k-stack" onSubmit={(e) => void onCode(e)}>
            <TextField label={t('signin.mfaCode')} value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric"
              autoComplete="one-time-code" maxLength={7} dir="ltr" required />
            {err ? <Callout tone="danger">{err}</Callout> : null}
            <Button type="submit" variant="primary" size="lg" block busy={busy}>{t('common.continue')}</Button>
          </form>
        </section></div>
      </AuthFrame>
    );
  }
  if (status === 'setup' || handle === null) {
    return (
      <AuthFrame>
        <div className="k-flow"><section className="k-flow-step">
          <h1>{t('recover.notSetUpTitle')}</h1>
          <p className="k-muted">{t('recover.notSetUpBody')}</p>
          <ButtonLink href="/setup" variant="primary" block>{t('setup.cta')}</ButtonLink>
          <p className="k-center k-small"><Link href="/help#recovery">{t('recover.howItWorks')}</Link></p>
        </section></div>
      </AuthFrame>
    );
  }
  if (handle === undefined || mfa === null) return <LoadingScreen />;
  return <RecoverFlow viaEmail initialHandle={handle} />;
}
