'use client';
// Dev-only (see app/(auth)/design): UI kit gallery + the shell screens rendered without a session.
import { useState, type ReactElement } from 'react';
import Link from 'next/link';
import { useT } from '@/i18n';
import {
  Avatar, Badge, Button, ButtonLink, Callout, Card, Dialog, EmptyState, Icon, ICON_NAMES, IconButton, List, ListItem,
  Segmented, Skeleton, Spinner, Switch, Tabs, TextField, Textarea, useToast,
} from '@/components/ui';
import { StylePicker } from '@/components/onboarding/StylePicker';
import { LanguagePicker } from '@/components/onboarding/LanguagePicker';
import { PassphraseField } from '@/components/onboarding/PassphraseField';
import { AppShell } from './AppShell';
import { ActivityScreen, CirclesScreen, HomeScreen, MessagesScreen, SettingsScreen, YouScreen } from './screens';
import { RecoveryNudge } from './Nudges';

function HomeWithNudge() {
  return (
    <>
      <div className="k-page" style={{ paddingBlockEnd: 0 }}><RecoveryNudge force /></div>
      <HomeScreen />
    </>
  );
}

const SCREENS: Record<string, () => ReactElement> = {
  home: HomeWithNudge,
  circles: CirclesScreen,
  messages: MessagesScreen,
  activity: ActivityScreen,
  you: YouScreen,
  'you/settings': SettingsScreen,
};

export function DesignPreview({ screen }: { screen: string }) {
  const S = SCREENS[screen];
  if (S) return <AppShell base="/design"><S /></AppShell>;
  return <Gallery />;
}

function Gallery() {
  const t = useT();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [on, setOn] = useState(true);
  const [seg, setSeg] = useState<'a' | 'b' | 'c'>('a');
  const [tab, setTab] = useState<'one' | 'two'>('one');
  const [pw, setPw] = useState('');
  return (
    <main id="main" className="k-gallery">
      <header className="k-row-wrap" style={{ justifyContent: 'space-between' }}>
        <h1>Kithwall 2 · UI kit</h1>
        <LanguagePicker compact />
      </header>
      <nav className="k-row-wrap" aria-label="Shell screens">
        {Object.keys(SCREENS).map((s) => <ButtonLink key={s} size="sm" variant="soft" href={`/design/${s}`}>{s}</ButtonLink>)}
        <ButtonLink size="sm" variant="soft" href="/">landing</ButtonLink>
        <ButtonLink size="sm" variant="soft" href="/join">join</ButtonLink>
        <ButtonLink size="sm" variant="soft" href="/signin">signin</ButtonLink>
      </nav>
      <Card title="Style"><StylePicker /></Card>
      <Card title="Buttons">
        <div className="k-row-wrap">
          <Button variant="primary">Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="soft" icon="plus">Soft</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Delete</Button>
          <Button variant="primary" busy>Busy</Button>
          <Button variant="secondary" disabled>Disabled</Button>
          <Button variant="primary" size="sm">Small</Button>
          <Button variant="primary" size="lg" iconEnd="forward">Large</Button>
          <IconButton icon="settings" label="Settings" />
          <IconButton icon="messages" label="Messages" variant="soft" badge={3} />
          <IconButton icon="plus" label="New" variant="primary" />
        </div>
      </Card>
      <Card title="Fields">
        <div className="k-stack">
          <TextField label="Display name" placeholder="Sara Khan" hint="Only people you connect with see this." />
          <TextField label="Handle" prefix="@" defaultValue="admin" error="That handle is reserved." dir="ltr" />
          <Textarea label="About" placeholder="A few words…" />
          <PassphraseField label="Passphrase" value={pw} onValue={setPw} meter />
          <Switch checked={on} onChange={setOn} label="Read receipts" description="Let people see when you've read their messages." />
          <Segmented label="Choice" value={seg} onChange={setSeg} options={[{ value: 'a', label: 'One' }, { value: 'b', label: 'Two' }, { value: 'c', label: 'Three' }]} />
        </div>
      </Card>
      <Card title="Feedback">
        <div className="k-stack">
          <Callout>Informational note.</Callout>
          <Callout tone="success">Saved.</Callout>
          <Callout tone="warning">Write this down somewhere safe.</Callout>
          <Callout tone="danger">That didn&apos;t work.</Callout>
          <div className="k-row-wrap">
            <Badge count={4} /><Badge count={120} /><Badge dot /><Badge tone="soft">Soft</Badge>
            <Badge tone="neutral">{t('common.soon')}</Badge><Badge tone="success">Verified</Badge>
            <Spinner />
          </div>
          <div className="k-row-wrap">
            <Button onClick={() => toast({ message: 'Post sealed and shared.', action: { label: 'Undo', onClick: () => undefined } })}>Toast</Button>
            <Button onClick={() => toast({ message: 'Could not connect.', tone: 'danger' })}>Error toast</Button>
            <Button onClick={() => setOpen(true)}>Dialog</Button>
            <Button onClick={() => setSheet(true)}>Sheet</Button>
          </div>
        </div>
      </Card>
      <Card title="Avatars & list">
        <div className="k-row-wrap">
          <Avatar name="Sara Khan" size={56} /><Avatar name="Ali" size={48} /><Avatar name="मीरा पटेल" size={48} />
          <Avatar name="李明" size={40} /><Avatar name="Zoë Ávila" size={40} /><Avatar size={40} />
        </div>
        <List>
          <li><ListItem leading={<Avatar name="Family" />} title="Family" subtitle="12 people" href="/design" /></li>
          <li><ListItem icon="lock" title="Security & recovery" subtitle="Passkeys, recovery key" href="/design" /></li>
          <li><ListItem icon="activity" title="Notifications" trailing={<Badge count={2} />} /></li>
        </List>
      </Card>
      <Card title="Tabs, skeleton, empty">
        <Tabs label="Example" value={tab} onChange={setTab} items={[
          {
            value: 'one', label: 'Posts', panel: (
              <div className="k-stack-sm">
                <div className="k-row"><Skeleton circle width={40} height={40} /><div style={{ flex: 1 }}><Skeleton text width="40%" /><Skeleton text width="70%" /></div></div>
                <Skeleton height={120} />
              </div>
            ),
          },
          { value: 'two', label: 'Photos', count: 3, panel: <EmptyState icon="image" title="No photos yet" body="Albums you create show up here." /> },
        ]} />
      </Card>
      <Card title="Icons">
        <div className="k-icon-grid">{ICON_NAMES.map((n) => <span key={n} title={n}><Icon name={n} /><small>{n}</small></span>)}</div>
      </Card>
      <Dialog open={open} onClose={() => setOpen(false)} title="Leave this circle?"
        footer={<><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button variant="danger" onClick={() => setOpen(false)}>Leave</Button></>}>
        <p className="k-muted">You&apos;ll stop seeing posts from College friends. You can be invited back any time.</p>
      </Dialog>
      <Dialog open={sheet} onClose={() => setSheet(false)} title="Share" sheet>
        <List>
          <li><ListItem icon="link" title="Copy link" onClick={() => setSheet(false)} /></li>
          <li><ListItem icon="qr" title="Show QR code" onClick={() => setSheet(false)} /></li>
        </List>
      </Dialog>
      <p className="k-small k-muted"><Link href="/">Back to the landing page</Link></p>
    </main>
  );
}
