// POST /api/crash — one crash report from a device whose owner turned "Send crash reports" on
// (Settings → Your data; docs/v2/03-transparency.md §6). No account is involved: the route reads no cookie
// and no Authorization header, and a report carries none.
//
//  - Size: at most 12 kB, refused from the Content-Length header and again while reading.
//  - Shape: parsed strictly (lib/crash/report.ts parseReport); unknown fields are dropped; the error text
//    is scrubbed AGAIN here with the same code the device ran, so only scrubbed text can be stored even
//    if a modified client skipped that step.
//  - Rate: 12 reports an hour per client, counted under a keyed hash of a daily-rotating IP tag
//    (kw.anon_rate_events, like the other account-less routes). The address itself is never written to the
//    database, to a log line or into the report. The table also takes at most 2,000 reports a day in total.
//  - Grouping: fingerprint = SHA-256 of the error class and its top frames without positions and hashes.
// Reports are deleted after 30 days (/api/cron/ephemeral). The answer never says more than "ok".
import { createHash } from 'node:crypto';
import { admin, json } from '@/lib/auth/server';
import { clientOverLimit } from '@/lib/auth/anon-limit';
import { parseReport, REPORT_MAX_BYTES, reportFingerprintSource } from '@/lib/crash/report';
import { routePattern } from '@/lib/crash/routes';
import type { ScrubContext } from '@/lib/crash/scrub';

export const dynamic = 'force-dynamic';

const PER_CLIENT = { max: 12, seconds: 3600 } as const;

/** The body as text, or null as soon as it is larger than `max` bytes (the rest is never read). */
async function readCapped(req: Request, max: number): Promise<string | null> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > max) return null;
  const reader = req.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel().catch(() => undefined); return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function originOf(u: string | undefined | null): string | null {
  try { return u ? new URL(u).origin : null; } catch { return null; }
}

function context(req: Request): ScrubContext {
  const origins = [originOf(process.env.NEXT_PUBLIC_SITE_URL), originOf(req.url), originOf(req.headers.get('origin'))];
  const api = originOf(process.env.NEXT_PUBLIC_SUPABASE_URL);
  return { appOrigins: [...new Set(origins.filter((o): o is string => !!o))], apiOrigins: api ? [api] : [], route: routePattern };
}

export async function POST(req: Request) {
  if (!/^application\/json\b/i.test(req.headers.get('content-type') ?? '')) return json({ error: 'bad_request' }, 415);
  const text = await readCapped(req, REPORT_MAX_BYTES).catch(() => null);
  if (text === null) return json({ error: 'too_large' }, 413);
  let body: unknown;
  try { body = JSON.parse(text); } catch { return json({ error: 'bad_request' }, 400); }
  const report = parseReport(body, context(req));
  if (!report) return json({ error: 'bad_request' }, 400);
  try {
    if (await clientOverLimit(req, 'crash-report', PER_CLIENT.max, PER_CLIENT.seconds)) return json({ error: 'rate_limited' }, 429);
    const fingerprint = createHash('sha256').update(reportFingerprintSource(report)).digest('hex').slice(0, 32);
    const { error } = await admin().rpc('crash_report_add', {
      p_id: report.id, p_fingerprint: fingerprint, p_kind: report.kind, p_platform: report.platform,
      p_app_web: report.app.web, p_app_version: report.app.version, p_app_build: report.app.build,
      p_os: report.os, p_browser: report.browser, p_route: report.route, p_locale: report.locale,
      p_name: report.name, p_message: report.message, p_stack: report.stack, p_component_stack: report.componentStack,
    });
    if (error) throw new Error(error.message);
    // Stored, or quietly dropped because today's total is full: the device needn't know which.
    return json({ ok: true });
  } catch (e) {
    console.error('crash report', (e as Error).message);
    return json({ error: 'unavailable' }, 503);
  }
}
