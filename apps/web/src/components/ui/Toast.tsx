'use client';
// Toasts: short, non-blocking confirmations. One polite live region; each toast auto-dismisses
// (paused while hovered/focused) and can carry one action ("Undo").
//   const toast = useToast();  toast({ message: t('…'), action: { label: t('common.undo'), onClick } })
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useT } from '@/i18n';
import { Button, IconButton } from './Button';

export interface ToastInput {
  message: ReactNode;
  tone?: 'default' | 'danger';
  action?: { label: string; onClick: () => void };
  /** ms; default 5000 (8000 with an action). */
  duration?: number;
}
interface ToastItem extends ToastInput { id: number }

const Ctx = createContext<((t: ToastInput) => void) | null>(null);

export function useToast(): (t: ToastInput) => void {
  const fn = useContext(Ctx);
  if (!fn) throw new Error('useToast() needs <ToastProvider>');
  return fn;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);
  const push = useCallback((t: ToastInput) => {
    const id = next.current++;
    setItems((xs) => [...xs.slice(-2), { ...t, id }]);
  }, []);
  const remove = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const value = useMemo(() => push, [push]);
  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="k-toasts" role="region" aria-live="polite" aria-relevant="additions">
        {items.map((it) => <Toast key={it.id} item={it} onDone={() => remove(it.id)} />)}
      </div>
    </Ctx.Provider>
  );
}

function Toast({ item, onDone }: { item: ToastItem; onDone: () => void }) {
  const t = useT();
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused) return;
    const ms = item.duration ?? (item.action ? 8000 : 5000);
    const h = setTimeout(onDone, ms);
    return () => clearTimeout(h);
  }, [paused, item, onDone]);
  return (
    <div
      className="k-toast"
      data-tone={item.tone === 'danger' ? 'danger' : undefined}
      role={item.tone === 'danger' ? 'alert' : 'status'}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span className="k-toast-msg">{item.message}</span>
      {item.action ? (
        <Button size="sm" variant="ghost" onClick={() => { item.action!.onClick(); onDone(); }}>{item.action.label}</Button>
      ) : null}
      <IconButton icon="close" size="sm" label={t('common.dismiss')} onClick={onDone} />
    </div>
  );
}
