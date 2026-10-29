'use client';
// Settings → About → "Is this the real Kithwall?". The website publishes the signing-certificate fingerprints
// of the genuine Android app (/.well-known/assetlinks.json, the same list passkeys rely on). In the app, the
// app reports its own certificate and we say whether it matches; anywhere else we show the fingerprints so
// people can compare them with the APK they were given (fake "Kithwall" APKs are a known threat).
import { useQuery } from '@tanstack/react-query';
import { useT } from '@/i18n';
import { Callout } from '@/components/ui/Callout';
import { isNative } from '@/lib/native';
import { shellInfo } from '@/lib/native/shell';
import { Section } from './shared';

async function officialFingerprints(): Promise<string[]> {
  const res = await fetch('/.well-known/assetlinks.json', { cache: 'no-store' });
  if (!res.ok) return [];
  const links = (await res.json()) as { target?: { sha256_cert_fingerprints?: unknown } }[];
  const out = new Set<string>();
  for (const l of Array.isArray(links) ? links : []) {
    const fp = l?.target?.sha256_cert_fingerprints;
    if (Array.isArray(fp)) for (const x of fp) if (typeof x === 'string') out.add(x.toUpperCase());
  }
  return [...out];
}

export function AppVerifySection() {
  const t = useT();
  const q = useQuery({
    queryKey: ['app-verify'], staleTime: 10 * 60_000,
    queryFn: async () => {
      const [official, info] = await Promise.all([officialFingerprints(), isNative() ? shellInfo().catch(() => null) : Promise.resolve(null)]);
      return { official, signer: info?.signer?.toUpperCase() || null };
    },
  });
  if (!q.data) return null;
  const { official, signer } = q.data;
  const native = isNative();
  return (
    <Section id="verify-app" title={t('appVerify.title')} description={t('appVerify.body')}>
      {native && signer ? (
        official.includes(signer)
          ? <Callout tone="success">{t('appVerify.genuine')}</Callout>
          : <Callout tone="danger">{t('appVerify.unknown')}</Callout>
      ) : null}
      {official.length ? (
        <>
          <p className="k-small">{t('appVerify.fingerprints')}</p>
          <ul className="k-fingerprints" role="list">
            {official.map((f) => <li key={f}><code className="k-ltr" translate="no">{f}</code></li>)}
          </ul>
        </>
      ) : null}
      {native && signer ? <p className="k-small k-muted">{t('appVerify.yours')} <code className="k-ltr" translate="no">{signer}</code></p> : null}
    </Section>
  );
}
