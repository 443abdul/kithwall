// Catalogue completeness + formatter behaviour. Run: npx vitest run src/i18n
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatMessage, placeholders } from './format';
import { LOCALES, RTL_LOCALES, dirOf, langTag, matchLocale } from './locales';

const dir = join(__dirname, 'messages');
const load = (l: string) => JSON.parse(readFileSync(join(dir, `${l}.json`), 'utf8')) as Record<string, unknown>;
const en = load('en');
const keys = Object.keys(en).filter((k) => k !== '_meta').sort();

describe('message catalogues', () => {
  it('English source has keys and no _meta', () => {
    expect(keys.length).toBeGreaterThan(100);
    expect(en._meta).toBeUndefined();
  });

  for (const l of LOCALES.filter((x) => x !== 'en')) {
    describe(l, () => {
      const cat = load(l);
      it('is marked for review', () => {
        expect(cat._meta).toMatchObject({ review: expect.any(String) });
      });
      it('has exactly the English keys', () => {
        const have = Object.keys(cat).filter((k) => k !== '_meta').sort();
        expect(have.filter((k) => !keys.includes(k)), 'extra keys').toEqual([]);
        expect(keys.filter((k) => !have.includes(k)), 'missing keys').toEqual([]);
      });
      it('keeps every placeholder and plural shape', () => {
        for (const k of keys) {
          const src = en[k] as string;
          const tr = cat[k];
          expect(typeof tr, `${l}:${k}`).toBe('string');
          expect(placeholders(tr as string), `${l}:${k}`).toEqual(placeholders(src));
          if (/,\s*plural\s*,/.test(src)) {
            expect(tr as string, `${l}:${k} plural`).toMatch(/,\s*plural\s*,/);
            expect(tr as string, `${l}:${k} needs an "other" branch`).toMatch(/\bother\s*\{/);
          }
          // Formats without throwing and leaves no raw {placeholders} behind.
          const vars = Object.fromEntries(placeholders(src).map((p) => [p, p === 'count' || p === 'min' || p === 'step' || p === 'total' ? 2 : 'x']));
          expect(formatMessage(tr as string, vars, langTag(l)), `${l}:${k}`).not.toMatch(/\{[a-z]+\}/i);
        }
      });
      it('is not just English', () => {
        const same = keys.filter((k) => cat[k] === en[k] && /[a-z]{4,}/i.test(en[k] as string));
        expect(same.length / keys.length).toBeLessThan(0.15);
      });
    });
  }
});

describe('formatMessage', () => {
  it('interpolates', () => {
    expect(formatMessage('Welcome, {name}!', { name: 'Sara' })).toBe('Welcome, Sara!');
    expect(formatMessage('Hi {missing}', {})).toBe('Hi {missing}');
  });
  it('localises numbers', () => {
    expect(formatMessage('{n} items', { n: 12345 }, 'en')).toBe('12,345 items');
  });
  it('handles plurals with # and =0', () => {
    const m = '{count, plural, =0 {No new activity} one {# new update} other {# new updates}}';
    expect(formatMessage(m, { count: 0 })).toBe('No new activity');
    expect(formatMessage(m, { count: 1 })).toBe('1 new update');
    expect(formatMessage(m, { count: 1200 })).toBe('1,200 new updates');
  });
  it('uses the language plural rules (Arabic two / few)', () => {
    const m = '{count, plural, zero {z} one {o} two {t} few {f} many {m} other {x}}';
    expect(formatMessage(m, { count: 2 }, 'ar')).toBe('t');
    expect(formatMessage(m, { count: 5 }, 'ar')).toBe('f');
    expect(formatMessage(m, { count: 11 }, 'ar')).toBe('m');
    const ru = '{count, plural, one {o} few {f} many {m} other {x}}';
    expect(formatMessage(ru, { count: 21 }, 'ru')).toBe('o');
    expect(formatMessage(ru, { count: 3 }, 'ru')).toBe('f');
    expect(formatMessage(ru, { count: 5 }, 'ru')).toBe('m');
  });
  it('nests select inside plural branches and keeps apostrophes', () => {
    const m = "{label}, {count, plural, one {# new} other {# new}} — you're {who, select, me {here} other {away}}";
    expect(formatMessage(m, { label: 'Messages', count: 3, who: 'me' })).toBe("Messages, 3 new — you're here");
  });
  it('lists placeholders', () => {
    expect(placeholders('{label}, {count, plural, one {# {thing}} other {#}}')).toEqual(['count', 'label', 'thing']);
  });
});

describe('locales', () => {
  it('detects from device languages', () => {
    expect(matchLocale(['ur-PK', 'en-GB'])).toBe('ur');
    expect(matchLocale(['de-DE', 'pt-BR'])).toBe('pt');
    expect(matchLocale(['zh-TW'])).toBe('zh');
    expect(matchLocale(['de'])).toBe('en');
    expect(matchLocale([])).toBe('en');
  });
  it('marks ur, ar, fa right-to-left', () => {
    expect([...RTL_LOCALES].sort()).toEqual(['ar', 'fa', 'ur']);
    expect(dirOf('ar')).toBe('rtl');
    expect(dirOf('hi')).toBe('ltr');
  });
  it('public/theme.js knows the same languages', () => {
    const js = readFileSync(join(__dirname, '../../public/theme.js'), 'utf8');
    const m = /var LOCALES = \[([^\]]+)\]/.exec(js);
    expect(m).not.toBeNull();
    expect(m![1]!.split(',').map((s) => s.trim().replace(/'/g, ''))).toEqual([...LOCALES]);
    expect(js).toContain('var RTL = { ur: 1, ar: 1, fa: 1 }');
  });
});
