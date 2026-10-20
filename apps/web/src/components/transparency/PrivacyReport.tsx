'use client';
// "What Kithwall knows about you" (/you/privacy-report). Everything on this page comes from
// public.transparency_report(): the server's actual rows about the signed-in person, counted and
// classified live (readable vs encrypted columns come from the data map maintained in the migration).
// Only the "outside the database" section is fixed text.
import Link from 'next/link';
import { useFormat, useT, type MessageKey } from '@/i18n';
import { Badge } from '@/components/ui/Badge';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Card } from '@/components/ui/Card';
import { Icon, type IconName } from '@/components/ui/Icon';
import { Spinner } from '@/components/ui/Spinner';
import { Page } from '@/components/shell/AppShell';
import { useDocumentTitle } from '@/components/onboarding/useDocumentTitle';
import { saveBlob } from '@/lib/export';
import { CATEGORIES, COLUMN_CLASSES, TABLES, tableName, type ColumnClass } from '@/lib/transparency/datamap';
import { uaSummary } from '@/lib/transparency/chain';
import { reportFilename, reportJson, reportTotals, rowsOf, useTransparencyReport, type ReportTable, type TransparencyReport } from '@/lib/transparency/report';

const CLASS_LABEL: Record<ColumnClass, MessageKey> = {
  ciphertext: 'transparency.class.ciphertext',
  plaintext: 'transparency.class.plaintext',
  time: 'transparency.class.time',
  id: 'transparency.class.id',
  hashed: 'transparency.class.hashed',
};

export function useSize() {
  const f = useFormat();
  return (bytes: number) => bytes >= 1048576
    ? f.number(bytes / 1048576, { style: 'unit', unit: 'megabyte', maximumFractionDigits: 1 })
    : f.number(Math.max(bytes, 0) / 1024, { style: 'unit', unit: 'kilobyte', maximumFractionDigits: 1 });
}

export function PrivacyReport() {
  const t = useT();
  const q = useTransparencyReport();
  useDocumentTitle(t('transparency.report.title'));
  const back = { href: '/you', label: t('common.back') };
  return (
    <Page title={t('transparency.report.title')} description={t('transparency.report.lede')} back={back}>
      {q.isPending ? <div className="k-center"><Spinner size={28} /></div>
        : q.isError || !q.data ? (
          <Callout tone="danger">
            {t('transparency.report.failed')}{' '}
            <Button size="sm" variant="ghost" onClick={() => void q.refetch()}>{t('transparency.report.retry')}</Button>
          </Callout>
        ) : <Report r={q.data} refreshing={q.isFetching} onRefresh={() => void q.refetch()} />}
    </Page>
  );
}

function Report({ r, refreshing, onRefresh }: { r: TransparencyReport; refreshing: boolean; onRefresh: () => void }) {
  const t = useT();
  const f = useFormat();
  const size = useSize();
  const totals = reportTotals(r);
  const at = (s: string | null | undefined) => (s ? f.date(new Date(s), { dateStyle: 'medium', timeStyle: 'short' }) : '—');
  const posts = rowsOf(r, 'public.posts');
  const messages = rowsOf(r, 'public.messages');
  const photos = rowsOf(r, 'public.photos');
  const friends = rowsOf(r, 'public.friendships');
  const empty = r.tables.filter((x) => !x.rows);

  return (
    <>
      <Card tone="accent" className="k-tr-summary">
        <div className="k-stack">
          <p className="k-tr-big">{t('transparency.report.summary', { count: totals.rows, tables: totals.tables })}</p>
          <p>{t('transparency.report.summaryEncrypted', { count: totals.encryptedRows })}</p>
          <ul className="k-tr-headlines" role="list">
            <Headline icon="edit" text={t('transparency.report.hlPosts', { count: posts })} />
            <Headline icon="messages" text={t('transparency.report.hlMessages', { count: messages })} />
            {photos ? <Headline icon="image" text={t('transparency.report.hlPhotos', { count: photos })} /> : null}
            {friends ? <Headline icon="users" text={t('transparency.report.hlConnections', { count: friends })} /> : null}
            {r.files.count ? <Headline icon="lock" text={t('transparency.report.hlFiles', { count: r.files.count, size: size(r.files.bytes) })} /> : null}
          </ul>
          <div className="k-row-wrap">
            <Button variant="primary" icon="download" onClick={() => saveBlob(new Blob([reportJson(r)], { type: 'application/json' }), reportFilename(r))}>
              {t('transparency.report.download')}
            </Button>
            <Button variant="ghost" icon="refresh" busy={refreshing} onClick={onRefresh}>{t('transparency.report.refresh')}</Button>
          </div>
          <p className="k-xs k-muted">{t('transparency.report.generated', { time: at(r.generated_at) })}</p>
        </div>
      </Card>

      <Account r={r} at={at} />

      {CATEGORIES.map((c) => {
        const rows = r.tables.filter((x) => x.category === c.id && x.rows > 0);
        if (!rows.length) return null;
        return (
          <section key={c.id} className="k-stack" aria-labelledby={`tr-${c.id}`}>
            <div className="k-tr-cat-head">
              <h2 id={`tr-${c.id}`} className="k-section-title"><Icon name={c.icon} /> {t(c.title)}</h2>
              <p className="k-small k-muted">{t(c.body)}</p>
            </div>
            <Card padding="flush">
              <ul className="k-tr-tables" role="list">
                {rows.map((x) => <TableRow key={x.table} x={x} at={at} />)}
              </ul>
            </Card>
          </section>
        );
      })}

      {empty.length ? (
        <details className="k-tr-empty">
          <summary>{t('transparency.report.emptyTables', { count: empty.length })}</summary>
          <p className="k-small k-muted">{t('transparency.report.emptyTablesBody')}</p>
          <p className="k-small k-ltr k-tr-codes">{empty.map((x) => <code key={x.table}>{x.table}</code>)}</p>
        </details>
      ) : null}

      <OutsideDatabase />

      <section className="k-stack" aria-labelledby="tr-yours">
        <h2 id="tr-yours" className="k-section-title">{t('transparency.report.yoursTitle')}</h2>
        <Card>
          <div className="k-stack">
            <p className="k-small">{t('transparency.report.yoursBody')}</p>
            <div className="k-row-wrap">
              <ButtonLink href="/you/settings/data#export" variant="secondary" icon="download">{t('transparency.report.export')}</ButtonLink>
              <ButtonLink href="/you/settings/data#delete" variant="ghost" icon="trash">{t('transparency.report.delete')}</ButtonLink>
              <ButtonLink href="/transparency" variant="ghost" icon="info">{t('transparency.report.publicReport')}</ButtonLink>
            </div>
          </div>
        </Card>
      </section>
    </>
  );
}

function Headline({ icon, text }: { icon: IconName; text: string }) {
  return <li><Icon name={icon} /><span>{text}</span></li>;
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="k-tr-fact"><dt>{label}</dt><dd>{children}</dd></div>;
}

function Account({ r, at }: { r: TransparencyReport; at: (s: string | null | undefined) => string }) {
  const t = useT();
  const f = useFormat();
  const a = r.account;
  return (
    <section className="k-stack" aria-labelledby="tr-account">
      <div className="k-tr-cat-head">
        <h2 id="tr-account" className="k-section-title"><Icon name="you" /> {t('transparency.report.accountTitle')}</h2>
        <p className="k-small k-muted">{t('transparency.report.accountBody')}</p>
      </div>
      <Card>
        <dl className="k-tr-facts">
          <Fact label={t('transparency.report.handle')}><span className="k-ltr">@{a.handle}</span></Fact>
          <Fact label={t('transparency.report.joined')}>{at(a.created_at)}</Fact>
          <Fact label={t('transparency.report.lastSignIn')}>{at(a.last_sign_in_at)}</Fact>
          <Fact label={t('transparency.report.email')}>
            {a.email_kind === 'synthetic' ? (
              <>
                {t('transparency.report.emailSynthetic')}
                {a.synthetic_email ? <code className="k-ltr k-tr-code-block">{a.synthetic_email}</code> : null}
              </>
            ) : a.email_kind === 'real' ? (
              <>{t('transparency.report.emailReal')} <span className="k-ltr">{a.email}</span></>
            ) : t('transparency.report.emailNone')}
          </Fact>
          <Fact label={t('transparency.report.noticeEmail')}>
            {a.notice_email ? <><span className="k-ltr">{a.notice_email}</span>{a.notice_email_verified_at ? ` · ${t('transparency.report.verifiedOn', { date: at(a.notice_email_verified_at) })}` : ''}</>
              : t('transparency.report.noticeEmailNone')}
          </Fact>
          <Fact label={t('transparency.report.directory')}>
            {a.discoverable ? t('transparency.report.directoryOn', { name: a.directory_name ?? '' }) : t('transparency.report.directoryOff')}
          </Fact>
          <Fact label={t('transparency.report.recovery')}>
            {a.recovery_saved_at ? t('transparency.report.recoverySaved', { date: at(a.recovery_saved_at) }) : t('transparency.report.recoveryNotSaved')}
          </Fact>
          <Fact label={t('transparency.report.mfa')}>{a.mfa_factors ? t('transparency.report.mfaOn', { count: a.mfa_factors }) : t('transparency.report.mfaOff')}</Fact>
        </dl>
      </Card>

      <Card>
        <div className="k-stack-sm">
          <h3 className="k-tr-h3">{t('transparency.report.passkeysTitle', { count: r.passkeys.length })}</h3>
          {r.passkeys.length ? (
            <ul className="k-tr-list" role="list">
              {r.passkeys.map((p, i) => (
                <li key={i}>
                  <Icon name="fingerprint" />
                  <div>
                    <p>{p.label || t('transparency.report.passkeyUnnamed')}{p.backed_up ? <> · <span className="k-muted">{t('transparency.report.passkeySynced')}</span></> : null}</p>
                    <p className="k-xs k-muted">{t('transparency.report.passkeyDates', { added: at(p.created_at), used: at(p.last_used_at) })}</p>
                  </div>
                </li>
              ))}
            </ul>
          ) : <p className="k-small k-muted">{t('transparency.report.passkeysNone')}</p>}
          <p className="k-xs k-muted">{t('transparency.report.passkeysNote')}</p>
        </div>
      </Card>

      <Card>
        <div className="k-stack-sm">
          <h3 className="k-tr-h3">{t('transparency.report.sessionsTitle', { count: r.sessions.length })}</h3>
          <p className="k-small k-muted">{t('transparency.report.sessionsBody')}</p>
          {r.sessions.length ? (
            <ul className="k-tr-list" role="list">
              {r.sessions.map((s, i) => (
                <li key={i}>
                  <Icon name="monitor" />
                  <div>
                    <p>{uaSummary(s.user_agent) ?? t('transparency.report.sessionUnknown')}{s.ip ? <> · <span className="k-ltr">{s.ip}</span></> : null}</p>
                    <p className="k-xs k-muted">{t('transparency.report.sessionDates', { started: at(s.created_at), active: at(s.refreshed_at) })}</p>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="k-xs k-muted">
            {t('transparency.report.authLog', { count: r.auth_log.count, date: r.auth_log.first ? f.date(new Date(r.auth_log.first)) : '—' })}
          </p>
        </div>
      </Card>
    </section>
  );
}

function TableRow({ x, at }: { x: ReportTable; at: (s: string | null | undefined) => string }) {
  const t = useT();
  const f = useFormat();
  const size = useSize();
  const info = TABLES[x.table];
  const cipher = x.columns.ciphertext ?? [];
  const date = (s: string | null) => (s ? f.date(new Date(s)) : '—');
  return (
    <li className="k-tr-table">
      <div className="k-tr-table-head">
        <h3 className="k-tr-h3">{info ? t(info.label) : <span className="k-ltr">{tableName(x.table)}</span>}</h3>
        <Badge tone="neutral">{t('transparency.report.records', { count: x.rows })}</Badge>
      </div>
      <p className="k-xs k-muted">
        {x.first ? (date(x.first) === date(x.last) ? date(x.first) : <span className="k-ltr-iso">{date(x.first)} – {date(x.last)}</span>) : null}
        {x.bytes ? ` · ${size(x.bytes)}` : null}
      </p>
      <p className="k-tr-line"><Icon name="eye" /><span>{info ? t(info.sees) : t('transparency.report.genericSees')}</span></p>
      {cipher.length ? (
        <p className="k-tr-line k-tr-sealed"><Icon name="lock" /><span>{info?.hidden ? t(info.hidden) : t('transparency.report.genericHidden')}</span></p>
      ) : <p className="k-tr-line k-muted"><Icon name="info" /><span>{t('transparency.report.nothingEncrypted')}</span></p>}
      <details className="k-tr-tech">
        <summary>{t('transparency.report.technical')}</summary>
        <dl>
          {COLUMN_CLASSES.filter((c) => x.columns[c]?.length).map((c) => (
            <div key={c} className={`k-tr-class k-tr-class-${c}`}>
              <dt>{t(CLASS_LABEL[c])}</dt>
              <dd className="k-ltr">{x.columns[c]!.map((col) => <code key={col}>{col}</code>)}</dd>
            </div>
          ))}
        </dl>
        <p className="k-xs k-muted k-ltr"><code>{x.table}</code> · {at(x.last)}</p>
      </details>
    </li>
  );
}

/** Fixed text: what exists outside the database (hosting logs, backups). Kept in step with the privacy policy. */
export function OutsideDatabase() {
  const t = useT();
  return (
    <section className="k-stack" aria-labelledby="tr-outside">
      <div className="k-tr-cat-head">
        <h2 id="tr-outside" className="k-section-title"><Icon name="globe" /> {t('transparency.logs.title')}</h2>
        <p className="k-small k-muted">{t('transparency.logs.body')}</p>
      </div>
      <Card>
        <ul className="k-tr-list" role="list">
          <li><Icon name="monitor" /><div><p>{t('transparency.logs.vercel')}</p><p className="k-xs k-muted">{t('transparency.logs.vercelBody')}</p></div></li>
          <li><Icon name="key" /><div><p>{t('transparency.logs.supabase')}</p><p className="k-xs k-muted">{t('transparency.logs.supabaseBody')}</p></div></li>
          <li><Icon name="mail" /><div><p>{t('transparency.logs.email')}</p><p className="k-xs k-muted">{t('transparency.logs.emailBody')}</p></div></li>
          <li><Icon name="refresh" /><div><p>{t('transparency.logs.backups')}</p><p className="k-xs k-muted">{t('transparency.logs.backupsBody')}</p></div></li>
          <li><Icon name="eye" /><div><p>{t('transparency.logs.none')}</p><p className="k-xs k-muted">{t('transparency.logs.noneBody')}</p></div></li>
        </ul>
        <p className="k-xs k-muted k-tr-foot">{t('transparency.logs.more')} <Link href="/legal/privacy">{t('footer.privacy')}</Link></p>
      </Card>
    </section>
  );
}
