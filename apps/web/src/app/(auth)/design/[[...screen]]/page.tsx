// Dev-only design preview: the UI kit gallery (/design) and the signed-in shell screens without an
// account (/design/home, /design/circles, …). Returns 404 outside `next dev`.
import { notFound } from 'next/navigation';
import { DesignPreview } from '@/components/shell/DesignPreview';

export const metadata = { title: 'Design preview' };

export default async function Page({ params }: { params: Promise<{ screen?: string[] }> }) {
  if (process.env.NODE_ENV !== 'development') notFound();
  const { screen } = await params;
  return <DesignPreview screen={(screen ?? []).join('/')} />;
}
