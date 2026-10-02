import { PublicKeyCredentialOptionsJSON, WebAuthnInterceptorEventPayload } from '../common_types';

export interface PendingRequest {
    state: 'editing' | 'native' | 'decoding';
    resolve: (value: Credential | null) => void;
    reject: (reason?: unknown) => void;
    originalOptions: CredentialCreationOptions | CredentialRequestOptions;
    operationType: 'create' | 'get';
    cleanup: () => void;
    abortNative?: () => void;
}

export type PendingRequestsMap = Map<string, PendingRequest>;

// A downstream hook may have saved our wrapper as its original function.
export interface Bypass<TOptions extends CredentialCreationOptions | CredentialRequestOptions> {
    native: (options?: TOptions) => Promise<Credential | null>;
    guard: { active: boolean };
}
export type CreateBypass = Bypass<CredentialCreationOptions>;
export type GetBypass = Bypass<CredentialRequestOptions>;

export function postEvent(payload: WebAuthnInterceptorEventPayload): void {
    window.postMessage({ type: 'WEBAUTHN_INTERCEPTOR_EVENT', payload }, window.location.origin);
}

export function closeRequest(requestId: string): void {
    window.postMessage({ type: 'WEBAUTHN_INTERCEPTOR_FINISHED', requestId }, window.location.origin);
}

export function makeCredentialOverride<T extends CredentialCreationOptions | CredentialRequestOptions>(
    operationType: 'create' | 'get',
    downstream: (options?: T) => Promise<Credential | null>,
    serialize: (options: NonNullable<T['publicKey']>) => PublicKeyCredentialOptionsJSON,
    pendingRequests: PendingRequestsMap,
    bypass: Bypass<T>,
): (options?: T) => Promise<Credential | null> {
    return async (options) => {
        if (bypass.guard.active) return bypass.native(options);
        if (!options?.publicKey || document.documentElement?.dataset.requestInterceptorEnabled === 'false') {
            return downstream(options);
        }
        options.signal?.throwIfAborted();
        const requestData = serialize(options.publicKey);
        const requestId = `req-${crypto.randomUUID()}`;
        return new Promise((resolve, reject) => {
            const abort = () => {
                const pending = pendingRequests.get(requestId);
                if (!pending) return;
                pendingRequests.delete(requestId);
                pending.cleanup();
                pending.abortNative?.();
                reject(options.signal?.reason);
                closeRequest(requestId);
            };
            pendingRequests.set(requestId, {
                state: 'editing',
                resolve,
                reject,
                originalOptions: options,
                operationType,
                cleanup: () => options.signal?.removeEventListener('abort', abort),
            });
            options.signal?.addEventListener('abort', abort, { once: true });
            postEvent({ requestId, operationType, eventType: 'request', requestData });
        });
    };
}
