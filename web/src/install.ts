/*
 * Whether this browser is already running Philo as an installed app, and — when
 * it is not — whether installing is something the operator has to be walked
 * through. On iOS that walkthrough is the only route: there is no install
 * prompt, and push notifications (#13) work *only* from a Home Screen web app,
 * so getting there is a prerequisite rather than a nicety (DESIGN.md).
 */

/** Chrome, Firefox, Edge and Opera on iOS: all WebKit, none able to add to the Home Screen. */
const IOS_NON_SAFARI = /CriOS|FxiOS|EdgiOS|OPiOS|Mercury/

export function isStandalone(): boolean {
  if (window.matchMedia('(display-mode: standalone)').matches) return true
  // iOS Safari predates display-mode and still answers only to this.
  return (navigator as Navigator & { standalone?: boolean }).standalone === true
}

export function isIosSafari(): boolean {
  const ua = navigator.userAgent
  // iPadOS 13+ reports a Mac user agent; the touch points are what give it away.
  const isIos = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
  return isIos && !IOS_NON_SAFARI.test(ua)
}

/**
 * Worth nudging: an iOS Safari tab that could be a Home Screen app and isn't.
 * Android and desktop browsers offer their own install affordance, so Philo
 * stays out of their way and only answers the question on the /install screen.
 */
export function shouldOfferInstall(): boolean {
  return isIosSafari() && !isStandalone()
}

const DISMISSED_KEY = 'philo.install-prompt-dismissed'

/** Storage can throw (Safari private mode, disabled cookies); a nudge is not worth a crash. */
export function isInstallPromptDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISSED_KEY) === '1'
  } catch {
    return false
  }
}

export function dismissInstallPrompt(): void {
  try {
    window.localStorage.setItem(DISMISSED_KEY, '1')
  } catch {
    // Nothing to do: the banner stays hidden for this page load either way.
  }
}
