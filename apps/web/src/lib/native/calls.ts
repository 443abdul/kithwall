'use client';
// Call hooks for the native app (docs/v2/05-native.md §5, "Calls"). The call UI (components/calls/**) calls
// these when a call connects, when the person switches speaker/earpiece, and when it ends. In a browser
// they do nothing. Android: keeps the screen on, switches to voice-call audio (echo cancellation, volume
// keys control call volume, Bluetooth headsets), routes to the speaker or earpiece (a headset always wins)
// and shows a "call in progress" notification so the microphone/camera keep working in other apps.
import { isNative, nativePlatform, nativePlugin } from './index';

/**
 * A call is now connected (or its route changed). `speaker`: true for speaker (video calls, speaker button),
 * false for the earpiece. `video`: the camera is in use (keeps it working while the person uses another app).
 */
export async function nativeCallActive(opts: { speaker: boolean; video: boolean }): Promise<void> {
  if (!isNative() || nativePlatform() !== 'android') return;
  try { await (await nativePlugin('KithwallShell')).setCallAudio({ active: true, speaker: opts.speaker, video: opts.video }); } catch { /* older app build */ }
}

/**
 * This device stopped ringing for a call in this conversation (answered here or elsewhere, declined,
 * cancelled, timed out): take down the incoming-call notification and screen the push may have shown
 * (KithwallPush.cancelCall, newer app builds). Safe to call when there is none.
 */
export async function nativeCallRingEnded(convId: string): Promise<void> {
  if (!isNative() || nativePlatform() !== 'android') return;
  try {
    const p = await nativePlugin('KithwallPush');
    if (typeof p.cancelCall === 'function') await p.cancelCall({ conv: convId });
  } catch { /* older app build */ }
}

/** "Decline" on the native incoming-call notification while the page is running (in the background). */
export async function onNativeCallAction(fn: (a: { action: 'decline'; conv: string; call: string }) => void): Promise<() => void> {
  if (!isNative() || nativePlatform() !== 'android') return () => undefined;
  const h = await (await nativePlugin('KithwallPush')).addListener('call', (e) => {
    if (e?.action === 'decline' && typeof e.conv === 'string' && typeof e.call === 'string') fn({ action: 'decline', conv: e.conv, call: e.call });
  });
  return () => { void h.remove(); };
}

/** The call ended (or failed): normal audio, the screen may turn off again. Safe to call more than once. */
export async function nativeCallEnded(): Promise<void> {
  if (!isNative() || nativePlatform() !== 'android') return;
  try { await (await nativePlugin('KithwallShell')).setCallAudio({ active: false }); } catch { /* older app build */ }
}
