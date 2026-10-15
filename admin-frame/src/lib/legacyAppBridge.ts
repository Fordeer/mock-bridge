import { adminRouteForApp } from "./appRoute";
import { postToEmbeddedApp } from "./embeddedFrame";
import { useLoadingFeatureStore } from "../store/features/loading";
import { useToastFeatureStore } from "../store/features/toast";
import { create } from "zustand";

/**
 * App Bridge v3 (`@shopify/app-bridge/actions`) messages from the embedded app:
 * `{ type: 'dispatch', payload: { type: 'APP::…', payload }, source }`.
 * The iframe side (app-bridge/src/features/legacy-v3.ts) makes sure they reach us.
 */
type LegacyAction = {
  type: string;
  payload?: Record<string, any>;
};

type LegacyContext = {
  clientId: string;
  shop: string;
  /** Post a v3 message back to the frame that sent the action. */
  reply: (message: unknown) => void;
  getSessionToken: () => Promise<string>;
};

/** `app.getState()` from v3 waits for a `getState` reply; the mock has no state. */
export function isLegacyGetState(data: unknown) {
  return Boolean(data && typeof data === 'object' && (data as { type?: unknown }).type === 'getState');
}

/** v3 Modal.create(app, { title, message, footer }) — message modals only (no url/path). */
export type LegacyModalButton = {
  id: string;
  label: string;
  disabled?: boolean;
  loading?: boolean;
  style?: string;
};

export type LegacyModal = {
  id: string;
  title?: string;
  message?: string;
  size?: string;
  primary?: LegacyModalButton;
  secondary: LegacyModalButton[];
};

function toLegacyModal(payload: Record<string, any>, previous?: LegacyModal): LegacyModal {
  const buttons = payload.footer?.buttons;
  return {
    id: String(payload.id),
    title: payload.title ?? previous?.title,
    message: payload.message ?? previous?.message,
    size: payload.size ?? previous?.size,
    primary: buttons ? buttons.primary : previous?.primary,
    secondary: buttons ? (Array.isArray(buttons.secondary) ? buttons.secondary : []) : previous?.secondary ?? [],
  };
}

export const useLegacyModalStore = create<{ modals: LegacyModal[] }>(() => ({ modals: [] }));

function setModals(update: (modals: LegacyModal[]) => LegacyModal[]) {
  useLegacyModalStore.setState(state => ({ modals: update(state.modals) }));
}

/** Footer button pressed in the admin → the app's Button CLICK subscription. */
export function clickLegacyModalButton(buttonId: string) {
  postToEmbeddedApp({
    type: 'dispatch',
    payload: { type: 'APP::MODAL::FOOTER::BUTTON::CLICK', group: 'Modal', payload: { id: buttonId } },
  });
}

/** Admin close (X / backdrop) → app Modal CLOSE subscription, then hide. */
export function closeLegacyModalFromAdmin(modalId: string) {
  postToEmbeddedApp({
    type: 'dispatch',
    payload: { type: 'APP::MODAL::CLOSE', group: 'Modal', payload: { id: modalId } },
  });
  setModals(modals => modals.filter(modal => modal.id !== modalId));
}

export function isLegacyDispatch(data: unknown): data is { type: 'dispatch'; payload: LegacyAction } {
  if (!data || typeof data !== 'object') return false;
  const message = data as { type?: unknown; payload?: { type?: unknown } };
  return message.type === 'dispatch' && typeof message.payload?.type === 'string' && message.payload.type.startsWith('APP::');
}

const IGNORED = new Set([
  // Handshake sent by createApp(); nothing to answer.
  'APP::CLIENT::INITIALIZE',
  // The iframe already reports its own location (nav-menu) → admin URL sync.
  'APP::NAVIGATION::HISTORY::PUSH',
  'APP::NAVIGATION::HISTORY::REPLACE',
  // No admin chrome to hide in the mock.
  'APP::FULLSCREEN::ENTER',
  'APP::FULLSCREEN::EXIT',
]);

/**
 * `/admin/charges/...` served by this mock-bridge (127.0.0.1 vs localhost and
 * http/https from app-side normalisation do not matter) → same-origin URL.
 */
function mockChargeUrl(raw: string) {
  try {
    const url = new URL(raw);
    if (!url.pathname.startsWith('/admin/charges/')) return null;
    // Same mock admin: this host (also behind a tunnel), or a local alias of it.
    const sameHost = url.host === window.location.host;
    const localAlias = ['localhost', '127.0.0.1'].includes(url.hostname) && url.port === window.location.port;
    if (!sameHost && !localAlias) return null;
    return `${window.location.origin}${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

export function handleLegacyAction(action: LegacyAction, context: LegacyContext) {
  const payload = action.payload ?? {};

  switch (action.type) {
    // @shopify/app-bridge-utils getSessionToken(app) → SessionToken.request().
    case 'APP::SESSION_TOKEN::REQUEST':
      context.getSessionToken()
        .then(sessionToken => sessionToken, () => '')
        .then(sessionToken => context.reply({
          type: 'dispatch',
          payload: {
            type: 'APP::SESSION_TOKEN::RESPOND',
            group: 'SessionToken',
            payload: { sessionToken },
          },
        }));
      return;

    case 'APP::NAVIGATION::REDIRECT::APP': {
      const path = typeof payload.path === 'string' ? payload.path : '/';
      if (payload.newContext) {
        window.open(adminRouteForApp(context.clientId, path), '_blank', 'noopener');
      } else {
        postToEmbeddedApp({ type: 'MOCK_NAVIGATE', path: path.startsWith('/') ? path : `/${path}` });
      }
      return;
    }

    case 'APP::NAVIGATION::REDIRECT::REMOTE': {
      if (typeof payload.url !== 'string') return;
      // Mock billing confirmation page (confirmationUrl from /mock-billing):
      // Shopify shows it in place of the admin, so stay in this tab.
      const mockCharge = mockChargeUrl(payload.url);
      if (mockCharge && !payload.newContext) {
        window.location.assign(mockCharge);
        return;
      }
      // Shopify navigates the whole admin (top window) unless newContext. In the
      // mock that would drop the debug session (e.g. reauth /login can never
      // finish against a mock app), so always use a new tab and log it.
      if (!payload.newContext) {
        console.info('[MockAdmin] v3 remote redirect (Shopify: same tab) → new tab:', payload.url);
      }
      window.open(payload.url, '_blank', 'noopener');
      return;
    }

    case 'APP::NAVIGATION::REDIRECT::ADMIN::PATH':
    case 'APP::NAVIGATION::REDIRECT::ADMIN::SECTION': {
      // The mock has no admin pages: open the real store admin instead.
      const path = typeof payload.path === 'string'
        ? payload.path
        : `/${payload.section?.name ?? ''}${payload.section?.resource?.id ? `/${payload.section.resource.id}` : ''}`;
      const url = `https://${context.shop}/admin${path.startsWith('/') ? path : `/${path}`}`;
      console.info('[MockAdmin] v3 admin redirect → new tab:', url);
      window.open(url, '_blank', 'noopener');
      return;
    }

    case 'APP::TOAST::SHOW':
      useToastFeatureStore.getState().show({
        id: String(payload.id ?? `legacy-toast-${Date.now()}`),
        message: String(payload.message ?? ''),
        duration: typeof payload.duration === 'number' ? payload.duration : undefined,
        isError: Boolean(payload.isError),
      });
      return;

    case 'APP::TOAST::CLEAR':
      if (payload.id) useToastFeatureStore.getState().hide({ id: String(payload.id) });
      return;

    case 'APP::MODAL::OPEN':
      if (payload.url || payload.path) {
        console.warn('[MockAdmin] App Bridge v3 iframe modal (url/path) not supported by mock-bridge:', payload);
        return;
      }
      setModals(modals => [...modals.filter(modal => modal.id !== String(payload.id)), toLegacyModal(payload)]);
      return;

    case 'APP::MODAL::UPDATE':
      setModals(modals => modals.map(modal => (modal.id === String(payload.id) ? toLegacyModal(payload, modal) : modal)));
      return;

    case 'APP::MODAL::CLOSE':
      setModals(modals => (payload.id ? modals.filter(modal => modal.id !== String(payload.id)) : []));
      return;

    case 'APP::MODAL::FOOTER::BUTTON::UPDATE':
    case 'APP::BUTTON::UPDATE': {
      const update = (button?: LegacyModalButton) => (button && button.id === payload.id ? { ...button, ...payload } : button);
      setModals(modals => modals.map(modal => ({
        ...modal,
        primary: update(modal.primary),
        secondary: modal.secondary.map(button => update(button)!),
      })));
      return;
    }

    case 'APP::LOADING::START':
      useLoadingFeatureStore.getState().setLoading({ isLoading: true });
      return;

    case 'APP::LOADING::STOP':
      useLoadingFeatureStore.getState().setLoading({ isLoading: false });
      return;

    default:
      // Web vitals are metrics only; Shopify collects them, the mock does not.
      if (!IGNORED.has(action.type) && !action.type.startsWith('APP::WEB_VITALS::')) {
        console.warn('[MockAdmin] App Bridge v3 action not supported by mock-bridge:', action.type, payload);
      }
  }
}
