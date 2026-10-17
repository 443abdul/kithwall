'use client';
// Help Center (reference vHelp) — works signed in or out.
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { PublicPage } from '@/components/auth/PublicPage';
import { Title } from '@/components/Shell';
import { renderMarkdown } from '@/components/auth/Markdown';
import { HELP } from '@/content/help';

export default function HelpPage() {
  const [q, setQ] = useState('');
  useEffect(() => { document.title = 'Help Center | Kithwall'; }, []);
  const sections = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return HELP;
    return HELP.map((s) => ({ ...s, items: s.items.filter((i) => `${i.q} ${i.a}`.toLowerCase().includes(term)) })).filter((s) => s.items.length);
  }, [q]);
  return (
    <PublicPage>
      <Title icon="info" right={<input type="search" placeholder="Search the Help Center" aria-label="Search the Help Center" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 220 }} />}>Help Center</Title>
      <div className="kw-legalnav" style={{ marginTop: 8 }}>
        {HELP.map((s) => <a key={s.id} href={`#${s.id}`}>{s.title}</a>)}
      </div>
      <div className="kw-doc">
        {sections.map((s) => (
          <section key={s.id} id={s.id}>
            <h2>{s.title}</h2>
            {s.items.map((i) => (
              <div className="kw-faq" key={i.q}><b>{i.q}</b><div>{renderMarkdown(i.a)}</div></div>
            ))}
          </section>
        ))}
        {!sections.length && <p className="gray">No answers match &ldquo;{q}&rdquo;.</p>}
        <hr />
        <p>Still stuck? Read the <Link href="/legal/privacy">Privacy Policy</Link>, <Link href="/legal/terms">Terms</Link> and <Link href="/legal/community">Community Standards</Link>.</p>
      </div>
    </PublicPage>
  );
}
