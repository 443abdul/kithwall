'use client';
// Settings → Your data → Search on this phone (lib/search, docs/v2/03-safety.md §14): the switch (on by
// default), how much the index holds, "Index older messages" with progress, and "Delete the search index".
import { useState } from 'react';
import { useFormat, useT } from '@/i18n';
import { useDataSaver } from '@/lib/net/dataSaver';
import { searchIndex, setSearchEnabled } from '@/lib/search';
import { startBackfill, stopBackfill, useBackfill } from '@/lib/search/backfill';
import { useIndexSize, useSearchEnabled } from '@/lib/search/hooks';
import { Section } from '@/components/settings/shared';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Dialog } from '@/components/ui/Dialog';
import { Switch } from '@/components/ui/Switch';
import { useToast } from '@/components/ui/Toast';

export function SearchSection() {
  const t = useT();
  const f = useFormat();
  const toast = useToast();
  const enabled = useSearchEnabled();
  const size = useIndexSize();
  const fill = useBackfill();
  const saver = useDataSaver();
  const [confirm, setConfirm] = useState<'delete' | 'saver' | null>(null);

  function start() {
    if (saver) { setConfirm('saver'); return; }
    startBackfill();
  }
  async function wipe() {
    stopBackfill();
    await searchIndex.destroy();
    setConfirm(null);
    toast({ message: t('search.settings.deleted') });
  }

  return (
    <Section id="search" title={t('search.settings.title')} description={t('search.settings.body')}>
      <Switch checked={enabled} label={t('search.settings.toggle')} description={t('search.settings.toggleNote')}
        onChange={(on) => { if (!on) stopBackfill(); setSearchEnabled(on); }} />
      {enabled ? (
        <>
          <p className="k-small k-muted" role="status">
            {size === null ? t('search.settings.sizeUnknown') : t('search.settings.size', { count: size, n: f.number(size) })}
          </p>
          {fill.running ? (
            <div className="k-composer-progress" role="status" aria-live="polite">
              <span className="k-small">
                {t('search.settings.progress', { done: fill.chatsDone, total: fill.chats, messages: f.number(fill.messages), posts: f.number(fill.posts) })}
              </span>
              <span className="k-progress" aria-hidden>
                <span style={{ inlineSize: `${fill.chats ? Math.max(4, Math.round((fill.chatsDone / fill.chats) * 100)) : 4}%` }} />
              </span>
            </div>
          ) : null}
          {fill.done ? <Callout tone="success">{t('search.settings.done', { messages: f.number(fill.messages), posts: f.number(fill.posts) })}</Callout> : null}
          {fill.full ? <Callout tone="info">{t('search.settings.full')}</Callout> : null}
          {fill.failed ? <Callout tone="danger">{t('search.settings.failed')}</Callout> : null}
          <div className="k-row-wrap">
            {fill.running
              ? <Button variant="secondary" onClick={stopBackfill}>{t('search.settings.stop')}</Button>
              : <Button variant="secondary" icon="download" onClick={start}>{t('search.settings.older')}</Button>}
            <ButtonLink href="/you/search" variant="ghost" icon="search">{t('search.open')}</ButtonLink>
            <Button variant="ghost" icon="trash" onClick={() => setConfirm('delete')}>{t('search.settings.delete')}</Button>
          </div>
          <p className="k-small k-muted">{t('search.settings.olderNote')}</p>
        </>
      ) : null}
      <Dialog open={confirm === 'delete'} onClose={() => setConfirm(null)} title={t('search.settings.delete')}
        footer={<>
          <Button variant="ghost" onClick={() => setConfirm(null)}>{t('settings.cancel')}</Button>
          <Button variant="danger" icon="trash" onClick={() => void wipe()}>{t('search.settings.deleteConfirm')}</Button>
        </>}>
        <p>{t('search.settings.deleteBody')}</p>
      </Dialog>
      <Dialog open={confirm === 'saver'} onClose={() => setConfirm(null)} title={t('search.settings.older')}
        footer={<>
          <Button variant="ghost" onClick={() => setConfirm(null)}>{t('settings.cancel')}</Button>
          <Button variant="primary" onClick={() => { setConfirm(null); startBackfill(); }}>{t('search.settings.saverStart')}</Button>
        </>}>
        <p>{t('search.settings.saverBody')}</p>
      </Dialog>
    </Section>
  );
}
