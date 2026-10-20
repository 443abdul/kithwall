import { notFound, redirect } from 'next/navigation';
import { handleShapeProblem } from '@/lib/auth/passkey-shared';

// v1 profile sub-pages (/<username>/friends, /info, /notes, /photos) → the Kithwall 2 profile.
export default async function Page({ params }: PageProps<'/[handle]/[...rest]'>) {
  const { handle } = await params;
  const h = decodeURIComponent(handle).toLowerCase();
  if (handleShapeProblem(h)) notFound(); // not a handle, or a reserved name (api, help, …)
  redirect(`/u/${h}`);
}
