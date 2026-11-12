'use client';
// Admin → Operator settings → Official accounts (docs/v2/13-official-accounts.md): the main switch, each
// source's switch with what it is allowed to show and when it last ran, and "Post now". A source's address is
// fixed by a migration; this screen can only switch it on or off.
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useFormat, useT, type MessageKey } from '@/i18n';
import { sb, must } from '@/lib/supabase';
import { automatedKey } from '@/lib/official/client';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Card } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { Switch } from '@/components/ui/Switch';
import { useToast } from '@/components/ui/Toast';

interface SourceRow {
  id: string; account: string; title: string; lang: string; terms: string; enabled: boolean;
  last_run_at: string | null; last_error: string | null;
}

const TERMS: Record<string, MessageKey> = {
  'public-domain': 'mod.official.terms.public-domain', cc: 'mod.official.terms.cc', summary: 'mod.official.terms.summary',
  headline: 'mod.official.terms.headline', embed: 'mod.official.terms.embed',
};

export function OfficialAdmin({ enabled, onToggle }: { enabled: boolean; onToggle: (on: boolean) => void }) {
  const t = useT();
  const f = useFormat();
  const toast = useToast();
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const sources = useQuery({
    queryKey: ['official-sources'],
    queryFn: async () => must(await sb().from('official_sources')
      .select('id, account, title, lang, terms, enabled, last_run_at, last_error').order('position')) as SourceRow[],
  });
  const rows = sources.data ?? null;
  const load = () => qc.invalidateQueries({ queryKey: ['official-sources'] });

  async function toggle(id: string, on: boolean) {
    setErr(null);
    try {
      must(await sb().rpc('set_official_source', { p_id: id, p_enabled: on }));
      toast({ message: t('mod.saved') });
      await load();
    } catch (x) { setErr((x as Error).message); }
  }

  async function runNow() {
    setErr(null);
    setNote(null);
    setBusy(true);
    try {
      const { data } = await sb().auth.getSession();
      const res = await fetch('/api/official/run', {
        method: 'POST', cache: 'no-store', headers: { authorization: `Bearer ${data.session?.access_token ?? ''}` },
      });
      const body = await res.json().catch(() => ({})) as { ran?: boolean; reason?: string; posted?: number; errors?: { where: string; error: string }[] };
      if (!res.ok) throw new Error(t('mod.official.failed'));
      if (!body.ran) setNote(t(body.reason === 'switched_off' ? 'mod.official.switchedOff' : 'mod.official.notConfigured'));
      else {
        setNote(t('mod.official.ran', { count: body.posted ?? 0 }));
        if (body.errors?.length) setErr(body.errors.slice(0, 4).map((e) => `${e.where}: ${e.error}`).join(' · '));
      }
      await load();
      await Promise.all([qc.invalidateQueries({ queryKey: automatedKey }), qc.invalidateQueries({ queryKey: ['public-posts'] })]);
    } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  }

  return (
    <section className="k-stack" aria-labelledby="mod-official">
      <h2 id="mod-official" className="k-section-title">{t('mod.official.title')}</h2>
      <Card className="k-stack">
        <Switch checked={enabled} onChange={onToggle} label={t('mod.official.switch')} description={t('mod.official.switchNote')} />
        <div className="k-row-wrap">
          <Button variant="secondary" icon="bolt" busy={busy} disabled={!enabled} onClick={() => void runNow()}>{t('mod.official.runNow')}</Button>
        </div>
        {note ? <p className="k-small" role="status">{note}</p> : null}
        {err ? <Callout tone="danger">{err}</Callout> : null}
        <h3 className="k-section-title">{t('mod.official.sources')}</h3>
        {sources.isError ? <Callout tone="danger">{t('errors.network')}</Callout> : rows === null ? <Skeleton text /> : (
          <ul role="list" className="k-stack-sm k-official-sources">
            {rows.map((r) => (
              <li key={r.id}>
                <Switch checked={r.enabled} onChange={(v) => void toggle(r.id, v)} label={<span dir="auto">{r.title}</span>}
                  description={<>
                    {t('mod.official.postsAs', { handle: `kithwall.${r.account}` })} · {TERMS[r.terms] ? t(TERMS[r.terms]!) : r.terms}
                    <br />
                    {r.last_run_at ? t('mod.official.lastRun', { date: f.date(new Date(r.last_run_at), { dateStyle: 'medium', timeStyle: 'short' }) }) : t('mod.official.never')}
                    {r.last_error ? <> · <span className="k-error">{t('mod.official.lastError', { error: r.last_error })}</span></> : null}
                  </>} />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}
