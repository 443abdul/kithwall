// Signed-in Kithwall 2 screens (home, circles, messages, activity, you). The guard routes by session
// status: signed out → /signin, locked → unlock screen, v1 account without keys yet → /welcome.
import { AppGate } from '@/components/shell/AppGate';
import { V2Root } from '@/components/shell/V2Root';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <V2Root><AppGate>{children}</AppGate></V2Root>;
}
