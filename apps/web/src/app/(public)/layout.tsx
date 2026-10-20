// Public Kithwall 2 pages that work signed in or out: legal documents, help, account recovery.
import { V2Root } from '@/components/shell/V2Root';

export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return <V2Root>{children}</V2Root>;
}
