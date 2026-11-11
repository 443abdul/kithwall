import { describe, expect, it } from 'vitest';
import {
  COMPONENT_FRAMES_MAX, FRAME_MAX, FRAMES_MAX, MESSAGE_MAX, STACK_MAX,
  fingerprintSource, scrubComponentStack, scrubCrash, scrubMessage, scrubName, scrubStack, type ScrubContext,
} from './scrub';
import { routePattern } from './routes';

const ctx: ScrubContext = {
  appOrigins: ['https://www.kithwall.com', 'http://localhost:3024'],
  apiOrigins: ['https://abcdefghijklmnop.supabase.co'],
  route: routePattern,
};
const msg = (m: string) => scrubMessage(m, ctx);

const UUID = '3f2c1a9e-7b4d-4c8e-9a1f-0d2e6b5c4a39';
const UUID2 = 'a81bc81b-dead-4e5d-abff-90865d1e13b1';

// Things that must never come out of the scrubber, whatever goes in. Each sample below is checked against
// all of them (plus its own expectations).
const SECRETS = [
  UUID, UUID2, 'saito', 'amina.khan', 'amina', 'khan@example.org', 'example.org', '03001234567', '+92 300 1234567',
  '4111111111111111', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  'c2VjcmV0LXNlc3Npb24tdG9rZW4tMTIzNDU2', 'deadbeefcafebabe1234', 'Meet me at the bridge', 'bridge', 'مرحبا', '你好',
  'नमस्ते', 'private-site.example', 'q=hello', 'token=abc', '192.168.1.44', '2001:db8:85a3::8a2e:370:7334', 'Hello dear',
];
function expectClean(out: string) {
  for (const s of SECRETS) expect(out, `leaked ${JSON.stringify(s)}`).not.toContain(s);
  expect(out).not.toMatch(/[^\x00-\x7f]/);
  expect(out).not.toMatch(/\?/);
  // No long numbers outside code locations ("chunk.js:1:23456").
  expect(out.replace(/[\w$.-]+:\d+(?::\d+)?/g, '')).not.toMatch(/\d{4,}/);
}

describe('scrubName', () => {
  it('keeps class names and nothing else', () => {
    expect(scrubName('TypeError')).toBe('TypeError');
    expect(scrubName('DOMException')).toBe('DOMException');
    expect(scrubName('java.lang.IllegalStateException')).toBe('java.lang.IllegalStateException');
    expect(scrubName('KeyWaitingError')).toBe('KeyWaitingError');
    expect(scrubName('Error: saito wrote this')).toBe('Error');
    expect(scrubName('مرحبا')).toBe('Error');
    expect(scrubName(`user_${'1'.repeat(8)}`)).toBe('Error');
    expect(scrubName('x'.repeat(200))).toBe('Error');
    expect(scrubName(undefined)).toBe('Error');
    expect(scrubName({ toString: () => 'saito' })).toBe('Error');
  });
});

describe('scrubMessage: addresses', () => {
  it('replaces foreign addresses whole', () => {
    expect(msg('Failed to load https://private-site.example/secret/page?q=hello#frag')).toBe('Failed to load <url>');
    expect(msg('ws error wss://private-site.example:8443/socket?token=abc')).toBe('ws error <url>');
    expect(msg('bad origin chrome-extension://abcdefghijklmnopabcdefghijklmnop/content.js')).toBe('bad origin <url>');
    expect(msg('opened file:///C:/Users/Saito/Documents/passport.pdf')).toBe('opened <url>');
    expect(msg('intent://scan/#Intent;scheme=zxing;end')).toBe('<url>');
  });

  it("turns the app's own pages into route patterns and drops query strings", () => {
    expect(msg(`Navigation to https://www.kithwall.com/messages/${UUID}?call=${UUID2}&answer=1 failed`)).toBe('Navigation to <app>/messages/[id] failed');
    expect(msg('at https://www.kithwall.com/u/saito/verify')).toBe('at <app>/u/[handle]/verify');
    expect(msg('at https://www.kithwall.com/saito')).toBe('at <app>/[handle]');
    expect(msg('at https://www.kithwall.com/some/odd/path/nobody/made')).toBe('at <app>/[handle]/[...rest]');
    expect(msg('at http://localhost:3024/you/settings/data#crash')).toBe('at <app>/you/settings/data');
  });

  it("keeps the app's own code files and API paths, without ids or queries", () => {
    expect(msg('ChunkLoadError https://www.kithwall.com/_next/static/chunks/4f2a9c01d3e5b677.js?dpl=dpl_abc123XYZ'))
      .toBe('ChunkLoadError /_next/static/chunks/4f2a9c01d3e5b677.js');
    expect(msg(`POST https://www.kithwall.com/api/push/dispatch?u=${UUID} 500`)).toBe('POST <app>/api/push/dispatch 500');
    expect(msg(`GET https://abcdefghijklmnop.supabase.co/rest/v1/messages?conversation_id=eq.${UUID}&select=* 401`)).toBe('GET <api>/rest/v1/messages 401');
    expect(msg(`https://abcdefghijklmnop.supabase.co/storage/v1/object/media/${UUID}/${UUID2}`)).toBe('<api>/storage/v1/object/media/<id>/<id>');
    // Another project's API is just a foreign address.
    expect(msg('https://zzzzzzzzzzzzzzzz.supabase.co/rest/v1/messages')).toBe('<url>');
  });

  it('never keeps blob and data addresses', () => {
    expect(msg(`Not allowed to load blob:https://www.kithwall.com/${UUID}`)).toBe('Not allowed to load blob:<id>');
    expect(msg('bad image data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk')).toBe('bad image <data>');
  });
});

describe('scrubMessage: identifiers, numbers and text', () => {
  it('removes ids, tokens, handles, e-mail and IP addresses', () => {
    expect(msg(`conversation ${UUID} not found`)).toBe('conversation <id> not found');
    expect(msg('no such user @saito here')).toBe('no such user <handle> here');
    expect(msg('@amina.khan is not a connection')).toBe('<handle> is not a connection');
    expect(msg('mail to khan@example.org bounced')).toBe('mail to <email> bounced');
    expect(msg('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U expired')).toBe('jwt <token> expired');
    expect(msg('key c2VjcmV0LXNlc3Npb24tdG9rZW4tMTIzNDU2 rejected')).toBe('key <token> rejected');
    expect(msg('digest deadbeefcafebabe1234 mismatch')).toBe('digest <hex> mismatch');
    expect(msg('peer 192.168.1.44 refused')).toBe('peer <ip> refused');
    expect(msg('peer 2001:db8:85a3::8a2e:370:7334 refused')).toBe('peer <ip> refused');
  });

  it('removes numbers of four digits or more and phone-like strings, keeps small ones', () => {
    expect(msg('call 03001234567 failed')).toBe('call <n> failed');
    expect(msg('call +92 300 1234567 failed')).toBe('call <n> failed');
    expect(msg('card 4111111111111111 declined')).toBe('card <n> declined');
    expect(msg('pin 482913 wrong')).toBe('pin <n> wrong');
    expect(msg('status 404 after 3 tries')).toBe('status 404 after 3 tries');
    expect(msg('offset 12 of 256')).toBe('offset 12 of 256');
  });

  it('removes every run of non-ASCII text', () => {
    expect(msg('could not send مرحبا يا صديقي to server')).toBe('could not send <text> <text> <text> to server');
    expect(msg('你好，世界')).toBe('<text>');
    expect(msg('नमस्ते दुनिया')).toBe('<text> <text>');
    expect(msg('Ünïcödé náme')).not.toMatch(/[^\x00-\x7f]/);
  });

  it('keeps quoted code names only where the engine quotes code', () => {
    expect(msg("Cannot read properties of undefined (reading 'envelope')")).toBe("Cannot read properties of undefined (reading 'envelope')");
    expect(msg("Cannot set properties of null (setting 'scrollTop')")).toBe("Cannot set properties of null (setting 'scrollTop')");
    expect(msg("undefined is not an object (evaluating 'a.b.c')")).toBe("undefined is not an object (evaluating 'a.b.c')");
    expect(msg("Failed to execute 'postMessage' on 'Window': Invalid target origin 'https://private-site.example' in a call"))
      .toBe("Failed to execute 'postMessage' on 'Window': Invalid target origin <text>");
    expect(msg("Failed to read the 'localStorage' property from 'Window': Access is denied")).toBe("Failed to read the 'localStorage' property from 'Window': Access is denied");
  });

  it('cuts the message at any other quoted text, including a single quoted word', () => {
    expect(msg('No account named "saito"')).toBe('No account named <text>');
    expect(msg("No account named 'saito' was found")).toBe('No account named <text>');
    expect(msg('Unexpected token \'H\', "Hello dear"... is not valid JSON')).toBe('Unexpected token <text>');
    expect(msg('JSON Parse error: Unexpected identifier "Hello"')).toBe('JSON Parse error: Unexpected identifier <text>');
    expect(msg('invalid input syntax for type uuid: "Meet me at the bridge"')).toBe('invalid input syntax for type uuid: <text>');
    expect(msg('bad template `Meet me at the bridge` here')).toBe('bad template <text>');
    // Quoted text that itself contains quotes: the words between the inner quotes must not survive.
    expect(msg('Unexpected token in "he said "Meet me at the bridge" ok" at position 3')).toBe('Unexpected token in <text>');
    // A quote that never closes (the engine cut the text off).
    expect(msg('Unterminated string in JSON: "Meet me at the bri')).toBe('Unterminated string in JSON: <text>');
    // A property-looking word outside the engine templates is not trusted.
    expect(msg("user typed 'envelope'")).toBe('user typed <text>');
  });

  it('leaves apostrophes inside words alone', () => {
    expect(msg("You can't send messages in this conversation.")).toBe("You can't send messages in this conversation.");
    expect(msg("That photo couldn't be read and isn't supported")).toBe("That photo couldn't be read and isn't supported");
  });

  it('removes file paths', () => {
    expect(msg('ENOENT: no such file /data/user/0/com.kithwall.app/files/saito.json')).toBe('ENOENT: no such file <path>');
    expect(msg('could not read C:\\Users\\Saito\\Documents\\passport.pdf')).toBe('could not read <path>');
    expect(msg('read/write failed for audio/webm')).toBe('read/write failed for audio/webm');
  });

  it("doesn't trust an earlier pass: forged <app> and <api> marks are checked again", () => {
    expect(msg('at <app>/messages/[id] now')).toBe('at <app>/messages/[id] now');
    expect(msg('at <app>/u/saito/verify now')).toBe('at <app>/u/[handle]/verify now');
    expect(msg(`at <api>/rest/v1/${UUID} now`)).toBe('at <api>/rest/v1/<id> now');
  });

  it('caps the length and flattens whitespace', () => {
    expect(msg(`a\n\n  b\t c ${'word '.repeat(200)}`).length).toBeLessThanOrEqual(MESSAGE_MAX);
    expect(msg('a\n\n  b\t c')).toBe('a b c');
    expect(msg(123 as unknown as string)).toBe('');
    expect(msg('x\u0000y\u0007z')).toBe('xy z');
  });
});

describe('scrubStack', () => {
  const v8 = [
    `TypeError: Cannot read properties of undefined (reading 'x') for @saito in ${UUID}`,
    '    at readMessage (https://www.kithwall.com/_next/static/chunks/4f2a9c01d3e5b677.js?dpl=dpl_9Xy:1:23456)',
    '    at async Promise.all (index 0)',
    `    at Object.send [as sendDraft] (https://www.kithwall.com/_next/static/chunks/app/(app)/messages/%5Bid%5D/page-0a1b2c3d4e5f6789.js:2:31)`,
    '    at content.js (chrome-extension://abcdefghijklmnopabcdefghijklmnop/content.js:10:5)',
    `    at eval (https://www.kithwall.com/messages/${UUID}?call=${UUID2}:3:9)`,
    '    at <anonymous>:1:23456',
    '    at new Promise (<anonymous>)',
  ].join('\n');

  it('keeps frames of our own code with their positions and drops the header', () => {
    const out = scrubStack(v8, ctx).split('\n');
    expect(out[0]).toBe('at readMessage (/_next/static/chunks/4f2a9c01d3e5b677.js:1:23456)');
    expect(out[1]).toBe('at async Promise.all (index 0)');
    expect(out[2]).toBe('at Object.send [as sendDraft] (/_next/static/chunks/app/(app)/messages/%5Bid%5D/page-0a1b2c3d4e5f6789.js:2:31)');
    expect(out[3]).toBe('at content.js (<url>)');
    expect(out[4]).toBe('at eval (<app>/messages/[id])');
    expect(out[5]).toBe('at <anonymous>:1:23456');
    expect(out[6]).toBe('at new Promise (<anonymous>)');
    expect(out).toHaveLength(7);
    expect(out.join('\n')).not.toContain('saito');
    expect(out.join('\n')).not.toContain(UUID);
  });

  it('reads Firefox and Safari frames', () => {
    const gecko = [
      `readMessage@https://www.kithwall.com/_next/static/chunks/4f2a9c01d3e5b677.js:1:23456`,
      '@https://www.kithwall.com/_next/static/chunks/main-app-0a1b2c3d4e5f6789.js:5:1',
      'forEach@[native code]',
      `load@https://private-site.example/app.js?user=saito:9:9`,
      'this line is part of a message about saito',
    ].join('\n');
    expect(scrubStack(gecko, ctx).split('\n')).toEqual([
      'readMessage@/_next/static/chunks/4f2a9c01d3e5b677.js:1:23456',
      '@/_next/static/chunks/main-app-0a1b2c3d4e5f6789.js:5:1',
      'forEach@[native code]',
      'load@<url>',
    ]);
  });

  it('reads Java frames from the Android app', () => {
    const java = [
      'java.lang.IllegalStateException: Could not open /data/user/0/com.kithwall.app/files/saito.json',
      '\tat com.kithwall.app.KithwallShellPlugin.setAppIcon(KithwallShellPlugin.java:412)',
      '\tat com.kithwall.app.KithwallShellPlugin$1.run(KithwallShellPlugin.java:12345)',
      '\tat android.os.Handler.dispatchMessage(Handler.java:942)',
      '\tat java.lang.reflect.Method.invoke(Native Method)',
      'Caused by: java.io.FileNotFoundException: /data/user/0/com.kithwall.app/files/saito.json (No such file)',
      '\tat CausedBy.java.io.FileNotFoundException(Unknown Source)',
    ].join('\n');
    expect(scrubStack(java, ctx).split('\n')).toEqual([
      'at com.kithwall.app.KithwallShellPlugin.setAppIcon(KithwallShellPlugin.java:412)',
      'at com.kithwall.app.KithwallShellPlugin$1.run(KithwallShellPlugin.java:12345)',
      'at android.os.Handler.dispatchMessage(Handler.java:942)',
      'at java.lang.reflect.Method.invoke(Native Method)',
      'at CausedBy.java.io.FileNotFoundException(Unknown Source)',
    ]);
  });

  it('caps frames, frame length and total size', () => {
    const many = Array.from({ length: 200 }, (_, i) => `    at fn${i % 7} (https://www.kithwall.com/_next/static/chunks/a${i % 9}.js:${i}:1)`).join('\n');
    const out = scrubStack(many, ctx);
    expect(out.split('\n')).toHaveLength(FRAMES_MAX);
    expect(out.length).toBeLessThanOrEqual(STACK_MAX);
    const long = `    at ${'veryLongName'.repeat(60)} (https://www.kithwall.com/_next/static/chunks/a.js:1:1)`;
    expect(scrubStack(long, ctx).length).toBeLessThanOrEqual(FRAME_MAX);
    const fat = Array.from({ length: 30 }, () => `    at ${'n'.repeat(230)} (x)`).join('\n');
    expect(scrubStack(fat, ctx).length).toBeLessThanOrEqual(STACK_MAX);
    expect(scrubStack('', ctx)).toBe('');
    expect(scrubStack(null, ctx)).toBe('');
  });

  it('scrubs React component stacks the same way', () => {
    const cs = [
      '',
      '    at Bubble (https://www.kithwall.com/_next/static/chunks/4f2a9c01d3e5b677.js:9:120)',
      '    at ol',
      '    at Thread (https://www.kithwall.com/_next/static/chunks/4f2a9c01d3e5b677.js:9:300)',
      ...Array.from({ length: 40 }, () => '    at div'),
    ].join('\n');
    const out = scrubComponentStack(cs, ctx).split('\n');
    expect(out[0]).toBe('at Bubble (/_next/static/chunks/4f2a9c01d3e5b677.js:9:120)');
    expect(out[1]).toBe('at ol');
    expect(out).toHaveLength(COMPONENT_FRAMES_MAX);
  });
});

describe('scrubCrash as a whole', () => {
  const samples: { name: string; message: string; stack: string }[] = [
    { name: 'TypeError', message: `Cannot read properties of undefined (reading 'x') at https://www.kithwall.com/messages/${UUID}?call=${UUID2}`, stack: `TypeError: x\n    at f (https://www.kithwall.com/_next/static/chunks/aa11bb22cc33dd44.js:1:234567)\n    at g (https://www.kithwall.com/_next/static/chunks/app/(app)/messages/%5Bid%5D/page-0a1b2c3d4e5f6789.js:12345:67890)\nh@https://www.kithwall.com/_next/static/chunks/aa11bb22cc33dd44.js:1:99999` },
    { name: 'SyntaxError', message: 'Unexpected token \'M\', "Meet me at the bridge" is not valid JSON', stack: 'SyntaxError: Unexpected token \'M\', "Meet me at the bridge" is not valid JSON\n    at JSON.parse (<anonymous>)\n    at parse (https://www.kithwall.com/_next/static/chunks/aa11bb22cc33dd44.js:4:99)' },
    { name: 'Error', message: 'مرحبا khan@example.org @saito 03001234567 +92 300 1234567 4111111111111111', stack: 'Error: مرحبا\n    at مرحبا (https://private-site.example/x.js?q=hello:1:1)' },
    { name: 'Error', message: `Request to https://abcdefghijklmnop.supabase.co/rest/v1/profiles?username=eq.saito&token=abc failed for ${UUID2} from 192.168.1.44`, stack: `fetchProfile@https://www.kithwall.com/_next/static/chunks/aa11bb22cc33dd44.js:7:7\n@https://www.kithwall.com/u/saito:1:1` },
    { name: 'DOMException', message: 'The quota 5242880 was exceeded by "你好 Hello dear"', stack: '' },
    { name: 'Error', message: 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U and c2VjcmV0LXNlc3Npb24tdG9rZW4tMTIzNDU2 and deadbeefcafebabe1234 2001:db8:85a3::8a2e:370:7334', stack: '    at नमस्ते (blob:https://www.kithwall.com/3f2c1a9e-7b4d-4c8e-9a1f-0d2e6b5c4a39:1:1)' },
    { name: 'java.lang.RuntimeException', message: 'Unable to open content://media/external/images/media/1000012345 or /data/user/0/com.kithwall.app/files/amina.khan.json or C:\\Users\\saito\\x.txt', stack: '\tat com.kithwall.app.KwChromeClient.copy(KwChromeClient.java:88)\n\tat android.os.Looper.loop(Looper.java:313)' },
  ];

  it('never lets any of the secrets through', () => {
    for (const s of samples) {
      const out = scrubCrash({ ...s, componentStack: s.stack }, ctx);
      expectClean(`${out.name}\n${out.message}\n${out.stack}\n${out.componentStack}`);
    }
  });

  it('is idempotent: the server scrubbing a scrubbed report changes nothing', () => {
    for (const s of samples) {
      const once = scrubCrash({ ...s, componentStack: s.stack }, ctx);
      const serverCtx: ScrubContext = { appOrigins: ['https://www.kithwall.com'], apiOrigins: [], route: routePattern };
      expect(scrubCrash(once, serverCtx)).toEqual(once);
      expect(scrubCrash(once, ctx)).toEqual(once);
    }
  });

  it('removes an over-long e-mail address whole', () => {
    const local = 'a.very.long.local.part.'.repeat(6);
    expect(msg(`mail to ${local}@example.org bounced`)).toBe('mail to <email> bounced');
  });

  it('takes linear time on long runs of letters (no quadratic patterns)', () => {
    // 2,000 lines of 1,000 letters: with an unbounded "name+" before "@" or ".js:" this takes many seconds.
    const line = `    at ${'a'.repeat(990)}`;
    const t0 = performance.now();
    scrubStack(Array.from({ length: 400 }, () => line).join('\n'), ctx);
    scrubMessage('a'.repeat(16_000), ctx);
    scrubMessage(`${'a.'.repeat(8000)}`, ctx);
    expect(performance.now() - t0).toBeLessThan(1500);
  });

  it('survives hostile input quickly', () => {
    const big = `${'a'.repeat(50_000)} ${'"'.repeat(20_000)} ${'1'.repeat(30_000)} ${"'x' ".repeat(10_000)}`;
    const t0 = Date.now();
    const out = scrubCrash({ name: big, message: big, stack: `    at ${big}\n`.repeat(50), componentStack: big }, ctx);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(out.name).toBe('Error');
    expect(out.message.length).toBeLessThanOrEqual(MESSAGE_MAX);
    expect(out.stack.length).toBeLessThanOrEqual(STACK_MAX);
    expect(() => scrubCrash({ name: 1, message: {}, stack: [], componentStack: null }, ctx)).not.toThrow();
  });
});

describe('fingerprintSource', () => {
  it('ignores positions, build hashes and numbers, keeps names', () => {
    const a = fingerprintSource('TypeError', 'at readMessage (/_next/static/chunks/4f2a9c01d3e5b677.js:1:23456)\nat async Promise.all (index 0)');
    const b = fingerprintSource('TypeError', 'at readMessage (/_next/static/chunks/99aa88bb77cc66dd.js:7:11)\nat async Promise.all (index 3)');
    expect(a).toBe(b);
    expect(a).toContain('readMessage');
    expect(fingerprintSource('RangeError', 'at readMessage (/_next/static/chunks/4f2a9c01d3e5b677.js:1:23456)')).not.toBe(a);
    expect(fingerprintSource('TypeError', 'at sendDraft (/_next/static/chunks/4f2a9c01d3e5b677.js:1:23456)')).not.toBe(a);
  });

  it('looks at the first six frames only', () => {
    const frames = Array.from({ length: 10 }, (_, i) => `at f${'abcdefghij'[i]} (x.js:1:1)`);
    expect(fingerprintSource('E', frames.join('\n'))).toBe(fingerprintSource('E', frames.slice(0, 6).join('\n')));
  });
});
