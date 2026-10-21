import 'server-only';
// Native push delivery for the Kithwall apps (docs/v2/05-native.md §5).
//
// Every native push carries ONLY ciphertext: the same "who + what" JSON that browsers get, encrypted to
// the app's on-device P-256 key (RFC 8291 aes128gcm, lib/push/crypto.ts). Providers:
//   fcm          Android "play" build. FCM HTTP v1, data-only high/normal priority message {kw: <b64u body>}.
//                Service account JSON in FCM_SERVICE_ACCOUNT_JSON (server-only env).
//   unifiedpush  Android "foss" build. A standard Web Push request (RFC 8030 + VAPID + aes128gcm) to the
//                distributor's endpoint, which is an arbitrary URL: re-validated, public addresses only
//                (checked at connect time), no redirects, 8 s timeout (lib/push/endpoint.ts).
//   apns         iOS (prepared; untested until the Apple account exists). Token-based auth
//                (APNS_KEY_ID, APNS_TEAM_ID, APNS_KEY_P8, optional APNS_BUNDLE_ID). The visible alert is a
//                fixed generic text; the Notification Service Extension decrypts {kw} and replaces it.
// Devices the provider reports as gone are deleted. Never log tokens, endpoints or payloads.
import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { connect as http2Connect } from 'node:http2';
import webpush from 'web-push';
import { admin } from '@/lib/auth/server';
import { b64uEncode, encryptPush, isAuthSecret, isP256Point } from './crypto';
import { isUnifiedPushEndpoint, publicOnlyLookup } from './endpoint';

export interface NativeDevice {
  id: string;
  provider: 'fcm' | 'apns' | 'unifiedpush';
  token: string;
  p256dh: string;
  auth: string;
  apns_env: 'production' | 'sandbox' | null;
}

export interface NativeJob { dev: NativeDevice; payload: object; urgency: 'high' | 'normal'; ttl: number; kind?: string }

type Outcome = 'ok' | 'gone' | 'failed' | 'unconfigured';

const GENERIC_TEXT = 'You have new activity on Kithwall.';

// ---------------------------------------------------------------------------------------------
// FCM HTTP v1
// ---------------------------------------------------------------------------------------------
interface ServiceAccount { project_id: string; client_email: string; private_key: string }
let fcmAccount: ServiceAccount | null | undefined;
let fcmToken: { value: string; exp: number } | null = null;

function fcmConfig(): ServiceAccount | null {
  if (fcmAccount !== undefined) return fcmAccount;
  try {
    const raw = process.env.FCM_SERVICE_ACCOUNT_JSON?.trim();
    const j = raw ? JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8')) as Partial<ServiceAccount> : null;
    fcmAccount = j?.project_id && j.client_email && j.private_key ? { project_id: j.project_id, client_email: j.client_email, private_key: j.private_key } : null;
  } catch { fcmAccount = null; }
  return fcmAccount;
}

function jwt(header: object, claims: object, key: KeyObject, alg: 'RS256' | 'ES256'): string {
  const head = b64uEncode(Buffer.from(JSON.stringify(header)));
  const body = b64uEncode(Buffer.from(JSON.stringify(claims)));
  const data = Buffer.from(`${head}.${body}`);
  const sig = alg === 'RS256' ? sign('RSA-SHA256', data, key) : sign('sha256', data, { key, dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${b64uEncode(sig)}`;
}

async function fcmAccessToken(sa: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (fcmToken && fcmToken.exp - 120 > now) return fcmToken.value;
  const assertion = jwt({ alg: 'RS256', typ: 'JWT' }, {
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  }, createPrivateKey(sa.private_key), 'RS256');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(8000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  if (!res.ok) throw new Error(`fcm oauth ${res.status}`);
  const j = await res.json() as { access_token?: string; expires_in?: number };
  if (!j.access_token) throw new Error('fcm oauth: no token');
  fcmToken = { value: j.access_token, exp: now + (j.expires_in ?? 3600) };
  return fcmToken.value;
}

async function sendFcm(job: NativeJob, body: Buffer): Promise<Outcome> {
  const sa = fcmConfig();
  if (!sa) return 'unconfigured';
  const token = await fcmAccessToken(sa);
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(sa.project_id)}/messages:send`, {
    method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(8000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        token: job.dev.token,
        // Data-only: Google sees an opaque blob; the app decrypts it and builds the notification itself.
        data: { kw: b64uEncode(body) },
        android: { priority: job.urgency === 'high' ? 'HIGH' : 'NORMAL', ttl: `${job.ttl}s` },
      },
    }),
  });
  if (res.ok) return 'ok';
  const text = await res.text().catch(() => '');
  if (res.status === 404 || /UNREGISTERED/.test(text)) return 'gone';
  if (res.status === 400 && /registration token|INVALID_ARGUMENT.*token/i.test(text)) return 'gone';
  if (res.status === 401) fcmToken = null;
  console.warn(`native push: fcm failed (status ${res.status})`);
  return 'failed';
}

// ---------------------------------------------------------------------------------------------
// APNs (token-based auth over HTTP/2)
// ---------------------------------------------------------------------------------------------
let apnsJwt: { value: string; at: number } | null = null;

function apnsConfig() {
  const keyId = process.env.APNS_KEY_ID?.trim();
  const teamId = process.env.APNS_TEAM_ID?.trim();
  const p8 = process.env.APNS_KEY_P8?.trim();
  if (!keyId || !teamId || !p8) return null;
  const pem = p8.includes('BEGIN') ? p8.replace(/\\n/g, '\n') : Buffer.from(p8, 'base64').toString('utf8');
  return { keyId, teamId, pem, topic: process.env.APNS_BUNDLE_ID?.trim() || 'com.kithwall.app' };
}

function apnsToken(cfg: NonNullable<ReturnType<typeof apnsConfig>>): string {
  const now = Math.floor(Date.now() / 1000);
  // Apple wants the token refreshed at most every 20 minutes and at least every 60.
  if (apnsJwt && now - apnsJwt.at < 45 * 60) return apnsJwt.value;
  const value = jwt({ alg: 'ES256', kid: cfg.keyId }, { iss: cfg.teamId, iat: now }, createPrivateKey(cfg.pem), 'ES256');
  apnsJwt = { value, at: now };
  return value;
}

function sendApns(job: NativeJob, body: Buffer): Promise<Outcome> {
  const cfg = apnsConfig();
  if (!cfg) return Promise.resolve('unconfigured');
  const host = job.dev.apns_env === 'sandbox' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';
  const call = job.kind === 'call';
  const payload = JSON.stringify({
    aps: {
      alert: { title: 'Kithwall', body: GENERIC_TEXT },
      'mutable-content': 1,
      sound: 'default',
      ...(call ? { 'interruption-level': 'time-sensitive' } : {}),
    },
    kw: b64uEncode(body),
  });
  return new Promise<Outcome>((resolve) => {
    const session = http2Connect(host);
    const done = (o: Outcome) => { try { session.close(); } catch { /* closed */ } resolve(o); };
    session.on('error', () => done('failed'));
    session.setTimeout(8000, () => { session.destroy(); resolve('failed'); });
    const req = session.request({
      ':method': 'POST', ':path': `/3/device/${job.dev.token}`,
      authorization: `bearer ${apnsToken(cfg)}`,
      'apns-topic': cfg.topic, 'apns-push-type': 'alert',
      'apns-priority': job.urgency === 'high' ? '10' : '5',
      'apns-expiration': String(Math.floor(Date.now() / 1000) + job.ttl),
      'content-type': 'application/json',
    });
    let status = 0;
    let text = '';
    req.setEncoding('utf8');
    req.on('response', (h) => { status = Number(h[':status']) || 0; });
    req.on('data', (c: string) => { if (text.length < 2048) text += c; });
    req.on('end', () => {
      if (status === 200) return done('ok');
      if (status === 410 || /BadDeviceToken|Unregistered|DeviceTokenNotForTopic/.test(text)) return done('gone');
      if (status === 403) apnsJwt = null;
      console.warn(`native push: apns failed (status ${status || 'network'})`);
      done('failed');
    });
    req.on('error', () => done('failed'));
    req.end(payload);
  });
}

// ---------------------------------------------------------------------------------------------
// UnifiedPush (Web Push to the distributor's endpoint)
// ---------------------------------------------------------------------------------------------
function sendUnifiedPush(job: NativeJob): Promise<Outcome> {
  const pub = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? '';
  const priv = process.env.VAPID_PRIVATE_KEY ?? '';
  if (!pub || !priv) return Promise.resolve('unconfigured');
  if (!isUnifiedPushEndpoint(job.dev.token)) return Promise.resolve('gone');
  const details = webpush.generateRequestDetails(
    { endpoint: job.dev.token, keys: { p256dh: job.dev.p256dh, auth: job.dev.auth } },
    JSON.stringify(job.payload),
    {
      TTL: job.ttl, urgency: job.urgency, contentEncoding: 'aes128gcm',
      vapidDetails: { subject: process.env.VAPID_SUBJECT || 'mailto:security@kithwall.com', publicKey: pub, privateKey: priv },
    },
  );
  const bodyBuf = details.body ? Buffer.from(details.body) : Buffer.alloc(0);
  if (bodyBuf.length > 4096) return Promise.resolve('failed');
  return new Promise<Outcome>((resolve) => {
    const req = httpsRequest(job.dev.token, {
      method: 'POST',
      headers: { ...(details.headers as Record<string, string>), 'Content-Length': String(bodyBuf.length) },
      lookup: publicOnlyLookup() as never,
      timeout: 8000,
    }, (res) => {
      res.resume();   // never read more than we need; https.request does not follow redirects
      const s = res.statusCode ?? 0;
      if (s >= 200 && s < 300) resolve('ok');
      else if (s === 404 || s === 410) resolve('gone');
      else { console.warn(`native push: unifiedpush failed (status ${s})`); resolve('failed'); }
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'EKW_PRIVATE_ADDRESS') { console.warn('native push: unifiedpush endpoint refused (non-public address)'); resolve('gone'); return; }
      resolve('failed');
    });
    req.end(bodyBuf);
  });
}

// ---------------------------------------------------------------------------------------------
export function nativePushConfigured(): { fcm: boolean; apns: boolean; unifiedpush: boolean } {
  return {
    fcm: !!fcmConfig(), apns: !!apnsConfig(),
    unifiedpush: !!(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY),
  };
}

async function sendOne(job: NativeJob): Promise<Outcome> {
  const d = job.dev;
  if (!isP256Point(d.p256dh) || !isAuthSecret(d.auth)) return 'gone';
  try {
    if (d.provider === 'unifiedpush') return await sendUnifiedPush(job);
    const body = encryptPush(d.p256dh, d.auth, JSON.stringify(job.payload));
    if (d.provider === 'fcm') return await sendFcm(job, body);
    if (d.provider === 'apns') return await sendApns(job, body);
    return 'gone';
  } catch {
    console.warn(`native push: ${d.provider} send error`);
    return 'failed';
  }
}

export interface NativeResult { sent: number; removed: number; failed: number }

/** Send each job in parallel; delete devices the provider says are gone, stamp successes. */
export async function sendNative(jobs: NativeJob[]): Promise<NativeResult> {
  if (!jobs.length) return { sent: 0, removed: 0, failed: 0 };
  const ok: string[] = [];
  const gone: string[] = [];
  let failed = 0;
  await Promise.all(jobs.map(async (job) => {
    const o = await sendOne(job);
    if (o === 'ok') ok.push(job.dev.id);
    else if (o === 'gone') gone.push(job.dev.id);
    else failed++;
  }));
  const db = admin();
  await Promise.all([
    gone.length ? db.from('native_push_devices').delete().in('id', gone) : null,
    ok.length ? db.from('native_push_devices').update({ last_success_at: new Date().toISOString() }).in('id', ok) : null,
  ]);
  return { sent: ok.length, removed: gone.length, failed };
}
