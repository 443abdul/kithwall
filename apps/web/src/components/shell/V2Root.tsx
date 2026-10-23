'use client';
// Root element of every Kithwall 2 screen. Scopes the v2 base styles (.kw), hosts toasts, follows OS
// light/dark changes for the "system" mode, re-applies <html lang dir>, and hosts the "Leaving Kithwall"
// sheet for user-supplied links (components/links).
import { useEffect, useLayoutEffect, type ReactNode } from 'react';
import { reapplyLocale, useLocale } from '@/i18n';
import { watchSystemMode } from '@/lib/theme';
import { ToastProvider } from '@/components/ui/Toast';
import { LeaveHost } from '@/components/links/LeaveHost';

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export function V2Root({ children, className }: { children: ReactNode; className?: string }) {
  useLocale(); // subscribes, which starts the i18n store (loads the catalogue)
  useIsoLayoutEffect(() => { reapplyLocale(); }, []);
  useEffect(() => watchSystemMode(), []);
  return (
    <div className={className ? `kw ${className}` : 'kw'}>
      <ToastProvider>{children}<LeaveHost /></ToastProvider>
    </div>
  );
}
