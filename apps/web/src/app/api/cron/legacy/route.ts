// GET /api/cron/legacy — the daily legacy-contact job (docs/v2/03-safety.md §12, migration
// 20261102000200_legacy_contact.sql). public.legacy_tick() does the work in the database: it reminds owners
// about 30 and 7 days before their inactivity period ends (an in-app notification, whose insert trigger sends
// the push) and releases notes whose period is over, at least a week after the last reminder, telling the
// contact. This route then emails each reminder to owners who set up a verified notice address
// (content-free: no names, no note). Release timing is a day at most out, which is fine for months.
// Called by Vercel Cron with "Authorization: Bearer $CRON_SECRET" (see docs/deploy.md), like /api/cron/stories.
import { timingSafeEqual } from 'node:crypto';
import { admin, claimNotice, json, siteOrigin } from '@/lib/auth/server';
import { mailConfigured, sendNotice } from '@/lib/auth/mailer';
import { noticeAddress } from '@/lib/auth/passkey-server';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function authorised(req: Request): boolean {
  const secret = process.env.CRON_SECRET ?? '';
  if (secret.length < 16) return false;
  const got = Buffer.from(req.headers.get('authorization') ?? '');
  const want = Buffer.from(`Bearer ${secret}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

type TickEvent =
  | { kind: 'reminder'; owner_id: string; notification_id: string; days: number }
  | { kind: 'released'; owner_id: string; contact_id: string; notification_id: string };

export async function GET(req: Request) {
  if (!authorised(req)) return json({ error: 'unauthorised' }, 401);
  const { data, error } = await admin().rpc('legacy_tick');
  if (error) return json({ error: error.message }, 500);
  const events = (Array.isArray(data) ? data : []) as TickEvent[];
  const reminders = events.filter((e): e is Extract<TickEvent, { kind: 'reminder' }> => e.kind === 'reminder');
  let emailed = 0;
  if (reminders.length && mailConfigured()) {
    const origin = siteOrigin(req);
    for (const r of reminders) {
      try {
        const to = await noticeAddress(r.owner_id);
        // claimNotice dedupes on the reminder's notification id, so a retried run never mails twice.
        if (!to || !(await claimNotice('legacy_reminder', r.notification_id, r.owner_id))) continue;
        const when = r.days <= 7 ? 'in about a week' : `in about ${Math.max(1, Math.round(r.days / 7))} weeks`;
        await sendNotice(to, 'Open Kithwall to keep your legacy contact on hold',
          `You chose a legacy contact on Kithwall. Because you haven't opened Kithwall for a while, ` +
          `your note to them will be passed on ${when}.\n\n` +
          `If you're well, simply open Kithwall: ${origin}\nThat is all it takes to keep everything on hold. ` +
          `You can change or remove your legacy contact any time under You > Settings > Security.\n\n— Kithwall`);
        emailed++;
      } catch (e) { console.error('legacy reminder email', e); }
    }
  }
  return json({ reminders: reminders.length, released: events.length - reminders.length, emailed });
}
