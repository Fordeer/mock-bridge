/**
 * App Bridge v3 (`@shopify/app-bridge` createApp + `@shopify/app-bridge/actions`)
 * talks to the admin with `window.top.postMessage(message, "https://<host>")`,
 * where <host> is the decoded `host` query param (e.g. test-shop.myshopify.com).
 * The mock admin runs on http://127.0.0.1:<port>, so the browser drops every
 * v3 action (Redirect, Toast, Loading…) on the targetOrigin mismatch.
 *
 * `window.top` cannot be redefined, so instead pin the one URL v3 builds the
 * target origin from — exactly `https://<decoded host>` — to the mock admin's
 * real origin. The admin frame then handles the v3 `dispatch` messages
 * (admin-frame/src/lib/legacyAppBridge.ts).
 */
export function installLegacyV3Transport() {
  if (window.top === window.self) return;

  const adminOrigin = mockAdminOrigin();
  const decodedHost = decodedHostParam();
  if (!adminOrigin || !decodedHost) return;

  const legacyTarget = `https://${decodedHost}`;
  const NativeURL = window.URL;
  const originGetter = Object.getOwnPropertyDescriptor(NativeURL.prototype, 'origin')?.get;
  if (!originGetter) return;

  class MockAdminURL extends NativeURL {
    private readonly mockAdminTarget: boolean;

    constructor(url: string | URL, base?: string | URL) {
      super(url, base);
      this.mockAdminTarget = base === undefined && String(url) === legacyTarget;
    }

    get origin() {
      return this.mockAdminTarget ? adminOrigin! : originGetter!.call(this);
    }
  }

  window.URL = MockAdminURL as typeof URL;
}

/** Origin of the mock admin that framed us (its page URL is the referrer). */
function mockAdminOrigin() {
  try {
    const referrer = new URL(document.referrer);
    return ['localhost', '127.0.0.1'].includes(referrer.hostname) ? referrer.origin : null;
  } catch {
    return null;
  }
}

/** Same decoding as app-bridge v3 validateAndDecodeConfig. */
function decodedHostParam() {
  const host = new URLSearchParams(window.location.search).get('host');
  if (!host) return null;
  try {
    return atob(host.replace(/_/g, '/').replace(/-/g, '+'));
  } catch {
    return null;
  }
}
