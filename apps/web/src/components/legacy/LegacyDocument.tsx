'use client';
// v1 pages are English-only and left-to-right. Kithwall 2 screens may have set another language on
// <html> before a client-side navigation here; reset it (V2Root re-applies the user's language).
import { useLayoutEffect } from 'react';

export function LegacyDocument() {
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.lang = 'en';
    root.dir = 'ltr';
    root.removeAttribute('data-i18n-pending');
  }, []);
  return null;
}
