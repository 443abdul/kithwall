// Signed-out Kithwall 2 pages: landing (/), sign-up (/join), sign-in (/signin).
import { V2Root } from '@/components/shell/V2Root';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return <V2Root>{children}</V2Root>;
}
