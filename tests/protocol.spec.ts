import { test, expect } from '@playwright/test';
import { parseAuthenticatorUrl } from '../src/authenticator-url';
import {
    isPageInterceptorEvent,
    publicKeyCredentialCreationOptionsToJSON,
    publicKeyCredentialCreationOptionsFromJSON,
    publicKeyCredentialRequestOptionsToJSON,
    publicKeyCredentialRequestOptionsFromJSON,
} from '../src/common_types';
import { extensionOutputsToJSON, extensionOutputsFromJSON } from '../src/extension-json';

const event = {
    requestId: 'req-00000000-0000-4000-8000-000000000000',
    operationType: 'get',
    requestData: { challenge: 'AQID' },
};
const errorData = { name: 'DataError', message: 'Response needs an id.' };

test('event variants reject missing and contradictory fields', () => {
    expect(isPageInterceptorEvent({ ...event, eventType: 'request' })).toBe(true);
    for (const invalid of [
        { eventType: 'request', responseData: null },
        { eventType: 'request', errorData },
        { eventType: 'response' },
        { eventType: 'response', responseData: undefined },
        { eventType: 'response', responseData: {}, errorData },
        { eventType: 'error' },
        { eventType: 'error', errorData: { message: 'Missing name' } },
        { eventType: 'error', errorData: { name: 'Error', message: 42 } },
        { eventType: 'other' },
    ]) {
        expect(isPageInterceptorEvent({ ...event, ...invalid })).toBe(false);
    }
});

test('response events allow null and editable malformed JSON', () => {
    for (const responseData of [null, {}, { response: { signature: 42 } }, 'invalid credential']) {
        expect(isPageInterceptorEvent({ ...event, eventType: 'response', responseData })).toBe(true);
        expect(isPageInterceptorEvent({ ...event, eventType: 'error', errorData, responseData })).toBe(true);
    }
    expect(isPageInterceptorEvent({ ...event, eventType: 'error', errorData })).toBe(true);
});

test('authenticator bases preserve directories and reject queries and fragments', () => {
    for (const [input, expected] of [
        ['http://127.0.0.1:1337', 'http://127.0.0.1:1337/'],
        ['https://example.test/ba', 'https://example.test/ba/'],
        ['https://example.test/ba/', 'https://example.test/ba/'],
        ['https://example.test/a%20b', 'https://example.test/a%20b/'],
    ]) {
        expect(parseAuthenticatorUrl(input).href).toBe(expected);
    }
    for (const input of ['https://example.test/ba?key=value', 'https://example.test/ba#section']) {
        expect(() => parseAuthenticatorUrl(input)).toThrow('query string or fragment');
    }
    expect(() => parseAuthenticatorUrl('file:///tmp/ba')).toThrow('http:// or https://');
});

test('request JSON preserves PRF buffers, view offsets and credential-specific inputs', () => {
    const bytes = new Uint8Array([99, 1, 2, 3, 99]);
    const extensions = {
        credProps: true,
        prf: {
            eval: { first: new DataView(bytes.buffer, 1, 3) },
            evalByCredential: {
                AQID: { first: bytes.subarray(1, 4), second: new Uint8Array([4, 5]).buffer },
            },
        },
        largeBlob: { write: bytes.subarray(1, 4) },
        custom: { enabled: true },
    };
    const creation: PublicKeyCredentialCreationOptions = {
        rp: { name: 'Test', id: 'interceptor.test' },
        user: { id: bytes, name: 'test', displayName: 'Test' },
        challenge: bytes,
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        extensions,
    };
    const request: PublicKeyCredentialRequestOptions = { challenge: bytes, extensions };
    const creationJSON = JSON.parse(JSON.stringify(publicKeyCredentialCreationOptionsToJSON(creation)));
    const requestJSON = JSON.parse(JSON.stringify(publicKeyCredentialRequestOptionsToJSON(request)));
    for (const json of [creationJSON, requestJSON]) {
        expect(json.extensions).toEqual({
            credProps: true,
            prf: { eval: { first: 'AQID' }, evalByCredential: { AQID: { first: 'AQID', second: 'BAU' } } },
            largeBlob: { write: 'AQID' },
            custom: { enabled: true },
        });
    }
    for (const restored of [
        publicKeyCredentialCreationOptionsFromJSON(creationJSON),
        publicKeyCredentialRequestOptionsFromJSON(requestJSON),
    ]) {
        expect(restored.extensions?.prf?.eval?.first).toEqual(new Uint8Array([1, 2, 3]).buffer);
        expect(restored.extensions?.prf?.eval?.second).toBeUndefined();
        expect(restored.extensions?.prf?.evalByCredential?.AQID).toEqual({
            first: new Uint8Array([1, 2, 3]).buffer,
            second: new Uint8Array([4, 5]).buffer,
        });
        expect(restored.extensions?.largeBlob?.write).toEqual(new Uint8Array([1, 2, 3]).buffer);
    }
    requestJSON.extensions.prf.eval.first = {};
    expect(() => publicKeyCredentialRequestOptionsFromJSON(requestJSON)).toThrow('base64url strings');
});

test('extension results round-trip as JSON strings and native buffers', () => {
    const extensions = {
        prf: {
            enabled: true,
            results: { first: new Uint8Array([1, 2, 3]).buffer, second: new Uint8Array(0).buffer },
        },
        largeBlob: { blob: new Uint8Array([4, 5]).buffer, supported: true },
        credProps: { rk: true },
    };
    const json = JSON.parse(JSON.stringify(extensionOutputsToJSON(extensions)));
    expect(json).toEqual({
        prf: { enabled: true, results: { first: 'AQID', second: '' } },
        largeBlob: { blob: 'BAU', supported: true },
        credProps: { rk: true },
    });
    expect(extensionOutputsFromJSON(json)).toEqual(extensions);
    for (const flags of [{}, { prf: { enabled: false } }, { largeBlob: { supported: false } }]) {
        expect(extensionOutputsToJSON(flags)).toStrictEqual(flags);
        expect(extensionOutputsFromJSON(flags)).toStrictEqual(flags);
    }
});
