'use client';
// Create / edit a Page (public, not encrypted).
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AppPage, Title } from '@/components/Shell';
import { ErrorBox, PublicWarning, useAction } from '@/components/groups/bits';
import { useAppSetting } from '@/lib/hooks';
import { createPage, PAGE_CATEGORIES, type PageInput } from '@/lib/pages';
import { ComingSoon } from './PagesHome';

export function PageFields({ initial, submitLabel, onSubmit, onCancel }:
  { initial?: PageInput; submitLabel: string; onSubmit: (p: PageInput) => Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState(initial?.name ?? '');
  const [category, setCategory] = useState(initial?.category ?? PAGE_CATEGORIES[0]!);
  const [about, setAbout] = useState(initial?.about ?? '');
  const { busy, error, setError, run } = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setError('Please give your Page a name.'); return; }
    await run(() => onSubmit({ name, category, about }));
  };
  return (
    <form onSubmit={(e) => void submit(e)}>
      <PublicWarning what="A Page's name, category, description and posts" />
      <ErrorBox error={error} />
      <table className="form"><tbody>
        <tr><td className="l"><label htmlFor="pg-name">Page Name:</label></td><td><input id="pg-name" type="text" value={name} maxLength={120} required onChange={(e) => setName(e.target.value)} /></td></tr>
        <tr><td className="l"><label htmlFor="pg-cat">Category:</label></td><td>
          <select id="pg-cat" className="w" value={category} onChange={(e) => setCategory(e.target.value)}>
            {[...new Set([category, ...PAGE_CATEGORIES])].map((c) => <option key={c} value={c}>{c}</option>)}
          </select></td></tr>
        <tr><td className="l"><label htmlFor="pg-about">About:</label></td><td><textarea id="pg-about" value={about} maxLength={2000} onChange={(e) => setAbout(e.target.value)} /></td></tr>
        <tr><td /><td><button type="submit" className="btn b" disabled={busy}>{busy ? 'Saving…' : submitLabel}</button>{' '}
          <button type="button" className="btn" onClick={onCancel}>Cancel</button></td></tr>
      </tbody></table>
    </form>
  );
}

export function NewPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const pub = useAppSetting('public_audience_enabled');
  if (pub.isLoading) return <AppPage active="pages" right={null}><div className="gray">Loading&hellip;</div></AppPage>;
  if (!pub.data) return <AppPage active="pages" right={null}><ComingSoon /></AppPage>;
  return (
    <AppPage active="pages" right={null}>
      <Title icon="page">Create a Page</Title>
      <PageFields submitLabel="Create Page" onCancel={() => router.push('/pages')} onSubmit={async (p) => {
        const id = await createPage(p);
        await qc.invalidateQueries({ queryKey: ['pages'] });
        router.push(`/pages/${id}`);
      }} />
    </AppPage>
  );
}
