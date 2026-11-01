// On-device translation: engine selection, detection, caching and download planning, with mocked engines.
// Run: npx vitest run src/lib/translate
import { describe, expect, it, vi } from 'vitest';
import type { KithwallTranslatePlugin } from '@/lib/native/plugins';
import { Lru, Translation, splitLines } from './core';
import { AVAILABILITY_TIMEOUT_MS, NeedsDownload, browserEngine, nativeEngine, selectEngine, type DetectorStatic, type TranslateEngine, type TranslatorStatic } from './engines';
import { detectable, dominantScript, foreignScript, pickDetection, sameLanguage, sourceLang } from './languages';

const URDU = 'آج موسم بہت اچھا ہے، شام کو پارک چلیں گے';
const ENGLISH = 'The weather is lovely today, let us go to the park';
const SPANISH = 'El tiempo está precioso hoy, vamos al parque luego';

describe('languages', () => {
  it('normalises detector tags into translation sources', () => {
    expect(sourceLang('ur')).toBe('ur');
    expect(sourceLang('ur-PK')).toBe('ur');
    expect(sourceLang('und')).toBeNull();
    expect(sourceLang('')).toBeNull();
    expect(sourceLang('hi-Latn')).toBeNull(); // Roman Hindi/Urdu: the models expect the native script
    expect(sourceLang('iw')).toBe('he');
    expect(sourceLang('zh-Hant')).toBe('zh-Hant');
    expect(sourceLang('zh-CN')).toBe('zh');
  });

  it('picks only a confident detection', () => {
    expect(pickDetection([{ lang: 'es', confidence: 0.3 }, { lang: 'pt', confidence: 0.2 }])).toBeNull();
    expect(pickDetection([{ lang: 'und', confidence: 0.9 }])).toBeNull();
    expect(pickDetection([{ lang: 'fr', confidence: 0.1 }, { lang: 'ur', confidence: 0.92 }])).toEqual({ lang: 'ur', confidence: 0.92 });
    expect(pickDetection(null)).toBeNull();
  });

  it('ignores short texts, links, handles and emoji', () => {
    expect(detectable('ok 👍')).toBe(false);
    expect(detectable('https://example.com/a-very-long-path-here @someone_long')).toBe(false);
    expect(detectable(ENGLISH)).toBe(true);
    expect(sameLanguage('pt-BR', 'pt')).toBe(true);
  });

  it('spots text in a script the reader’s language does not use', () => {
    expect(dominantScript(URDU)).toBe('arabic');
    expect(foreignScript(URDU, 'en')).toBe(true);
    expect(foreignScript(URDU, 'ur')).toBe(false);
    expect(foreignScript(SPANISH, 'en')).toBe(false); // same script: only a real detector can tell
    expect(foreignScript(ENGLISH, 'ru')).toBe(true);
  });
});

describe('Lru and splitLines', () => {
  it('evicts the least recently used entry', () => {
    const l = new Lru<string, number>(2);
    l.set('a', 1); l.set('b', 2);
    l.get('a');
    l.set('c', 3);
    expect(l.has('a')).toBe(true);
    expect(l.has('b')).toBe(false);
    expect(l.size).toBe(2);
  });

  it('keeps line breaks out of what is translated', () => {
    expect(splitLines('one\n\ntwo\nthree')).toEqual([
      { text: 'one', translate: true }, { text: '\n\n', translate: false },
      { text: 'two', translate: true }, { text: '\n', translate: false }, { text: 'three', translate: true },
    ]);
  });
});

// ------------------------------------------------------------------------------------- engines
function fakeBrowser(o: { detector?: string; pairs?: Record<string, string>; activation?: () => boolean } = {}) {
  const detect = vi.fn(async (text: string) => (text.includes('موسم')
    ? [{ detectedLanguage: 'ur', confidence: 0.95 }, { detectedLanguage: 'und', confidence: 0.05 }]
    : text.includes('tiempo') ? [{ detectedLanguage: 'es', confidence: 0.9 }] : [{ detectedLanguage: 'en', confidence: 0.97 }]));
  let detectorState = o.detector ?? 'available';
  const pairs = { ...(o.pairs ?? {}) };
  const translate = vi.fn(async (s: string) => `[${s}]`);
  const LanguageDetector: DetectorStatic = {
    availability: vi.fn(async () => detectorState as 'available'),
    create: vi.fn(async (opts?: { monitor?: (m: { addEventListener(t: 'downloadprogress', f: (e: { loaded: number }) => void): void }) => void }) => {
      if (detectorState !== 'available' && o.activation && !o.activation()) throw Object.assign(new Error('needs a tap'), { name: 'NotAllowedError' });
      opts?.monitor?.({ addEventListener: (_t, f) => { f({ loaded: 0.5 }); f({ loaded: 1 }); } });
      detectorState = 'available';
      return { detect };
    }),
  };
  const Translator: TranslatorStatic = {
    availability: vi.fn(async ({ sourceLanguage, targetLanguage }) => (pairs[`${sourceLanguage}>${targetLanguage}`] ?? 'unavailable') as 'available'),
    create: vi.fn(async ({ sourceLanguage, targetLanguage }) => {
      const k = `${sourceLanguage}>${targetLanguage}`;
      if (pairs[k] === 'unavailable' || !pairs[k]) throw Object.assign(new Error('no'), { name: 'NotSupportedError' });
      if (pairs[k] !== 'available' && o.activation && !o.activation()) throw Object.assign(new Error('needs a tap'), { name: 'NotAllowedError' });
      pairs[k] = 'available';
      return { translate };
    }),
  };
  return { LanguageDetector, Translator, detect, translate, pairs };
}

function fakePlugin(o: { supported?: boolean; installed?: string[]; wifi?: boolean } = {}): KithwallTranslatePlugin & { installed: Set<string> } {
  const installed = new Set(['en', ...(o.installed ?? [])]);
  const known = new Set(['en', 'ur', 'es', 'hi', 'ar']);
  return {
    installed,
    status: vi.fn(async () => ({ supported: o.supported ?? true, wifi: o.wifi ?? true })),
    detect: vi.fn(async ({ text }: { text: string }) => ({ languages: text.includes('موسم') ? [{ lang: 'ur', confidence: 0.9 }] : [{ lang: 'en', confidence: 0.9 }] })),
    pair: vi.fn(async ({ source, target }: { source: string; target: string }) => ({
      supported: known.has(source) && known.has(target),
      missing: [source, target].filter((l) => !installed.has(l)),
    })),
    download: vi.fn(async ({ source, target }: { source: string; target: string }) => { installed.add(source); installed.add(target); }),
    translate: vi.fn(async ({ text, source, target }: { text: string; source: string; target: string }) => {
      if (!installed.has(source) || !installed.has(target)) throw Object.assign(new Error('no pack'), { code: 'not_downloaded' });
      return { text: `${source}->${target}: ${text}` };
    }),
    packs: vi.fn(async () => ({ packs: [...installed].filter((l) => l !== 'en') })),
    removePack: vi.fn(async ({ lang }: { lang: string }) => { installed.delete(lang); }),
  };
}

describe('selectEngine', () => {
  it('prefers the Android plugin when it is supported (play build)', async () => {
    const e = await selectEngine({ native: async () => fakePlugin(), browser: () => fakeBrowser() });
    expect(e?.kind).toBe('native');
  });

  it('falls back to the browser APIs when the plugin is unsupported (foss) or missing (older app)', async () => {
    expect((await selectEngine({ native: async () => fakePlugin({ supported: false }), browser: () => fakeBrowser() }))?.kind).toBe('browser');
    expect((await selectEngine({ native: async () => { throw new Error('not implemented'); }, browser: () => fakeBrowser() }))?.kind).toBe('browser');
  });

  it('has no engine without both built-in APIs, and never a remote one', async () => {
    expect(await selectEngine({ native: async () => fakePlugin({ supported: false }), browser: () => ({}) })).toBeNull();
    const b = fakeBrowser();
    expect(await selectEngine({ native: async () => null, browser: () => ({ Translator: b.Translator }) })).toBeNull();
    expect(await selectEngine({ native: async () => null, browser: () => null })).toBeNull();
  });
});

// ------------------------------------------------------------------------------------- service
const service = (e: TranslateEngine | null) => new Translation(async () => e);

describe('Translation with the browser engine', () => {
  it('offers translation only for another language, and caches detections', async () => {
    const b = fakeBrowser({ pairs: { 'ur>en': 'available', 'es>en': 'downloadable' } });
    const s = service(browserEngine(b));
    expect(await s.offer(URDU, 'en')).toEqual({ kind: 'offer', source: 'ur' });
    expect(await s.offer(URDU, 'en')).toEqual({ kind: 'offer', source: 'ur' });
    expect(b.detect).toHaveBeenCalledTimes(1);
    expect(await s.offer(ENGLISH, 'en')).toEqual({ kind: 'none' });
    expect(await s.offer('hi there', 'en')).toEqual({ kind: 'none' }); // too short to detect
    expect(await s.offer(URDU, 'ur')).toEqual({ kind: 'none' });
  });

  it('hides the action for pairs the browser cannot translate', async () => {
    const b = fakeBrowser({ pairs: {} });
    const s = service(browserEngine(b));
    expect(await s.offer(URDU, 'en')).toEqual({ kind: 'none' });
  });

  it('translates from memory the second time, line by line', async () => {
    const b = fakeBrowser({ pairs: { 'ur>en': 'available' } });
    const s = service(browserEngine(b));
    const text = `${URDU}\n\n${URDU}`;
    expect(await s.plan(text, 'en')).toEqual({ kind: 'ready', source: 'ur' });
    expect(await s.translate(text, 'ur', 'en')).toBe(`[${URDU}]\n\n[${URDU}]`);
    expect(await s.translate(text, 'ur', 'en')).toBe(`[${URDU}]\n\n[${URDU}]`);
    expect(b.translate).toHaveBeenCalledTimes(2); // two lines, once
    expect(s.cached(text, 'ur', 'en')).toBe(`[${URDU}]\n\n[${URDU}]`);
    s.clear();
    expect(s.cached(text, 'ur', 'en')).toBeUndefined();
  });

  it('shares one translation between parallel requests', async () => {
    const b = fakeBrowser({ pairs: { 'ur>en': 'available' } });
    const s = service(browserEngine(b));
    await Promise.all([s.translate(URDU, 'ur', 'en'), s.translate(URDU, 'ur', 'en')]);
    expect(b.translate).toHaveBeenCalledTimes(1);
  });

  it('asks before the browser downloads a model, then translates', async () => {
    const b = fakeBrowser({ pairs: { 'es>en': 'downloadable' } });
    const s = service(browserEngine(b));
    expect(await s.offer(SPANISH, 'en')).toEqual({ kind: 'offer', source: 'es' });
    const plan = await s.plan(SPANISH, 'en');
    expect(plan).toEqual({ kind: 'download', source: 'es', detector: false, missing: [] });
    expect(b.Translator.create).not.toHaveBeenCalled(); // nothing downloads before the person agreed
    const progress: number[] = [];
    const next = await s.download(SPANISH, 'en', plan as Extract<typeof plan, { kind: 'download' }>, { wifiOnly: true, onProgress: (p) => progress.push(p) });
    expect(next).toEqual({ kind: 'ready', source: 'es' });
    expect(await s.translate(SPANISH, 'es', 'en')).toBe(`[${SPANISH}]`);
  });

  it('with the detector not yet downloaded: offers by script, detects after the tap', async () => {
    let tapped = false;
    const b = fakeBrowser({ detector: 'downloadable', pairs: { 'ur>en': 'downloadable' }, activation: () => tapped });
    const s = service(browserEngine(b));
    expect(await s.offer(URDU, 'en')).toEqual({ kind: 'offer', source: null });
    expect(await s.offer(SPANISH, 'en')).toEqual({ kind: 'none' }); // same script: wait for a real detector
    const p1 = await s.plan(URDU, 'en');
    expect(p1).toEqual({ kind: 'download', source: null, detector: true, missing: [] });
    tapped = true;
    const p2 = await s.download(URDU, 'en', p1 as Extract<typeof p1, { kind: 'download' }>, { wifiOnly: true });
    // Detection now works; the translation model is a second download (and a second tap in the browser).
    expect(p2).toEqual({ kind: 'download', source: 'ur', detector: false, missing: [] });
    const p3 = await s.download(URDU, 'en', p2 as Extract<typeof p2, { kind: 'download' }>, { wifiOnly: true });
    expect(p3).toEqual({ kind: 'ready', source: 'ur' });
  });

  it('turns a refused download (no user activation) into NeedsDownload', async () => {
    const b = fakeBrowser({ pairs: { 'es>en': 'downloadable' }, activation: () => false });
    const s = service(browserEngine(b));
    const plan = await s.plan(SPANISH, 'en');
    await expect(s.download(SPANISH, 'en', plan as Extract<typeof plan, { kind: 'download' }>, { wifiOnly: true })).rejects.toBeInstanceOf(NeedsDownload);
    await expect(s.translate(SPANISH, 'es', 'en')).rejects.toBeInstanceOf(NeedsDownload);
  });

  it('says when the careful detection finds the reader’s own language', async () => {
    const b = fakeBrowser({ pairs: {} });
    const s = service(browserEngine(b));
    expect(await s.plan(ENGLISH, 'en')).toEqual({ kind: 'same' });
  });

  it('treats an availability() that never answers as unavailable', async () => {
    vi.useFakeTimers();
    try {
      const b = fakeBrowser();
      b.Translator.availability = vi.fn(() => new Promise<'available'>(() => {}));
      const s = service(browserEngine(b));
      const offer = s.offer(URDU, 'en');
      await vi.advanceTimersByTimeAsync(AVAILABILITY_TIMEOUT_MS + 10);
      expect(await offer).toEqual({ kind: 'none' });
    } finally { vi.useRealTimers(); }
  });

  it('cannot list or remove packs (the browser manages its models)', async () => {
    const s = service(browserEngine(fakeBrowser()));
    expect(await s.packs()).toBeNull();
    expect(await s.onWifi()).toBeNull();
  });
});

describe('Translation with the native engine', () => {
  it('lists the packs a download needs, waits for consent, and downloads on Wi-Fi only when asked', async () => {
    const plugin = fakePlugin({ wifi: false });
    const s = service(nativeEngine(plugin));
    expect(await s.offer(URDU, 'en')).toEqual({ kind: 'offer', source: 'ur' });
    const plan = await s.plan(URDU, 'en');
    expect(plan).toEqual({ kind: 'download', source: 'ur', detector: false, missing: ['ur'] });
    expect(plugin.download).not.toHaveBeenCalled();
    expect(await s.onWifi()).toBe(false);
    const next = await s.download(URDU, 'en', plan as Extract<typeof plan, { kind: 'download' }>, { wifiOnly: true });
    expect(plugin.download).toHaveBeenCalledWith({ source: 'ur', target: 'en', wifiOnly: true });
    expect(next).toEqual({ kind: 'ready', source: 'ur' });
    expect(await s.translate(URDU, 'ur', 'en')).toBe(`ur->en: ${URDU}`);
  });

  it('translating English into Urdu needs the Urdu pack (English is built in)', async () => {
    const s = service(nativeEngine(fakePlugin()));
    expect(await s.plan(ENGLISH, 'ur')).toEqual({ kind: 'download', source: 'en', detector: false, missing: ['ur'] });
  });

  it('shares one download between texts of the same pair', async () => {
    const plugin = fakePlugin();
    const s = service(nativeEngine(plugin));
    const a = await s.plan(URDU, 'en');
    const other = `${URDU} اور کل بھی`;
    const b = await s.plan(other, 'en');
    await Promise.all([
      s.download(URDU, 'en', a as Extract<typeof a, { kind: 'download' }>, { wifiOnly: false }),
      s.download(other, 'en', b as Extract<typeof b, { kind: 'download' }>, { wifiOnly: false }),
    ]);
    expect(plugin.download).toHaveBeenCalledTimes(1);
  });

  it('a pack removed in Settings makes the next translation ask again', async () => {
    const plugin = fakePlugin({ installed: ['ur'] });
    const s = service(nativeEngine(plugin));
    expect(await s.plan(URDU, 'en')).toEqual({ kind: 'ready', source: 'ur' });
    expect(await s.packs()).toEqual(['ur']);
    await s.removePack('ur');
    expect(await s.packs()).toEqual([]);
    expect(await s.plan(URDU, 'en')).toEqual({ kind: 'download', source: 'ur', detector: false, missing: ['ur'] });
    await expect(s.translate(URDU, 'ur', 'en')).rejects.toBeInstanceOf(NeedsDownload);
  });

  it('unsupported languages are not offered', async () => {
    const plugin = fakePlugin();
    plugin.detect = vi.fn(async () => ({ languages: [{ lang: 'xx', confidence: 0.99 }] }));
    const s = service(nativeEngine(plugin));
    expect(await s.offer(SPANISH, 'en')).toEqual({ kind: 'none' });
    expect(await s.plan(SPANISH, 'en')).toEqual({ kind: 'unsupported', source: 'xx' });
  });

  it('never more than two detections at a time', async () => {
    const plugin = fakePlugin();
    let running = 0, peak = 0;
    plugin.detect = vi.fn(async () => {
      running++; peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return { languages: [{ lang: 'ur', confidence: 0.9 }] };
    });
    const s = service(nativeEngine(plugin));
    await Promise.all(Array.from({ length: 6 }, (_, i) => s.detect(`${URDU} ${'ا'.repeat(i + 1)}`)));
    expect(peak).toBe(2);
    expect(plugin.detect).toHaveBeenCalledTimes(6);
  });
});

describe('Translation without an engine', () => {
  it('offers nothing', async () => {
    const s = service(null);
    expect(await s.offer(URDU, 'en')).toEqual({ kind: 'none' });
    expect(await s.plan(URDU, 'en')).toEqual({ kind: 'unsupported', source: null });
  });

  it('treats an engine that fails to start as none', async () => {
    const s = new Translation(async () => { throw new Error('boom'); });
    expect(await s.engine()).toBeNull();
  });
});
