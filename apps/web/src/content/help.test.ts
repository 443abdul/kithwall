// Every Help Center question/answer key exists in the English catalogue, and answers only link
// inside Kithwall. Run: npx vitest run src/content
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HELP } from './help';

const en = JSON.parse(readFileSync(join(__dirname, '../i18n/messages/en.json'), 'utf8')) as Record<string, string>;

describe('help content', () => {
  it('has a message for every section, question and answer', () => {
    for (const s of HELP) {
      expect(en[s.title], s.title).toBeTypeOf('string');
      for (const i of s.items) {
        expect(en[i.q], i.q).toBeTypeOf('string');
        expect(en[i.a], i.a).toBeTypeOf('string');
      }
    }
  });
  it('links only to Kithwall pages that exist in v2', () => {
    const links = HELP.flatMap((s) => s.items.flatMap((i) => [...en[i.a]!.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]!)));
    expect(links.length).toBeGreaterThan(10);
    for (const l of links) expect(l, l).toMatch(/^\/(people|you|activity|circles|home|notes|recover|signin|legal|donate)\b/);
  });
});
