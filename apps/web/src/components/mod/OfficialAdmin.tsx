'use client';
// Admin → Official accounts (docs/v2/13-official-accounts.md §5): the main switch, "Post now", the accounts
// (add one, remove one that was never used), and the sources: switch each on or off, set how many posts a day
// it may make, post from it now, and add a feed or a YouTube channel of your own. The server checks every
// address an admin adds before storing it (app/api/official/sources).
import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useFormat, useT, type MessageKey } from '@/i18n';
import { LOCALES, LOCALE_NAMES } from '@/i18n/locales';
import { sb, must } from '@/lib/supabase';
import { automatedKey } from '@/lib/official/client';
import { Button, IconButton } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Card } from '@/components/ui/Card';
import { TextField } from '@/components/ui/Field';
import { Skeleton } from '@/components/ui/Skeleton';
import { Switch } from '@/components/ui/Switch';
import { useToast } from '@/components/ui/Toast';

interface SourceRow {
  id: string; account: string; title: string; lang: string; terms: string; enabled: boolean; per_day: number; custom: boolean;
  last_run_at: string | null; last_posted_at: string | null; last_error: string | null;
}
interface AccountRow { slug: string; handle: string; name: string; custom: boolean }
interface RunBody { ran?: boolean; reason?: string; posted?: number; pictures?: number; quiet?: string[]; errors?: { where: string; error: string }[] }

const TERMS: Record<string, MessageKey> = {
  'public-domain': 'mod.official.terms.public-domain', cc: 'mod.official.terms.cc', summary: 'mod.official.terms.summary',
  headline: 'mod.official.terms.headline', embed: 'mod.official.terms.embed',
};
const RATES = [1, 2, 3, 4, 6, 8, 12, 24];

async function post<T>(path: string, body: unknown): Promise<{ ok: boolean; status: number; data: T }> {
  const { data } = await sb().auth.getSession();
  const res = await fetch(path, {
    method: 'POST', cache: 'no-store',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${data.session?.access_token ?? ''}` },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status, data: (await res.json().catch(() => ({}))) as T };
}

export function OfficialAdmin({ enabled, onToggle }: { enabled: boolean; onToggle: (on: boolean) => void }) {
  const t = useT();
  const f = useFormat();
  const toast = useToast();
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Add an account
  const [handle, setHandle] = useState('');
  const [name, setName] = useState('');
  // Add a source
  const [account, setAccount] = useState('');
  const [address, setAddress] = useState('');
  const [title, setTitle] = useState('');
  const [lang, setLang] = useState('en');
  const [perDay, setPerDay] = useState(2);
  const [summary, setSummary] = useState(false);

  const sources = useQuery({
    queryKey: ['official-sources'],
    queryFn: async () => must(await sb().from('official_sources')
      .select('id, account, title, lang, terms, enabled, per_day, custom, last_run_at, last_posted_at, last_error').order('position').order('id')) as SourceRow[],
  });
  const accounts = useQuery({
    queryKey: ['official-accounts'],
    queryFn: async () => must(await sb().from('official_account_defs').select('slug, handle, name, custom').order('created_at')) as AccountRow[],
  });
  const rows = sources.data ?? null;
  const accs = accounts.data ?? [];
  const reload = () => Promise.all([
    qc.invalidateQueries({ queryKey: ['official-sources'] }), qc.invalidateQueries({ queryKey: ['official-accounts'] }),
  ]);
  const when = (iso: string) => f.date(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });
  const titleOf = (id: string) => rows?.find((r) => r.id === id)?.title ?? id;

  async function rpc(fn: string, args: Record<string, unknown>) {
    setErr(null);
    try {
      must(await sb().rpc(fn, args));
      toast({ message: t('mod.saved') });
      await reload();
      return true;
    } catch (x) { setErr((x as Error).message); return false; }
  }

  async function runNow(source?: string) {
    setErr(null);
    setNote(null);
    setBusy(source ?? 'all');
    try {
      const r = await post<RunBody>('/api/official/run', source ? { source } : {});
      if (!r.ok) throw new Error(t('mod.official.failed'));
      const b = r.data;
      if (!b.ran) setNote(t(b.reason === 'switched_off' ? 'mod.official.switchedOff' : 'mod.official.notConfigured'));
      else {
        const quiet = (b.quiet ?? []).map(titleOf);
        setNote([
          t('mod.official.ran', { count: b.posted ?? 0 }),
          b.pictures ? t('mod.official.pictures', { count: b.pictures }) : '',
          quiet.length ? t('mod.official.quiet', { list: quiet.join(', ') }) : '',
        ].filter(Boolean).map((s) => s.replace(/[.。۔।]$/u, '')).join(' · '));
        if (b.errors?.length) setErr(b.errors.slice(0, 6).map((e) => `${titleOf(e.where)}: ${e.error}`).join(' · '));
      }
      await reload();
      await Promise.all([qc.invalidateQueries({ queryKey: automatedKey }), qc.invalidateQueries({ queryKey: ['public-posts'] })]);
    } catch (x) { setErr((x as Error).message); } finally { setBusy(null); }
  }

  async function addAccount(e: FormEvent) {
    e.preventDefault();
    const h = handle.trim().toLowerCase().replace(/^@/, '').replace(/^kithwall\./, '');
    if (await rpc('add_official_account', { p_handle: `kithwall.${h}`, p_name: name.trim() })) { setHandle(''); setName(''); }
  }

  async function addSource(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setNote(null);
    setBusy('add');
    try {
      const r = await post<{ error?: string; title?: string; items?: number }>('/api/official/sources', {
        account: account || accs[0]?.slug, url: address.trim(), title: title.trim(), lang, perDay, summary,
      });
      if (!r.ok) {
        const why = r.data.error ?? '';
        throw new Error(why === 'no_feed' ? t('mod.official.noFeed') : t('mod.official.addFailed', { reason: why.replace(/^fetch: /, '') || String(r.status) }));
      }
      setNote(t('mod.official.added', { title: r.data.title ?? '', count: r.data.items ?? 0 }));
      setAddress(''); setTitle('');
      await reload();
    } catch (x) { setErr((x as Error).message); } finally { setBusy(null); }
  }

  return (
    <section className="k-stack" aria-labelledby="mod-official">
      <h2 id="mod-official" className="k-section-title">{t('mod.official.title')}</h2>
      <Card className="k-stack">
        <Switch checked={enabled} onChange={onToggle} label={t('mod.official.switch')} description={t('mod.official.switchNote')} />
        <div className="k-row-wrap">
          <Button variant="primary" icon="bolt" busy={busy === 'all'} disabled={!enabled || busy !== null} onClick={() => void runNow()}>{t('mod.official.runNow')}</Button>
        </div>
        {note ? <p className="k-small" role="status">{note}</p> : null}
        {err ? <Callout tone="danger">{err}</Callout> : null}

        <h3 className="k-section-title">{t('mod.official.accounts')}</h3>
        {accounts.isPending ? <Skeleton text /> : (
          <ul role="list" className="k-official-list">
            {accs.map((a) => (
              <li key={a.slug} className="k-official-row">
                <span className="k-official-row-text">
                  <strong dir="auto">{a.name}</strong>
                  <span className="k-small k-muted k-ltr">@{a.handle}</span>
                </span>
                {a.custom ? <IconButton icon="trash" size="sm" label={`${t('mod.official.remove')}: ${a.name}`} onClick={() => void rpc('remove_official_account', { p_slug: a.slug })} /> : null}
              </li>
            ))}
          </ul>
        )}
        <form className="k-stack-sm k-official-form" onSubmit={(e) => void addAccount(e)}>
          <h4 className="k-label">{t('mod.official.addAccount')}</h4>
          <TextField label={t('mod.official.handle')} prefix="@kithwall." value={handle} onChange={(e) => setHandle(e.target.value)}
            autoCapitalize="none" autoCorrect="off" spellCheck={false} dir="ltr" maxLength={20} pattern="[A-Za-z]{2,20}" required />
          <TextField label={t('mod.official.name')} value={name} onChange={(e) => setName(e.target.value)} dir="auto" maxLength={60} minLength={2} required />
          <div><Button type="submit" variant="secondary" icon="plus" disabled={handle.trim().length < 2 || name.trim().length < 2}>{t('mod.official.add')}</Button></div>
        </form>

        <h3 className="k-section-title">{t('mod.official.sources')}</h3>
        {sources.isError ? <Callout tone="danger">{t('errors.network')}</Callout> : rows === null ? <Skeleton text /> : (
          <ul role="list" className="k-official-list">
            {rows.map((r) => (
              <li key={r.id} className="k-official-source">
                <Switch checked={r.enabled} onChange={(v) => void rpc('set_official_source', { p_id: r.id, p_enabled: v })} label={<span dir="auto">{r.title}</span>}
                  description={<>
                    {t('mod.official.postsAs', { handle: `kithwall.${r.account}` })} · {TERMS[r.terms] ? t(TERMS[r.terms]!) : r.terms}
                    <br />
                    {r.last_run_at ? t('mod.official.lastRun', { date: when(r.last_run_at) }) : t('mod.official.never')}
                    {r.last_error ? <> · <span className="k-error">{t('mod.official.lastError', { error: r.last_error })}</span></> : null}
                  </>} />
                <div className="k-row-wrap k-official-controls">
                  <label className="k-official-rate k-small">
                    <span>{t('mod.official.perDay')}</span>
                    <select className="k-input" value={r.per_day} onChange={(e) => void rpc('set_official_source_rate', { p_id: r.id, p_per_day: Number(e.target.value) })}>
                      {[...new Set([...RATES, r.per_day])].sort((a, b) => a - b).map((n) => <option key={n} value={n}>{f.number(n)}</option>)}
                    </select>
                  </label>
                  <Button size="sm" variant="secondary" icon="bolt" busy={busy === r.id} disabled={!enabled || !r.enabled || busy !== null}
                    onClick={() => void runNow(r.id)}>{t('mod.official.runNow')}</Button>
                  {r.custom ? <IconButton icon="trash" size="sm" label={`${t('mod.official.remove')}: ${r.title}`} onClick={() => void rpc('remove_official_source', { p_id: r.id })} /> : null}
                </div>
              </li>
            ))}
          </ul>
        )}

        <form className="k-stack-sm k-official-form" onSubmit={(e) => void addSource(e)}>
          <h4 className="k-label">{t('mod.official.addSource')}</h4>
          <TextField label={t('mod.official.address')} hint={t('mod.official.addressHint')} type="url" inputMode="url" value={address}
            onChange={(e) => setAddress(e.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} dir="ltr" maxLength={500} required />
          <TextField label={t('mod.official.sourceName')} value={title} onChange={(e) => setTitle(e.target.value)} dir="auto" maxLength={80} />
          <div className="k-row-wrap k-official-controls">
            <label className="k-official-rate k-small">
              <span>{t('mod.official.account')}</span>
              <select className="k-input" value={account || accs[0]?.slug || ''} onChange={(e) => setAccount(e.target.value)}>
                {accs.map((a) => <option key={a.slug} value={a.slug}>@{a.handle}</option>)}
              </select>
            </label>
            <label className="k-official-rate k-small">
              <span>{t('mod.official.lang')}</span>
              <select className="k-input" value={lang} onChange={(e) => setLang(e.target.value)}>
                {LOCALES.map((l) => <option key={l} value={l}>{LOCALE_NAMES[l].native}</option>)}
              </select>
            </label>
            <label className="k-official-rate k-small">
              <span>{t('mod.official.perDay')}</span>
              <select className="k-input" value={perDay} onChange={(e) => setPerDay(Number(e.target.value))}>
                {RATES.map((n) => <option key={n} value={n}>{f.number(n)}</option>)}
              </select>
            </label>
          </div>
          <Switch checked={summary} onChange={setSummary} label={t('mod.official.summary')} description={t('mod.official.summaryNote')} />
          <div><Button type="submit" variant="secondary" icon="plus" busy={busy === 'add'} disabled={!address.trim() || !accs.length || busy !== null}>{t('mod.official.add')}</Button></div>
        </form>
      </Card>
    </section>
  );
}
