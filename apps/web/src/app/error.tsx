'use client';
// A screen failed to render: the fallback inside the app's own layout (components/crash/CrashScreen.tsx).
import { CrashScreen } from '@/components/crash/CrashScreen';

export default function Error({ error, retry }: { error: unknown; retry: () => void }) {
  return <CrashScreen error={error} retry={retry} />;
}
