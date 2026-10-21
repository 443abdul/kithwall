// GET /.well-known/assetlinks.json: Android Digital Asset Links for com.kithwall.app (passkeys with the
// site's rpID, verified app links). Served from the rpID host itself, with no redirect (Google's
// verifier does not follow them). Empty list until ANDROID_CERT_SHA256 is set. docs/v2/05-native.md §2.
import { assetLinks, parseCertFingerprints } from '../../../lib/native/association';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET() {
  const body = assetLinks(parseCertFingerprints(process.env.ANDROID_CERT_SHA256));
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' },
  });
}
