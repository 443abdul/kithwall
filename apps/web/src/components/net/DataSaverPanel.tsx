'use client';
// Settings → Connection → Data Saver: Automatic / On / Off for this device, what it does, and how much media
// this device downloaded today (lib/net/dataSaver).
import { useFormat, useT } from '@/i18n';
import { Segmented } from '@/components/ui/Segmented';
import { Callout } from '@/components/ui/Callout';
import { formatBytes } from '@/components/posts/bits';
import { setDataSaverMode, useDataSaver, useDataSaverMode, useMediaBytesToday, type DataSaverMode } from '@/lib/net/dataSaver';

export function DataSaverPanel() {
  const t = useT();
  const f = useFormat();
  const mode = useDataSaverMode();
  const active = useDataSaver();
  const used = useMediaBytesToday();
  return (
    <div className="k-stack">
      <Segmented<DataSaverMode> block label={t('saver.title')} value={mode} onChange={setDataSaverMode}
        options={[
          { value: 'auto', label: t('saver.auto') },
          { value: 'on', label: t('saver.on') },
          { value: 'off', label: t('saver.off') },
        ]} />
      <p className="k-hint">{mode === 'auto' ? (active ? t('saver.autoOn') : t('saver.autoOff')) : mode === 'on' ? t('saver.onBody') : t('saver.offBody')}</p>
      {active ? <Callout>{t('saver.what')}</Callout> : null}
      <p className="k-small k-muted">{t('saver.usedToday', { size: formatBytes(used, f.number) })}</p>
    </div>
  );
}
