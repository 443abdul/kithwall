'use client';
// Settings → Reels (docs/v2/12-reels.md §3, §4): the time controls (a daily limit and a break reminder, both
// off until turned on) and "Reset what reels has learned". Everything on this page is kept on this device
// only (lib/reels/store): it is not part of the settings that sync between my devices and is never uploaded.
import { useState } from 'react';
import { useFormat, useT } from '@/i18n';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Dialog } from '@/components/ui/Dialog';
import { Segmented } from '@/components/ui/Segmented';
import { useToast } from '@/components/ui/Toast';
import { SettingsPage, Section } from '@/components/settings/shared';
import { profileSummary } from '@/lib/reels/rank';
import { resetReelProfile, updateReelState, useReelState } from '@/lib/reels/store';
import { BREAK_CHOICES, LIMIT_CHOICES, watchedToday, type BreakMinutes, type LimitMinutes } from '@/lib/reels/time';

export function ReelsSettings() {
  const t = useT();
  const f = useFormat();
  const toast = useToast();
  const state = useReelState();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  // Today's count, and how much of the profile is still fresh, depend on the clock.
  const now = new Date();
  const summary = profileSummary(state.profile, now.getTime());
  const learned = summary.authors + summary.topics + summary.seen + summary.hidden > 0;
  const minutes = Math.round(watchedToday(state.time, now) / 60);

  async function reset() {
    setBusy(true);
    try {
      await resetReelProfile();
      setConfirm(false);
      toast({ message: t('reels.settings.resetDone') });
    } catch { toast({ message: t('feed.failed'), tone: 'danger' }); } finally { setBusy(false); }
  }

  // Five choices have to fit a 320 px screen: the unit is in the group's name, the buttons carry the number.
  const mins = (n: number) => (n ? f.number(n) : t('reels.settings.off'));
  return (
    <SettingsPage title={t('reels.settings.title')} description={t('reels.settings.sub')}>
      <Callout tone="accent" icon="phone">{t('reels.settings.deviceOnly')}</Callout>

      <Section id="reels-time" title={t('reels.settings.timeTitle')} description={t('reels.settings.timeBody')}>
        <div className="k-stack-sm">
          <span className="k-label">{t('reels.settings.limit')}</span>
          <Segmented<`${LimitMinutes}`> label={t('reels.settings.limit')} value={`${state.time.limitMin}`} block
            onChange={(v) => updateReelState((s) => ({ time: { ...s.time, limitMin: Number(v) as LimitMinutes, dismissedDay: null } }))}
            options={LIMIT_CHOICES.map((n) => ({ value: `${n}` as `${LimitMinutes}`, label: mins(n) }))} />
          <p className="k-small k-muted">{state.time.limitMin ? t('reels.settings.limitOn', { count: minutes }) : t('reels.settings.limitOff')}</p>
        </div>
        <div className="k-stack-sm">
          <span className="k-label">{t('reels.settings.break')}</span>
          <Segmented<`${BreakMinutes}`> label={t('reels.settings.break')} value={`${state.time.breakMin}`} block
            onChange={(v) => updateReelState((s) => ({ time: { ...s.time, breakMin: Number(v) as BreakMinutes } }))}
            options={BREAK_CHOICES.map((n) => ({ value: `${n}` as `${BreakMinutes}`, label: mins(n) }))} />
          <p className="k-small k-muted">{t('reels.settings.breakBody')}</p>
        </div>
      </Section>

      <Section id="reels-learned" title={t('reels.settings.learnedTitle')} description={t('reels.settings.learnedBody')}>
        <p className="k-small">
          {learned
            ? t('reels.settings.learnedNow', { authors: summary.authors, topics: summary.topics, seen: summary.seen, hidden: summary.hidden })
            : t('reels.settings.learnedNothing')}
        </p>
        <div className="k-row-wrap">
          <Button variant="secondary" icon="refresh" disabled={!state.loaded || !learned} onClick={() => setConfirm(true)}>{t('reels.settings.reset')}</Button>
        </div>
      </Section>

      <Dialog open={confirm} onClose={() => setConfirm(false)} title={t('reels.settings.reset')} dismissible={!busy}
        footer={<>
          <Button variant="ghost" onClick={() => setConfirm(false)} disabled={busy}>{t('feed.cancel')}</Button>
          <Button variant="danger" busy={busy} onClick={() => void reset()}>{t('reels.settings.resetConfirm')}</Button>
        </>}>
        <p>{t('reels.settings.resetBody')}</p>
      </Dialog>
    </SettingsPage>
  );
}
