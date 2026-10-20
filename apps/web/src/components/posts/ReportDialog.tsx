'use client';
// Report a post, comment, story or profile (spec §5): the reporter's device discloses what they saw
// (and the content key) to moderators; the server snapshots the ciphertext so the report can be verified.
import { useId, useState } from 'react';
import { useT, type MessageKey } from '@/i18n';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { reportItem, type Disclosure, type ReportKind, type ReportReason } from '@/lib/report';

const REASONS: ReportReason[] = ['spam', 'harassment', 'hate', 'violence', 'nudity', 'child_safety', 'self_harm', 'impersonation', 'illegal', 'other'];

export function ReportDialog({ open, onClose, kind, id, disclosure }: {
  open: boolean; onClose: () => void; kind: ReportKind; id: string; disclosure?: () => Disclosure | undefined;
}) {
  const t = useT();
  const toast = useToast();
  const name = useId();
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);

  async function send() {
    if (!reason) return;
    setBusy(true);
    try {
      await reportItem({ kind, id, reason, details: details.trim() || undefined, disclosure: disclosure?.() });
      toast({ message: t('feed.reported') });
      setReason(null); setDetails('');
      onClose();
    } catch {
      toast({ message: t('feed.failed'), tone: 'danger' });
    } finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onClose={onClose} title={t('feed.reportTitle')} sheet dismissible={!busy}
      footer={<>
        <Button variant="ghost" onClick={onClose} disabled={busy}>{t('feed.cancel')}</Button>
        <Button variant="danger" onClick={() => void send()} busy={busy} disabled={!reason}>{t('feed.reportSend')}</Button>
      </>}>
      <div className="k-stack">
        <p className="k-muted k-small">{t('feed.reportBody')}</p>
        <fieldset className="k-radios">
          <legend className="k-label">{t('feed.reportReason')}</legend>
          {REASONS.map((r) => (
            <label key={r} className="k-radio">
              <input type="radio" name={name} value={r} checked={reason === r} onChange={() => setReason(r)} />
              <span>{t(`feed.reason.${r}` as MessageKey)}</span>
            </label>
          ))}
        </fieldset>
        <Textarea label={t('feed.reportDetails')} value={details} maxLength={2000} rows={3} onChange={(e) => setDetails(e.target.value)} />
      </div>
    </Dialog>
  );
}
