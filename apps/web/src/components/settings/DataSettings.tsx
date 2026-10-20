'use client';
// Settings → Your data (Kithwall 2): what the server knows about me (/you/privacy-report), export
// everything (decrypted on this device into a ZIP, lib/export.ts) and delete the account (the device signs a
// one-time server nonce with the identity key, so a stolen session alone can't do it; works the same for
// passkey, passphrase and v1 accounts).
import { useState } from 'react';
import { signChallenge } from '@kithwall/crypto';
import { useFormat, useT, type MessageKey } from '@/i18n';
import { identity, signOut, useSession } from '@/lib/keys/session';
import { deviceStore } from '@/lib/keys/device';
import { sb } from '@/lib/supabase';
import { authedPost } from '@/lib/auth/api';
import { buildExport, saveBlob, type ExportStep, type ExportSummary } from '@/lib/export';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Dialog } from '@/components/ui/Dialog';
import { TextField } from '@/components/ui/Field';
import { SettingsPage, Section } from './shared';

const STEP: Record<ExportStep, MessageKey> = {
  profile: 'transparency.export.step.profile', posts: 'transparency.export.step.posts', comments: 'transparency.export.step.comments',
  albums: 'transparency.export.step.albums', photos: 'transparency.export.step.photos', stories: 'transparency.export.step.stories',
  circles: 'transparency.export.step.circles', events: 'transparency.export.step.events', messages: 'transparency.export.step.messages',
  settings: 'transparency.export.step.settings', inventory: 'transparency.export.step.inventory', packaging: 'transparency.export.step.packaging',
};

function KnowsSection() {
  const t = useT();
  return (
    <Section id="knows" title={t('transparency.data.title')} description={t('transparency.data.body')}>
      <div className="k-row-wrap">
        <ButtonLink href="/you/privacy-report" variant="secondary" icon="eye">{t('transparency.data.cta')}</ButtonLink>
        <ButtonLink href="/transparency" variant="ghost" icon="info">{t('transparency.data.public')}</ButtonLink>
      </div>
    </Section>
  );
}

function ExportSection() {
  const t = useT();
  const f = useFormat();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ step?: ExportStep; done?: number; total?: number } | null>(null);
  const [summary, setSummary] = useState<ExportSummary | null>(null);
  const [err, setErr] = useState(false);
  async function go() {
    setBusy(true); setErr(false); setSummary(null); setProgress({});
    try {
      const r = await buildExport((step, done, total) => setProgress({ step, done, total }));
      saveBlob(r.blob, r.filename);
      setSummary(r.summary);
    } catch { setErr(true); } finally { setBusy(false); setProgress(null); }
  }
  return (
    <Section id="export" title={t('settings.data.exportTitle')} description={t('transparency.export.body')}>
      {err ? <Callout tone="danger">{t('settings.data.exportFailed')}</Callout> : null}
      {summary ? (
        <Callout tone="success">
          {t('settings.data.exportDone', {
            posts: summary.posts, comments: summary.comments, photos: summary.photos, messages: summary.messages,
            size: f.number(summary.bytes / 1048576, { maximumFractionDigits: 1 }),
          })}
          {' '}{t('transparency.export.doneMore', { notes: summary.notes, stories: summary.stories, circles: summary.circles, events: summary.events, reactions: summary.reactions, files: summary.files })}
          {summary.skipped ? ` ${t('settings.data.exportSkipped', { count: summary.skipped })}` : ''}
          {summary.tooLarge ? ` ${t('transparency.export.tooLarge', { count: summary.tooLarge })}` : ''}
        </Callout>
      ) : null}
      <div className="k-row-wrap">
        <Button variant="primary" icon="share" busy={busy} onClick={() => void go()}>{t('settings.data.exportCta')}</Button>
        {progress ? (
          <span className="k-set-progress" role="status">
            {progress.step ? `${t(STEP[progress.step])} ` : ''}
            {progress.done && progress.total ? t('settings.data.exportProgress', { done: progress.done, total: progress.total }) : t('settings.data.exportPreparing')}
          </span>
        ) : null}
      </div>
    </Section>
  );
}

function DeleteSection() {
  const t = useT();
  const { profile } = useSession();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const handle = profile?.username ?? '';
  const ready = ack && !!handle && typed.trim().replace(/^@/, '').toLowerCase() === handle.toLowerCase();

  async function del() {
    setBusy(true); setErr(null);
    try {
      const { data, error } = await sb().rpc('create_key_challenge', { purpose: 'delete_account' });
      if (error) throw new Error(error.code === 'P0429' ? 'rate' : 'failed');
      const ch = (Array.isArray(data) ? data[0] : data) as { id: string; nonce: string } | undefined;
      if (!ch) throw new Error('failed');
      const signature = signChallenge(identity().signPriv, ch.nonce);
      await authedPost('/api/account/delete', { challengeId: ch.id, signature });
      await deviceStore.clear().catch(() => undefined);
      await signOut().catch(() => undefined);
      location.href = '/?deleted=1';
    } catch (x) {
      setErr((x as Error).message === 'rate' ? t('errors.rate_limited') : t('settings.data.deleteFailed'));
      setBusy(false);
    }
  }

  return (
    <Section id="delete" title={t('settings.data.deleteTitle')} description={t('settings.data.deleteBody')} tone="danger">
      <div><Button variant="danger" onClick={() => { setOpen(true); setTyped(''); setAck(false); setErr(null); }}>{t('settings.data.deleteCta')}</Button></div>
      <Dialog open={open} onClose={() => setOpen(false)} title={t('settings.data.deleteConfirmTitle')} dismissible={!busy}
        footer={<><Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>{t('settings.cancel')}</Button>
          <Button variant="danger" busy={busy} disabled={!ready} onClick={() => void del()}>{t('settings.data.deleteForever')}</Button></>}>
        <div className="k-stack">
          {err ? <Callout tone="danger">{err}</Callout> : null}
          <p className="k-muted">{t('settings.data.deleteConfirmBody')}</p>
          <label className="k-set-check">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            <span>{t('settings.data.deleteAck')}</span>
          </label>
          <TextField label={t('settings.data.deleteType', { handle })} value={typed} dir="ltr" autoCapitalize="none" autoComplete="off" spellCheck={false}
            onChange={(e) => setTyped(e.target.value)} />
          <p className="k-small k-muted">{t('settings.data.deleteProof')}</p>
        </div>
      </Dialog>
    </Section>
  );
}

export function DataSettings() {
  const t = useT();
  return (
    <SettingsPage title={t('settings.data.title')} description={t('settings.data.description')}>
      <KnowsSection />
      <ExportSection />
      <DeleteSection />
    </SettingsPage>
  );
}
