'use client';
// Safety centre (docs/v2/00-brief.md §4, docs/v2/03-safety.md): panic tools up front, then app lock and
// duress PIN, hidden chats, check-ins, devices and tips — each on its own page.
import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useT } from '@/i18n';
import { useSession } from '@/lib/keys/session';
import { lockNow, useAppLock, useExitPrefs } from '@/lib/safety/applock';
import { useHiddenChatIds } from '@/lib/safety/hidden';
import { listCheckins } from '@/lib/safety/checkins';
import { wipeThisDevice } from '@/lib/safety/wipe';
import { Page } from '@/components/shell/AppShell';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Card } from '@/components/ui/Card';
import { Dialog } from '@/components/ui/Dialog';
import { List, ListItem } from '@/components/ui/ListItem';
import { useDocumentTitle } from '@/components/onboarding/useDocumentTitle';

export function SafetyPage({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  const t = useT();
  useDocumentTitle(title);
  return <Page title={title} description={description} back={{ href: '/you/safety', label: t('safety.title') }}>{children}</Page>;
}

export function useCheckins() {
  const { status } = useSession();
  return useQuery({ queryKey: ['safety', 'checkins'], enabled: status === 'ready', queryFn: listCheckins, refetchInterval: 60_000 });
}

export function WipeDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  async function wipe() {
    setBusy(true);
    await wipeThisDevice();
    location.replace('/');
  }
  return (
    <Dialog open={open} onClose={onClose} title={t('safety.wipe.title')} dismissible={!busy}
      footer={<>
        <Button variant="ghost" onClick={onClose} disabled={busy}>{t('safety.cancel')}</Button>
        <Button variant="danger" icon="trash" busy={busy} onClick={() => void wipe()}>{t('safety.wipe.confirm')}</Button>
      </>}>
      <div className="k-stack">
        <p>{t('safety.wipe.body')}</p>
        <ul className="k-safety-bullets">
          <li>{t('safety.wipe.item1')}</li>
          <li>{t('safety.wipe.item2')}</li>
          <li>{t('safety.wipe.item3')}</li>
        </ul>
        <Callout tone="warning">{t('safety.wipe.recover')}</Callout>
      </div>
    </Dialog>
  );
}

export function SafetyCentre() {
  const t = useT();
  const { pin } = useAppLock();
  const exit = useExitPrefs();
  const hidden = useHiddenChatIds();
  const checkins = useCheckins();
  const [wiping, setWiping] = useState(false);
  const [locking, setLocking] = useState(false);
  useDocumentTitle(t('safety.title'));
  const armed = checkins.data?.filter((c) => !c.released_at).length ?? 0;
  const on = <Badge tone="success">{t('safety.on')}</Badge>;
  const off = <Badge tone="neutral">{t('safety.off')}</Badge>;

  return (
    <Page title={t('safety.title')} description={t('safety.description')} back={{ href: '/you', label: t('common.back') }}>
      <Card className="k-safety-panic">
        <div className="k-stack">
          <div>
            <h2 className="k-safety-h">{t('safety.panic.title')}</h2>
            <p className="k-muted k-small">{t('safety.panic.body')}</p>
          </div>
          <div className="k-safety-panic-row">
            <Button variant="secondary" size="lg" icon="lock" busy={locking} onClick={() => { setLocking(true); void lockNow(); }}>{t('safety.panic.lock')}</Button>
            <Button variant="danger" size="lg" icon="trash" onClick={() => setWiping(true)}>{t('safety.panic.wipe')}</Button>
          </div>
        </div>
      </Card>

      <Card padding="flush">
        <List label={t('safety.title')}>
          <li><ListItem icon="lock" title={t('safety.lock.section')} subtitle={t('safety.lock.sectionSub')} href="/you/safety/lock" trailing={pin === 'set' ? on : off} /></li>
          <li><ListItem icon="eyeOff" title={t('safety.hidden.title')} subtitle={t('safety.hidden.sub')} href="/you/safety/hidden"
            trailing={hidden.size ? <Badge tone="neutral">{t('safety.hidden.count', { count: hidden.size })}</Badge> : undefined} /></li>
          <li><ListItem icon="clock" title={t('safety.checkins.title')} subtitle={t('safety.checkins.sub')} href="/you/safety/checkins"
            trailing={armed ? <Badge tone="accent">{t('safety.checkins.active', { count: armed })}</Badge> : undefined} /></li>
          <li><ListItem icon="monitor" title={t('safety.devices.title')} subtitle={t('safety.devices.sub')} href="/you/safety/devices" /></li>
          <li><ListItem icon="shield" title={t('safety.exit.title')} subtitle={t('safety.exit.sub')} href="/you/safety/lock#quick-exit" trailing={exit.enabled ? on : off} /></li>
          <li><ListItem icon="info" title={t('safety.tips.title')} subtitle={t('safety.tips.sub')} href="/you/safety/tips" /></li>
        </List>
      </Card>

      <Callout tone="info" icon="info">{t('keys.limits')}</Callout>
      <WipeDialog open={wiping} onClose={() => setWiping(false)} />
    </Page>
  );
}
