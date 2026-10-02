import { errorMessage, isPageInterceptorEvent, isRecord, WebAuthnRequestEvent } from './common_types';
import { parseAuthenticatorUrl } from './authenticator-url';
import {
    ActiveRequest,
    BackgroundMessage,
    BackgroundReplies,
    ContentMessage,
    isBackgroundMessage,
    isCredentialEntry,
    RequestState,
} from './protocol';
import { RequestSession, RequestStore } from './request-store';

const requests = new RequestStore();
const controllers = new Map<string, AbortController>();

async function send(session: RequestSession, message: ContentMessage): Promise<unknown> {
    return chrome.tabs.sendMessage(session.tabId, message, { documentId: session.documentId });
}
async function activeRequest(session: RequestSession): Promise<ActiveRequest | undefined> {
    try {
        const result = await send(session, {
            type: 'GET_ACTIVE_REQUEST',
            payload: { requestId: session.event.requestId },
        });
        if (
            isRecord(result) &&
            isPageInterceptorEvent(result.event) &&
            result.event.requestId === session.event.requestId &&
            (result.panelVersion === undefined || typeof result.panelVersion === 'string') &&
            typeof result.hasSelector === 'boolean' &&
            typeof result.awaitingResponse === 'boolean' &&
            (result.attemptId === undefined || typeof result.attemptId === 'string')
        ) {
            return {
                event: result.event,
                panelVersion: result.panelVersion,
                hasSelector: result.hasSelector,
                awaitingResponse: result.awaitingResponse,
                attemptId: result.attemptId,
            };
        }
    } catch {
        // The document may have navigated or closed while the worker was asleep.
    }
}
async function close(session: RequestSession, cancel = false): Promise<void> {
    const requestId = session.event.requestId;
    await requests.remove(requestId);
    controllers.get(requestId)?.abort();
    controllers.delete(requestId);
    try {
        if (cancel)
            await send(session, {
                type: 'WEBAUTHN_INTERCEPTOR_EXTENSION_RESPONSE_TO_PAGE',
                payload: { requestId, action: 'cancel' },
            });
        await send(session, { type: 'WEBAUTHN_INTERCEPTOR_CLOSE_UI', payload: { requestId } });
    } catch {
        // Nothing remains to close when the owning document has gone away.
    }
}
async function show(session: RequestSession): Promise<void> {
    try {
        await send(session, {
            type: 'WEBAUTHN_INTERCEPTOR_SHOW_UI',
            payload: { ...session.event, version: session.version },
        });
    } catch {
        await close(session);
    }
}
async function deliver(session: RequestSession): Promise<void> {
    if (!isRecord(session.event.requestData)) throw new Error('Request must be a JSON object.');
    try {
        await send(session, {
            type: 'WEBAUTHN_INTERCEPTOR_EXTENSION_RESPONSE_TO_PAGE',
            payload: {
                requestId: session.event.requestId,
                action: 'proceed',
                requestData: session.event.requestData,
                responseData: session.event.responseData,
                attemptId: session.attemptId,
            },
        });
    } catch {
        await close(session);
    }
}
function requireState(session: RequestSession, state: RequestState): void {
    if (session.state !== state)
        throw new Error('This request is already in progress. Wait for the result or cancel.');
}
function owns(session: RequestSession, sender: chrome.runtime.MessageSender): boolean {
    return (
        session.tabId === sender.tab?.id &&
        session.frameId === sender.frameId &&
        session.documentId === sender.documentId
    );
}

async function recover(): Promise<void> {
    for (let session of requests.all()) {
        const active = await activeRequest(session);
        if (!active) {
            await close(session);
            continue;
        }
        if (session.state === 'remote') {
            session = {
                ...session,
                state: 'editing',
                event: {
                    ...session.event,
                    eventType: 'error',
                    errorData: {
                        name: 'InterruptedError',
                        message:
                            'The extension worker restarted during the authenticator call. It may have processed the request. Check the authenticator before retrying.',
                    },
                },
            };
            await requests.put(session);
            await send(session, {
                type: 'CLOSE_CREDENTIAL_SELECTOR_UI',
                payload: { requestId: session.event.requestId },
            });
            await show(session);
        } else if (session.state === 'native' || session.state === 'returning') {
            if (
                active.attemptId === session.attemptId &&
                !active.awaitingResponse &&
                active.event.eventType !== 'request'
            ) {
                session = {
                    ...session,
                    state: 'editing',
                    event: { ...active.event, badAuthenticatorUrl: session.event.badAuthenticatorUrl },
                };
                await requests.put(session);
                await show(session);
            } else {
                await deliver(session);
            }
        } else {
            if (active.panelVersion !== session.version) await show(session);
            if (session.state === 'editing' && active.hasSelector)
                await send(session, {
                    type: 'CLOSE_CREDENTIAL_SELECTOR_UI',
                    payload: { requestId: session.event.requestId },
                });
            if (session.state === 'selecting' && !active.hasSelector) {
                await send(session, {
                    type: 'SHOW_CREDENTIAL_SELECTOR_UI',
                    payload: { requestId: session.event.requestId },
                });
            }
        }
    }
}
void requests.run(recover).catch(console.error);
chrome.tabs.onRemoved.addListener((tabId) => {
    void requests
        .run(async () => {
            for (const session of requests.all()) if (session.tabId === tabId) await close(session);
        })
        .catch(console.error);
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (change.status !== 'loading') return;
    void requests
        .run(async () => {
            for (const session of requests.all()) {
                if (session.tabId === tabId && !(await activeRequest(session))) await close(session);
            }
        })
        .catch(console.error);
});

async function api(path: string, signal: AbortSignal, options?: unknown): Promise<unknown> {
    const config = await chrome.storage.local.get(['badAuthenticatorUrl', 'badAuthenticatorBearerToken']);
    if (!config.badAuthenticatorUrl) throw new Error('Set the badAuthenticator URL in the extension popup.');
    const url = parseAuthenticatorUrl(config.badAuthenticatorUrl);
    if (!config.badAuthenticatorBearerToken) throw new Error('Set the bearer token in the extension popup.');
    const response = await fetch(new URL(path.replace(/^\//, ''), url), {
        method: options === undefined ? 'GET' : 'POST',
        headers: {
            Authorization: `Bearer ${config.badAuthenticatorBearerToken}`,
            'Content-Type': 'application/json',
        },
        body: options === undefined ? undefined : JSON.stringify({ options }),
        signal,
    });
    if (response.status === 401)
        throw new Error('Authentication failed. Check the bearer token in the extension popup.');
    if (!response.ok)
        throw new Error(`badAuthenticator returned ${response.status}: ${await response.text()}`);
    return response.json();
}
function rpId(session: RequestSession): string {
    const data = session.event.requestData;
    return isRecord(data) && typeof data.rpId === 'string' ? data.rpId : session.defaultRpId;
}

async function query(session: RequestSession): Promise<void> {
    const controller = new AbortController();
    controllers.set(session.event.requestId, controller);
    const timeout = setTimeout(
        () => controller.abort(new Error('badAuthenticator did not respond within 25 seconds.')),
        25000,
    );
    let event = session.event;
    try {
        const responseData = await api(
            event.operationType === 'create' ? '/api/v1/attest' : '/api/v1/assert',
            controller.signal,
            event.requestData,
        );
        event = { ...event, eventType: 'response', responseData, errorData: undefined };
    } catch (error) {
        event = {
            ...event,
            eventType: 'error',
            errorData: {
                name: 'FetchError',
                message:
                    errorMessage(error) === 'Failed to fetch'
                        ? 'Could not connect to badAuthenticator. Check the server and URL.'
                        : errorMessage(error),
            },
        };
    } finally {
        clearTimeout(timeout);
        if (controllers.get(session.event.requestId) === controller)
            controllers.delete(session.event.requestId);
    }
    await requests.run(async () => {
        if (requests.get(session.event.requestId) !== session) return;
        const updated: RequestSession = { ...session, state: 'editing', event };
        await requests.put(updated);
        await send(updated, {
            type: 'CLOSE_CREDENTIAL_SELECTOR_UI',
            payload: { requestId: session.event.requestId },
        });
        await show(updated);
    });
}
async function listCredentials(
    session: RequestSession,
): Promise<BackgroundReplies['FETCH_CREDENTIALS_FOR_RPID']> {
    const id = session.event.requestId;
    if (controllers.has(id)) throw new Error('A credential list request is already running.');
    const controller = new AbortController();
    controllers.set(id, controller);
    const timeout = setTimeout(() => controller.abort(), 25000);
    try {
        const rpid = rpId(session);
        const data = await api(`/api/v1/listCredentials?rpid=${encodeURIComponent(rpid)}`, controller.signal);
        if (!isRecord(data) || !Array.isArray(data.credentials) || !data.credentials.every(isCredentialEntry))
            throw new Error('badAuthenticator returned an invalid credential list.');
        const credentials = data.credentials;
        return await requests.run(async () => {
            if (requests.get(id) !== session) throw new Error('This request has ended.');
            return { rpid, credentials };
        });
    } finally {
        clearTimeout(timeout);
        if (controllers.get(id) === controller) controllers.delete(id);
    }
}

// A deferred reply keeps network I/O out of the state queue.
interface Reply {
    value?: BackgroundReplies[BackgroundMessage['type']];
    deferred?: Promise<void | BackgroundReplies['FETCH_CREDENTIALS_FOR_RPID']>;
}
async function handle(message: BackgroundMessage, sender: chrome.runtime.MessageSender): Promise<Reply> {
    if (message.type === 'WEBAUTHN_INTERCEPTOR_REQUEST_FROM_CONTENT') {
        const payload = message.payload;
        if (sender.tab?.id === undefined || !sender.documentId || sender.frameId === undefined)
            throw new Error('Missing request document.');
        const existing = requests.get(payload.requestId);
        if (existing && !owns(existing, sender)) throw new Error('Request belongs to another document.');
        if (payload.eventType === 'request' && existing) return {};
        if (
            payload.eventType !== 'request' &&
            (!existing || (existing.state !== 'native' && existing.state !== 'returning'))
        )
            return {};
        const config = await chrome.storage.local.get('badAuthenticatorUrl');
        const session: RequestSession = {
            event: {
                ...payload,
                badAuthenticatorUrl:
                    typeof config.badAuthenticatorUrl === 'string' ? config.badAuthenticatorUrl : undefined,
            },
            tabId: sender.tab.id,
            frameId: sender.frameId,
            documentId: sender.documentId,
            defaultRpId: sender.url ? new URL(sender.url).hostname : '',
            state: 'editing',
            version: crypto.randomUUID(),
        };
        await requests.put(session);
        await show(session);
        return {};
    }
    if (message.type === 'WEBAUTHN_INTERCEPTOR_FINISHED') {
        const session = requests.get(message.payload.requestId);
        if (session && owns(session, sender)) await close(session);
        return {};
    }
    if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL('')))
        throw new Error('Unauthorised sender.');
    const requestId = message.payload.requestId;
    const session = requests.get(requestId);
    if (!session) {
        if (
            message.type === 'CLOSE_INTERCEPTOR_UI' ||
            message.type === 'CANCEL_WEBAUTHN_FROM_SELECTOR' ||
            (message.type === 'WEBAUTHN_UI_DECISION' && message.payload.action === 'cancel')
        )
            return {};
        throw new Error('This request has ended. Close the panel and try again.');
    }
    switch (message.type) {
        case 'GET_INTERCEPTOR_PAYLOAD':
            return { value: { event: session.event, state: session.state } };
        case 'WEBAUTHN_UI_DECISION': {
            const payload = message.payload;
            if (payload.action === 'cancel') {
                await close(session, true);
                return {};
            }
            requireState(session, 'editing');
            const event: WebAuthnRequestEvent = {
                ...session.event,
                eventType: 'request',
                requestData: payload.requestData,
                responseData: undefined,
                errorData: undefined,
            };
            const updated: RequestSession = {
                ...session,
                state: payload.responseData === undefined ? 'native' : 'returning',
                attemptId: crypto.randomUUID(),
                event:
                    payload.responseData === undefined
                        ? event
                        : { ...event, eventType: 'response', responseData: payload.responseData },
            };
            await requests.put(updated);
            await deliver(updated);
            return {};
        }
        case 'CLOSE_INTERCEPTOR_UI':
        case 'CANCEL_WEBAUTHN_FROM_SELECTOR':
            await close(session, true);
            return {};
        case 'QUERY_BAD_AUTHENTICATOR': {
            requireState(session, 'editing');
            const requestData = message.payload.requestData;
            const selecting =
                session.event.operationType === 'get' &&
                (!Array.isArray(requestData.allowCredentials) || !requestData.allowCredentials.length);
            const updated: RequestSession = {
                ...session,
                state: selecting ? 'selecting' : 'remote',
                event: {
                    ...session.event,
                    eventType: 'request',
                    requestData,
                    responseData: undefined,
                    errorData: undefined,
                },
            };
            await requests.put(updated);
            if (selecting) {
                await send(updated, { type: 'SHOW_CREDENTIAL_SELECTOR_UI', payload: { requestId } });
                return {};
            }
            return { deferred: query(updated) };
        }
        case 'FETCH_CREDENTIALS_FOR_RPID':
            requireState(session, 'selecting');
            return { deferred: listCredentials(session) };
        case 'CREDENTIAL_SELECTED': {
            requireState(session, 'selecting');
            if (!isRecord(session.event.requestData)) throw new Error('Request must be a JSON object.');
            const requestData = {
                ...session.event.requestData,
                rpId: rpId(session),
                allowCredentials: [{ id: message.payload.selectedCredentialId, type: 'public-key' }],
            };
            const updated: RequestSession = {
                ...session,
                state: 'remote',
                event: { ...session.event, requestData },
            };
            await requests.put(updated);
            return { deferred: query(updated) };
        }
    }
}

chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
    if (!isBackgroundMessage(message)) {
        respond({ error: 'Invalid extension message.' });
        return false;
    }
    void requests
        .run(() => handle(message, sender))
        .then(async (reply) => (reply.deferred ? await reply.deferred : reply.value) ?? { ok: true })
        .then(respond, (error) => respond({ error: errorMessage(error) }));
    return true;
});
