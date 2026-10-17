'use client';
import Link from 'next/link';
import { useEffect } from 'react';
import { AppPage, Title } from '@/components/Shell';
import { ModConsole } from '@/components/mod/ModConsole';
import { useIsStaff } from '@/lib/hooks';

export default function ModPage() {
  const staff = useIsStaff();
  useEffect(() => { document.title = 'Moderation | Kithwall'; }, []);
  return (
    <AppPage bare>
      <div className="kw-page" style={{ maxWidth: 980, margin: '0 auto' }}>
        <Title icon="flag">{staff.data === 'admin' ? 'Moderation & Admin' : 'Moderation'}</Title>
        {staff.isPending ? <p className="gray">Loading&hellip;</p>
          : staff.data ? <ModConsole role={staff.data} />
          : <div className="err"><b>You don&rsquo;t have access to this page.</b>It&rsquo;s only for Kithwall moderators. <Link href="/">Go home</Link>.</div>}
      </div>
    </AppPage>
  );
}
