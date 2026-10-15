type EmbeddedFrameMessage = {
  type: string;
  id?: string;
  value?: string;
  checked?: boolean;
  path?: string;
  requestId?: string;
  selection?: unknown;
  /** App Bridge v3 envelope: { type: 'dispatch', payload: { type: 'APP::…', payload } } */
  payload?: unknown;
}

/** Talk to the embedded app. Clicks land on the original iframe node. */
export function postToEmbeddedApp(message: EmbeddedFrameMessage) {
  const iframe = document.getElementById('app-iframe') as HTMLIFrameElement | null;
  iframe?.contentWindow?.postMessage(message, '*');
}

export function activateEmbeddedElement(id: string) {
  postToEmbeddedApp({ type: 'MOCK_ELEMENT_CLICK', id });
}

function modalFrameName(id: string) {
  return `mock-modal-${id}`;
}

/**
 * Cross-origin bridge: modal content (app origin) cannot set window.opener to
 * the main app iframe when admin is on another port. App-bridge posts
 * MOCK_RELAY_TO_APP / MOCK_RELAY_TO_MODAL; admin forwards the payload.
 */
let modalRelayInstalled = false;

/**
 * Envelope for the receiving frame's app-bridge, which re-dispatches the inner
 * message with the sender's origin (listenForRelayedMessages). Older
 * app-bridge builds send no senderOrigin: forward the bare message as before.
 */
function relayed(data: { message: unknown; senderOrigin?: unknown }) {
  return typeof data.senderOrigin === 'string'
    ? { type: 'MOCK_RELAYED_MESSAGE', message: data.message, senderOrigin: data.senderOrigin }
    : data.message;
}

export function installModalMessageRelay() {
  if (modalRelayInstalled) return;
  modalRelayInstalled = true;

  window.addEventListener('message', (event: MessageEvent) => {
    const data = event.data;
    if (!data || typeof data !== 'object') return;

    if (data.type === 'MOCK_RELAY_TO_APP' && 'message' in data) {
      const iframe = document.getElementById('app-iframe') as HTMLIFrameElement | null;
      const targetOrigin = typeof data.targetOrigin === 'string' ? data.targetOrigin : '*';
      iframe?.contentWindow?.postMessage(relayed(data), targetOrigin);
      return;
    }

    if (data.type === 'MOCK_RELAY_TO_MODAL' && typeof data.id === 'string' && 'message' in data) {
      try {
        const frame = (window.frames as unknown as Record<string, Window>)[modalFrameName(data.id)];
        const targetOrigin = typeof data.targetOrigin === 'string' ? data.targetOrigin : '*';
        frame?.postMessage(relayed(data), targetOrigin);
      } catch (error) {
        console.warn('[MockAdmin] MOCK_RELAY_TO_MODAL failed', error);
      }
    }
  });
}
