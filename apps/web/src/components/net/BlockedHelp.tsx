'use client';
// /help/blocked: what to do when Kithwall is blocked or the internet is shut down
// (docs/v2/08-censorship.md). Public: works signed in or out, and on every mirror.
import Link from 'next/link';
import { useT, type MessageKey } from '@/i18n';
import { Card } from '@/components/ui/Card';
import { PublicFrame } from '@/components/onboarding/PublicChrome';
import { useDocumentTitle } from '@/components/onboarding/useDocumentTitle';
import { ApkPanel, MirrorsPanel, RoutePanel, TorPanel } from './ConnectionPanels';

function Part({ id, title, body, children }: { id: string; title: MessageKey; body?: MessageKey; children?: React.ReactNode }) {
  const t = useT();
  return (
    <section id={id} className="k-help-section" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>{t(title)}</h2>
      <Card>
        <div className="k-stack">
          {body ? <p>{t(body)}</p> : null}
          {children}
        </div>
      </Card>
    </section>
  );
}

export function BlockedHelp() {
  const t = useT();
  useDocumentTitle(t('net.help.title'));
  return (
    <PublicFrame>
      <div className="k-doc-layout k-net-help">
        <header className="k-doc-head">
          <h1>{t('net.help.title')}</h1>
          <p className="k-muted">{t('net.help.lede')}</p>
        </header>
        <div className="k-doc-body">
          <Part id="now" title="net.route.title"><RoutePanel /></Part>
          <Part id="mirrors" title="net.help.mirrors.title" body="net.help.mirrors.body"><MirrorsPanel /></Part>
          <Part id="tor" title="net.help.tor.title"><TorPanel /></Part>
          <Part id="app" title="net.help.app.title" body="net.help.app.body"><ApkPanel /></Part>
          <Part id="vpn" title="net.help.vpn.title" body="net.help.vpn.body" />
          <Part id="shutdown" title="net.help.shutdown.title" body="net.help.shutdown.body" />
          <Part id="safety" title="net.help.safety.title" body="net.help.safety.body" />
          <p className="k-muted k-small k-doc-foot">
            <Link href="/you/settings/connection">{t('net.help.settingsLink')}</Link> · <Link href="/help">{t('help.title')}</Link>
          </p>
        </div>
      </div>
    </PublicFrame>
  );
}
