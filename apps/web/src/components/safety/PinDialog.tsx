'use client';
// Ask for the app PIN in a dialog (revealing hidden chats, changing or turning off the PIN).
import { useState } from 'react';
import { useT } from '@/i18n';
import { verifyAppPin } from '@/lib/safety/applock';
import { revealHiddenChats } from '@/lib/safety/hidden';
import { Dialog } from '@/components/ui/Dialog';
import { PinPad } from './PinPad';

export function PinDialog({ open, title, body, submitLabel, onClose, onPin }: {
  open: boolean;
  title: string;
  body?: string;
  submitLabel: string;
  onClose: () => void;
  /** Return an error message to show, or null when done. */
  onPin: (pin: string) => Promise<string | null>;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function submit(pin: string) {
    setBusy(true); setErr(null);
    try {
      const e = await onPin(pin);
      if (e) setErr(e); else onClose();
    } finally { setBusy(false); }
  }
  return (
    <Dialog open={open} onClose={onClose} title={title} sheet dismissible={!busy}>
      <div className="k-stack">
        {body ? <p className="k-muted k-small">{body}</p> : null}
        {open ? <PinPad id="k-pin-dialog" label={title} submitLabel={submitLabel} onSubmit={submit} busy={busy} error={err} /> : null}
      </div>
    </Dialog>
  );
}

/** "Reveal hidden chats": checks the app PIN, then shows hidden chats until the app locks. */
export function RevealHiddenDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  return (
    <PinDialog open={open} onClose={onClose} title={t('safety.hidden.revealTitle')} body={t('safety.hidden.revealBody')}
      submitLabel={t('safety.hidden.reveal')}
      onPin={async (pin) => {
        const r = await verifyAppPin(pin);
        if (r === 'ok') { revealHiddenChats(); return null; }
        if (r === 'wiped') { location.replace('/'); return null; }
        return r === 'wait' ? t('safety.lock.wait') : t('safety.lock.wrong');
      }} />
  );
}
