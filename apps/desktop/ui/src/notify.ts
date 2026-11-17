// Native system notifications via the Tauri notification plugin. No-ops in
// the browser dev preview (only real under Tauri). macOS shows the app icon;
// we put the Human's name in the title so you know who needs you.

const isTauri =
  typeof window !== 'undefined' &&
  'isTauri' in window &&
  Boolean((window as { isTauri?: boolean }).isTauri);

let granted = false;
let checked = false;

/** Ask for notification permission once (idempotent). Call on startup. */
export async function ensureNotifyPermission(): Promise<void> {
  if (!isTauri || checked) return;
  checked = true;
  try {
    const m = await import('@tauri-apps/plugin-notification');
    granted = await m.isPermissionGranted();
    if (!granted) granted = (await m.requestPermission()) === 'granted';
  } catch {
    granted = false;
  }
}

/** Fire a notification (best-effort; silent if unavailable / not granted). */
export function notify(title: string, body: string): void {
  if (!isTauri || !granted) return;
  void import('@tauri-apps/plugin-notification')
    .then((m) => m.sendNotification({ title, body }))
    .catch(() => {
      /* plugin unavailable */
    });
}
