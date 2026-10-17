'use client';
import Link from 'next/link';
import { Title } from '@/components/Shell';
import '@/styles/auth.css';

const TABS = [
  ['account', 'Settings', '/settings/account'],
  ['privacy', 'Privacy', '/settings/privacy'],
  ['security', 'Security & Recovery', '/settings/security'],
] as const;

export function SettingsTabs({ active, title, icon }: { active: (typeof TABS)[number][0]; title: string; icon: string }) {
  return (
    <>
      <Title icon={icon}>{title}</Title>
      <nav className="tabs2" aria-label="Settings">
        {TABS.map(([k, label, href]) => (
          <Link key={k} href={href} className={active === k ? 'on' : ''} aria-current={active === k ? 'page' : undefined}>{label}</Link>
        ))}
      </nav>
    </>
  );
}
