'use client';
// Building blocks for the Kithwall 2 settings pages.
import { useEffect, type ReactNode } from 'react';
import { useT } from '@/i18n';
import { useSession } from '@/lib/keys/session';
import { loadSettings } from '@/lib/settings';
import { Page } from '@/components/shell/AppShell';
import { Card } from '@/components/ui/Card';
import { useDocumentTitle } from '@/components/onboarding/useDocumentTitle';

/** A settings sub-page: title, back to the settings index, and its sections. */
export function SettingsPage({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  const t = useT();
  const { status } = useSession();
  useDocumentTitle(title);
  useEffect(() => { if (status === 'ready') void loadSettings().catch(() => undefined); }, [status]);
  return (
    <Page title={title} description={description} back={{ href: '/you/settings', label: t('settings.title') }}>
      {children}
    </Page>
  );
}

export function Section({ id, title, description, children, tone }: { id: string; title: string; description?: ReactNode; children: ReactNode; tone?: 'danger' }) {
  return (
    <section className="k-set-section" aria-labelledby={`${id}-h`} id={id}>
      <h2 id={`${id}-h`} className="k-section-title">{title}</h2>
      <Card className={tone === 'danger' ? 'k-set-danger' : undefined}>
        <div className="k-stack">
          {description ? <p className="k-muted k-small">{description}</p> : null}
          {children}
        </div>
      </Card>
    </section>
  );
}
