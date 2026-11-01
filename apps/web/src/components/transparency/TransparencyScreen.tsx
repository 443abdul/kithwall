'use client';
// Public transparency report (/transparency): requests received, what we can and can't hand over, a
// dated statement the owner re-checks (lib/transparency/facts.ts, docs/v2/03-transparency.md), where the
// source code lives (open source, AGPL-3.0), a static version of the data map, and the public key log with
// its GitHub witness (KeyLogSection). Works signed in or out.
import Link from 'next/link';
import { useFormat, useT } from '@/i18n';
import { Card } from '@/components/ui/Card';
import { Icon } from '@/components/ui/Icon';
import { PublicFrame } from '@/components/onboarding/PublicChrome';
import { useDocumentTitle } from '@/components/onboarding/useDocumentTitle';
import { useSession } from '@/lib/keys/session';
import { CATEGORIES, STATIC_MAP, TABLES } from '@/lib/transparency/datamap';
import { TRANSPARENCY_FACTS as F } from '@/lib/transparency/facts';
import { COMMIT_SHA, REPO_URL, shortCommit, sourceUrl } from '@/lib/source';
import { OutsideDatabase } from './PrivacyReport';
import { KeyLogSection } from './KeyLogSection';

export function TransparencyScreen() {
  const t = useT();
  const f = useFormat();
  const { status } = useSession();
  useDocumentTitle(t('transparency.page.title'));
  const asOf = f.date(new Date(`${F.asOf}T12:00:00Z`), { dateStyle: 'long' });
  const since = f.date(new Date(`${F.since}T12:00:00Z`), { dateStyle: 'long' });
  const rows = [
    { label: t('transparency.page.reqUserData'), n: F.requests.userData },
    { label: t('transparency.page.reqProduced'), n: F.requests.produced },
    { label: t('transparency.page.reqPreservation'), n: F.requests.preservation },
    { label: t('transparency.page.reqRemoval'), n: F.requests.removal },
    { label: t('transparency.page.reqEmergency'), n: F.requests.emergency },
  ];
  const sections = [
    { id: 'requests', title: t('transparency.page.requestsTitle') },
    { id: 'statement', title: t('transparency.page.statementTitle') },
    { id: 'can', title: t('transparency.page.canTitle') },
    { id: 'map', title: t('transparency.page.mapTitle') },
    { id: 'logs', title: t('transparency.logs.title') },
    { id: 'key-log', title: t('kt.page.title') },
    { id: 'source', title: t('transparency.page.sourceTitle') },
  ];
  return (
    <PublicFrame>
      <div className="k-doc-layout">
        <header className="k-doc-head">
          <h1>{t('transparency.page.title')}</h1>
          <p className="k-muted">{t('transparency.page.lede')}</p>
          <p className="k-small k-muted">{t('transparency.page.updated', { date: asOf })}</p>
        </header>
        <nav className="k-doc-nav" aria-label={t('transparency.page.sections')}>
          <ul role="list">{sections.map((s) => <li key={s.id}><a href={`#${s.id}`}>{s.title}</a></li>)}</ul>
        </nav>
        <div className="k-doc-body k-tr-public">
          <section id="requests" aria-labelledby="requests-h" className="k-stack">
            <h2 id="requests-h">{t('transparency.page.requestsTitle')}</h2>
            <p>{t('transparency.page.requestsBody', { since, date: asOf })}</p>
            <Card padding="flush">
              <table className="k-tr-table-req">
                <caption className="k-sr-only">{t('transparency.page.requestsTitle')}</caption>
                <thead><tr><th scope="col">{t('transparency.page.reqKind')}</th><th scope="col">{t('transparency.page.reqCount')}</th></tr></thead>
                <tbody>{rows.map((r) => <tr key={r.label}><th scope="row">{r.label}</th><td>{f.number(r.n)}</td></tr>)}</tbody>
              </table>
            </Card>
            <p className="k-small k-muted">{t('transparency.page.requestsHow')} <Link href="/legal/law-enforcement">{t('footer.lawEnforcement')}</Link></p>
          </section>

          <section id="statement" aria-labelledby="statement-h" className="k-stack">
            <h2 id="statement-h">{t('transparency.page.statementTitle')}</h2>
            <Card tone="accent">
              <div className="k-stack-sm">
                <p className="k-tr-statement">{t('transparency.page.statement', { date: asOf })}</p>
                <p className="k-small k-muted">{t('transparency.page.statementReview', { count: F.reviewMonths })}</p>
              </div>
            </Card>
          </section>

          <section id="can" aria-labelledby="can-h" className="k-stack">
            <h2 id="can-h">{t('transparency.page.canTitle')}</h2>
            <p>{t('transparency.page.canBody')}</p>
            <div className="k-tr-two">
              <Card>
                <h3 className="k-tr-h3"><Icon name="eye" /> {t('transparency.page.canHave')}</h3>
                <ul className="k-tr-bullets">
                  <li>{t('transparency.page.have1')}</li><li>{t('transparency.page.have2')}</li><li>{t('transparency.page.have3')}</li>
                  <li>{t('transparency.page.have4')}</li><li>{t('transparency.page.have5')}</li>
                </ul>
              </Card>
              <Card>
                <h3 className="k-tr-h3"><Icon name="lock" /> {t('transparency.page.cannot')}</h3>
                <ul className="k-tr-bullets">
                  <li>{t('transparency.page.not1')}</li><li>{t('transparency.page.not2')}</li><li>{t('transparency.page.not3')}</li>
                  <li>{t('transparency.page.not4')}</li><li>{t('transparency.page.not5')}</li>
                </ul>
              </Card>
            </div>
          </section>

          <section id="map" aria-labelledby="map-h" className="k-stack">
            <h2 id="map-h">{t('transparency.page.mapTitle')}</h2>
            <p>{t('transparency.page.mapBody')}</p>
            {status === 'ready' ? <p><Link href="/you/privacy-report">{t('transparency.page.mapYours')}</Link></p>
              : <p className="k-small k-muted">{t('transparency.page.mapSignIn')}</p>}
            {STATIC_MAP.map((g) => {
              const c = CATEGORIES.find((x) => x.id === g.category)!;
              return (
                <Card key={g.category} padding="flush">
                  <h3 className="k-tr-map-head"><Icon name={c.icon} /> {t(c.title)}</h3>
                  <ul className="k-tr-tables" role="list">
                    {g.tables.map((tbl) => {
                      const info = TABLES[tbl]!;
                      return (
                        <li key={tbl} className="k-tr-table">
                          <h4 className="k-tr-h4">{t(info.label)}</h4>
                          <p className="k-tr-line"><Icon name="eye" /><span>{t(info.sees)}</span></p>
                          {info.hidden ? <p className="k-tr-line k-tr-sealed"><Icon name="lock" /><span>{t(info.hidden)}</span></p>
                            : <p className="k-tr-line k-muted"><Icon name="info" /><span>{t('transparency.report.nothingEncrypted')}</span></p>}
                        </li>
                      );
                    })}
                  </ul>
                </Card>
              );
            })}
            <p className="k-small k-muted">{t('transparency.page.mapComplete')}</p>
          </section>

          <div id="logs"><OutsideDatabase /></div>

          <KeyLogSection />

          <section id="source" aria-labelledby="source-h" className="k-stack">
            <h2 id="source-h">{t('transparency.page.sourceTitle')}</h2>
            <p>{t('transparency.page.sourceBody')}</p>
            <ul role="list" className="k-tr-source-links">
              <li><a href={REPO_URL} target="_blank" rel="noopener noreferrer"><Icon name="code" />{t('transparency.page.sourceRepo')}</a></li>
              {COMMIT_SHA ? <li><a href={sourceUrl()} target="_blank" rel="noopener noreferrer"><Icon name="link" /><span>{t('transparency.page.sourceVersion')} <span className="k-ltr k-muted" translate="no">({shortCommit()})</span></span></a></li> : null}
            </ul>
            <p className="k-small k-muted">{t('transparency.page.sourceAudit')}</p>
          </section>
        </div>
      </div>
    </PublicFrame>
  );
}
