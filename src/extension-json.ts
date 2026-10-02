import { base64URLStringToBuffer, bufferToBase64URLString } from '@simplewebauthn/browser';

export type ExtensionOutputsJSON = Omit<AuthenticationExtensionsClientOutputs, 'prf' | 'largeBlob'> & {
    prf?: {
        enabled?: boolean;
        results?: AuthenticationExtensionsPRFValuesJSON;
    };
    largeBlob?: {
        supported?: boolean;
        written?: boolean;
        blob?: string;
    };
};

export function extensionInputsToJSON(
    extensions: AuthenticationExtensionsClientInputs | undefined,
): AuthenticationExtensionsClientInputsJSON | undefined {
    if (!extensions) return undefined;
    const { prf, largeBlob } = extensions;
    return {
        ...extensions,
        prf: prf && {
            ...prf,
            eval: prf.eval && prfValuesToJSON(prf.eval),
            evalByCredential:
                prf.evalByCredential &&
                Object.fromEntries(
                    Object.entries(prf.evalByCredential).map(([id, values]) => [id, prfValuesToJSON(values)]),
                ),
        },
        largeBlob: largeBlob && {
            ...largeBlob,
            write: largeBlob.write === undefined ? undefined : encodeBuffer(largeBlob.write),
        },
    };
}

export function extensionInputsFromJSON(
    extensions: AuthenticationExtensionsClientInputsJSON | undefined,
): AuthenticationExtensionsClientInputs | undefined {
    if (!extensions) return undefined;
    const { prf, largeBlob } = extensions;
    return {
        ...extensions,
        prf: prf && {
            ...prf,
            eval: prf.eval && prfValuesFromJSON(prf.eval),
            evalByCredential:
                prf.evalByCredential &&
                Object.fromEntries(
                    Object.entries(prf.evalByCredential).map(([id, values]) => [
                        id,
                        prfValuesFromJSON(values),
                    ]),
                ),
        },
        largeBlob: largeBlob && {
            ...largeBlob,
            write: largeBlob.write === undefined ? undefined : base64URLStringToBuffer(largeBlob.write),
        },
    };
}

export function extensionOutputsToJSON(
    extensions: AuthenticationExtensionsClientOutputs,
): ExtensionOutputsJSON {
    const { prf, largeBlob, ...rest } = extensions;
    const json: ExtensionOutputsJSON = rest;
    if (prf) {
        const { results, ...flags } = prf;
        json.prf = flags;
        if (results) json.prf.results = prfValuesToJSON(results);
    }
    if (largeBlob) {
        const { blob, ...flags } = largeBlob;
        json.largeBlob = flags;
        if (blob !== undefined) json.largeBlob.blob = encodeBuffer(blob);
    }
    return json;
}

export function extensionOutputsFromJSON(
    extensions: ExtensionOutputsJSON,
): AuthenticationExtensionsClientOutputs {
    const { prf, largeBlob, ...rest } = extensions;
    const outputs: AuthenticationExtensionsClientOutputs = rest;
    if (prf) {
        const { results, ...flags } = prf;
        outputs.prf = flags;
        if (results) outputs.prf.results = prfValuesFromJSON(results);
    }
    if (largeBlob) {
        const { blob, ...flags } = largeBlob;
        outputs.largeBlob = flags;
        if (blob !== undefined) outputs.largeBlob.blob = base64URLStringToBuffer(blob);
    }
    return outputs;
}

function prfValuesToJSON(values: AuthenticationExtensionsPRFValues): AuthenticationExtensionsPRFValuesJSON {
    const { first, second, ...rest } = values;
    return {
        ...rest,
        first: encodeBuffer(first),
        ...(second === undefined ? {} : { second: encodeBuffer(second) }),
    };
}

function prfValuesFromJSON(values: AuthenticationExtensionsPRFValuesJSON): AuthenticationExtensionsPRFValues {
    const { first, second, ...rest } = values;
    if (typeof first !== 'string' || (second !== undefined && typeof second !== 'string')) {
        throw new TypeError('PRF first and second values must be base64url strings.');
    }
    return {
        ...rest,
        first: base64URLStringToBuffer(first),
        ...(second === undefined ? {} : { second: base64URLStringToBuffer(second) }),
    };
}

function encodeBuffer(value: BufferSource): string {
    const buffer =
        value instanceof ArrayBuffer
            ? value
            : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    return bufferToBase64URLString(buffer);
}
