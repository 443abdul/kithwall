'use client';
// Circle settings (admins): edit the sealed name/emoji/colour/description; the creator can delete.
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useT } from '@/i18n';
import { me } from '@/lib/keys/session';
import { Page } from '@/components/shell/AppShell';
import { useDocumentTitle } from '@/components/onboarding/useDocumentTitle';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Callout } from '@/components/ui/Callout';
import { Dialog } from '@/components/ui/Dialog';
import { TextField } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { deleteCircle, isAdmin, readCircle, saveCircle, useCircle } from './data';
import { CircleForm, type CircleDraft } from './CircleForm';
import { isTone } from './look';
import { Loading, NotFound } from './shared';

export function CircleSettingsScreen({ id }: { id: string }) {
  const t = useT();
  useDocumentTitle(t('circles.settings.title'));
  const q = useCircle(id);
  const router = useRouter();
  const toast = useToast();
  const qc = useQueryClient();
  const s = q.data ?? null;
  const d = s ? readCircle(s.circle) : null;
  const [draft, setDraft] = useState<CircleDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [del, setDel] = useState(false);
  const [confirmText, setConfirmText] = useState('');

  const info = d?.ok ? d.value : null;
  useEffect(() => {
    if (info && !draft) setDraft({ name: info.name, description: info.description ?? '', emoji: info.emoji ?? '', tone: isTone(info.tone) ? info.tone : 'accent' });
  }, [info, draft]);

  const back = { href: `/circles/${id}`, label: t('common.back') };
  if (q.isLoading) return <Page title={t('circles.settings.title')} back={back}><Loading /></Page>;
  if (!s || !isAdmin(s.circle, s.membership)) {
    return <Page title={t('circles.settings.title')} back={back}><NotFound icon="lock" title={t('circles.settings.adminsOnly')} /></Page>;
  }
  const creator = s.circle.creator_id === me();

  const save = async () => {
    if (!draft || !draft.name.trim()) return;
    setBusy(true);
    try {
      await saveCircle(s.circle, draft);
      void qc.invalidateQueries({ queryKey: ['circles'] });
      toast({ message: t('circles.settings.saved') });
      router.push(`/circles/${id}`);
    } catch { toast({ message: t('circles.ui.error'), tone: 'danger' }); }
    setBusy(false);
  };
  const remove = async () => {
    setBusy(true);
    try {
      await deleteCircle(s.circle);
      void qc.invalidateQueries({ queryKey: ['circles'] });
      toast({ message: t('circles.settings.deleted') });
      router.replace('/circles');
    } catch { toast({ message: t('circles.ui.error'), tone: 'danger' }); setBusy(false); }
  };

  return (
    <Page title={t('circles.settings.title')} back={back}>
      {draft ? (
        <Card><CircleForm value={draft} onChange={setDraft} nameError={draft.name.trim() ? undefined : t('circles.form.nameRequired')} /></Card>
      ) : d && !d.ok ? <Callout icon="lock">{t('circles.ui.waitingKey')}</Callout> : <Loading />}
      <div className="kc-form-actions">
        <ButtonLink href={`/circles/${id}`} variant="secondary">{t('circles.ui.cancel')}</ButtonLink>
        <Button variant="primary" busy={busy} disabled={!draft?.name.trim()} onClick={() => void save()}>{t('circles.ui.save')}</Button>
      </div>
      <section className="k-stack-sm" aria-labelledby="kc-priv-h">
        <h2 id="kc-priv-h" className="k-section-title">{t('circles.settings.privacy')}</h2>
        <Callout icon="lock" tone="accent">{t('circles.form.privacy')}</Callout>
      </section>
      {creator ? (
        <section className="k-stack-sm" aria-labelledby="kc-danger-h">
          <h2 id="kc-danger-h" className="k-section-title">{t('circles.settings.danger')}</h2>
          <Card>
            <div className="k-stack-sm">
              <p className="k-small k-muted">{t('circles.settings.deleteBody')}</p>
              <div><Button variant="danger" icon="close" onClick={() => setDel(true)}>{t('circles.settings.delete')}</Button></div>
            </div>
          </Card>
        </section>
      ) : null}
      <Dialog open={del} onClose={() => { if (!busy) setDel(false); }} title={t('circles.settings.deleteTitle')} dismissible={!busy}
        footer={<>
          <Button variant="secondary" disabled={busy} onClick={() => setDel(false)}>{t('circles.ui.cancel')}</Button>
          <Button variant="danger" busy={busy} disabled={confirmText.trim() !== (info?.name ?? '').trim()} onClick={() => void remove()}>{t('circles.settings.delete')}</Button>
        </>}>
        <div className="k-stack">
          <p>{t('circles.settings.deleteBody')}</p>
          <TextField label={t('circles.settings.typeName', { name: info?.name ?? '' })} value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoComplete="off" />
        </div>
      </Dialog>
    </Page>
  );
}
