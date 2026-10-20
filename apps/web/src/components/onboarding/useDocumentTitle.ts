'use client';
import { useEffect } from 'react';

/** Sets the (translated) tab title for client-rendered screens. */
export function useDocumentTitle(title: string) {
  useEffect(() => { document.title = title ? `${title} · Kithwall` : 'Kithwall'; }, [title]);
}
