// GET /.well-known/apple-app-site-association: iOS webcredentials (passkeys for the site's rpID) and
// universal links for <APPLE_TEAM_ID>.com.kithwall.app. 404 until APPLE_TEAM_ID is set. Apple's CDN
// fetches it over HTTPS from the exact host, without redirects, as application/json.
import { appleAppSiteAssociation, isAppleTeamId } from '../../../lib/native/association';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET() {
  const team = process.env.APPLE_TEAM_ID?.trim();
  if (!isAppleTeamId(team)) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  return new Response(JSON.stringify(appleAppSiteAssociation(team)), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' },
  });
}
