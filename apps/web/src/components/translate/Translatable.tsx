'use client';
// "Translate" under a post, comment or chat message written in another language (lib/translate). The
// language is detected on this device once the text scrolls near the screen; the translation is made on
// this device and kept in memory only. The first use explains that, and any language pack download is
// asked for first (size, Wi-Fi, Data Saver).
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { dirOf, useFormat, useLocale, useT } from '@/i18n';
import { useDataSaver } from '@/lib/net/dataSaver';
import {
  NeedsDownload, PACK_BYTES, languageName, setTranslationIntroSeen, translation, translationIntroSeen,
  useTranslationEngine, useTranslationOffered, type Offer, type Plan,
} from '@/lib/translate';
import { detectable } from '@/lib/translate/languages';
import { formatBytes } from '@/components/posts/bits';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Dialog } from '@/components/ui/Dialog';
import { cx } from '@/components/ui/cx';

interface Props {
  /** The plain text that would be translated (what `children` shows). */
  text: string;
  /** The original, as the surrounding component renders it. */
  children: ReactNode;
  variant: 'post' | 'comment' | 'chat';
  /** Classes for the translated text, so it looks like the original (e.g. "k-post-text"). */
  textClassName?: string;
  /** The reader wrote it: nothing to offer. */
  mine?: boolean;
}

export function Translatable(props: Props) {
  const offered = useTranslationOffered();
  const engine = useTranslationEngine();
  if (props.mine || !offered || !engine || engine === 'none' || !detectable(props.text)) return <>{props.children}</>;
  return <TranslatableText {...props} />;
}

type Status =
  | { kind: 'working' }
  | { kind: 'downloading'; progress: number | null }
  | { kind: 'wifi' }
  | { kind: 'same' }
  | { kind: 'unsupported' }
  | { kind: 'failed' };

interface Ask { plan: Exclude<Plan, { kind: 'same' | 'unsupported' }>; intro: boolean; wifi: boolean | null }

function TranslatableText({ text, children, variant, textClassName }: Props) {
  const t = useT();
  const f = useFormat();
  const { locale, tag } = useLocale();
  const key = `${locale}\n${text}`;
  const ref = useRef<HTMLDivElement>(null);
  const live = useRef(true);
  // Each piece of state remembers the text + language it belongs to; an edit or a language switch resets it.
  const [offer, setOffer] = useState<{ key: string; offer: Offer } | null>(null);
  const [result, setResult] = useState<{ key: string; text: string; source: string } | null>(null);
  const [showing, setShowing] = useState(false);
  const [status, setStatus] = useState<{ key: string; s: Status } | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);

  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);

  // Detect lazily: only once the text is (nearly) on screen.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let on = true;
    const check = () => { void translation.offer(text, locale).then((o) => { if (on) setOffer({ key: `${locale}\n${text}`, offer: o }); }); };
    if (typeof IntersectionObserver === 'undefined') { check(); return () => { on = false; }; }
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      check();
    }, { rootMargin: '400px 0px' });
    io.observe(el);
    return () => { on = false; io.disconnect(); };
  }, [text, locale]);

  const st = status?.key === key ? status.s : null;
  const translated = result?.key === key ? result : null;
  const visible = showing && !!translated;
  const offering = offer?.key === key && offer.offer.kind === 'offer';
  const busy = st?.kind === 'working' || st?.kind === 'downloading' || st?.kind === 'wifi';
  const set = (s: Status | null) => { if (live.current) setStatus(s ? { key, s } : null); };

  async function run(source: string, retried: boolean) {
    set({ kind: 'working' });
    try {
      const out = await translation.translate(text, source, locale);
      if (!live.current) return;
      setResult({ key, text: out, source });
      setShowing(true);
      set(null);
    } catch (e) {
      if (e instanceof NeedsDownload && !retried) await proceed(await translation.plan(text, locale), true);
      else set({ kind: 'failed' });
    }
  }

  async function proceed(plan: Plan, retried = false) {
    if (!live.current) return;
    if (plan.kind === 'same' || plan.kind === 'unsupported') { set({ kind: plan.kind }); return; }
    if (plan.kind === 'ready' && translationIntroSeen()) { await run(plan.source, retried); return; }
    const wifi = plan.kind === 'download' ? await translation.onWifi() : null;
    if (!live.current) return;
    set(null);
    setAsk({ plan, intro: !translationIntroSeen(), wifi });
  }

  function toggle() {
    if (visible) { setShowing(false); return; }
    if (translated) { setShowing(true); return; }
    set({ kind: 'working' });
    void translation.plan(text, locale).then((p) => proceed(p)).catch(() => set({ kind: 'failed' }));
  }

  // Runs in the click that confirmed: the browser only starts a model download from a user gesture.
  function confirm(wifiOnly: boolean) {
    const a = ask;
    if (!a) return;
    setAsk(null);
    setTranslationIntroSeen();
    if (a.plan.kind === 'ready') { void run(a.plan.source, false); return; }
    set(wifiOnly && a.wifi === false ? { kind: 'wifi' } : { kind: 'downloading', progress: null });
    translation.download(text, locale, a.plan, { wifiOnly, onProgress: (p) => set({ kind: 'downloading', progress: p }) })
      .then((next) => proceed(next, true))
      .catch((e) => {
        // The browser wanted a fresh tap (the first one was used up by an earlier download): ask again.
        if (e instanceof NeedsDownload) void translation.plan(text, locale).then((p) => proceed(p, true));
        else set({ kind: 'failed' });
      });
  }

  const dir = dirOf(locale);
  const statusText = !st ? null
    : st.kind === 'working' ? t('translate.working')
    : st.kind === 'downloading' ? (st.progress != null ? t('translate.downloadingPercent', { percent: f.number(st.progress, { style: 'percent' }) }) : t('translate.downloading'))
    : st.kind === 'wifi' ? t('translate.waitingWifi')
    : st.kind === 'same' ? t('translate.same', { language: languageName(locale, tag) })
    : st.kind === 'unsupported' ? t('translate.unsupported')
    : t('translate.failed');
  const showButton = visible || (offering && st?.kind !== 'same' && st?.kind !== 'unsupported');

  return (
    <div ref={ref} className={cx('k-tr', `k-tr-${variant}`)}>
      {visible ? null : children}
      <div className="k-tr-live" aria-live="polite">
        {visible ? <div className={cx('k-tr-text', textClassName)} lang={tag} dir={dir}>{translated.text}</div> : null}
        {statusText ? <p className={cx('k-tr-status', st?.kind === 'failed' && 'is-error')}>{statusText}</p> : null}
      </div>
      {showButton ? (
        <p className="k-tr-bar">
          {visible ? <><span>{t('translate.note', { language: languageName(translated.source, tag) })}</span><span aria-hidden> · </span></> : null}
          {/* aria-disabled, not disabled: a disabled button would drop keyboard focus while work runs. */}
          <button type="button" className="k-linkbtn k-tr-btn" aria-disabled={busy || undefined} onClick={() => { if (!busy) toggle(); }}>
            {visible ? t('translate.showOriginal') : t('translate.action')}
          </button>
        </p>
      ) : null}
      {ask ? <AskDialog ask={ask} onConfirm={confirm} onClose={() => setAsk(null)} /> : null}
    </div>
  );
}

function AskDialog({ ask, onConfirm, onClose }: { ask: Ask; onConfirm: (wifiOnly: boolean) => void; onClose: () => void }) {
  const t = useT();
  const f = useFormat();
  const { tag } = useLocale();
  const saver = useDataSaver();
  const { plan, intro, wifi } = ask;
  const download = plan.kind === 'download' ? plan : null;
  const native = useTranslationEngine() === 'native';
  const packs = download?.missing ?? [];
  const size = formatBytes(packs.length * PACK_BYTES, f.number);
  const offWifi = native && wifi === false;
  return (
    <Dialog open onClose={onClose} sheet title={download ? t('translate.download.title') : t('translate.intro.title')}
      footer={<>
        <Button variant="ghost" onClick={onClose}>{t('common.notNow')}</Button>
        {offWifi ? <Button variant="secondary" onClick={() => onConfirm(false)}>{t('translate.download.useData')}</Button> : null}
        <Button variant="primary" onClick={() => onConfirm(true)}>
          {!download ? t('translate.action') : offWifi ? t('translate.download.wifi') : t('translate.download.now')}
        </Button>
      </>}>
      <div className="k-stack">
        {intro ? <p>{t('translate.intro.body')}</p> : null}
        {download && native && packs.length ? (
          <>
            <p>{t('translate.download.native', { count: packs.length, size })}</p>
            <ul className="k-tr-packs">
              {packs.map((p) => <li key={p}>{languageName(p, tag)}</li>)}
            </ul>
          </>
        ) : null}
        {download && !native ? (
          <p>{download.detector ? t('translate.download.detector') : t('translate.download.browser', { language: languageName(download.source ?? '', tag) })}</p>
        ) : null}
        {download && saver ? <Callout tone="warning">{t('translate.download.saver')}</Callout> : null}
        {offWifi && !saver ? <p className="k-hint">{t('translate.download.mobile')}</p> : null}
      </div>
    </Dialog>
  );
}
