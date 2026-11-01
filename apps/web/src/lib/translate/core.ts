// On-device translation, the engine-independent part (lib/translate): when to offer "Translate", what has to
// be downloaded first, and caching. Detections and translations are cached in memory only: never written to
// storage, never sent anywhere, and dropped when the account locks (lib/translate/index.ts).
import type { Locale } from '@/i18n/locales';
import { detectable, foreignScript, pickDetection, sameLanguage, type Detection } from './languages';
import { NeedsDownload, type DownloadOptions, type PairInfo, type TranslateEngine } from './engines';

/** A small least-recently-used map. */
export class Lru<K, V> {
  private m = new Map<K, V>();
  constructor(private max: number) {}
  get(k: K): V | undefined {
    if (!this.m.has(k)) return undefined;
    const v = this.m.get(k)!;
    this.m.delete(k);
    this.m.set(k, v);
    return v;
  }
  has(k: K): boolean { return this.m.has(k); }
  set(k: K, v: V): void {
    this.m.delete(k);
    this.m.set(k, v);
    while (this.m.size > this.max) this.m.delete(this.m.keys().next().value as K);
  }
  delete(k: K): void { this.m.delete(k); }
  clear(): void { this.m.clear(); }
  get size(): number { return this.m.size; }
}

/** Whether to show "Translate" under a text. */
export type Offer =
  | { kind: 'none' }
  /** `source` null: written in another script, the real language is detected after the tap (browser). */
  | { kind: 'offer'; source: string | null };

/** What a tap on "Translate" leads to. */
export type Plan =
  | { kind: 'ready'; source: string }
  /** Ask first: a download is needed. `detector`: the browser's detection model; `missing`: language packs. */
  | { kind: 'download'; source: string | null; detector: boolean; missing: string[] }
  /** The careful detection says it's already in the reader's language. */
  | { kind: 'same' }
  | { kind: 'unsupported'; source: string | null };

const DETECT_CACHE = 500;
const RESULT_CACHE = 200;
/** Detections at the same time (each is a call into the browser model or across the app bridge). */
const DETECT_PARALLEL = 2;

export class Translation {
  private engineP: Promise<TranslateEngine | null> | null = null;
  /** text → detection (null: no confident language); absent while unknown. */
  private detections = new Lru<string, Detection | null>(DETECT_CACHE);
  private detecting = new Map<string, Promise<Detection | null | undefined>>();
  /** "source>target\ntext" → translation. */
  private results = new Lru<string, string>(RESULT_CACHE);
  private translating = new Map<string, Promise<string>>();
  private pairs = new Map<string, Promise<PairInfo>>();
  private downloads = new Map<string, Promise<void>>();
  private active = 0;
  private queue: (() => void)[] = [];

  constructor(private makeEngine: () => Promise<TranslateEngine | null>) {}

  engine(): Promise<TranslateEngine | null> {
    this.engineP ??= this.makeEngine().catch(() => null);
    return this.engineP;
  }

  /** Forget everything translated or detected (the account locked, or the person signed out). */
  clear(): void {
    this.detections.clear();
    this.results.clear();
    this.detecting.clear();
    this.translating.clear();
  }

  /** A translation already made for this text, if any (synchronous, for the first render). */
  cached(text: string, source: string, target: string): string | undefined {
    return this.results.get(resultKey(text, source, target));
  }

  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= DETECT_PARALLEL) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try { return await fn(); } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }

  /** Detected language (null: none confident), or undefined while detection needs a download first. */
  async detect(text: string): Promise<Detection | null | undefined> {
    if (this.detections.has(text)) return this.detections.get(text);
    const running = this.detecting.get(text);
    if (running) return running;
    const p = (async () => {
      const e = await this.engine();
      if (!e) return null;
      const r = await this.slot(() => e.detect(text));
      if (r === null) return undefined;
      const d = pickDetection(r);
      this.detections.set(text, d);
      return d;
    })().catch(() => null).finally(() => { this.detecting.delete(text); });
    this.detecting.set(text, p);
    return p;
  }

  private pair(source: string, target: string): Promise<PairInfo> {
    const k = `${source}>${target}`;
    let p = this.pairs.get(k);
    if (!p) {
      p = this.engine().then((e) => (e ? e.pair(source, target) : { status: 'unavailable' as const, missing: [] }));
      this.pairs.set(k, p);
      p.catch(() => this.pairs.delete(k));
    }
    return p;
  }

  private forgetPairs(): void { this.pairs.clear(); }

  /** Should "Translate" be offered under this text for a reader using `locale`? Detects lazily, on device. */
  async offer(text: string, locale: Locale): Promise<Offer> {
    if (!detectable(text)) return { kind: 'none' };
    const e = await this.engine();
    if (!e) return { kind: 'none' };
    const d = await this.detect(text);
    if (d === undefined) return foreignScript(text, locale) ? { kind: 'offer', source: null } : { kind: 'none' };
    if (!d || sameLanguage(d.lang, locale)) return { kind: 'none' };
    try {
      const p = await this.pair(d.lang, locale);
      return p.status === 'unavailable' ? { kind: 'none' } : { kind: 'offer', source: d.lang };
    } catch { return { kind: 'none' }; }
  }

  /** What has to happen before this text can be translated into `locale`. */
  async plan(text: string, locale: Locale): Promise<Plan> {
    const e = await this.engine();
    if (!e) return { kind: 'unsupported', source: null };
    const d = await this.detect(text);
    if (d === undefined) return { kind: 'download', source: null, detector: true, missing: [] };
    if (!d) return { kind: 'unsupported', source: null };
    if (sameLanguage(d.lang, locale)) return { kind: 'same' };
    if (this.results.has(resultKey(text, d.lang, locale))) return { kind: 'ready', source: d.lang };
    const p = await this.pair(d.lang, locale);
    if (p.status === 'unavailable') return { kind: 'unsupported', source: d.lang };
    if (p.status === 'downloadable') return { kind: 'download', source: d.lang, detector: false, missing: p.missing };
    return { kind: 'ready', source: d.lang };
  }

  /**
   * Download what `plan` needs, then plan again. In browsers call this straight from the click that
   * confirmed the download (the browser requires that user activation). Parallel downloads of the same
   * pair share one request.
   */
  async download(text: string, locale: Locale, plan: Extract<Plan, { kind: 'download' }>, opts: DownloadOptions): Promise<Plan> {
    const e = await this.engine();
    if (!e) return { kind: 'unsupported', source: null };
    if (plan.detector) {
      await e.prepareDetector(opts);
      this.detections.delete(text);
    }
    if (plan.source) {
      const k = `${plan.source}>${locale}`;
      let p = this.downloads.get(k);
      if (!p) {
        p = e.download(plan.source, locale, opts).finally(() => { this.downloads.delete(k); });
        this.downloads.set(k, p);
      }
      await p;
      this.forgetPairs();
    }
    return this.plan(text, locale);
  }

  /** Translate (from the cache when possible). Line breaks are kept: each line is translated on its own. */
  async translate(text: string, source: string, target: string): Promise<string> {
    const k = resultKey(text, source, target);
    const hit = this.results.get(k);
    if (hit !== undefined) return hit;
    const running = this.translating.get(k);
    if (running) return running;
    const p = (async () => {
      const e = await this.engine();
      if (!e) throw new Error('unsupported');
      const parts = splitLines(text);
      const out: string[] = [];
      for (const part of parts) out.push(part.translate ? await e.translate(part.text, source, target) : part.text);
      const result = out.join('');
      this.results.set(k, result);
      return result;
    })();
    this.translating.set(k, p);
    p.catch((x) => { if (x instanceof NeedsDownload) this.forgetPairs(); }).finally(() => { this.translating.delete(k); });
    return p;
  }

  /** On Wi-Fi now (null: the engine can't tell, as in browsers). */
  async onWifi(): Promise<boolean | null> {
    const e = await this.engine();
    return e ? e.onWifi() : null;
  }

  /** Downloaded language packs (null: this engine doesn't let us manage them). */
  async packs(): Promise<string[] | null> {
    const e = await this.engine();
    return e?.packs ? e.packs.list() : null;
  }

  async removePack(lang: string): Promise<void> {
    const e = await this.engine();
    if (!e?.packs) return;
    await e.packs.remove(lang);
    this.forgetPairs();
  }
}

const resultKey = (text: string, source: string, target: string) => `${source}>${target}\n${text}`;

/** The text split into lines to translate and the line breaks / blank lines between them (kept as is). */
export function splitLines(text: string): { text: string; translate: boolean }[] {
  return text.split(/(\s*\n\s*)/).filter((s) => s.length > 0).map((s) => ({ text: s, translate: /\S/.test(s) && !/\n/.test(s) }));
}
