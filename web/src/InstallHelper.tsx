import { isIosSafari, isStandalone } from './install.ts'
import { Link } from './router.tsx'

/**
 * The Add-to-Home-Screen walkthrough. iOS gets step-by-step instructions
 * because Safari offers no install prompt at all and hides the action three
 * taps deep; every other browser gets pointed at its own affordance.
 */
export function InstallHelper() {
  if (isStandalone()) {
    return (
      <section className="screen">
        <h1>Install Philo</h1>
        <p className="empty">
          Philo is already installed — you are looking at the installed app. Notifications can be
          turned on from here once push lands.
        </p>
        <p>
          <Link to="/">Back to leads</Link>
        </p>
      </section>
    )
  }

  return (
    <section className="screen">
      <h1>Install Philo</h1>
      {isIosSafari() ? <IosSteps /> : <GenericSteps />}
      <p>
        <Link to="/">Back to leads</Link>
      </p>
    </section>
  )
}

function IosSteps() {
  return (
    <div className="panel">
      <p>
        On iPhone and iPad, Philo has to be added to the Home Screen before it can open full screen
        or send notifications. Safari does this from the Share menu.
      </p>
      <ol className="steps">
        <li>
          Tap <strong>Share</strong> in the Safari toolbar — the square with an arrow pointing up.
        </li>
        <li>
          Scroll down and tap <strong>Add to Home Screen</strong>.
        </li>
        <li>
          Tap <strong>Add</strong>. Philo appears on the Home Screen with the other apps.
        </li>
        <li>Open Philo from that icon from now on, and sign in once more.</li>
      </ol>
      <p className="muted">
        Notifications only reach the Home Screen app, never a Safari tab — and in the EU, Apple
        turns off web app notifications entirely.
      </p>
    </div>
  )
}

function GenericSteps() {
  return (
    <div className="panel">
      <p>
        Philo can be installed as an app on this device. Your browser offers this itself: look for
        an install icon in the address bar, or <strong>Install app</strong> /{' '}
        <strong>Add to Home screen</strong> in its menu.
      </p>
      <p className="muted">
        Installing is optional here — Philo works the same in a tab. It gets you an icon, a window
        of its own, and a place for notifications to land.
      </p>
    </div>
  )
}
