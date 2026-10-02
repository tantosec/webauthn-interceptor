import { bufferToBase64URLString, base64URLStringToBuffer } from '@simplewebauthn/browser';
import { readAttestation } from './attestation';
import {
    extensionInputsToJSON,
    extensionInputsFromJSON,
    extensionOutputsToJSON,
    extensionOutputsFromJSON,
    ExtensionOutputsJSON,
} from './extension-json';

export interface PublicKeyCredentialCreationOptionsJSON {
    rp: PublicKeyCredentialRpEntityJSON;
    user: PublicKeyCredentialUserEntityJSON;
    challenge: string;
    pubKeyCredParams: PublicKeyCredentialParameters[];
    timeout?: number;
    excludeCredentials?: PublicKeyCredentialDescriptorJSON[];
    authenticatorSelection?: AuthenticatorSelectionCriteria;
    attestation?: AttestationConveyancePreference;
    extensions?: AuthenticationExtensionsClientInputsJSON;
}

export interface PublicKeyCredentialRequestOptionsJSON {
    challenge: string;
    timeout?: number;
    rpId?: string;
    allowCredentials?: PublicKeyCredentialDescriptorJSON[];
    userVerification?: UserVerificationRequirement;
    extensions?: AuthenticationExtensionsClientInputsJSON;
}

export type PublicKeyCredentialOptionsJSON =
    PublicKeyCredentialCreationOptionsJSON | PublicKeyCredentialRequestOptionsJSON;
export interface PublicKeyCredentialRpEntityJSON extends Omit<PublicKeyCredentialRpEntity, 'id'> {
    id?: string;
}
export interface PublicKeyCredentialUserEntityJSON extends Omit<PublicKeyCredentialUserEntity, 'id'> {
    id: string;
}
export interface PublicKeyCredentialDescriptorJSON extends Omit<PublicKeyCredentialDescriptor, 'id'> {
    id: string;
    transports?: AuthenticatorTransport[];
}

export interface SerializedAuthenticatorAttestationResponseJSON {
    clientDataJSON?: string;
    attestationObject: string;
    transports?: AuthenticatorTransport[];
    authenticatorData?: string;
    publicKey?: string | null;
    publicKeyAlgorithm?: number;
}

export interface SerializedAuthenticatorAssertionResponseJSON {
    clientDataJSON?: string;
    authenticatorData: string;
    signature: string;
    userHandle?: string | null;
}

export type SerializedAuthenticatorResponseJSON =
    SerializedAuthenticatorAttestationResponseJSON | SerializedAuthenticatorAssertionResponseJSON;

export interface PublicKeyCredentialJSON {
    id: string;
    rawId: string;
    type: string;
    authenticatorAttachment?: string | null;
    clientExtensionResults: ExtensionOutputsJSON;
    response: SerializedAuthenticatorResponseJSON;
}
interface WebAuthnEventBase {
    requestId: string;
    operationType: 'get' | 'create';
    requestData: unknown;
    badAuthenticatorUrl?: string;
}
export interface WebAuthnRequestEvent extends WebAuthnEventBase {
    eventType: 'request';
    responseData?: never;
    errorData?: never;
}
export interface WebAuthnResponseEvent extends WebAuthnEventBase {
    eventType: 'response';
    responseData: unknown;
    errorData?: never;
}
export interface WebAuthnErrorEvent extends WebAuthnEventBase {
    eventType: 'error';
    // Preserve an edited response when decoding fails so the user can correct it.
    responseData?: unknown;
    errorData: { message: string; name: string; [key: string]: unknown };
}
export type WebAuthnInterceptorEventPayload =
    WebAuthnRequestEvent | WebAuthnResponseEvent | WebAuthnErrorEvent;

export type UiDecision =
    | { requestId: string; action: 'cancel' }
    | { requestId: string; action: 'proceed'; requestData: unknown; responseData?: unknown };

export function publicKeyCredentialCreationOptionsToJSON(
    options: PublicKeyCredentialCreationOptions,
): PublicKeyCredentialCreationOptionsJSON {
    return {
        ...options,
        extensions: extensionInputsToJSON(options.extensions),
        challenge: bufferToBase64URLString(bufferSourceToArrayBuffer(options.challenge)),
        user: {
            ...options.user,
            id: bufferToBase64URLString(bufferSourceToArrayBuffer(options.user.id)),
        },
        excludeCredentials: options.excludeCredentials?.map((cred) => ({
            ...cred,
            id: bufferToBase64URLString(bufferSourceToArrayBuffer(cred.id)),
        })),
    };
}

export function publicKeyCredentialCreationOptionsFromJSON(
    jsonOptions: PublicKeyCredentialCreationOptionsJSON,
): PublicKeyCredentialCreationOptions {
    return {
        ...jsonOptions,
        extensions: extensionInputsFromJSON(jsonOptions.extensions),
        challenge: base64URLStringToBuffer(jsonOptions.challenge),
        user: {
            ...jsonOptions.user,
            id: base64URLStringToBuffer(jsonOptions.user.id),
        },
        excludeCredentials: jsonOptions.excludeCredentials?.map((cred) => ({
            ...cred,
            id: base64URLStringToBuffer(cred.id),
        })),
    };
}

export function publicKeyCredentialRequestOptionsToJSON(
    options: PublicKeyCredentialRequestOptions,
): PublicKeyCredentialRequestOptionsJSON {
    return {
        ...options,
        extensions: extensionInputsToJSON(options.extensions),
        challenge: bufferToBase64URLString(bufferSourceToArrayBuffer(options.challenge)),
        allowCredentials: options.allowCredentials?.map((cred) => ({
            ...cred,
            id: bufferToBase64URLString(bufferSourceToArrayBuffer(cred.id)),
        })),
    };
}

export function publicKeyCredentialRequestOptionsFromJSON(
    jsonOptions: PublicKeyCredentialRequestOptionsJSON,
): PublicKeyCredentialRequestOptions {
    return {
        ...jsonOptions,
        extensions: extensionInputsFromJSON(jsonOptions.extensions),
        challenge: base64URLStringToBuffer(jsonOptions.challenge),
        allowCredentials: jsonOptions.allowCredentials?.map((cred) => ({
            ...cred,
            id: base64URLStringToBuffer(cred.id),
        })),
    };
}

export function serializePublicKeyCredentialToJSON(
    credential: PublicKeyCredential | null,
): PublicKeyCredentialJSON | null {
    if (!credential) return null;
    const response = credential.response;
    let responseJSON: SerializedAuthenticatorResponseJSON;
    if ('attestationObject' in response) {
        const attestation = response as AuthenticatorAttestationResponse;
        const publicKey = attestation.getPublicKey?.();
        responseJSON = {
            clientDataJSON: bufferToBase64URLString(response.clientDataJSON),
            attestationObject: bufferToBase64URLString(attestation.attestationObject),
            transports: attestation.getTransports?.() as AuthenticatorTransport[],
            authenticatorData: attestation.getAuthenticatorData
                ? bufferToBase64URLString(attestation.getAuthenticatorData())
                : undefined,
            publicKey: publicKey ? bufferToBase64URLString(publicKey) : null,
            publicKeyAlgorithm: attestation.getPublicKeyAlgorithm?.(),
        };
    } else {
        const assertion = response as AuthenticatorAssertionResponse;
        responseJSON = {
            clientDataJSON: bufferToBase64URLString(response.clientDataJSON),
            authenticatorData: bufferToBase64URLString(assertion.authenticatorData),
            signature: bufferToBase64URLString(assertion.signature),
            userHandle: assertion.userHandle === null ? null : bufferToBase64URLString(assertion.userHandle),
        };
    }
    return {
        id: credential.id,
        rawId: bufferToBase64URLString(credential.rawId),
        type: credential.type,
        authenticatorAttachment: credential.authenticatorAttachment,
        clientExtensionResults: extensionOutputsToJSON(credential.getClientExtensionResults()),
        response: responseJSON,
    };
}

export async function deserializeJsonToPublicKeyCredential(
    json: unknown,
): Promise<PublicKeyCredential | null> {
    if (json === null) return null;
    if (
        !isRecord(json) ||
        typeof json.id !== 'string' ||
        typeof json.rawId !== 'string' ||
        json.type !== 'public-key' ||
        !isRecord(json.response)
    ) {
        throw new TypeError('Response needs id, rawId, type "public-key", and a response object.');
    }
    const data = json.response;
    if (typeof data.clientDataJSON !== 'string') throw new TypeError('Response needs clientDataJSON.');
    const clientDataJSON = base64URLStringToBuffer(data.clientDataJSON);
    let response: AuthenticatorResponse;
    if (typeof data.attestationObject === 'string') {
        const parsed = await readAttestation(data.attestationObject);
        response = Object.create(AuthenticatorAttestationResponse.prototype, {
            clientDataJSON: { value: clientDataJSON, enumerable: true },
            attestationObject: { value: base64URLStringToBuffer(data.attestationObject), enumerable: true },
            getTransports: { value: () => (isStringArray(data.transports) ? [...data.transports] : []) },
            getPublicKey: {
                value: () =>
                    typeof data.publicKey === 'string'
                        ? base64URLStringToBuffer(data.publicKey)
                        : parsed.publicKey,
            },
            getAuthenticatorData: {
                value: () => {
                    const value =
                        typeof data.authenticatorData === 'string'
                            ? base64URLStringToBuffer(data.authenticatorData)
                            : parsed.authenticatorData;
                    if (!value)
                        throw new DOMException(
                            'Could not read attestation authenticatorData.',
                            'NotSupportedError',
                        );
                    return value;
                },
            },
            getPublicKeyAlgorithm: {
                value: () => {
                    const value =
                        typeof data.publicKeyAlgorithm === 'number'
                            ? data.publicKeyAlgorithm
                            : parsed.publicKeyAlgorithm;
                    if (value === undefined)
                        throw new DOMException(
                            'Could not read the attestation public key algorithm.',
                            'NotSupportedError',
                        );
                    return value;
                },
            },
        });
    } else {
        if (typeof data.authenticatorData !== 'string' || typeof data.signature !== 'string') {
            throw new TypeError('Assertion response needs authenticatorData and signature.');
        }
        response = Object.create(AuthenticatorAssertionResponse.prototype, {
            clientDataJSON: { value: clientDataJSON, enumerable: true },
            authenticatorData: { value: base64URLStringToBuffer(data.authenticatorData), enumerable: true },
            signature: { value: base64URLStringToBuffer(data.signature), enumerable: true },
            userHandle: {
                value: typeof data.userHandle === 'string' ? base64URLStringToBuffer(data.userHandle) : null,
                enumerable: true,
            },
        });
    }
    const extensionResults = extensionOutputsFromJSON(
        isRecord(json.clientExtensionResults) ? json.clientExtensionResults : {},
    );
    // Native constructors are not public, so define the data and methods the RP uses.
    return Object.create(PublicKeyCredential.prototype, {
        id: { value: json.id, enumerable: true },
        rawId: { value: base64URLStringToBuffer(json.rawId), enumerable: true },
        type: { value: json.type, enumerable: true },
        authenticatorAttachment: { value: json.authenticatorAttachment ?? null, enumerable: true },
        response: { value: response, enumerable: true },
        getClientExtensionResults: {
            value: () => structuredClone(extensionResults),
        },
        toJSON: { value: () => structuredClone(json) },
    });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isWebAuthnRequestId(value: unknown): value is string {
    return (
        typeof value === 'string' &&
        /^req-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    );
}

export function isWebAuthnOperationType(value: unknown): value is 'create' | 'get' {
    return value === 'create' || value === 'get';
}

export function isPageInterceptorEvent(value: unknown): value is WebAuthnInterceptorEventPayload {
    if (
        !isRecord(value) ||
        !isWebAuthnRequestId(value.requestId) ||
        !isWebAuthnOperationType(value.operationType) ||
        !isRecord(value.requestData) ||
        (value.badAuthenticatorUrl !== undefined && typeof value.badAuthenticatorUrl !== 'string')
    )
        return false;
    switch (value.eventType) {
        case 'request':
            return value.responseData === undefined && value.errorData === undefined;
        case 'response':
            return value.responseData !== undefined && value.errorData === undefined;
        case 'error':
            return (
                isRecord(value.errorData) &&
                typeof value.errorData.message === 'string' &&
                typeof value.errorData.name === 'string'
            );
        default:
            return false;
    }
}

export function isUiDecisionEvent(value: unknown): value is UiDecision {
    return (
        isRecord(value) &&
        isWebAuthnRequestId(value.requestId) &&
        (value.action === 'cancel' || (value.action === 'proceed' && isRecord(value.requestData)))
    );
}

export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function bufferSourceToArrayBuffer(value: BufferSource): ArrayBuffer {
    if (value instanceof ArrayBuffer) {
        return value;
    }

    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
}
