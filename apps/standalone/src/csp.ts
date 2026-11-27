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
 * web font, no worker but the service worker, and no frame but the email
 * preview and, with an external IdP, the extra-token helper's hidden frame.
 *
 * Two policies come out of one config, differing only in `frame-ancestors`:
 * the shell's, which no one may frame, and the sign-in callback's, which the
 * PWA itself frames when the extra-token helper's hidden request lands there.
 */

/**
 * The sign-in callback: the redirect URI the IdP sends both the sign-in and
 * the hidden extra-token frame back to. Must match `CALLBACK_PATH` in
 * apps/web/src/auth.ts and `FIRST_PARTY_CALLBACK_PATH` on the server.
 */
export const CALLBACK_PATH = '/auth/callback'

export interface PwaContentSecurityPolicyOptions {
  /**
   * `PHILO_OIDC_ISSUER`, when an external IdP signs people in. The PWA fetches
   * its discovery document and token endpoint, so its origin joins
   * `connect-src`; the extra-token helper loads its authorize URL in a hidden
   * frame, so its origin joins `frame-src` too (ADR-0013). The sign-in itself
   * is a top-level navigation, which no directive here restricts.
   */
  issuer?: string | undefined
  /**
   * `PHILO_WEB_CONNECT_ORIGINS`: more origins for `connect-src`, for a provider
   * whose token or revocation endpoint is not on its issuer's origin. Already
   * validated as bare origins by `loadConfig`. Never added to `frame-src`:
   * they are for fetches, and nothing here frames a token endpoint.
   */
  connectOrigins?: readonly string[] | undefined
  /**
   * `PHILO_WEB_HOST_SCRIPT_URL` (ADR-0013), already validated by `loadConfig`.
   * An absolute URL joins `script-src` as that exact URL without its query,
   * not its origin; a path on this origin is already covered by `'self'`.
   */
  hostScriptUrl?: string | undefined
  /**
   * `PHILO_WEB_ASSET_ORIGINS` (ADR-0013): where the host script's own code,
   * styles and fonts come from. Already validated by `loadConfig` as origins
   * or origin-and-path-prefix sources. Each joins `script-src`, `style-src`
   * and `font-src` as given, and its origin alone joins `img-src`. Never
   * `connect-src` or `frame-src`: the host's API calls go through
   * `connectOrigins`.
   */
  assetOrigins?: readonly string[] | undefined
}

/** Directive name → its sources, in the order they are served. */
export type CspDirectives = Record<string, string[]>

/** The shell's policy and the callback's, built once at startup — see `pwaContentSecurityPolicies`. */
export interface PwaContentSecurityPolicies {
  /** Every PWA response but the callback's. */
  shell: string
  /** `CALLBACK_PATH` alone. */
  callback: string
}

export function pwaCspDirectives(options: PwaContentSecurityPolicyOptions = {}): CspDirectives {
  const issuer = options.issuer === undefined ? [] : [new URL(options.issuer).origin]
  const connect = ["'self'"]
  for (const origin of [...issuer, ...(options.connectOrigins ?? [])]) if (!connect.includes(origin)) connect.push(origin)
  const script = ["'self'"]
  if (options.hostScriptUrl !== undefined && !options.hostScriptUrl.startsWith('/')) {
    const url = new URL(options.hostScriptUrl)
    script.push(`${url.origin}${url.pathname}`)
  }
  const assets = options.assetOrigins ?? []
  const img = ["'self'"]
  for (const source of assets) {
    if (!script.includes(source)) script.push(source)
    const origin = new URL(source).origin
    if (!img.includes(origin)) img.push(origin)
  }
  return {
    // Anything not named below: this origin only.
    'default-src': ["'self'"],
    // The hashed module bundle. No inline script, no eval: index.html is
    // checked for inline script by apps/web/test/csp-build.test.ts. With an
    // operator host script on another origin, that one URL (ADR-0013).
    'script-src': script,
    // The hashed stylesheet. React's `style` prop would go through the CSSOM,
    // which this does not restrict; the app has no `style` attributes or
    // `<style>` elements, and the build test holds index.html to that. A host
    // script's stylesheets come from its asset sources.
    'style-src': ["'self'", ...assets],
    // The icons. Vite inlines no asset as a `data:` URI in this build. A host
    // script's images, by origin.
    'img-src': img,
    // No web fonts of Philo's own; the system font stack needs no source. A
    // host script's fonts come from its asset sources.
    'font-src': ["'self'", ...assets],
    // The API, the built-in IdP and the live feed are all this origin; an
    // external IdP adds its issuer and any `PHILO_WEB_CONNECT_ORIGINS`.
    'connect-src': connect,
    // `/sw.js`, the service worker (push and the offline shell).
    'worker-src': ["'self'"],
    // `/manifest.webmanifest`.
    'manifest-src': ["'self'"],
    // The email template preview, the server's `/api/email-preview` page. It
    // has a policy of its own for the template's styles and images, which a
    // `srcdoc` frame here would inherit this policy and lose. With an external
    // IdP, its issuer too: the extra-token helper's hidden frame loads the
    // issuer's authorize URL (apps/web/src/extra-token.ts).
    'frame-src': ["'self'", ...issuer],
    'object-src': ["'none'"],
    // A `<base>` cannot point relative URLs somewhere else.
    'base-uri': ["'self'"],
    // The PWA's forms submit through fetch; nothing posts off-origin.
    'form-action': ["'self'"],
    // No one frames the shell: clickjacking, and a frame that reads nothing.
    // The callback's policy relaxes this to `'self'` alone.
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

/**
 * Both policies the PWA is served with. The callback's lets the PWA's own
 * pages frame it (`frame-ancestors 'self'`): the extra-token helper's hidden
 * frame is redirected there by the IdP and posts its answer to the parent.
 * `'self'` and not more, because the callback handles an authorization code;
 * every other path keeps `'none'`.
 */
export function pwaContentSecurityPolicies(options: PwaContentSecurityPolicyOptions = {}): PwaContentSecurityPolicies {
  const directives = pwaCspDirectives(options)
  return {
    shell: serializeCsp(directives),
    callback: serializeCsp({ ...directives, 'frame-ancestors': ["'self'"] }),
  }
}
