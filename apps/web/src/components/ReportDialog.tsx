'use client';
// Report dialog (2010 dialog style). Owned by the auth/safety work; other areas import it.
// Contract: <ReportDialog kind id disclosure onClose /> — disclosure is built by the caller from the
// item it already decrypted (see lib/report.ts). The dialog must explain that reporting shares
// the item's content with Kithwall moderators.
import type { Disclosure, ReportKind } from '@/lib/report';

export interface ReportDialogProps { kind: ReportKind; id: string; disclosure?: Disclosure; onClose: () => void }

export function ReportDialog(_props: ReportDialogProps) { return null; }
