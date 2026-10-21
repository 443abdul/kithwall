// Type contracts of the four app-local Capacitor plugins (apps/mobile; Android in
// android/app/src/main/java/com/kithwall/app/, iOS in ios/App/App/Kithwall*.swift). Keep in step with the
// native code: names, argument keys and error codes are part of the contract.
import type { PluginListenerHandle } from '@capacitor/core';

/**
 * Native passkeys: Android Credential Manager (androidx.credentials, API 28+), iOS AuthenticationServices
 * (iOS 16+; PRF from iOS 18). Requests and responses are WebAuthn JSON (PublicKeyCredential*OptionsJSON
 * in, RegistrationResponseJSON / AuthenticationResponseJSON out) including the `prf` extension, with
 * binary values base64url-encoded. Errors: 'cancelled', 'no_credential', 'exists', 'unsupported', 'failed'.
 */
export interface KithwallPasskeyPlugin {
  isAvailable(): Promise<{ available: boolean; prf: boolean }>;
  create(opts: { requestJson: string }): Promise<{ responseJson: string }>;
  get(opts: { requestJson: string }): Promise<{ responseJson: string }>;
}

/**
 * Hardware-backed storage: values are encrypted with a non-exportable AES-256-GCM key in the Android
 * Keystore (StrongBox when present) or kept as Keychain items (ThisDeviceOnly, never backed up or
 * synced). The `bio*` calls use a second key that only opens after a strong biometric check (the key
 * is invalidated when biometrics are re-enrolled). Errors: 'cancelled', 'unavailable', 'invalidated',
 * 'lockout', 'failed'.
 */
export interface KithwallSecurePlugin {
  get(opts: { key: string }): Promise<{ value: string | null }>;
  set(opts: { key: string; value: string }): Promise<void>;
  remove(opts: { key: string }): Promise<void>;
  /** Removes every value, both keys and the biometric item (panic wipe). */
  clear(): Promise<void>;
  biometricStatus(): Promise<{ available: boolean; enrolled: boolean; kind: 'face' | 'fingerprint' | 'iris' | 'biometric' | 'none' }>;
  bioSet(opts: { key: string; value: string; title: string; cancel: string }): Promise<void>;
  bioGet(opts: { key: string; title: string; cancel: string }): Promise<{ value: string | null }>;
  bioRemove(opts: { key: string }): Promise<void>;
}

export interface ShellInfo {
  platform: 'android' | 'ios';
  env: 'production' | 'staging';
  origin: string;
  version: string;
  build: string;
  /** Android build flavour: 'play' (FCM) or 'foss' (UnifiedPush, no Google libraries). iOS: 'ios'. */
  flavor: 'play' | 'foss' | 'ios';
}

/** The app shell: screen protection, screenshot notices, leaving the app. */
export interface KithwallShellPlugin {
  info(): Promise<ShellInfo>;
  /** Android: FLAG_SECURE (no screenshots or recordings, blank app preview). iOS: cover the app switcher snapshot. Persists across launches. */
  setSecureScreen(opts: { enabled: boolean }): Promise<void>;
  getSecureScreen(): Promise<{ enabled: boolean }>;
  /** Opens an https link in the system browser (never inside the app). */
  openExternal(opts: { url: string }): Promise<void>;
  /** Quick exit: Android removes the task from recents; iOS opens the neutral site in the browser (apps can't quit themselves). */
  exit(opts: { url: string }): Promise<void>;
  /** A screenshot (iOS; Android 14+) or screen recording started (iOS) on this device. Local notice only: nobody else is told. */
  addListener(event: 'screenshot', fn: (e: { kind: 'screenshot' | 'recording' }) => void): Promise<PluginListenerHandle>;
}

export type NativePushProvider = 'fcm' | 'apns' | 'unifiedpush';
export interface NativePushRegistration {
  provider: NativePushProvider;
  token: string;
  /** The device's P-256 public key (65-byte point, base64url) and 16-byte auth secret (base64url). */
  p256dh: string;
  auth: string;
  apnsEnv?: 'production' | 'sandbox';
}

/**
 * Native push. Payloads arrive encrypted to a key made on the device (RFC 8291); the app decrypts and
 * shows them itself. Errors: 'denied', 'no_distributor' (foss build without a UnifiedPush app),
 * 'unavailable' (no Play services / not configured), 'failed'.
 */
export interface KithwallPushPlugin {
  permission(): Promise<{ state: 'granted' | 'denied' | 'prompt' }>;
  requestPermission(): Promise<{ state: 'granted' | 'denied' | 'prompt' }>;
  /** Get (or create) this install's push address and key. May show the UnifiedPush distributor picker. */
  register(opts?: { vapid?: string }): Promise<NativePushRegistration>;
  /** What register() would return, without prompting or creating anything; {} when not registered. */
  current(): Promise<Partial<NativePushRegistration>>;
  /** Forget the token and the device key (the server row is deleted separately). */
  unregister(): Promise<void>;
  /** Mirror of the hidden-chat hashes (same format as the service worker's, lib/safety/swmirror.ts). */
  setHidden(opts: { salt: string; hashes: string[] }): Promise<void>;
  clearHidden(): Promise<void>;
  /** Remove every shown notification (lock / wipe). */
  clearNotifications(): Promise<void>;
  /**
   * A notification was tapped while the app was running (a cold start loads the path directly). Retained
   * until a listener is attached, so a tap during page load isn't lost.
   */
  addListener(event: 'open', fn: (e: { url: string }) => void): Promise<PluginListenerHandle>;
}
