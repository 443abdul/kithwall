'use client';
// Modal dialog / bottom sheet on the native <dialog> element: showModal() puts it in the top layer and
// makes everything else inert (focus can't leave it), Esc closes it, and focus returns to the opener.
// We add: initial focus, close on backdrop click, scroll lock, and a labelled close button.
// A dialog that has never been opened renders nothing: lists render one or two closed dialogs per item
// (delete, report…), which would otherwise be thousands of hidden elements on a long feed. Once opened
// it stays in the document, so closing behaves exactly like before (focus returns to the opener).
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useT } from '@/i18n';
import { IconButton } from './Button';
import { cx } from './cx';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children?: ReactNode;
  /** Buttons row. */
  footer?: ReactNode;
  /** Bottom sheet on phones (a centred dialog on larger screens). */
  sheet?: boolean;
  /** Prevent Esc / backdrop from closing (e.g. while saving). */
  dismissible?: boolean;
  className?: string;
}

export function Dialog(props: DialogProps) {
  const [opened, setOpened] = useState(props.open);
  if (props.open && !opened) setOpened(true);
  return opened ? <OpenedDialog {...props} /> : null;
}

function OpenedDialog({ open, onClose, title, children, footer, sheet, dismissible = true, className }: DialogProps) {
  const t = useT();
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      document.documentElement.style.overflow = 'hidden';
      // Focus the first field/button in the body (not the close button) when there is one.
      const first = d.querySelector<HTMLElement>('.k-dialog-body :is(input, textarea, select, button, a[href], [tabindex="0"])');
      first?.focus();
    } else if (!open && d.open) {
      d.close();
    }
    if (!open) document.documentElement.style.overflow = '';
    return () => { document.documentElement.style.overflow = ''; };
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={cx('k-dialog', sheet && 'k-sheet', className)}
      aria-labelledby={titleId}
      onCancel={(e) => { e.preventDefault(); if (dismissible) closeRef.current(); }}
      onClick={(e) => { if (dismissible && e.target === e.currentTarget) closeRef.current(); }}
    >
      {sheet ? <span className="k-sheet-grip" aria-hidden /> : null}
      <div className="k-dialog-head">
        <h2 id={titleId}>{title}</h2>
        {dismissible ? <IconButton icon="close" label={t('common.close')} size="sm" onClick={() => closeRef.current()} /> : null}
      </div>
      <div className="k-dialog-body">{children}</div>
      {footer ? <div className="k-dialog-foot">{footer}</div> : null}
    </dialog>
  );
}
