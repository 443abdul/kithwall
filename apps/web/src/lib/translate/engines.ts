// Translation engines (lib/translate). Both run entirely on this device; there is no cloud engine and no
// fallback to one:
//  - browser: the built-in Translator and LanguageDetector APIs (desktop Chrome 138+). The browser downloads
//    its models itself, and only from a tap (user activation) when a download is needed.
//  - native:  the Android app's KithwallTranslate plugin (play build: Google ML Kit). Language packs are
//    ~30 MB each and are downloaded only after the person agreed (lib/native/plugins.ts).
// Everywhere else there is no engine and the Translate action is not shown.
import type { KithwallTranslatePlugin } from '@/lib/native/plugins';
import type { Detection } from './languages';

export type PairStatus = 'available' | 'downloadable' | 'unavailable';
export interface PairInfo {
  status: PairStatus;
  /** Language packs that a download would fetch (native engine; the browser doesn't say). */
  missing: string[];
}

export interface DownloadOptions {
  /** Native: wait for Wi-Fi (or another unmetered network) before downloading. */
  wifiOnly: boolean;
  /** Browser: download progress, 0–1. */
  onProgress?: (fraction: number) => void;
}

export interface TranslateEngine {
  readonly kind: 'browser' | 'native';
  /** Languages of `text`, most likely first; null while detection needs a download only a tap may start. */
  detect(text: string): Promise<Detection[] | null>;
  /** Download the detection model (browser; call from a click handler). */
  prepareDetector(opts: DownloadOptions): Promise<void>;
  pair(source: string, target: string): Promise<PairInfo>;
  /** Download what the pair needs (browser: call from a click handler, it needs user activation). */
  download(source: string, target: string, opts: DownloadOptions): Promise<void>;
  translate(text: string, source: string, target: string): Promise<string>;
  /** On Wi-Fi now? null when the engine can't tell (browser). */
  onWifi(): Promise<boolean | null>;
  /** Downloaded language packs, when the engine lets us manage them (native). */
  packs: { list(): Promise<string[]>; remove(lang: string): Promise<void> } | null;
}

/** A translation step failed because a model is missing (removed meanwhile, or the browser wants a tap). */
export class NeedsDownload extends Error {
  constructor() { super('needs_download'); this.name = 'NeedsDownload'; }
}

// ------------------------------------------------------------------------------------- browser
// Shapes of the built-in AI APIs (WebML CG "Translator and Language Detector APIs"; Chrome's docs). Typed
// here because TypeScript's DOM library doesn't include them yet.
type Availability = 'unavailable' | 'downloadable' | 'downloading' | 'available';
interface CreateMonitor { addEventListener(type: 'downloadprogress', fn: (e: { loaded: number }) => void): void }
interface BrowserTranslator { translate(input: string): Promise<string>; destroy?(): void }
interface BrowserDetector { detect(input: string): Promise<{ detectedLanguage?: string; confidence?: number }[]>; destroy?(): void }
export interface TranslatorStatic {
  availability(o: { sourceLanguage: string; targetLanguage: string }): Promise<Availability>;
  create(o: { sourceLanguage: string; targetLanguage: string; monitor?: (m: CreateMonitor) => void }): Promise<BrowserTranslator>;
}
export interface DetectorStatic {
  availability(o?: object): Promise<Availability>;
  create(o?: { monitor?: (m: CreateMonitor) => void }): Promise<BrowserDetector>;
}
export interface BrowserAi { Translator?: TranslatorStatic; LanguageDetector?: DetectorStatic }

const pairKey = (s: string, t: string) => `${s}>${t}`;

/**
 * availability() should answer at once, but some Chromium builds that expose the APIs without the on-device
 * model service never settle it (seen in an Electron-based browser): treat silence as "unavailable".
 */
export const AVAILABILITY_TIMEOUT_MS = 5000;
function availability(p: Promise<Availability>): Promise<Availability> {
  return Promise.race([p, new Promise<Availability>((r) => setTimeout(() => r('unavailable'), AVAILABILITY_TIMEOUT_MS))]);
}

/** Chrome refuses create() without user activation when a download is needed: that is "ask first". */
const isActivationError = (e: unknown) => (e as { name?: string } | null)?.name === 'NotAllowedError';

export function browserEngine(ai: Required<BrowserAi>): TranslateEngine {
  const { Translator, LanguageDetector } = ai;
  let detector: Promise<BrowserDetector> | null = null;
  const translators = new Map<string, Promise<BrowserTranslator>>();

  const monitorFor = (opts?: DownloadOptions) => opts?.onProgress
    ? (m: CreateMonitor) => m.addEventListener('downloadprogress', (e) => opts.onProgress!(Math.max(0, Math.min(1, e.loaded))))
    : undefined;

  // A model being created is remembered at once (so parallel calls share it) and forgotten if creation fails.
  function rememberDetector(p: Promise<BrowserDetector>): Promise<BrowserDetector> {
    detector = p;
    p.catch(() => { if (detector === p) detector = null; });
    return p;
  }
  function rememberTranslator(k: string, p: Promise<BrowserTranslator>): Promise<BrowserTranslator> {
    translators.set(k, p);
    p.catch(() => { if (translators.get(k) === p) translators.delete(k); });
    return p;
  }

  /** The detector, 'download' when it needs one (a tap must start it), or null when the browser has none. */
  async function getDetector(): Promise<BrowserDetector | 'download' | null> {
    if (detector) return detector;
    const a = await availability(LanguageDetector.availability());
    if (a === 'unavailable') return null;
    if (a !== 'available') return 'download';
    return rememberDetector(LanguageDetector.create());
  }

  async function getTranslator(source: string, target: string): Promise<BrowserTranslator> {
    const k = pairKey(source, target);
    const have = translators.get(k);
    if (have) return have;
    if ((await availability(Translator.availability({ sourceLanguage: source, targetLanguage: target }))) !== 'available') throw new NeedsDownload();
    return rememberTranslator(k, Translator.create({ sourceLanguage: source, targetLanguage: target }));
  }

  return {
    kind: 'browser',
    async detect(text) {
      const d = await getDetector();
      if (d === 'download') return null;
      if (!d) return [];
      const out = await d.detect(text);
      return out.filter((r) => typeof r.detectedLanguage === 'string').map((r) => ({ lang: r.detectedLanguage!, confidence: Number(r.confidence) || 0 }));
    },
    async prepareDetector(opts) {
      // create() first, with no await before it: it must run while the tap's user activation is fresh.
      const p = rememberDetector(LanguageDetector.create({ monitor: monitorFor(opts) }));
      try { await p; } catch (e) { throw isActivationError(e) ? new NeedsDownload() : e; }
    },
    async pair(source, target) {
      if (translators.has(pairKey(source, target))) return { status: 'available', missing: [] };
      const a = await availability(Translator.availability({ sourceLanguage: source, targetLanguage: target }));
      return { status: a === 'available' ? 'available' : a === 'unavailable' ? 'unavailable' : 'downloadable', missing: [] };
    },
    async download(source, target, opts) {
      // Same as prepareDetector: create() before any await.
      const k = pairKey(source, target);
      const p = rememberTranslator(k, Translator.create({ sourceLanguage: source, targetLanguage: target, monitor: monitorFor(opts) }));
      try { await p; } catch (e) { throw isActivationError(e) ? new NeedsDownload() : e; }
    },
    async translate(text, source, target) {
      let tr: BrowserTranslator;
      try { tr = await getTranslator(source, target); } catch (e) { throw isActivationError(e) ? new NeedsDownload() : e; }
      return tr.translate(text);
    },
    async onWifi() { return null; },
    packs: null,
  };
}

// ------------------------------------------------------------------------------------- native
export function nativeEngine(plugin: KithwallTranslatePlugin): TranslateEngine {
  const code = (e: unknown) => ((e as { code?: unknown } | null)?.code);
  return {
    kind: 'native',
    async detect(text) {
      const r = await plugin.detect({ text });
      return r.languages ?? [];
    },
    async prepareDetector() { /* ML Kit's language identification model ships inside the app */ },
    async pair(source, target) {
      const r = await plugin.pair({ source, target });
      if (!r.supported) return { status: 'unavailable', missing: [] };
      return { status: r.missing.length ? 'downloadable' : 'available', missing: r.missing };
    },
    async download(source, target, opts) {
      await plugin.download({ source, target, wifiOnly: opts.wifiOnly });
    },
    async translate(text, source, target) {
      try {
        return (await plugin.translate({ text, source, target })).text;
      } catch (e) {
        if (code(e) === 'not_downloaded') throw new NeedsDownload();
        throw e;
      }
    },
    async onWifi() {
      try { return (await plugin.status()).wifi; } catch { return null; }
    },
    packs: {
      list: async () => (await plugin.packs()).packs ?? [],
      remove: async (lang) => { await plugin.removePack({ lang }); },
    },
  };
}

// ------------------------------------------------------------------------------------- selection
export interface EngineEnv {
  /** The app's plugin when running in the Android app, else null. */
  native(): Promise<KithwallTranslatePlugin | null>;
  /** The page's global object (self), for the built-in APIs. */
  browser(): BrowserAi | null;
}

/**
 * The engine this device has, or null. In the Android app the native plugin wins when it is supported (play
 * build); the foss build reports unsupported, and an older app build has no plugin at all. Then (and in
 * browsers) the built-in browser APIs are used when BOTH exist: without a detector we wouldn't know what to
 * translate from.
 */
export async function selectEngine(env: EngineEnv): Promise<TranslateEngine | null> {
  try {
    const plugin = await env.native();
    if (plugin && (await plugin.status()).supported) return nativeEngine(plugin);
  } catch { /* older app without the plugin */ }
  const ai = env.browser();
  if (ai?.Translator && ai.LanguageDetector
    && typeof ai.Translator.create === 'function' && typeof ai.LanguageDetector.create === 'function') {
    return browserEngine({ Translator: ai.Translator, LanguageDetector: ai.LanguageDetector });
  }
  return null;
}
