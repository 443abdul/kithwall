'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useT } from '@/i18n';
import { Page } from '@/components/shell/AppShell';
import { useDocumentTitle } from '@/components/onboarding/useDocumentTitle';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Callout } from '@/components/ui/Callout';
import { useToast } from '@/components/ui/Toast';
import { createCircle } from './data';
import { CircleForm, type CircleDraft } from './CircleForm';
import { ConnectionPicker, E2eeLine } from './shared';

export function NewCircleScreen() {
  const t = useT();
  useDocumentTitle(t('circles.create'));
  const router = useRouter();
  const toast = useToast();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<CircleDraft>({ name: '', description: '', emoji: '', tone: 'accent' });
  const [invite, setInvite] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [nameError, setNameError] = useState<string>();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.name.trim()) { setNameError(t('circles.form.nameRequired')); return; }
    setBusy(true);
    try {
      const id = await createCircle(draft, invite);
      void qc.invalidateQueries({ queryKey: ['circles'] });
      toast({ message: t('circles.form.created') });
      router.replace(`/circles/${id}`);
    } catch {
      toast({ message: t('circles.ui.error'), tone: 'danger' });
      setBusy(false);
    }
  };

  return (
    <Page title={t('circles.create')} back={{ href: '/circles', label: t('common.back') }}>
      <form className="k-stack" onSubmit={(e) => void submit(e)} noValidate>
        <Card>
          <CircleForm value={draft} onChange={(v) => { setDraft(v); if (v.name.trim()) setNameError(undefined); }} nameError={nameError} />
        </Card>
        <Callout icon="lock" tone="accent">{t('circles.form.privacy')}</Callout>
        <section className="k-stack-sm" aria-labelledby="kc-inv">
          <h2 id="kc-inv" className="k-section-title">{t('circles.form.invite')}</h2>
          <Card padding="flush"><div className="kc-pad"><ConnectionPicker value={invite} onChange={setInvite} emptyText={t('circles.form.noConnections')} /></div></Card>
        </section>
        <div className="kc-form-actions">
          <Button type="submit" variant="primary" busy={busy} icon="check">{t('circles.form.submit')}</Button>
        </div>
        <E2eeLine>{t('circles.form.e2ee')}</E2eeLine>
      </form>
    </Page>
  );
}
