import { decodeCBOR, decodePartialCBOR, CBORType } from '@levischuck/tiny-cbor';
import { base64URLStringToBuffer, bufferToBase64URLString } from '@simplewebauthn/browser';

const FLAGS_OFFSET = 32;
const ATTESTED_CREDENTIAL_DATA_FLAG = 0x40;
const AUTHENTICATOR_HEADER_LENGTH = 37;
const AAGUID_LENGTH = 16;
const CREDENTIAL_ID_LENGTH_OFFSET = AUTHENTICATOR_HEADER_LENGTH + AAGUID_LENGTH;
const CREDENTIAL_ID_OFFSET = CREDENTIAL_ID_LENGTH_OFFSET + 2;

// COSE's negative labels depend on the key type.
const COSE = {
    keyType: 1,
    algorithm: 3,
    ec: { curve: -1, x: -2, y: -3 },
    rsa: { modulus: -1, exponent: -2 },
    okp: { curve: -1, x: -2 },
};
const KEY_TYPE = { okp: 1, ec: 2, rsa: 3 };
const EC_CURVES = new Map([
    [1, 'P-256'],
    [2, 'P-384'],
    [3, 'P-521'],
]);
const ED25519_CURVE = 6;
type CborMap = Map<string | number, CBORType>;

interface AttestationFields {
    authenticatorData?: ArrayBuffer;
    publicKeyAlgorithm?: number;
    publicKey: ArrayBuffer | null;
}

export async function readAttestation(attestationObject: string): Promise<AttestationFields> {
    const fields: AttestationFields = { publicKey: null };
    let bytes: Uint8Array;
    try {
        bytes = new Uint8Array(base64URLStringToBuffer(attestationObject));
    } catch (error) {
        if (error instanceof DOMException && error.name === 'InvalidCharacterError') return fields;
        throw error;
    }

    const attestation = decodeMap(bytes);
    const authData = attestation?.get('authData');
    if (!(authData instanceof Uint8Array)) return fields;
    fields.authenticatorData = new Uint8Array(authData).buffer;

    if (authData.length < CREDENTIAL_ID_OFFSET) return fields;
    if (!(authData[FLAGS_OFFSET] & ATTESTED_CREDENTIAL_DATA_FLAG)) return fields;

    const view = new DataView(authData.buffer, authData.byteOffset, authData.byteLength);
    const credentialIdLength = view.getUint16(CREDENTIAL_ID_LENGTH_OFFSET, false);
    const keyOffset = CREDENTIAL_ID_OFFSET + credentialIdLength;
    if (keyOffset >= authData.length) return fields;

    // Extensions may follow the key, so decode only the first CBOR item at this offset.
    const key = decodeMap(authData, keyOffset);
    if (!key) return fields;
    const algorithm = key.get(COSE.algorithm);
    if (typeof algorithm !== 'number') return fields;

    fields.publicKeyAlgorithm = algorithm;
    fields.publicKey = await exportPublicKey(key);
    return fields;
}

function decodeMap(bytes: Uint8Array, offset?: number): CborMap | undefined {
    let value: CBORType;
    try {
        value = offset === undefined ? decodeCBOR(bytes) : decodePartialCBOR(bytes, offset)[0];
    } catch {
        // The decoder reports malformed input with generic Error and RangeError exceptions.
        return undefined;
    }
    return value instanceof Map ? value : undefined;
}

function keyBytes(key: CborMap, label: number): string | undefined {
    const value = key.get(label);
    if (!(value instanceof Uint8Array) || value.length === 0) return undefined;
    return bufferToBase64URLString(new Uint8Array(value).buffer);
}

async function exportPublicKey(key: CborMap): Promise<ArrayBuffer | null> {
    let jwk: JsonWebKey;
    let algorithm: AlgorithmIdentifier | EcKeyImportParams | RsaHashedImportParams;
    switch (key.get(COSE.keyType)) {
        case KEY_TYPE.ec: {
            const curve = key.get(COSE.ec.curve);
            const crv = typeof curve === 'number' ? EC_CURVES.get(curve) : undefined;
            const x = keyBytes(key, COSE.ec.x);
            const y = keyBytes(key, COSE.ec.y);
            if (!crv || !x || !y) return null;
            jwk = { kty: 'EC', crv, x, y, ext: true };
            algorithm = { name: 'ECDSA', namedCurve: crv };
            break;
        }
        case KEY_TYPE.rsa: {
            const n = keyBytes(key, COSE.rsa.modulus);
            const e = keyBytes(key, COSE.rsa.exponent);
            if (!n || !e) return null;
            jwk = { kty: 'RSA', n, e, ext: true };
            algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
            break;
        }
        case KEY_TYPE.okp: {
            const x = keyBytes(key, COSE.okp.x);
            if (key.get(COSE.okp.curve) !== ED25519_CURVE || !x) return null;
            jwk = { kty: 'OKP', crv: 'Ed25519', x, ext: true };
            algorithm = 'Ed25519';
            break;
        }
        default:
            return null;
    }

    try {
        const imported = await crypto.subtle.importKey('jwk', jwk, algorithm, true, ['verify']);
        return await crypto.subtle.exportKey('spki', imported);
    } catch (error) {
        if (
            error instanceof DOMException &&
            ['DataError', 'NotSupportedError', 'OperationError'].includes(error.name)
        )
            return null;
        throw error;
    }
}
