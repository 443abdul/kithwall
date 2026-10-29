// The call quality controller (docs/v2/04-calls.md §11 "Low bandwidth"). Pure: the engine feeds it one
// sample of WebRTC stats per peer every 2 s and applies what comes out (sender encodings, Opus bitrate,
// RED on/off, the quality bars). vitest drives it with synthetic samples.
//
// Rules, in short:
//  - Audio comes first. Video steps down 720p/30 → 360p/24 → 180p/15 → paused (voice only) long before
//    audio is touched, and audio is squeezed (32 → 8 kbps) only when even that doesn't fit.
//  - Going down is quick (two bad samples, ~4 s; one if it's dire). Going up is earned: good samples in a
//    row with headroom (the first step of a call after 2, ≈ 4 s; later ones after 4). An upgrade that fails soon after doubles the wait for the next
//    one (exponential back-off, up to a minute), so a flaky link doesn't flap between tiers.
//  - Paused video comes back by itself: when the link has been calm for a while the controller probes
//    the lowest tier again (the bandwidth estimate can't grow while almost nothing is being sent).
//  - A ceiling caps the best tier: data saver (180p), the receiver asking for less, or the mesh size (each
//    extra person means another encoder on the same phone and another share of the same uplink).

export type Tier = 0 | 1 | 2 | 3;
export const PAUSED: Tier = 3;

export interface TierSpec { height: number; fps: number; maxBitrate: number }
/** 0: 720p/30, 1: 360p/24, 2: 180p/15. Tier 3 = video paused, audio only. */
export const TIERS: readonly TierSpec[] = [
  { height: 720, fps: 30, maxBitrate: 1_200_000 },
  { height: 360, fps: 24, maxBitrate: 450_000 },
  { height: 180, fps: 15, maxBitrate: 140_000 },
];
/** Uplink (bps, for this peer) needed to stay on a tier … */
export const STAY: readonly number[] = [700_000, 260_000, 90_000];
/** … and to move up to it (hysteresis: entering needs clearly more than staying). */
export const ENTER: readonly number[] = [1_300_000, 550_000, 170_000];
/** Opus bitrate steps (bps). */
export const AUDIO_STEPS = [32_000, 24_000, 16_000, 12_000, 8_000] as const;
/** Data saver: Opus never above this. */
export const SAVER_AUDIO = 12_000;

export const DOWN_HOLD = 2;
export const UP_HOLD = 4;
/** The first step up of a call (nothing has gone wrong yet): earned in half the time (≈ 4 s). */
export const START_UP_HOLD = 2;
/**
 * The bandwidth estimate can't grow far beyond what we let the encoder send: Chrome probes for headroom up
 * to roughly twice the allocated bitrate (measured: 360p capped at 450 kbps + Opus → the estimate settles
 * at ~830 kbps on a LAN). So "the next tier's ENTER threshold" alone could never be met from below (calls
 * stayed at 360p on perfect links, and 180p never came back to 360p). An estimate this many times what the
 * current tier is allowed also counts as room to step up.
 */
export const HEADROOM = 1.6;
export const MAX_UP_HOLD = 30;

export type Quality = 'good' | 'fair' | 'poor';
export type QualityReason = 'bandwidth' | 'loss' | 'latency' | 'cpu';
export type Limitation = 'none' | 'bandwidth' | 'cpu' | 'other';

export interface NetSample {
  /** Estimated uplink for this peer (bps): candidate-pair availableOutgoingBitrate, shared out in a mesh. Null if unknown. */
  availableOut: number | null;
  /** Round-trip time (s), null if unknown. */
  rtt: number | null;
  /** Fraction of MY packets lost on the way to this peer (0–1), from their receiver reports. */
  loss: number;
  /** Fraction of THEIR packets I didn't get (0–1). Only used for the quality shown, not for what I send. */
  inLoss?: number;
  /** Inbound audio jitter (s). */
  jitter?: number | null;
  /** Why the video encoder is holding back (outbound-rtp qualityLimitationReason). */
  limitation?: Limitation | null;
}

export interface ControllerConfig {
  /** Best tier allowed (0 = no cap). */
  ceiling: Tier;
  /** Data saver: audio capped at SAVER_AUDIO, RED only under heavy loss. */
  saver: boolean;
}

export interface Decision {
  tier: Tier;
  audioBitrate: number;
  red: boolean;
  quality: Quality;
  reason: QualityReason | null;
  /** Is the video tier below the ceiling because of the network (not because of a cap)? */
  constrained: boolean;
}

/** Pick a starting tier from what the browser knows about the connection (Network Information API). */
export function startTier(hint: { effectiveType?: string; saveData?: boolean; downlink?: number } | null | undefined, saver: boolean): Tier {
  if (saver || hint?.saveData) return 2;
  const et = hint?.effectiveType;
  if (et === 'slow-2g' || et === '2g') return 2;
  // Chrome's bandwidth estimate starts around 300 kbps: starting at 720p would only mean dropping frames.
  return 1;
}

/** The ceiling a mesh of `peers` remote people allows (CPU: one encoder per peer; uplink: shared). */
export function meshCeiling(peers: number): Tier {
  return peers >= 4 ? 2 : peers >= 2 ? 1 : 0;
}

/** Each peer's share of the uplink in a mesh: its own estimate, but never more than a fair share of the total. */
export function shareUplink(estimates: (number | null)[]): (number | null)[] {
  const known = estimates.filter((e): e is number => typeof e === 'number' && e > 0);
  if (known.length < 2) return estimates;
  const fair = known.reduce((a, b) => a + b, 0) / estimates.length;
  return estimates.map((e) => (typeof e === 'number' ? Math.min(e, fair) : e));
}

/** Highest-quality tier (lowest number) whose threshold the budget meets, else PAUSED. */
function fit(budget: number, table: readonly number[]): Tier {
  for (let t = 0; t < table.length; t++) if (budget >= table[t]!) return t as Tier;
  return PAUSED;
}

function audioFor(budget: number | null): number {
  if (budget === null) return AUDIO_STEPS[0];
  if (budget >= 300_000) return 32_000;
  if (budget >= 120_000) return 24_000;
  if (budget >= 60_000) return 16_000;
  if (budget >= 35_000) return 12_000;
  return 8_000;
}

export class QualityController {
  tier: Tier;
  audioBitrate: number;
  red = false;
  quality: Quality = 'good';
  reason: QualityReason | null = null;
  private cfg: ControllerConfig;
  private n = 0;
  private down = 0;
  private up = 0;
  upHold = START_UP_HOLD;
  private lastUpAt = -1_000;
  private lastDownAt = -1_000;
  private audioDown = 0;
  private audioUp = 0;
  private redOn = 0;
  private redOff = 0;
  /** Pushed below where we were by the network (vs. merely not yet earned / capped). Cleared once back. */
  private pushedFrom: Tier | null = null;
  private qCand: Quality = 'good';
  private qCount = 0;

  constructor(cfg: ControllerConfig, start: Tier = 1) {
    this.cfg = { ...cfg };
    this.tier = Math.max(start, cfg.ceiling) as Tier;
    this.audioBitrate = cfg.saver ? SAVER_AUDIO : AUDIO_STEPS[0];
  }

  get config(): ControllerConfig { return { ...this.cfg }; }

  /** Change the caps (data saver toggled, receiver asked for less, people joined/left). Applies at once. */
  configure(cfg: Partial<ControllerConfig>): Decision {
    const wasCeiling = this.cfg.ceiling;
    this.cfg = { ...this.cfg, ...cfg };
    if (this.tier < this.cfg.ceiling) this.tier = this.cfg.ceiling;
    // The cap was lifted: start from the new ceiling's neighbourhood, but still earn anything above 360p.
    if (this.cfg.ceiling < wasCeiling && this.tier === wasCeiling && wasCeiling === PAUSED) this.tier = Math.max(this.cfg.ceiling, 2) as Tier;
    if (this.cfg.saver) { this.audioBitrate = Math.min(this.audioBitrate, SAVER_AUDIO); }
    this.up = 0;
    return this.decision();
  }

  private decision(): Decision {
    return { tier: this.tier, audioBitrate: this.audioBitrate, red: this.red, quality: this.quality, reason: this.reason, constrained: this.pushedFrom !== null && this.tier > this.cfg.ceiling };
  }

  update(s: NetSample): Decision {
    this.n++;
    const budget = typeof s.availableOut === 'number' && s.availableOut > 0 ? s.availableOut : null;
    const rtt = typeof s.rtt === 'number' ? s.rtt : null;
    const loss = Math.max(0, Math.min(1, s.loss || 0));
    const cpu = s.limitation === 'cpu';
    const ceiling = this.cfg.ceiling;

    // ---------------------------------------------------------------- video: pressure to go down
    let target: Tier = this.tier;
    let why: QualityReason | null = null;
    let dire = false;
    if (budget !== null && this.tier < PAUSED) {
      const stay = fit(budget, STAY);
      if (stay > target) { target = stay; why = 'bandwidth'; }
      if (budget < STAY[this.tier]! * 0.5) dire = true;
    }
    if (loss >= 0.25) { target = PAUSED; why = 'loss'; dire = loss >= 0.35; }
    else if (loss >= 0.10 && this.tier < PAUSED) { if (this.tier + 1 > target) { target = (this.tier + 1) as Tier; why = 'loss'; } }
    if (rtt !== null && rtt >= 1.0 && this.tier < PAUSED && this.tier + 1 > target) { target = (this.tier + 1) as Tier; why = 'latency'; }
    if (cpu && this.tier < 2 && this.tier + 1 > target) { target = (this.tier + 1) as Tier; why = 'cpu'; }

    if (target > this.tier) {
      this.down++;
      this.up = 0;
      if (this.down >= DOWN_HOLD || dire) {
        // An upgrade that didn't hold: make the next one wait twice as long.
        if (this.upHold < UP_HOLD) this.upHold = UP_HOLD;
        else if (this.n - this.lastUpAt <= 3 * DOWN_HOLD) this.upHold = Math.min(MAX_UP_HOLD, this.upHold * 2);
        this.pushedFrom ??= this.tier;
        this.tier = target;
        this.down = 0;
        this.lastDownAt = this.n;
      }
    } else {
      this.down = 0;
      // ------------------------------------------------------------ video: earn the way back up
      if (this.tier > ceiling) {
        const next = (this.tier - 1) as Tier;
        const calm = loss < 0.03 && (rtt === null || rtt < 0.6) && !cpu;
        // From paused, the estimate can't grow (almost nothing is sent), so a calm link earns a probe of
        // the lowest tier with a lower bar; elsewhere the budget must clearly fit the next tier.
        const allocated = this.tier < PAUSED ? TIERS[this.tier]!.maxBitrate + this.audioBitrate : 0;
        const room = budget === null || budget >= ENTER[next]! || (this.tier === PAUSED && budget >= STAY[2])
          || (this.tier < PAUSED && budget >= HEADROOM * allocated && budget >= STAY[next]!);
        if (calm && room) {
          this.up++;
          if (this.up >= this.upHold) { this.tier = next; this.up = 0; this.lastUpAt = this.n; }
        } else this.up = 0;
      } else this.up = 0;
      // A long calm spell forgives earlier failed upgrades.
      if (this.n - this.lastDownAt > 60 && this.upHold > UP_HOLD) { this.upHold = Math.max(UP_HOLD, this.upHold / 2); this.lastDownAt = this.n; }
    }
    if (this.tier < ceiling) this.tier = ceiling;
    if (this.pushedFrom !== null && this.tier <= Math.max(this.pushedFrom, ceiling)) this.pushedFrom = null;
    const pushed = this.pushedFrom !== null;

    // ---------------------------------------------------------------- audio
    let want = audioFor(budget);
    if (this.cfg.saver) want = Math.min(want, SAVER_AUDIO);
    if (want < this.audioBitrate) {
      this.audioUp = 0;
      if (++this.audioDown >= DOWN_HOLD || (budget !== null && budget < 40_000)) { this.audioBitrate = want; this.audioDown = 0; }
    } else if (want > this.audioBitrate) {
      this.audioDown = 0;
      if (++this.audioUp >= UP_HOLD) {
        const i = AUDIO_STEPS.indexOf(this.audioBitrate as (typeof AUDIO_STEPS)[number]);
        this.audioBitrate = i > 0 ? Math.min(want, AUDIO_STEPS[i - 1]!) : want;
        this.audioUp = 0;
      }
    } else { this.audioDown = 0; this.audioUp = 0; }

    // ---------------------------------------------------------------- RED (audio redundancy)
    // Sends each audio frame twice (≈ double the audio bitrate) so a single lost packet costs nothing.
    // Worth it under real loss when there is room; data saver allows it only when loss is heavy.
    const redLoss = this.cfg.saver ? 0.15 : 0.08;
    const redRoom = budget === null || budget >= 3 * this.audioBitrate;
    if (!this.red) {
      if (loss >= redLoss && redRoom) { if (++this.redOn >= DOWN_HOLD) { this.red = true; this.redOn = 0; } } else this.redOn = 0;
    } else {
      if (loss < 0.03 || !redRoom) { if (++this.redOff >= UP_HOLD || !redRoom) { this.red = false; this.redOff = 0; } } else this.redOff = 0;
    }

    // ---------------------------------------------------------------- what the bars show
    const inLoss = Math.max(0, Math.min(1, s.inLoss ?? 0));
    const worstLoss = Math.max(loss, inLoss);
    let q: Quality = 'good';
    let r: QualityReason | null = null;
    const bump = (to: Quality, reason: QualityReason) => {
      if (to === 'poor' && q !== 'poor') { q = 'poor'; r = reason; } else if (to === 'fair' && q === 'good') { q = 'fair'; r = reason; }
    };
    if (worstLoss >= 0.10) bump('poor', 'loss'); else if (worstLoss >= 0.03) bump('fair', 'loss');
    if (rtt !== null) { if (rtt >= 1.0) bump('poor', 'latency'); else if (rtt >= 0.4) bump('fair', 'latency'); }
    if (budget !== null) { if (budget < 60_000) bump('poor', 'bandwidth'); else if (budget < 200_000) bump('fair', 'bandwidth'); }
    if (pushed && this.tier === PAUSED) bump('poor', why ?? this.reason ?? 'bandwidth');
    else if (pushed) bump('fair', why ?? this.reason ?? 'bandwidth');
    if (cpu) bump('fair', 'cpu');
    // Show a change only once it has been seen twice in a row (no flicker), except the very first sample.
    if (this.n === 1) { this.quality = q; this.reason = r; this.qCand = q; this.qCount = 0; }
    else if (q === this.quality) { this.reason = r ?? this.reason; this.qCount = 0; }
    else if (q === this.qCand) { if (++this.qCount >= 1) { this.quality = q; this.reason = r; this.qCount = 0; } }
    else { this.qCand = q; this.qCount = 0; }
    if (this.quality === 'good') this.reason = null;

    return this.decision();
  }
}

/** Encoding parameters for a video tier, given the capture height. */
export function videoEncoding(tier: Tier, captureHeight: number, budget: number | null): { active: boolean; scaleResolutionDownBy: number; maxBitrate: number; maxFramerate: number } {
  if (tier === PAUSED) return { active: false, scaleResolutionDownBy: 1, maxBitrate: TIERS[2]!.maxBitrate, maxFramerate: TIERS[2]!.fps };
  const spec = TIERS[tier]!;
  const h = captureHeight > 0 ? captureHeight : spec.height;
  const scale = Math.max(1, Math.round((h / spec.height) * 100) / 100);
  // Never ask for more than ~85 % of what the link can carry (the rest is audio, headers, retransmits).
  const cap = budget ? Math.max(STAY[tier]! * 0.8, Math.floor(budget * 0.85)) : spec.maxBitrate;
  return { active: true, scaleResolutionDownBy: scale, maxBitrate: Math.round(Math.min(spec.maxBitrate, cap)), maxFramerate: spec.fps };
}

/**
 * Fraction of my packets lost on the way to them since the previous sample. Audio is the honest signal (it
 * is always flowing and not retransmitted); video only counts when it actually sent enough packets, and
 * a kind with no new receiver report this round (lost counter unchanged, few packets) counts as clean.
 */
export function deltaLoss(sent: Record<string, number>, lost: Record<string, number>, pSent: Record<string, number>, pLost: Record<string, number>): number {
  let worst = 0;
  for (const kind of ['audio', 'video']) {
    const ds = (sent[kind] ?? 0) - (pSent[kind] ?? 0);
    const dl = (lost[kind] ?? 0) - (pLost[kind] ?? 0);
    if (ds < (kind === 'audio' ? 20 : 40) || dl <= 0) continue;
    worst = Math.max(worst, Math.min(1, dl / (ds + dl)));
  }
  return worst;
}
