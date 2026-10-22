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

/** The call ended (or failed): normal audio, the screen may turn off again. Safe to call more than once. */
export async function nativeCallEnded(): Promise<void> {
  if (!isNative() || nativePlatform() !== 'android') return;
  try { await (await nativePlugin('KithwallShell')).setCallAudio({ active: false }); } catch { /* older app build */ }
}
