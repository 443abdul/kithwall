import 'server-only';
// Who may run the automated accounts from the Admin screen: a signed-in admin (second factor passed if they
// have one). Returns the refusal to send, or null when the caller is an admin.
import { admin, callerFromRequest, json, needsMfa } from '../auth/server';

export async function adminCaller(req: Request): Promise<Response | null> {
  const caller = await callerFromRequest(req);
  if (!caller) return json({ error: 'unauthorised' }, 401);
  if (needsMfa(caller)) return json({ error: 'mfa_required' }, 403);
  const { data } = await admin().from('staff_roles').select('role').eq('user_id', caller.user.id).maybeSingle();
  if (data?.role !== 'admin') return json({ error: 'forbidden' }, 403);
  return null;
}
