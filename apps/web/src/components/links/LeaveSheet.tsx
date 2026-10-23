'use client';
// "Leaving Kithwall": where a link really goes before it is opened. Shows the scheme, the hostname with its
// registrable domain highlighted (Public Suffix List), the Punycode form of IDNs, the full address (folded),
// tracking parameters that will be removed, and warnings (lib/links/analyze.ts). Options: Open, Copy link,
// Cancel, and "Don't ask again for <site>" (this device only; never for links with warnings).
// Loaded on demand by LeaveHost; nothing here talks to a server.
import { useEffect, useMemo, useState } from 'react';
import { useT, type MessageKey } from '@/i18n';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { Switch } from '@/components/ui/Switch';
import { useToast } from '@/components/ui/Toast';
import { analyzeLink, type LinkWarning } from '@/lib/links/analyze';
import { isolate, isTrustedSite, openOutside, trustSite, type LeaveRequest } from '@/lib/links/leave';

const iso = isolate;

const SERIOUS: LinkWarning[] = ['userinfo', 'mismatch', 'mixedScript', 'confusable', 'deceptiveSubdomain', 'ip', 'obfuscated'];

export default function LeaveSheet({ req, onClose }: { req: LeaveRequest; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const r = useMemo(() => analyzeLink(req.href, req.text), [req.href, req.text]);
  const site = r.domain ?? r.host;
  const auto = r.navigable && !r.flagged && isTrustedSite(site);
  const [full, setFull] = useState(false);
  const [remember, setRemember] = useState(false);

  // A site the person chose not to be asked about again: open straight away (tracking still removed).
  useEffect(() => {
    if (!auto) return;
    openOutside(r.openUrl);
    onClose();
  }, [auto, r.openUrl, onClose]);
  if (auto) return null;

  const open = () => {
    if (remember && !r.flagged) trustSite(site);
    openOutside(r.openUrl);
    onClose();
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(r.openUrl);
      toast({ message: t('links.copied') });
      onClose();
    } catch {
      toast({ message: t('links.copyFailed'), tone: 'danger' });
    }
  };

  if (!r.navigable) {
    return (
      <Dialog open onClose={onClose} title={t('links.title')} sheet
        footer={<Button variant="secondary" onClick={onClose}>{t('links.cancel')}</Button>}>
        <p className="kl-blocked"><Icon name="block" /> {t('links.cantOpen', { scheme: iso(`${r.scheme || '?'}:`) })}</p>
      </Dialog>
    );
  }

  const warn = (w: LinkWarning): string => {
    const vars = { host: iso(r.host), domain: iso(site), claimed: iso(r.claimed ?? ''), userinfo: iso(r.userinfo ?? ''), port: iso(r.port) };
    return t(`links.warn.${w}` as MessageKey, vars);
  };
  const serious = r.warnings.some((w) => SERIOUS.includes(w));
  const hostPrefix = r.domain && r.subdomain ? `${r.subdomain}.` : '';
  const hostMain = r.domain ?? r.host;

  return (
    <Dialog open onClose={onClose} title={t('links.title')} sheet className="kl-sheet"
      footer={<>
        <Button variant="ghost" onClick={onClose}>{t('links.cancel')}</Button>
        <Button variant="secondary" icon="copy" onClick={() => void copy()}>{t('links.copy')}</Button>
        <Button variant={serious ? 'danger' : 'primary'} icon="forward" onClick={open}>
          {r.flagged ? t('links.openAnyway') : t('links.open')}
        </Button>
      </>}>
      <div className="kl">
        <p className="k-small k-muted">{t('links.intro')}</p>

        <div className="kl-dest" data-tone={serious ? 'danger' : r.flagged ? 'warning' : 'ok'}>
          <span className="kl-label">{t('links.goesTo')}</span>
          <span className="kl-host k-ltr" dir="ltr" translate="no">
            {hostPrefix ? <span className="kl-sub">{hostPrefix}</span> : null}
            <strong className="kl-domain">{hostMain}</strong>
            {r.port ? <span className="kl-sub">:{r.port}</span> : null}
          </span>
          <span className="kl-scheme" data-secure={r.scheme === 'https' ? '' : undefined}>
            <Icon name={r.scheme === 'https' ? 'lock' : 'alert'} />
            {r.scheme === 'https' ? t('links.secure') : t('links.insecureBadge')}
          </span>
        </div>

        {r.unicodeHost ? (
          <dl className="kl-idn">
            <div><dt>{t('links.looksLike')}</dt><dd className="k-ltr" dir="ltr" translate="no">{r.unicodeHost}</dd></div>
            <div><dt>{t('links.realAddress')}</dt><dd className="k-ltr" dir="ltr" translate="no">{r.host}</dd></div>
          </dl>
        ) : null}

        {r.warnings.length ? (
          <section className="kl-warns" aria-labelledby={`kl-w-${req.id}`} data-tone={serious ? 'danger' : 'warning'}>
            <h3 id={`kl-w-${req.id}`}><Icon name="alert" /> {t('links.checkCarefully')}</h3>
            <ul>
              {r.warnings.map((w) => <li key={w} data-warning={w}>{warn(w)}</li>)}
            </ul>
          </section>
        ) : null}

        <div className="kl-full">
          <span className="kl-label">{t('links.fullAddress')}</span>
          <code className="kl-url k-ltr" dir="ltr" translate="no" data-open={full ? '' : undefined} id={`kl-u-${req.id}`}>{r.original}</code>
          {r.original.length > 90 ? (
            <button type="button" className="k-linkbtn" aria-expanded={full} aria-controls={`kl-u-${req.id}`} onClick={() => setFull((x) => !x)}>
              {full ? t('links.showLess') : t('links.showFull')}
            </button>
          ) : null}
        </div>

        {r.removed.length ? (
          <p className="kl-tracking k-small"><Icon name="shield" /> {t('links.trackingRemoved', { count: r.removed.length })}{' '}
            <span className="k-ltr k-muted" dir="ltr" translate="no">{r.removed.join(', ')}</span>
          </p>
        ) : null}

        {r.flagged ? (
          <p className="k-small k-muted">{t('links.trustUnavailable')}</p>
        ) : (
          <Switch checked={remember} onChange={setRemember} label={t('links.trust', { site: iso(site) })} description={t('links.trustHint')} />
        )}
      </div>
    </Dialog>
  );
}
