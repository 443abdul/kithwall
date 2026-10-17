// GET /api/altcha/challenge — a fresh, signed proof-of-work challenge for the sign-up form.
import { newChallenge } from '@/lib/auth/altcha-server';
import { admin, json } from '@/lib/auth/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const challenge = await newChallenge();
    let signupsEnabled = true;
    try {
      const { data } = await admin().from('app_settings').select('value').eq('key', 'signups_enabled').maybeSingle();
      signupsEnabled = data?.value !== false;
    } catch { /* the hook still enforces it */ }
    return json({ challenge, signupsEnabled });
  } catch (e) {
    console.error('altcha challenge', e);
    return json({ error: 'Sign-up is temporarily unavailable.' }, 503);
  }
}
