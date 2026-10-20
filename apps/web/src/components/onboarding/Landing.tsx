'use client';
// Signed-out home page (kithwall.com): what Kithwall is, the privacy promises, how joining works,
// the three styles, and how it's funded. Copy follows docs/v2/00-brief.md §1–§5 and §9.
import { useT, type MessageKey } from '@/i18n';
import { usePrefs, STYLES } from '@/lib/theme';
import { ButtonLink } from '@/components/ui/Button';
import { Icon, type IconName } from '@/components/ui/Icon';
import { Avatar } from '@/components/ui/Avatar';
import { PublicFooter, PublicHeader } from './PublicChrome';
import { StylePreview } from './StylePicker';
import { useDocumentTitle } from './useDocumentTitle';

const PROMISES: { icon: IconName; title: MessageKey; body: MessageKey }[] = [
  { icon: 'lock', title: 'landing.p1Title', body: 'landing.p1Body' },
  { icon: 'noAds', title: 'landing.p2Title', body: 'landing.p2Body' },
  { icon: 'heart', title: 'landing.p3Title', body: 'landing.p3Body' },
  { icon: 'phone', title: 'landing.p4Title', body: 'landing.p4Body' },
  { icon: 'shield', title: 'landing.p5Title', body: 'landing.p5Body' },
  { icon: 'code', title: 'landing.p6Title', body: 'landing.p6Body' },
];

const STEPS: { icon: IconName; title: MessageKey; body: MessageKey }[] = [
  { icon: 'palette', title: 'landing.s1Title', body: 'landing.s1Body' },
  { icon: 'fingerprint', title: 'landing.s2Title', body: 'landing.s2Body' },
  { icon: 'users', title: 'landing.s3Title', body: 'landing.s3Body' },
];

export function Landing() {
  const t = useT();
  const { resolved } = usePrefs();
  useDocumentTitle(t('landing.docTitle'));
  return (
    <div className="k-landing">
      <PublicHeader />
      <main id="main">
        <section className="k-hero" aria-labelledby="hero-title">
          <div className="k-hero-copy">
            <p className="k-eyebrow"><Icon name="sealed" /> {t('landing.eyebrow')}</p>
            <h1 id="hero-title">{t('landing.title')}</h1>
            <p className="k-hero-lede">{t('landing.lede')}</p>
            <div className="k-hero-cta">
              <ButtonLink href="/join" variant="primary" size="lg" iconEnd="forward">{t('landing.cta')}</ButtonLink>
              <ButtonLink href="/signin" variant="secondary" size="lg">{t('landing.signIn')}</ButtonLink>
            </div>
            <p className="k-muted k-small">{t('landing.ctaNote')}</p>
          </div>
          <HeroArt />
        </section>

        <section className="k-band" aria-labelledby="promises-title">
          <h2 id="promises-title" className="k-band-title">{t('landing.promisesTitle')}</h2>
          <ul role="list" className="k-promises">
            {PROMISES.map((p) => (
              <li key={p.title} className="k-promise">
                <span className="k-promise-ico"><Icon name={p.icon} /></span>
                <h3>{t(p.title)}</h3>
                <p className="k-muted">{t(p.body)}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className="k-band" aria-labelledby="how-title">
          <h2 id="how-title" className="k-band-title">{t('landing.howTitle')}</h2>
          <ol className="k-steps">
            {STEPS.map((s, i) => (
              <li key={s.title} className="k-step">
                <span className="k-step-num" aria-hidden>{i + 1}</span>
                <div>
                  <h3><Icon name={s.icon} /> {t(s.title)}</h3>
                  <p className="k-muted">{t(s.body)}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className="k-band" aria-labelledby="styles-title">
          <h2 id="styles-title" className="k-band-title">{t('landing.stylesTitle')}</h2>
          <p className="k-band-lede k-muted">{t('landing.stylesBody')}</p>
          <div className="k-style-strip">
            {STYLES.map((s) => (
              <figure key={s} className="k-style-fig">
                <StylePreview style={s} mode={resolved} />
                <figcaption>{t(`style.${s}` as MessageKey)}</figcaption>
              </figure>
            ))}
          </div>
        </section>

        <section className="k-band k-donate" aria-labelledby="donate-title">
          <span className="k-promise-ico"><Icon name="gift" /></span>
          <div>
            <h2 id="donate-title">{t('landing.donateTitle')}</h2>
            <p className="k-muted">{t('landing.donateBody')}</p>
          </div>
        </section>

        <section className="k-band k-final" aria-labelledby="final-title">
          <h2 id="final-title">{t('landing.finalTitle')}</h2>
          <ButtonLink href="/join" variant="primary" size="lg">{t('landing.cta')}</ButtonLink>
        </section>
      </main>
      <PublicFooter />
    </div>
  );
}

/** Decorative hero: a phone showing a calm, sealed conversation. Built from tokens, no images. */
function HeroArt() {
  const t = useT();
  return (
    <div className="k-hero-art" aria-hidden>
      <div className="k-hero-phone">
        <div className="k-hero-phone-top">
          <Avatar name={t('preview.circleName')} size={28} />
          <span className="k-hero-phone-title">{t('preview.circleName')}</span>
          <Icon name="lock" />
        </div>
        <div className="k-bubble k-bubble-in">{t('preview.msg1')}</div>
        <div className="k-bubble k-bubble-out">{t('preview.msg2')}</div>
        <div className="k-bubble k-bubble-in">{t('preview.msg3')}</div>
        <div className="k-hero-seal"><Icon name="lock" /> {t('preview.sealed')}</div>
      </div>
      <span className="k-hero-blob k-hero-blob-1" />
      <span className="k-hero-blob k-hero-blob-2" />
    </div>
  );
}
