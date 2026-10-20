'use client';
// Root element of every Kithwall 2 screen. Scopes the v2 base styles (.kw), hosts toasts, follows OS
// light/dark changes for the "system" mode, and re-applies <html lang dir>.
import { useEffect, useLayoutEffect, type ReactNode } from 'react';
import { reapplyLocale, useLocale } from '@/i18n';
import { watchSystemMode } from '@/lib/theme';
import { ToastProvider } from '@/components/ui/Toast';

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export function V2Root({ children, className }: { children: ReactNode; className?: string }) {
  useLocale(); // subscribes, which starts the i18n store (loads the catalogue)
  useIsoLayoutEffect(() => { reapplyLocale(); }, []);
  useEffect(() => watchSystemMode(), []);
  return (
    <div className={className ? `kw ${className}` : 'kw'}>
      <ToastProvider>{children}</ToastProvider>
    </div>
  );
}
