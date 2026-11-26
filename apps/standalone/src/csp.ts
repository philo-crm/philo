/**
 * The Content-Security-Policy the PWA shell is served with. ADR-0006 keeps the
 * refresh token in `localStorage` and counts on this policy, together with the
 * absence of third-party script, to bound what an injected script could reach.
 *
 * Built once at startup, from config, as directive lists and then serialized,
 * so anything that later widens one directive (an extra origin) adds to a list
 * instead of editing a string. Every source here was checked against the real
 * build (`apps/web/dist`): one module script and one stylesheet under
 * `/assets`, no inline script or style, no `data:` or `blob:` subresource, no
 * web font, no worker but the service worker, no frame but the email preview.
 */

export interface PwaContentSecurityPolicyOptions {
  /**
   * `PHILO_OIDC_ISSUER`, when an external IdP signs people in. The PWA fetches
   * its discovery document and token endpoint, so its origin joins
   * `connect-src`. The sign-in itself is a top-level navigation, which no
   * directive here restricts.
   */
  issuer?: string | undefined
  /**
   * `PHILO_WEB_CONNECT_ORIGINS`: more origins for `connect-src`, for a provider
   * whose token or revocation endpoint is not on its issuer's origin. Already
   * validated as bare origins by `loadConfig`.
   */
  connectOrigins?: readonly string[] | undefined
}

/** Directive name → its sources, in the order they are served. */
export type CspDirectives = Record<string, string[]>

export function pwaCspDirectives(options: PwaContentSecurityPolicyOptions = {}): CspDirectives {
  const connect = ["'self'"]
  const extra = [...(options.issuer === undefined ? [] : [new URL(options.issuer).origin]), ...(options.connectOrigins ?? [])]
  for (const origin of extra) if (!connect.includes(origin)) connect.push(origin)
  return {
    // Anything not named below: this origin only.
    'default-src': ["'self'"],
    // The hashed module bundle. No inline script, no eval: index.html is
    // checked for inline script by apps/web/test/csp-build.test.ts.
    'script-src': ["'self'"],
    // The hashed stylesheet. React's `style` prop would go through the CSSOM,
    // which this does not restrict; the app has no `style` attributes or
    // `<style>` elements, and the build test holds index.html to that.
    'style-src': ["'self'"],
    // The icons. Vite inlines no asset as a `data:` URI in this build.
    'img-src': ["'self'"],
    // No web fonts today; the system font stack needs no source.
    'font-src': ["'self'"],
    // The API, the built-in IdP and the live feed are all this origin; an
    // external IdP adds its issuer and any `PHILO_WEB_CONNECT_ORIGINS`.
    'connect-src': connect,
    // `/sw.js`, the service worker (push and the offline shell).
    'worker-src': ["'self'"],
    // `/manifest.webmanifest`.
    'manifest-src': ["'self'"],
    // The email template preview, the server's `/api/email-preview` page. It
    // has a policy of its own for the template's styles and images, which a
    // `srcdoc` frame here would inherit this policy and lose.
    'frame-src': ["'self'"],
    'object-src': ["'none'"],
    // A `<base>` cannot point relative URLs somewhere else.
    'base-uri': ["'self'"],
    // The PWA's forms submit through fetch; nothing posts off-origin.
    'form-action': ["'self'"],
    // No one frames the shell: clickjacking, and a frame that reads nothing.
    'frame-ancestors': ["'none'"],
  }
}

export function serializeCsp(directives: CspDirectives): string {
  return Object.entries(directives)
    .map(([name, sources]) => [name, ...sources].join(' '))
    .join('; ')
}

export function pwaContentSecurityPolicy(options: PwaContentSecurityPolicyOptions = {}): string {
  return serializeCsp(pwaCspDirectives(options))
}
