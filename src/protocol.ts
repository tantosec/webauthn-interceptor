import {
    isPageInterceptorEvent,
    isRecord,
    isUiDecisionEvent,
    isWebAuthnRequestId,
    WebAuthnInterceptorEventPayload,
    UiDecision,
} from './common_types';

export type RequestState = 'editing' | 'selecting' | 'native' | 'remote' | 'returning';
export interface CredentialEntry {
    credentialId: string;
    userHandle?: string;
    creationDate?: string | number;
}

type RequestId = { requestId: string };
interface BackgroundPayloads {
    WEBAUTHN_INTERCEPTOR_REQUEST_FROM_CONTENT: WebAuthnInterceptorEventPayload;
    WEBAUTHN_INTERCEPTOR_FINISHED: RequestId;
    GET_INTERCEPTOR_PAYLOAD: RequestId;
    WEBAUTHN_UI_DECISION: UiDecision;
    CLOSE_INTERCEPTOR_UI: RequestId;
    CANCEL_WEBAUTHN_FROM_SELECTOR: RequestId;
    QUERY_BAD_AUTHENTICATOR: RequestId & { requestData: Record<string, unknown> };
    FETCH_CREDENTIALS_FOR_RPID: RequestId;
    CREDENTIAL_SELECTED: RequestId & { selectedCredentialId: string };
}
export type BackgroundMessage = {
    [K in keyof BackgroundPayloads]: { type: K; payload: BackgroundPayloads[K] };
}[keyof BackgroundPayloads];
type Ack = { ok: true };
export type BackgroundReplies = {
    [K in keyof BackgroundPayloads]: K extends 'GET_INTERCEPTOR_PAYLOAD'
        ? { event: WebAuthnInterceptorEventPayload; state: RequestState }
        : K extends 'FETCH_CREDENTIALS_FOR_RPID'
          ? { credentials: CredentialEntry[]; rpid: string }
          : Ack;
};
export type ContentMessage =
    | { type: 'WEBAUTHN_INTERCEPTOR_SHOW_UI'; payload: WebAuthnInterceptorEventPayload & { version: string } }
    | {
          type: 'WEBAUTHN_INTERCEPTOR_EXTENSION_RESPONSE_TO_PAGE';
          payload: UiDecision & { attemptId?: string };
      }
    | {
          type:
              | 'WEBAUTHN_INTERCEPTOR_CLOSE_UI'
              | 'SHOW_CREDENTIAL_SELECTOR_UI'
              | 'CLOSE_CREDENTIAL_SELECTOR_UI'
              | 'GET_ACTIVE_REQUEST';
          payload: RequestId;
      };
export interface ActiveRequest {
    event: WebAuthnInterceptorEventPayload;
    panelVersion?: string;
    hasSelector: boolean;
    attemptId?: string;
    awaitingResponse: boolean;
}

export function isRequestState(value: unknown): value is RequestState {
    return (
        value === 'editing' ||
        value === 'selecting' ||
        value === 'native' ||
        value === 'remote' ||
        value === 'returning'
    );
}
export function isCredentialEntry(value: unknown): value is CredentialEntry {
    return (
        isRecord(value) &&
        typeof value.credentialId === 'string' &&
        (value.userHandle === undefined || typeof value.userHandle === 'string') &&
        (value.creationDate === undefined ||
            typeof value.creationDate === 'string' ||
            typeof value.creationDate === 'number')
    );
}
export function isBackgroundMessage(value: unknown): value is BackgroundMessage {
    if (!isRecord(value) || !isRecord(value.payload) || !isWebAuthnRequestId(value.payload.requestId))
        return false;
    switch (value.type) {
        case 'WEBAUTHN_INTERCEPTOR_REQUEST_FROM_CONTENT':
            return isPageInterceptorEvent(value.payload);
        case 'WEBAUTHN_UI_DECISION':
            return isUiDecisionEvent(value.payload);
        case 'QUERY_BAD_AUTHENTICATOR':
            return isRecord(value.payload.requestData);
        case 'CREDENTIAL_SELECTED':
            return (
                typeof value.payload.selectedCredentialId === 'string' &&
                value.payload.selectedCredentialId.length > 0
            );
        case 'WEBAUTHN_INTERCEPTOR_FINISHED':
        case 'GET_INTERCEPTOR_PAYLOAD':
        case 'CLOSE_INTERCEPTOR_UI':
        case 'CANCEL_WEBAUTHN_FROM_SELECTOR':
        case 'FETCH_CREDENTIALS_FOR_RPID':
            return true;
        default:
            return false;
    }
}
export function isContentMessage(value: unknown): value is ContentMessage {
    if (!isRecord(value) || !isRecord(value.payload) || !isWebAuthnRequestId(value.payload.requestId))
        return false;
    switch (value.type) {
        case 'WEBAUTHN_INTERCEPTOR_SHOW_UI':
            return typeof value.payload.version === 'string' && isPageInterceptorEvent(value.payload);
        case 'WEBAUTHN_INTERCEPTOR_EXTENSION_RESPONSE_TO_PAGE':
            return (
                (value.payload.attemptId === undefined || typeof value.payload.attemptId === 'string') &&
                isUiDecisionEvent(value.payload)
            );
        case 'WEBAUTHN_INTERCEPTOR_CLOSE_UI':
        case 'SHOW_CREDENTIAL_SELECTOR_UI':
        case 'CLOSE_CREDENTIAL_SELECTOR_UI':
        case 'GET_ACTIVE_REQUEST':
            return true;
        default:
            return false;
    }
}
function isReply<K extends BackgroundMessage['type']>(
    type: K,
    value: unknown,
): value is BackgroundReplies[K] {
    if (!isRecord(value)) return false;
    if (type === 'GET_INTERCEPTOR_PAYLOAD')
        return isPageInterceptorEvent(value.event) && isRequestState(value.state);
    if (type === 'FETCH_CREDENTIALS_FOR_RPID')
        return (
            typeof value.rpid === 'string' &&
            Array.isArray(value.credentials) &&
            value.credentials.every(isCredentialEntry)
        );
    return value.ok === true;
}
export class WorkerConnectionError extends Error {}
export async function sendBackground<M extends BackgroundMessage>(
    message: M,
): Promise<BackgroundReplies[M['type']]> {
    let result: unknown;
    try {
        result = await chrome.runtime.sendMessage(message);
    } catch (error) {
        throw new WorkerConnectionError(error instanceof Error ? error.message : String(error));
    }
    if (isRecord(result) && typeof result.error === 'string') throw new Error(result.error);
    if (!isReply<M['type']>(message.type, result))
        throw new Error('Invalid reply from the extension worker.');
    return result;
}
export function panelRequestId(): string {
    const value = new URLSearchParams(location.search).get('requestId');
    if (!isWebAuthnRequestId(value)) throw new Error('Missing or invalid request ID.');
    return value;
}
export function dismissPanel(): void {
    window.parent.postMessage({ type: 'WEBAUTHN_INTERCEPTOR_UI_CLOSE_PANEL' }, '*');
}
