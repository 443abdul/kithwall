import { notFound, redirect } from 'next/navigation';
import { handleShapeProblem } from '@/lib/auth/passkey-shared';

// v1 profile links (kithwall.com/<username>) → Kithwall 2 profiles (/u/<handle>). Every real route is a
// static segment, which Next matches before this one, and reserved names (lib/social/reserved.ts) keep
// handles from ever colliding with them. Anything that isn't a handle is a 404.
export default async function Page({ params }: PageProps<'/[handle]'>) {
  const { handle } = await params;
  const h = decodeURIComponent(handle).toLowerCase();
  if (handleShapeProblem(h)) notFound(); // not a handle, or a reserved name (api, help, …)
  redirect(`/u/${h}`);
}
