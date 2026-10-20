// Appearance preference store (lib/theme.ts) and the pre-paint script (public/theme.js).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFS, LEGACY_THEME_KEY, MODE_KEY, STYLE_KEY, THEME_COLORS, readPrefs, resolveMode, writePrefs } from './theme';

function memoryStorage(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
    removeItem: (k: string) => { m.delete(k); },
    dump: () => Object.fromEntries(m),
  };
}

describe('readPrefs / writePrefs', () => {
  it('defaults to warm + system', () => {
    expect(readPrefs(memoryStorage())).toEqual(DEFAULT_PREFS);
    expect(readPrefs(null)).toEqual(DEFAULT_PREFS);
  });
  it('reads saved values and ignores junk', () => {
    expect(readPrefs(memoryStorage({ [STYLE_KEY]: 'bold', [MODE_KEY]: 'dark' }))).toEqual({ style: 'bold', mode: 'dark' });
    expect(readPrefs(memoryStorage({ [STYLE_KEY]: 'neon', [MODE_KEY]: 'dim' }))).toEqual({ style: 'warm', mode: 'system' });
  });
  it('migrates the v1 kw.theme value once', () => {
    const s = memoryStorage({ [LEGACY_THEME_KEY]: 'dark' });
    expect(readPrefs(s)).toEqual({ style: 'warm', mode: 'dark' });
    expect(s.dump()).toEqual({ [MODE_KEY]: 'dark' });
    const s2 = memoryStorage({ [LEGACY_THEME_KEY]: 'system' });
    expect(readPrefs(s2).mode).toBe('system');
    expect(s2.dump()).toEqual({});
  });
  it('does not let kw.theme override an existing kw.mode', () => {
    expect(readPrefs(memoryStorage({ [MODE_KEY]: 'light', [LEGACY_THEME_KEY]: 'dark' })).mode).toBe('light');
  });
  it('writes only what changed', () => {
    const s = memoryStorage();
    writePrefs({ style: 'minimal' }, s);
    expect(s.dump()).toEqual({ [STYLE_KEY]: 'minimal' });
    writePrefs({ mode: 'light' }, s);
    expect(readPrefs(s)).toEqual({ style: 'minimal', mode: 'light' });
  });
  it('survives a storage that throws', () => {
    const bad = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => undefined };
    expect(readPrefs(bad)).toEqual(DEFAULT_PREFS);
    expect(() => writePrefs({ style: 'bold' }, bad)).not.toThrow();
  });
  it('resolves system mode', () => {
    expect(resolveMode('system', true)).toBe('dark');
    expect(resolveMode('system', false)).toBe('light');
    expect(resolveMode('light', true)).toBe('light');
  });
});

describe('theme colours', () => {
  it('match the --chrome token of every style × mode', () => {
    const css = readFileSync(join(__dirname, '../styles/v2/tokens.css'), 'utf8');
    for (const [style, modes] of Object.entries(THEME_COLORS)) {
      for (const [mode, color] of Object.entries(modes)) {
        const block = new RegExp(`:root\\[data-style="${style}"\\]\\[data-mode="${mode}"\\][^{]*\\{([^}]*)\\}`).exec(css);
        expect(block, `${style}/${mode}`).not.toBeNull();
        expect(/--chrome:\s*(#[0-9a-f]{6})/i.exec(block![1]!)?.[1]).toBe(color);
      }
    }
  });
});

describe('public/theme.js (pre-paint)', () => {
  const src = readFileSync(join(__dirname, '../../public/theme.js'), 'utf8');

  function run({ storage = {} as Record<string, string>, dark = false, languages = ['en-US'], path = '/' } = {}) {
    const attrs: Record<string, string> = {};
    const meta = { content: '', setAttribute(_: string, v: string) { this.content = v; } };
    const store = memoryStorage(storage);
    const document = {
      documentElement: { setAttribute: (k: string, v: string) => { attrs[k] = v; } },
      querySelector: () => meta,
      addEventListener: () => undefined,
    };
    const window = { localStorage: store, matchMedia: () => ({ matches: dark }) };
    runInNewContext(src, { window, document, navigator: { languages, language: languages[0] }, location: { pathname: path } });
    return { attrs, meta: meta.content, store: store.dump() };
  }

  it('applies defaults', () => {
    const r = run();
    expect(r.attrs).toMatchObject({ 'data-style': 'warm', 'data-mode': 'light', 'data-mode-pref': 'system', lang: 'en', dir: 'ltr' });
    expect(r.attrs['data-i18n-pending']).toBeUndefined();
    expect(r.meta).toBe(THEME_COLORS.warm.light);
  });
  it('follows the OS in system mode and applies saved style', () => {
    const r = run({ storage: { [STYLE_KEY]: 'bold' }, dark: true });
    expect(r.attrs).toMatchObject({ 'data-style': 'bold', 'data-mode': 'dark' });
    expect(r.attrs['data-theme']).toBeUndefined(); // the v1 attribute is gone with the v1 pages
    expect(r.meta).toBe(THEME_COLORS.bold.dark);
  });
  it('migrates kw.theme like lib/theme.ts', () => {
    const r = run({ storage: { [LEGACY_THEME_KEY]: 'dark' } });
    expect(r.attrs['data-mode']).toBe('dark');
    expect(r.store).toEqual({ [MODE_KEY]: 'dark' });
  });
  it('detects an RTL device language', () => {
    const r = run({ languages: ['ur-PK', 'en'] });
    expect(r.attrs).toMatchObject({ lang: 'ur', dir: 'rtl', 'data-i18n-pending': '' });
  });
  it('honours a saved language and uses zh-Hans', () => {
    expect(run({ storage: { 'kw.locale': 'zh' }, path: '/home' }).attrs).toMatchObject({ lang: 'zh-Hans', dir: 'ltr' });
  });
  it('applies the saved language on every page (no v1 English-only pages left)', () => {
    expect(run({ storage: { 'kw.locale': 'ar' }, path: '/legal/privacy' }).attrs).toMatchObject({ lang: 'ar', dir: 'rtl' });
    expect(run({ storage: { 'kw.locale': 'ar' }, path: '/recover' }).attrs.dir).toBe('rtl');
    expect(run({ storage: { 'kw.locale': 'ar' }, path: '/you/settings' }).attrs.dir).toBe('rtl');
  });
});
