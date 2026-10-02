import {
    publicKeyCredentialCreationOptionsFromJSON,
    publicKeyCredentialRequestOptionsFromJSON,
    PublicKeyCredentialCreationOptionsJSON,
    PublicKeyCredentialRequestOptionsJSON,
    UiDecision,
    errorMessage,
    isUiDecisionEvent,
    isRecord,
    serializePublicKeyCredentialToJSON,
    deserializeJsonToPublicKeyCredential,
} from './common_types';
import { getCreateOverride } from './credential_overrides/create_override';
import { getGetOverride } from './credential_overrides/get_override';
import { PendingRequest, postEvent, closeRequest } from './credential_overrides/common_override_utils';
import { installGreedyCredentialOverrides } from './credential_overrides/greedy_install';

declare global {
    interface Window {
        __WEBAUTHN_INTERCEPTOR_INSTALLED?: boolean;
    }
}

if (!window.__WEBAUTHN_INTERCEPTOR_INSTALLED && navigator.credentials) {
    window.__WEBAUTHN_INTERCEPTOR_INSTALLED = true;
    install();
}

function install(): void {
    const pendingRequests = new Map<string, PendingRequest>();
    const hooks = installGreedyCredentialOverrides(
        (downstream, bypass) => getCreateOverride(downstream, pendingRequests, bypass),
        (downstream, bypass) => getGetOverride(downstream, pendingRequests, bypass),
    );
    if (!hooks) return;

    function finish(requestId: string, pending: PendingRequest): void {
        pendingRequests.delete(requestId);
        pending.cleanup();
        pending.abortNative?.();
        closeRequest(requestId);
    }

    function cancel(requestId: string, pending: PendingRequest): void {
        finish(requestId, pending);
        pending.reject(new DOMException('Request cancelled.', 'AbortError'));
    }

    window.addEventListener('pagehide', () => {
        for (const [requestId, pending] of pendingRequests) cancel(requestId, pending);
    });

    async function proceed(
        payload: Extract<UiDecision, { action: 'proceed' }>,
        pending: PendingRequest,
    ): Promise<void> {
        const { requestId, requestData, responseData } = payload;
        const { operationType } = pending;
        const event = { requestId, operationType, requestData };
        if (pending.state !== 'editing') return;
        pending.state = responseData === undefined ? 'native' : 'decoding';
        try {
            // An empty response calls the authenticator. JSON null returns a null credential.
            if (responseData !== undefined) {
                const credential = await deserializeJsonToPublicKeyCredential(responseData);
                if (!pendingRequests.has(requestId)) return;
                finish(requestId, pending);
                pending.resolve(credential);
                return;
            }

            const controller = new AbortController();
            pending.abortNative = () => controller.abort();
            let credential: Credential | null;
            if (operationType === 'create') {
                credential = await hooks!.passthroughCreate({
                    ...(pending.originalOptions as CredentialCreationOptions),
                    publicKey: publicKeyCredentialCreationOptionsFromJSON(
                        requestData as PublicKeyCredentialCreationOptionsJSON,
                    ),
                    signal: controller.signal,
                });
            } else {
                const options = pending.originalOptions as CredentialRequestOptions;
                credential = await hooks!.passthroughGet({
                    ...options,
                    // Proceed is an explicit action, so leave autofill mode and show the browser prompt.
                    mediation: options.mediation === 'conditional' ? 'optional' : options.mediation,
                    publicKey: publicKeyCredentialRequestOptionsFromJSON(
                        requestData as PublicKeyCredentialRequestOptionsJSON,
                    ),
                    signal: controller.signal,
                });
            }
            if (pendingRequests.has(requestId)) {
                postEvent({
                    ...event,
                    eventType: 'response',
                    responseData: serializePublicKeyCredentialToJSON(
                        credential as PublicKeyCredential | null,
                    ),
                });
            }
        } catch (error) {
            if (pendingRequests.has(requestId)) {
                postEvent({
                    ...event,
                    eventType: 'error',
                    responseData,
                    errorData: {
                        message: errorMessage(error),
                        name: error instanceof Error ? error.name : 'Error',
                    },
                });
            }
        } finally {
            pending.abortNative = undefined;
            pending.state = 'editing';
        }
    }

    window.addEventListener('message', (event) => {
        if (
            event.source !== window ||
            !isRecord(event.data) ||
            event.data.type !== 'WEBAUTHN_INTERCEPTOR_PAGE_RESPONSE' ||
            !isUiDecisionEvent(event.data.payload)
        )
            return;
        const payload = event.data.payload;
        const pending = pendingRequests.get(payload.requestId);
        if (!pending) return;
        if (payload.action === 'cancel') {
            cancel(payload.requestId, pending);
        } else {
            void proceed(payload, pending);
        }
    });
}
