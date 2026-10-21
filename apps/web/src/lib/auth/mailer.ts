import 'server-only';
// Minimal SMTP client for CONTENT-FREE notice emails ("a recovery request was started",
// "your account is scheduled for deletion"). Auth emails (confirm, reset) are sent by Supabase
// through the same SMTP account (docs/deploy.md). No dependency, no templates, no user content.
//
// Config: SMTP_URL = smtps://user:password@mail.spacemail.com:465   (implicit TLS, required in production)
//         MAIL_FROM = "Kithwall <no-reply@example.com>"
// Plain smtp:// is only accepted for localhost (local testing). Without SMTP_URL the notice is skipped.
import net from 'node:net';
import tls from 'node:tls';

const TIMEOUT_MS = 15_000;

class SmtpConn {
  private buf = '';
  private waiters: ((line: string) => void)[] = [];
  private lines: string[] = [];
  private failed: Error | null = null;

  constructor(private sock: net.Socket) {
    sock.setEncoding('utf8');
    sock.setTimeout(TIMEOUT_MS, () => this.fail(new Error('SMTP timeout')));
    sock.on('data', (d: string) => {
      this.buf += d;
      let i: number;
      while ((i = this.buf.indexOf('\r\n')) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 2);
        const w = this.waiters.shift();
        if (w) w(line); else this.lines.push(line);
      }
    });
    sock.on('error', (e) => this.fail(e));
    sock.on('close', () => this.fail(new Error('SMTP connection closed')));
  }

  private fail(e: Error) {
    if (this.failed) return;
    this.failed = e;
    this.waiters.splice(0).forEach((w) => w(`599 ${e.message}`));
  }

  private nextLine(): Promise<string> {
    const l = this.lines.shift();
    if (l !== undefined) return Promise.resolve(l);
    if (this.failed) return Promise.resolve(`599 ${this.failed.message}`);
    return new Promise((r) => this.waiters.push(r));
  }

  /** Reads one (possibly multi-line) reply and checks its code. */
  async expect(ok: number[]): Promise<string[]> {
    const out: string[] = [];
    for (;;) {
      const line = await this.nextLine();
      out.push(line);
      if (/^\d{3} /.test(line) || !/^\d{3}-/.test(line)) break;
    }
    const code = Number(out[out.length - 1]!.slice(0, 3));
    if (!ok.includes(code)) throw new Error(`SMTP error: ${out[out.length - 1]}`);
    return out;
  }

  send(cmd: string) { this.sock.write(`${cmd}\r\n`); }
  close() { try { this.sock.end(); } catch { /* ignore */ } }
}

const clean = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();
const addr = (s: string) => { const m = /<([^<>\s]+@[^<>\s]+)>/.exec(s); return m ? m[1]! : s.trim(); };

export function mailConfigured(): boolean {
  // In production the links in a notice must point at the configured site, never at whatever Host header
  // the request carried (security review L8), so no site URL means no mail.
  if (process.env.NODE_ENV === 'production' && !process.env.NEXT_PUBLIC_SITE_URL) return false;
  return !!process.env.SMTP_URL && !!process.env.MAIL_FROM;
}

/** Sends a short plain-text notice. Returns false when mail isn't configured. Throws on SMTP errors. */
export async function sendNotice(to: string, subject: string, text: string): Promise<boolean> {
  const smtpUrl = process.env.SMTP_URL;
  const from = process.env.MAIL_FROM;
  if (!smtpUrl || !from) {
    console.info('[mail] SMTP_URL/MAIL_FROM not set: notice email skipped');
    return false;
  }
  if (!/^[^\s@<>]+@[^\s@<>]+$/.test(to)) throw new Error('invalid recipient');
  const u = new URL(smtpUrl);
  const secure = u.protocol === 'smtps:';
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (!secure && !(u.protocol === 'smtp:' && local)) throw new Error('SMTP_URL must use smtps:// (implicit TLS)');
  const port = Number(u.port || (secure ? 465 : 25));

  const sock: net.Socket = await new Promise((resolve, reject) => {
    const s = secure
      ? tls.connect({ host: u.hostname, port, servername: u.hostname, minVersion: 'TLSv1.2' }, () => resolve(s))
      : net.connect({ host: u.hostname, port }, () => resolve(s));
    s.once('error', reject);
    s.setTimeout(TIMEOUT_MS, () => { s.destroy(); reject(new Error('SMTP connect timeout')); });
  });
  const c = new SmtpConn(sock);
  try {
    await c.expect([220]);
    const helo = new URL(process.env.NEXT_PUBLIC_SITE_URL || 'http://kithwall.local').hostname;
    c.send(`EHLO ${helo}`); await c.expect([250]);
    if (u.username) {
      const plain = Buffer.from(`\0${decodeURIComponent(u.username)}\0${decodeURIComponent(u.password)}`).toString('base64');
      c.send(`AUTH PLAIN ${plain}`); await c.expect([235]);
    }
    c.send(`MAIL FROM:<${addr(from)}>`); await c.expect([250]);
    c.send(`RCPT TO:<${to}>`); await c.expect([250, 251]);
    c.send('DATA'); await c.expect([354]);
    const body = text.replace(/\r?\n/g, '\r\n').split('\r\n').map((l) => (l.startsWith('.') ? `.${l}` : l)).join('\r\n');
    const domain = addr(from).split('@')[1] ?? 'kithwall.local';
    const msg = [
      `From: ${clean(from)}`, `To: <${to}>`, `Subject: ${clean(subject)}`,
      `Date: ${new Date().toUTCString()}`, `Message-ID: <${crypto.randomUUID()}@${domain}>`,
      'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit',
      'Auto-Submitted: auto-generated', '', body, '.',
    ].join('\r\n');
    c.send(msg); await c.expect([250]);
    c.send('QUIT');
    return true;
  } finally {
    c.close();
  }
}
