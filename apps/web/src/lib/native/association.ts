// App ↔ domain association for the native apps (docs/v2/05-native.md §2). Pure functions, used by the
// /.well-known route handlers and by the passkey server (relyingParty() accepts the Android app's
// origin). Configuration, all server-side environment variables:
//   ANDROID_CERT_SHA256  comma-separated SHA-256 fingerprints of the Android signing certificates
//                        (Play Console → App integrity → App signing key AND upload key; add the debug
//                        key on staging), "AB:CD:…" or plain hex
//   APPLE_TEAM_ID        10-character Apple Developer Team ID; the iOS file is only served when set
export const APP_ID = 'com.kithwall.app';

/** Normalise fingerprints to the colon-separated upper-case form Digital Asset Links uses. Invalid entries are dropped. */
export function parseCertFingerprints(raw: string | undefined | null): string[] {
  const out: string[] = [];
  for (const part of (raw ?? '').split(',')) {
    const hex = part.trim().replace(/[:\s]/g, '').toUpperCase();
    if (!/^[0-9A-F]{64}$/.test(hex)) continue;
    const fp = hex.match(/.{2}/g)!.join(':');
    if (!out.includes(fp)) out.push(fp);
  }
  return out;
}

/** `android:apk-key-hash:<base64url(SHA-256 of the signing certificate)>`: the origin Credential Manager puts in clientDataJSON for a native app. */
export function androidOrigins(fingerprints: string[]): string[] {
  return fingerprints.map((fp) => `android:apk-key-hash:${Buffer.from(fp.replace(/:/g, ''), 'hex').toString('base64url')}`);
}

export interface AssetLink {
  relation: string[];
  target: { namespace: 'android_app'; package_name: string; sha256_cert_fingerprints: string[] };
}

/** /.well-known/assetlinks.json: passkeys (get_login_creds) and verified app links for this site. */
export function assetLinks(fingerprints: string[]): AssetLink[] {
  if (!fingerprints.length) return [];
  return [{
    relation: ['delegate_permission/common.handle_all_urls', 'delegate_permission/common.get_login_creds'],
    target: { namespace: 'android_app', package_name: APP_ID, sha256_cert_fingerprints: fingerprints },
  }];
}

export const isAppleTeamId = (s: string | undefined | null): s is string => !!s && /^[A-Z0-9]{10}$/.test(s.trim());

/** /.well-known/apple-app-site-association: passkeys (webcredentials) and universal links, never for /api. */
export function appleAppSiteAssociation(teamId: string) {
  const appID = `${teamId.trim()}.${APP_ID}`;
  return {
    webcredentials: { apps: [appID] },
    applinks: {
      details: [{
        appIDs: [appID],
        components: [
          { '/': '/api/*', exclude: true, comment: 'server routes never open the app' },
          { '/': '/.well-known/*', exclude: true },
          { '/': '/*' },
        ],
      }],
    },
  };
}
