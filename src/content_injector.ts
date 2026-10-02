import {
    isPageInterceptorEvent,
    isRecord,
    isWebAuthnRequestId,
    WebAuthnInterceptorEventPayload,
} from './common_types';
import { ActiveRequest, isContentMessage, sendBackground, WorkerConnectionError } from './protocol';

const storageKey = 'request_interceptorEnabled';
let enabled = true;
function updateEnabled(): void {
    if (document.documentElement)
        document.documentElement.dataset.requestInterceptorEnabled = String(enabled);
}
void chrome.storage.local.get(storageKey).then((config) => {
    enabled = config[storageKey] !== false;
    updateEnabled();
});
if (!document.documentElement) {
    const observer = new MutationObserver(() => {
        if (document.documentElement) {
            updateEnabled();
            observer.disconnect();
        }
    });
    observer.observe(document, { childList: true });
}
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[storageKey]) {
        enabled = changes[storageKey].newValue !== false;
        updateEnabled();
    }
});

const active = new Map<string, ActiveRequest>();
const queue = new Map<string, WebAuthnInterceptorEventPayload & { version: string }>();
let currentId: string | undefined;
let modal: HTMLIFrameElement | undefined;
let selector: HTMLIFrameElement | undefined;

function frame(path: string, requestId: string, kind: 'modal' | 'selector'): HTMLIFrameElement {
    const iframe = document.createElement('iframe');
    const url = new URL(chrome.runtime.getURL(path));
    // Keep request JSON and server configuration out of the page-readable URL.
    url.searchParams.set('requestId', requestId);
    iframe.src = url.href;
    iframe.id = kind === 'modal' ? 'webauthn-interceptor-iframe' : 'webauthn-credential-selector';
    iframe.title = kind === 'modal' ? 'WebAuthn Interceptor' : 'Select a credential';
    iframe.allow = 'clipboard-write';
    Object.assign(iframe.style, {
        position: 'fixed',
        top: 'clamp(8px, 2vh, 16px)',
        [kind === 'modal' ? 'right' : 'left']: 'clamp(8px, 2vw, 16px)',
        width: `min(${kind === 'modal' ? 560 : 420}px, calc(100% - 24px))`,
        height: `min(${kind === 'modal' ? 760 : 520}px, calc(100vh - 24px))`,
        zIndex: kind === 'modal' ? '2147483646' : '2147483647',
        border: '1px solid #dc2626',
        borderRadius: '8px',
        boxShadow: '0 5px 20px rgba(0,0,0,0.2)',
        backgroundColor: '#fff',
    });
    (document.body ?? document.documentElement).appendChild(iframe);
    return iframe;
}

function showNext(): void {
    currentId = queue.keys().next().value;
    if (currentId) modal = frame('ui/interceptor-modal.html', currentId, 'modal');
}

function close(requestId: string): void {
    queue.delete(requestId);
    if (currentId !== requestId) return;
    modal?.remove();
    selector?.remove();
    modal = selector = undefined;
    showNext();
}

async function sendPageEvent(payload: WebAuthnInterceptorEventPayload): Promise<void> {
    const message = { type: 'WEBAUTHN_INTERCEPTOR_REQUEST_FROM_CONTENT', payload } as const;
    try {
        await sendBackground(message);
    } catch (error) {
        if (!(error instanceof WorkerConnectionError)) throw error;
        await sendBackground(message);
    }
}

window.addEventListener('message', (event) => {
    if (
        (event.source === modal?.contentWindow || event.source === selector?.contentWindow) &&
        event.origin === new URL(chrome.runtime.getURL('')).origin &&
        isRecord(event.data) &&
        event.data.type === 'WEBAUTHN_INTERCEPTOR_UI_CLOSE_PANEL' &&
        currentId
    ) {
        window.postMessage(
            {
                type: 'WEBAUTHN_INTERCEPTOR_PAGE_RESPONSE',
                payload: { requestId: currentId, action: 'cancel' },
            },
            window.location.origin,
        );
        close(currentId);
        return;
    }
    if (event.source !== window || !isRecord(event.data)) return;
    const { type, payload, requestId } = event.data;
    if (type === 'WEBAUTHN_INTERCEPTOR_FINISHED' && isWebAuthnRequestId(requestId)) {
        active.delete(requestId);
        close(requestId);
        void sendBackground({ type, payload: { requestId } }).catch(() => {});
    } else if (type === 'WEBAUTHN_INTERCEPTOR_EVENT' && isPageInterceptorEvent(payload)) {
        const previous = active.get(payload.requestId);
        active.set(payload.requestId, {
            event: payload,
            hasSelector: false,
            attemptId: previous?.attemptId,
            awaitingResponse: false,
        });
        void sendPageEvent(payload).catch((error) => {
            console.warn('WebAuthn Interceptor could not forward the event to its worker.', error);
            window.postMessage(
                {
                    type: 'WEBAUTHN_INTERCEPTOR_PAGE_RESPONSE',
                    payload: { requestId: payload.requestId, action: 'cancel' },
                },
                window.location.origin,
            );
        });
    }
});

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (!isContentMessage(message)) return false;
    const requestId = message.payload.requestId;
    const current = active.get(requestId);
    if (message.type === 'GET_ACTIVE_REQUEST') {
        respond(
            current
                ? {
                      ...current,
                      panelVersion: queue.get(requestId)?.version,
                      hasSelector: currentId === requestId && !!selector,
                  }
                : { missing: true },
        );
        return false;
    }
    switch (message.type) {
        case 'WEBAUTHN_INTERCEPTOR_SHOW_UI':
            if (!current) break;
            queue.set(requestId, message.payload);
            if (!currentId) showNext();
            else if (currentId === requestId) {
                modal?.remove();
                modal = frame('ui/interceptor-modal.html', currentId, 'modal');
            }
            break;
        case 'WEBAUTHN_INTERCEPTOR_EXTENSION_RESPONSE_TO_PAGE':
            if (!current) break;
            if (message.payload.action === 'proceed') {
                if (message.payload.attemptId && current.attemptId === message.payload.attemptId) break;
                current.attemptId = message.payload.attemptId;
                current.awaitingResponse = true;
            }
            window.postMessage(
                { type: 'WEBAUTHN_INTERCEPTOR_PAGE_RESPONSE', payload: message.payload },
                window.location.origin,
            );
            break;
        case 'WEBAUTHN_INTERCEPTOR_CLOSE_UI':
            close(requestId);
            break;
        case 'SHOW_CREDENTIAL_SELECTOR_UI':
            if (requestId === currentId) {
                selector?.remove();
                selector = frame('ui/credential-selector.html', currentId, 'selector');
            }
            break;
        case 'CLOSE_CREDENTIAL_SELECTOR_UI':
            if (requestId === currentId) {
                selector?.remove();
                selector = undefined;
            }
            break;
        default:
            return false;
    }
    respond({ ok: true });
    return false;
});

window.addEventListener('pagehide', () => {
    for (const requestId of active.keys()) {
        void sendBackground({ type: 'WEBAUTHN_INTERCEPTOR_FINISHED', payload: { requestId } }).catch(
            () => {},
        );
        close(requestId);
    }
    active.clear();
});
