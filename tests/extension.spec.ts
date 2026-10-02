import { decodeCBOR, encodeCBOR, CBORType } from '@levischuck/tiny-cbor';
import { test, expect, localPage, start, query, finish, modal, selector, settleFrame } from './fixtures';

test.beforeEach(async ({ extension }) => {
    await localPage(extension.page);
});

test('register, edit a response, and select a discoverable credential', async ({ extension }) => {
    const { page } = extension;
    await start(page);
    const registration = await query(page);
    registration.clientExtensionResults = { credProps: { rk: true } };
    await modal(page).locator('#responseDisplay').fill(JSON.stringify(registration));
    expect(await finish(page)).toMatchObject({ ok: true, isCredential: true, credential: registration });
    await start(page, 'get');
    const edited = JSON.parse(await modal(page).locator('#requestDisplay').inputValue());
    edited.challenge = 'ZWRpdGVkLWNoYWxsZW5nZQ';
    await modal(page).locator('#requestDisplay').fill(JSON.stringify(edited));
    await modal(page).locator('#queryBadAuthenticator').click();
    await settleFrame(selector(page));
    await selector(page).getByRole('option').filter({ hasText: registration.id }).click();
    await selector(page).getByRole('button', { name: 'Select', exact: true }).click();
    await expect(page.locator('#webauthn-credential-selector')).toHaveCount(0);
    await expect(modal(page).locator('#responseDisplay')).not.toHaveValue('');
    const assertion = JSON.parse(await modal(page).locator('#responseDisplay').inputValue());
    expect(JSON.parse(Buffer.from(assertion.response.clientDataJSON, 'base64url').toString()).challenge).toBe(
        edited.challenge,
    );
    expect(await finish(page)).toMatchObject({ ok: true, credential: { id: registration.id } });
});

test('allowCredentials bypasses the selector', async ({ extension }) => {
    const { page } = extension;
    await start(page);
    const registration = await query(page);
    await finish(page);
    await start(page, 'get');
    const request = JSON.parse(await modal(page).locator('#requestDisplay').inputValue());
    request.allowCredentials = [{ type: 'public-key', id: registration.id }];
    await modal(page).locator('#requestDisplay').fill(JSON.stringify(request));
    expect((await query(page)).id).toBe(registration.id);
    await expect(page.locator('#webauthn-credential-selector')).toHaveCount(0);
    expect(await finish(page)).toMatchObject({ ok: true });
});

test('invalid JSON and malformed credentials can be corrected without losing the request', async ({
    extension,
}) => {
    const { page } = extension;
    await start(page);
    const original = await modal(page).locator('#requestDisplay').inputValue();
    await modal(page).locator('#requestDisplay').fill('{');
    await modal(page).locator('#proceedButton').click();
    await expect(modal(page).locator('#feedbackMessage')).toContainText('Request is not valid JSON');
    await modal(page).locator('#queryBadAuthenticator').click();
    await expect(modal(page).locator('#feedbackMessage')).toContainText('Request is not valid JSON');
    await modal(page).locator('#requestDisplay').fill(original);
    await modal(page).locator('#responseDisplay').fill('{');
    await modal(page).locator('#proceedButton').click();
    await expect(modal(page).locator('#feedbackMessage')).toContainText('Response is not valid JSON');
    await modal(page).locator('#responseDisplay').fill('{}');
    await modal(page).locator('#proceedButton').click();
    await expect(modal(page).locator('#feedbackMessage')).toContainText('Response needs');
    await expect(modal(page).locator('#proceedButton')).toBeEnabled();
    await modal(page).locator('#responseDisplay').fill('null');
    expect(await finish(page)).toMatchObject({ ok: true, credential: null });
});

test('manual response returns without an authenticator call', async ({ extension }) => {
    const { page } = extension;
    await start(page, 'get');
    const credential = {
        id: 'AQID',
        rawId: 'AQID',
        type: 'public-key',
        clientExtensionResults: {},
        response: { clientDataJSON: 'e30', authenticatorData: 'AQID', signature: 'BAUG', userHandle: null },
    };
    await modal(page).locator('#responseDisplay').fill(JSON.stringify(credential));
    expect(await finish(page)).toMatchObject({ ok: true, isCredential: true, credential });
});

test('cancel and Escape reject the page promise', async ({ extension }) => {
    const { page } = extension;
    for (const operation of ['create', 'get'] as const) {
        await start(page, operation);
        if (operation === 'create') await modal(page).locator('#cancelButton').click();
        else await modal(page).locator('#requestDisplay').press('Escape');
        await expect
            .poll(() => page.evaluate(() => window.result))
            .toMatchObject({ ok: false, name: 'AbortError' });
        await expect(page.locator('#webauthn-interceptor-iframe')).toHaveCount(0);
    }
});

test('page abort removes the panel while the request is paused', async ({ extension }) => {
    const { page } = extension;
    await start(page);
    await page.evaluate(() => window.abortController.abort());
    await expect
        .poll(() => page.evaluate(() => window.result))
        .toMatchObject({ ok: false, name: 'AbortError' });
    await expect(page.locator('#webauthn-interceptor-iframe')).toHaveCount(0);
});

test('cancel and Escape close a panel whose saved request is missing', async ({ extension }) => {
    const { page, popup, context } = extension;
    const session = await context.newCDPSession(page);
    await session.send('ServiceWorker.enable');
    for (const action of ['cancel', 'Escape']) {
        await start(page);
        const requestId = new URL(
            (await page.locator('#webauthn-interceptor-iframe').getAttribute('src'))!,
        ).searchParams.get('requestId');
        await session.send('ServiceWorker.stopAllWorkers');
        await popup.evaluate(() => chrome.storage.session.clear());
        const result = await popup.evaluate(
            (requestId) =>
                chrome.runtime.sendMessage({ type: 'GET_INTERCEPTOR_PAYLOAD', payload: { requestId } }),
            requestId,
        );
        expect(result.error).toContain('request has ended');
        await modal(page).locator('#proceedButton').click();
        await expect(modal(page).locator('#feedbackMessage')).toContainText('request has ended');
        if (action === 'cancel') await modal(page).locator('#cancelButton').click();
        else await modal(page).locator('#requestDisplay').press('Escape');
        await expect(page.locator('#webauthn-interceptor-iframe')).toHaveCount(0);
        await expect
            .poll(() => page.evaluate(() => window.result))
            .toMatchObject({ ok: false, name: 'AbortError' });
    }
    await session.detach();
});

test('empty credential list and selector cancellation', async ({ extension }) => {
    const { page } = extension;
    await start(page, 'get');
    const request = JSON.parse(await modal(page).locator('#requestDisplay').inputValue());
    request.rpId = 'no-credentials.example';
    await modal(page).locator('#requestDisplay').fill(JSON.stringify(request));
    await modal(page).locator('#queryBadAuthenticator').click();
    await expect(selector(page).locator('#loadingMessage')).toContainText(
        'No credentials found for no-credentials.example',
    );
    await settleFrame(selector(page));
    await selector(page).locator('#cancelButton').click();
    await expect(page.locator('#webauthn-interceptor-iframe')).toHaveCount(0);
    await expect(page.locator('#webauthn-credential-selector')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.result)).toMatchObject({ name: 'AbortError' });
});

test('authentication and connection errors preserve edited request JSON', async ({
    extension,
    authenticator,
}) => {
    const { page, popup } = extension;
    await popup.locator('#bearerToken').fill('incorrect-test-token');
    await popup.locator('#bearerToken').press('Tab');
    await start(page);
    const edited = JSON.parse(await modal(page).locator('#requestDisplay').inputValue());
    edited.user.displayName = 'Edited user';
    await modal(page).locator('#requestDisplay').fill(JSON.stringify(edited));
    await modal(page).locator('#queryBadAuthenticator').click();
    await expect(modal(page).locator('#feedbackMessage')).toContainText('Authentication failed');
    expect(JSON.parse(await modal(page).locator('#requestDisplay').inputValue())).toEqual(edited);
    await popup.locator('#bearerToken').fill(authenticator.token);
    await popup.locator('#bearerToken').press('Tab');
    await query(page);
    expect(await finish(page)).toMatchObject({ ok: true });
    await popup.locator('#badAuthenticatorUrl').fill('http://127.0.0.1:1');
    await popup.locator('#badAuthenticatorUrl').press('Tab');
    await start(page);
    await modal(page).locator('#queryBadAuthenticator').click();
    await expect(modal(page).locator('#feedbackMessage')).toContainText('Could not connect');
    await modal(page).locator('#cancelButton').click();
});

test('popup validates URLs, saves settings and clears configuration', async ({ extension }) => {
    const { popup, worker, page } = extension;
    await popup.locator('#badAuthenticatorUrl').fill('file:///tmp/test');
    await popup.locator('#badAuthenticatorUrl').press('Tab');
    expect(
        await popup
            .locator('#badAuthenticatorUrl')
            .evaluate((input: HTMLInputElement) => input.validationMessage),
    ).toContain('http://');
    for (const suffix of ['?key=value', '#section']) {
        await popup.locator('#badAuthenticatorUrl').fill(`http://127.0.0.1:1337/ba${suffix}`);
        await popup.locator('#badAuthenticatorUrl').press('Tab');
        expect(
            await popup
                .locator('#badAuthenticatorUrl')
                .evaluate((input: HTMLInputElement) => input.validationMessage),
        ).toContain('query string or fragment');
    }
    await popup.locator('#clearBadAuthenticatorConfig').click();
    await expect(popup.locator('#badAuthenticatorUrl')).toHaveValue('');
    await expect(popup.locator('#bearerToken')).toHaveValue('');
    expect(
        await worker.evaluate(() =>
            chrome.storage.local.get(['badAuthenticatorUrl', 'badAuthenticatorBearerToken']),
        ),
    ).toEqual({});
    await start(page);
    await expect(modal(page).locator('#remoteAuthenticatorSection')).toBeHidden();
    await modal(page).locator('#cancelButton').click();
    await popup.locator('label[aria-label="Enable or disable WebAuthn interception"]').click();
    await expect
        .poll(() => page.evaluate(() => document.documentElement.dataset.requestInterceptorEnabled))
        .toBe('false');
    await popup.reload();
    await expect(popup.locator('#request-enableToggle')).not.toBeChecked();
});

test('authenticator URLs with path prefixes support registration and credential selection', async ({
    extension,
    authenticator,
}) => {
    const { createServer } = await import('node:http');
    const { once } = await import('node:events');
    const { page, popup } = extension;
    const prefix = '/ba/nested';
    const calls: { path: string; authorization?: string }[] = [];
    const server = createServer(async (request, response) => {
        const path = request.url ?? '/';
        calls.push({ path, authorization: request.headers.authorization });
        if (!path.startsWith(`${prefix}/`)) {
            response.writeHead(404).end();
            return;
        }
        try {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const upstream = await fetch(new URL(path.slice(prefix.length), authenticator.url), {
                method: request.method,
                headers: {
                    Authorization: request.headers.authorization ?? '',
                    'Content-Type': 'application/json',
                },
                body: request.method === 'POST' ? Buffer.concat(chunks) : undefined,
            });
            response.writeHead(upstream.status, { 'Content-Type': 'application/json' });
            response.end(await upstream.text());
        } catch (error) {
            response.writeHead(502).end(String(error));
        }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
        const address = server.address() as import('node:net').AddressInfo;
        for (const suffix of ['', '/']) {
            calls.length = 0;
            await popup
                .locator('#badAuthenticatorUrl')
                .fill(`http://127.0.0.1:${address.port}${prefix}${suffix}`);
            await popup.locator('#badAuthenticatorUrl').press('Tab');
            await start(page);
            const registration = await query(page);
            expect(await finish(page)).toMatchObject({ ok: true });
            await start(page, 'get');
            await modal(page).locator('#queryBadAuthenticator').click();
            await settleFrame(selector(page));
            await selector(page).getByRole('option').filter({ hasText: registration.id }).click();
            await selector(page).getByRole('button', { name: 'Select', exact: true }).click();
            await expect(modal(page).locator('#responseDisplay')).not.toHaveValue('');
            expect(await finish(page)).toMatchObject({ ok: true, credential: { id: registration.id } });
            expect(calls.map((call) => call.path.split('?')[0])).toEqual([
                `${prefix}/api/v1/attest`,
                `${prefix}/api/v1/listCredentials`,
                `${prefix}/api/v1/assert`,
            ]);
            expect(calls.every((call) => call.authorization === `Bearer ${authenticator.token}`)).toBe(true);
        }
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

test('native registration, authentication and disabled passthrough', async ({ extension }) => {
    const { page, context, popup } = extension;
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', {
        options: {
            protocol: 'ctap2',
            transport: 'internal',
            hasResidentKey: true,
            hasUserVerification: true,
            isUserVerified: true,
            automaticPresenceSimulation: true,
        },
    });
    await start(page);
    await modal(page).locator('#proceedButton').click();
    await expect(modal(page).locator('#responseDisplay')).not.toHaveValue('');
    const registration = await finish(page);
    expect(registration).toMatchObject({ ok: true, isCredential: true });
    expect(
        (
            registration.credential!
                .response as import('../src/common_types').SerializedAuthenticatorAttestationResponseJSON
        ).publicKeyAlgorithm,
    ).toBe(-7);
    await start(page, 'get');
    await modal(page).locator('#proceedButton').click();
    await expect(modal(page).locator('#responseDisplay')).not.toHaveValue('');
    expect(await finish(page)).toMatchObject({ ok: true, credential: { id: registration.credential!.id } });
    await popup.locator('label[aria-label="Enable or disable WebAuthn interception"]').click();
    await expect
        .poll(() => page.evaluate(() => document.documentElement.dataset.requestInterceptorEnabled))
        .toBe('false');
    const id = await page.evaluate(async () => {
        const credential = await navigator.credentials.get({
            publicKey: { challenge: new Uint8Array(32), rpId: location.hostname },
        });
        return credential?.id;
    });
    expect(id).toBe(registration.credential!.id);
    await expect(page.locator('#webauthn-interceptor-iframe')).toHaveCount(0);
});

test('native PRF requests and results survive both Proceed steps', async ({ extension }) => {
    const { page, context } = extension;
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', {
        options: {
            protocol: 'ctap2',
            ctap2Version: 'ctap2_1',
            transport: 'usb',
            hasResidentKey: true,
            hasUserVerification: true,
            isUserVerified: true,
            hasPrf: true,
            automaticPresenceSimulation: true,
        },
    });
    for (const operation of ['create', 'get'] as const) {
        await page.evaluate((operation) => {
            window.result = undefined;
            const values = { first: new Uint8Array([1, 2, 3]).buffer, second: new Uint8Array([4, 5, 6]) };
            const publicKey = {
                challenge: crypto.getRandomValues(new Uint8Array(32)),
                userVerification: 'required' as const,
            };
            const pending =
                operation === 'create'
                    ? navigator.credentials.create({
                          publicKey: {
                              ...publicKey,
                              rp: { id: location.hostname, name: 'PRF test' },
                              user: { id: new Uint8Array([1]), name: 'test-user', displayName: 'Test user' },
                              pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
                              authenticatorSelection: {
                                  residentKey: 'required',
                                  userVerification: 'required',
                                  authenticatorAttachment: 'cross-platform',
                              },
                              attestation: 'direct',
                              extensions: { credProps: true, prf: { eval: values } },
                          },
                      })
                    : navigator.credentials.get({
                          publicKey: {
                              ...publicKey,
                              rpId: location.hostname,
                              allowCredentials: [{ type: 'public-key', id: window.credential!.rawId }],
                              extensions: { prf: { evalByCredential: { [window.credential!.id]: values } } },
                          },
                      });
            pending
                .then((value) => {
                    window.credential = value as PublicKeyCredential;
                    window.result = { ok: true, isCredential: value instanceof PublicKeyCredential };
                })
                .catch((error) => {
                    window.result = { ok: false, name: error.name, message: error.message };
                });
        }, operation);
        await settleFrame(modal(page));
        const request = JSON.parse(await modal(page).locator('#requestDisplay').inputValue());
        const values =
            operation === 'create'
                ? request.extensions.prf.eval
                : Object.values(request.extensions.prf.evalByCredential)[0];
        expect(values).toEqual({ first: 'AQID', second: 'BAUG' });
        await modal(page).locator('#proceedButton').click();
        await expect(modal(page).locator('#responseDisplay')).not.toHaveValue('');
        const response = JSON.parse(await modal(page).locator('#responseDisplay').inputValue());
        if (operation === 'create') expect(response.clientExtensionResults.prf.enabled).toBe(true);
        if (operation === 'get') {
            for (const value of Object.values(response.clientExtensionResults.prf.results)) {
                expect(typeof value).toBe('string');
                expect(Buffer.from(value as string, 'base64url')).toHaveLength(32);
            }
        }
        expect(await finish(page)).toMatchObject({ ok: true, isCredential: true });
        expect(await page.evaluate(() => window.credential!.toJSON())).toEqual(response);
        if (operation === 'get') {
            expect(
                await page.evaluate(() => {
                    const results = window.credential!.getClientExtensionResults().prf!.results!;
                    return [results.first, results.second].map(
                        (value) => value instanceof ArrayBuffer && value.byteLength,
                    );
                }),
            ).toEqual([32, 32]);
        }
    }
});

test('copies request and response JSON', async ({ extension }) => {
    const { page, context } = extension;
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await start(page);
    await modal(page).locator('#copyRequestButton').click();
    await expect(modal(page).locator('#feedbackMessage')).toContainText('Request copied.');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        await modal(page).locator('#requestDisplay').inputValue(),
    );
    await modal(page).locator('#copyResponseButton').click();
    await expect(modal(page).locator('#feedbackMessage')).toContainText('Nothing to copy.');
    await query(page);
    await modal(page).locator('#copyResponseButton').click();
    await expect(modal(page).locator('#feedbackMessage')).toContainText('Response copied.');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        await modal(page).locator('#responseDisplay').inputValue(),
    );
});

test('queues concurrent requests and closes only the selected request', async ({ extension }) => {
    const { page } = extension;
    await start(page);
    const first = await page.locator('#webauthn-interceptor-iframe').getAttribute('src');
    await page.evaluate(() => {
        window.second = navigator.credentials.get({ publicKey: { challenge: new Uint8Array(32) } }).then(
            () => 'resolved',
            (error) => error.name,
        );
    });
    await modal(page).locator('#cancelButton').click();
    await expect(page.locator('#webauthn-interceptor-iframe')).not.toHaveAttribute('src', first!);
    await expect(modal(page).locator('#modalHeader')).toContainText('authentication');
    await modal(page).locator('#cancelButton').click();
    expect(await page.evaluate(() => window.second)).toBe('AbortError');
    await expect(page.locator('#webauthn-interceptor-iframe')).toHaveCount(0);
});

test('already aborted requests do not open a panel', async ({ extension }) => {
    const { page } = extension;
    const name = await page.evaluate(async () => {
        const controller = new AbortController();
        controller.abort();
        try {
            await navigator.credentials.get({
                publicKey: { challenge: new Uint8Array(32) },
                signal: controller.signal,
            });
        } catch (error) {
            return (error as Error).name;
        }
    });
    expect(name).toBe('AbortError');
    await expect(page.locator('#webauthn-interceptor-iframe')).toHaveCount(0);
});

test('native errors remain editable and native requests can be cancelled', async ({ extension }) => {
    const { page, context } = extension;
    await start(page, 'get');
    const request = JSON.parse(await modal(page).locator('#requestDisplay').inputValue());
    request.rpId = 'unrelated.example';
    await modal(page).locator('#requestDisplay').fill(JSON.stringify(request));
    await modal(page).locator('#proceedButton').click();
    await expect(modal(page).locator('#feedbackMessage')).not.toBeEmpty();
    await expect(modal(page).locator('#proceedButton')).toBeEnabled();
    await modal(page).locator('#cancelButton').click();
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', {
        options: {
            protocol: 'ctap2',
            transport: 'internal',
            hasResidentKey: true,
            hasUserVerification: true,
            isUserVerified: true,
            automaticPresenceSimulation: false,
        },
    });
    await start(page);
    await modal(page).locator('#proceedButton').click();
    await expect(modal(page).locator('#feedbackMessage')).toContainText('Waiting for the browser');
    await modal(page).locator('#cancelButton').click();
    await expect.poll(() => page.evaluate(() => window.result)).toMatchObject({ name: 'AbortError' });
    await expect(page.locator('#webauthn-interceptor-iframe')).toHaveCount(0);
});

test('late hooks remain downstream and cannot recurse into the interceptor', async ({ extension }) => {
    const { page, context } = extension;
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', {
        options: {
            protocol: 'ctap2',
            transport: 'internal',
            hasResidentKey: true,
            hasUserVerification: true,
            isUserVerified: true,
            automaticPresenceSimulation: true,
        },
    });
    await page.evaluate(() => {
        const captured = navigator.credentials.create;
        window.downstreamCalls = 0;
        navigator.credentials.create = async (options) => {
            window.downstreamCalls++;
            return captured.call(navigator.credentials, options);
        };
    });
    await start(page);
    await modal(page).locator('#proceedButton').click();
    await expect(modal(page).locator('#responseDisplay')).not.toHaveValue('');
    expect(await finish(page)).toMatchObject({ ok: true });
    expect(await page.evaluate(() => window.downstreamCalls)).toBe(1);
});

test('Proceed promotes conditional authentication to a browser prompt', async ({ extension }) => {
    const { page, context } = extension;
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', {
        options: {
            protocol: 'ctap2',
            transport: 'internal',
            hasResidentKey: true,
            hasUserVerification: true,
            isUserVerified: true,
            automaticPresenceSimulation: true,
        },
    });
    await start(page);
    await modal(page).locator('#proceedButton').click();
    await expect(modal(page).locator('#responseDisplay')).not.toHaveValue('');
    await finish(page);
    await start(page, 'get', {}, { mediation: 'conditional' });
    await modal(page).locator('#proceedButton').click();
    await expect(modal(page).locator('#responseDisplay')).not.toHaveValue('');
    expect(await finish(page)).toMatchObject({ ok: true });
});

test('attestation getters expose real authenticator data and public keys', async ({ extension }) => {
    const { page } = extension;
    for (const alg of [-7, -35, -257, -8]) {
        await start(page);
        const request = JSON.parse(await modal(page).locator('#requestDisplay').inputValue());
        request.pubKeyCredParams = [{ type: 'public-key', alg }];
        await modal(page).locator('#requestDisplay').fill(JSON.stringify(request));
        const credential = await query(page);
        if (alg === -7 && 'attestationObject' in credential.response) {
            const attestation = decodeCBOR(
                new Uint8Array(Buffer.from(credential.response.attestationObject, 'base64url')),
            );
            if (!(attestation instanceof Map)) throw new Error('Expected an attestation map.');
            const data = attestation.get('authData');
            if (!(data instanceof Uint8Array)) throw new Error('Expected authenticator data.');
            const extended = Buffer.concat([data, encodeCBOR(new Map([['test-extension', true]]))]);
            extended[32] |= 0x80;
            attestation.set('authData', extended);
            credential.response.attestationObject = Buffer.from(encodeCBOR(attestation)).toString(
                'base64url',
            );
            await modal(page).locator('#responseDisplay').fill(JSON.stringify(credential));
        }
        expect(await finish(page)).toMatchObject({ ok: true });
        const fields = await page.evaluate(() => {
            const response = (window.credential as PublicKeyCredential)
                .response as AuthenticatorAttestationResponse;
            return {
                alg: response.getPublicKeyAlgorithm(),
                data: [...new Uint8Array(response.getAuthenticatorData())],
                key: [...new Uint8Array(response.getPublicKey()!)],
            };
        });
        expect(fields.alg).toBe(alg);
        expect(fields.data.length).toBeGreaterThan(55);
        expect(fields.key.length).toBeGreaterThan(32);
    }
});

test('page abort during initial dispatch does not leave a stale panel', async ({ extension }) => {
    const { page } = extension;
    const outcome = await page.evaluate(async () => {
        const controller = new AbortController();
        const request = navigator.credentials.get({
            publicKey: { challenge: new Uint8Array(32) },
            signal: controller.signal,
        });
        controller.abort();
        try {
            await request;
        } catch (error) {
            return (error as Error).name;
        }
    });
    expect(outcome).toBe('AbortError');
    await start(page);
    await expect(modal(page).locator('#modalHeader')).toContainText('registration');
    await modal(page).locator('#cancelButton').click();
    await expect(page.locator('#webauthn-interceptor-iframe')).toHaveCount(0);
});

test('iframes expose only request IDs and a child frame receives its own response', async ({ extension }) => {
    const { page } = extension;
    await page.route('**/interceptor-child', (route) =>
        route.fulfill({
            contentType: 'text/html',
            body: '<!doctype html><html><body>Child frame</body></html>',
        }),
    );
    await page.evaluate(() => {
        const child = document.createElement('iframe');
        child.id = 'test-child';
        child.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:1000;background:white';
        child.src = location.origin + '/interceptor-child';
        document.body.append(child);
    });
    const child = page.frameLocator('#test-child');
    await expect(child.locator('body')).toContainText('Child frame');
    const frame = await page
        .locator('#test-child')
        .elementHandle()
        .then((handle) => handle!.contentFrame());
    await frame!.evaluate(() => {
        window.frameResult = undefined;
        navigator.credentials.get({ publicKey: { challenge: new Uint8Array(32) } }).then(
            () => {
                window.frameResult = 'resolved';
            },
            (error) => {
                window.frameResult = error.name;
            },
        );
    });
    const panel = child.frameLocator('#webauthn-interceptor-iframe');
    await expect(panel.locator('#proceedButton')).toBeEnabled();
    const url = new URL((await child.locator('#webauthn-interceptor-iframe').getAttribute('src'))!);
    expect([...url.searchParams.keys()]).toEqual(['requestId']);
    await settleFrame(panel);
    await panel.locator('#cancelButton').click();
    await expect.poll(() => frame!.evaluate(() => window.frameResult)).toBe('AbortError');
    await expect(child.locator('#webauthn-interceptor-iframe')).toHaveCount(0);
});

test('cancelling a remote request aborts its connection and expires the session', async ({
    extension,
    authenticator,
}) => {
    const { createServer } = await import('node:http');
    const { once } = await import('node:events');
    const { page, popup } = extension;
    let respond: (() => void) | undefined;
    let connectionClosed: Promise<unknown> | undefined;
    const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const upstream = await fetch(`${authenticator.url}/api/v1/attest`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${authenticator.token}`, 'Content-Type': 'application/json' },
            body: Buffer.concat(chunks),
        });
        const body = await upstream.text();
        connectionClosed = once(response, 'close');
        respond = () => {
            response.writeHead(upstream.status, { 'Content-Type': 'application/json' });
            response.end(body);
        };
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
        const address = server.address() as import('node:net').AddressInfo;
        await popup.locator('#badAuthenticatorUrl').fill(`http://127.0.0.1:${address.port}`);
        await popup.locator('#badAuthenticatorUrl').press('Tab');
        await start(page);
        const requestId = new URL(
            (await page.locator('#webauthn-interceptor-iframe').getAttribute('src'))!,
        ).searchParams.get('requestId');
        await modal(page).locator('#queryBadAuthenticator').click();
        await expect.poll(() => !!respond).toBe(true);
        await expect(modal(page).locator('#queryBadAuthenticator')).toBeDisabled();
        await modal(page).locator('#cancelButton').click();
        await connectionClosed;
        respond!();
        await expect(page.locator('#webauthn-interceptor-iframe')).toHaveCount(0);
        const result = await popup.evaluate(
            (requestId) =>
                chrome.runtime.sendMessage({ type: 'GET_INTERCEPTOR_PAYLOAD', payload: { requestId } }),
            requestId,
        );
        expect(result.error).toContain('request has ended');
        await start(page);
        await expect(modal(page).locator('#responseDisplay')).toHaveValue('');
        await modal(page).locator('#cancelButton').click();
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

test('worker restarts preserve paused edits and responses awaiting review', async ({ extension }) => {
    const { page, popup, context } = extension;
    const cdp = await context.newCDPSession(page);
    await cdp.send('ServiceWorker.enable');
    await start(page);
    const src = (await page.locator('#webauthn-interceptor-iframe').getAttribute('src'))!;
    const requestId = new URL(src).searchParams.get('requestId');
    const edited = JSON.parse(await modal(page).locator('#requestDisplay').inputValue());
    edited.challenge = 'ZWRpdGVkLWNoYWxsZW5nZQ';
    await modal(page).locator('#requestDisplay').fill(JSON.stringify(edited));
    await cdp.send('ServiceWorker.stopAllWorkers');
    const restored = await popup.evaluate(
        (requestId) =>
            chrome.runtime.sendMessage({ type: 'GET_INTERCEPTOR_PAYLOAD', payload: { requestId } }),
        requestId,
    );
    expect(restored.state).toBe('editing');
    expect(JSON.parse(await modal(page).locator('#requestDisplay').inputValue())).toEqual(edited);
    const response = await query(page);
    expect(JSON.parse(Buffer.from(response.response.clientDataJSON!, 'base64url').toString()).challenge).toBe(
        edited.challenge,
    );
    await cdp.send('ServiceWorker.stopAllWorkers');
    expect(await finish(page)).toMatchObject({ ok: true, credential: response });
    await expect.poll(() => popup.evaluate(() => chrome.storage.session.get(null))).toEqual({});
});

test('credential selection survives a worker restart with edited options', async ({ extension }) => {
    const { page, popup, context } = extension;
    await start(page);
    const registration = await query(page);
    await finish(page);
    await start(page, 'get');
    const requestId = new URL(
        (await page.locator('#webauthn-interceptor-iframe').getAttribute('src'))!,
    ).searchParams.get('requestId');
    const edited = JSON.parse(await modal(page).locator('#requestDisplay').inputValue());
    edited.challenge = 'ZWRpdGVkLWNoYWxsZW5nZQ';
    await modal(page).locator('#requestDisplay').fill(JSON.stringify(edited));
    await modal(page).locator('#queryBadAuthenticator').click();
    await expect(selector(page).getByRole('option').filter({ hasText: registration.id })).toBeVisible();
    const cdp = await context.newCDPSession(page);
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');
    const restored = await popup.evaluate(
        (requestId) =>
            chrome.runtime.sendMessage({ type: 'GET_INTERCEPTOR_PAYLOAD', payload: { requestId } }),
        requestId,
    );
    expect(restored.state).toBe('selecting');
    await settleFrame(selector(page));
    await selector(page).getByRole('option').filter({ hasText: registration.id }).click();
    await selector(page).locator('#selectButton').click();
    await expect(modal(page).locator('#responseDisplay')).not.toHaveValue('');
    const response = JSON.parse(await modal(page).locator('#responseDisplay').inputValue());
    expect(JSON.parse(Buffer.from(response.response.clientDataJSON, 'base64url').toString()).challenge).toBe(
        edited.challenge,
    );
    expect(await finish(page)).toMatchObject({ ok: true, credential: { id: registration.id } });
});

test('worker recovery does not repeat a pending native call', async ({ extension }) => {
    const { page, popup, context } = extension;
    const cdp = await context.newCDPSession(page);
    await cdp.send('ServiceWorker.enable');
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', {
        options: {
            protocol: 'ctap2',
            transport: 'internal',
            hasResidentKey: true,
            hasUserVerification: true,
            isUserVerified: true,
            automaticPresenceSimulation: true,
        },
    });
    await page.evaluate(() => {
        const captured = navigator.credentials.create;
        window.downstreamCalls = 0;
        navigator.credentials.create = async (options) => {
            window.downstreamCalls++;
            const credential = await captured.call(navigator.credentials, options);
            return new Promise((resolve) => {
                window.releaseNative = () => resolve(credential);
            });
        };
    });
    await start(page);
    const requestId = new URL(
        (await page.locator('#webauthn-interceptor-iframe').getAttribute('src'))!,
    ).searchParams.get('requestId');
    await modal(page).locator('#proceedButton').click();
    await expect.poll(() => page.evaluate(() => typeof window.releaseNative)).toBe('function');
    await cdp.send('ServiceWorker.stopAllWorkers');
    const restored = await popup.evaluate(
        (requestId) =>
            chrome.runtime.sendMessage({ type: 'GET_INTERCEPTOR_PAYLOAD', payload: { requestId } }),
        requestId,
    );
    expect(restored.state).toBe('native');
    const duplicate = await popup.evaluate(
        (requestId) =>
            chrome.runtime.sendMessage({
                type: 'WEBAUTHN_UI_DECISION',
                payload: { requestId, action: 'proceed', requestData: {} },
            }),
        requestId,
    );
    expect(duplicate.error).toContain('already in progress');
    await page.evaluate(() => window.releaseNative!());
    await expect(modal(page).locator('#responseDisplay')).not.toHaveValue('');
    expect(await finish(page)).toMatchObject({ ok: true });
    expect(await page.evaluate(() => window.downstreamCalls)).toBe(1);
});

test('interrupted remote calls recover without an automatic retry', async ({ extension }) => {
    const { createServer } = await import('node:http');
    const { once } = await import('node:events');
    const { page, popup, context } = extension;
    let calls = 0;
    const server = createServer(async (request, response) => {
        for await (const _chunk of request) {
            /* Read the full request before counting it. */
        }
        calls++;
        if (calls > 1) {
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end('{}');
        }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
        const address = server.address() as import('node:net').AddressInfo;
        await popup.locator('#badAuthenticatorUrl').fill(`http://127.0.0.1:${address.port}`);
        await popup.locator('#badAuthenticatorUrl').press('Tab');
        await start(page);
        const requestId = new URL(
            (await page.locator('#webauthn-interceptor-iframe').getAttribute('src'))!,
        ).searchParams.get('requestId');
        const edited = JSON.parse(await modal(page).locator('#requestDisplay').inputValue());
        edited.challenge = 'ZWRpdGVkLWNoYWxsZW5nZQ';
        await modal(page).locator('#requestDisplay').fill(JSON.stringify(edited));
        await modal(page).locator('#queryBadAuthenticator').click();
        await expect.poll(() => calls).toBe(1);
        const duplicate = await popup.evaluate(
            (requestId) =>
                chrome.runtime.sendMessage({
                    type: 'QUERY_BAD_AUTHENTICATOR',
                    payload: { requestId, requestData: {} },
                }),
            requestId,
        );
        expect(duplicate.error).toContain('already in progress');
        const cdp = await context.newCDPSession(page);
        await cdp.send('ServiceWorker.enable');
        await cdp.send('ServiceWorker.stopAllWorkers');
        await expect(modal(page).locator('#feedbackMessage')).toContainText('worker restarted');
        await expect(modal(page).locator('#proceedButton')).toBeEnabled();
        expect(JSON.parse(await modal(page).locator('#requestDisplay').inputValue())).toEqual(edited);
        expect(calls).toBe(1);
        await query(page);
        expect(calls).toBe(2);
        await modal(page).locator('#cancelButton').click();
        await expect.poll(() => popup.evaluate(() => chrome.storage.session.get(null))).toEqual({});
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});

test('navigation while the worker sleeps removes the old document request', async ({ extension }) => {
    const { page, popup, context } = extension;
    await start(page);
    const requestId = new URL(
        (await page.locator('#webauthn-interceptor-iframe').getAttribute('src'))!,
    ).searchParams.get('requestId');
    const cdp = await context.newCDPSession(page);
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');
    await page.route('https://navigation.test/**', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Navigated</title>' }),
    );
    await page.goto('https://navigation.test');
    await expect
        .poll(async () => {
            const values = await popup.evaluate(() => chrome.storage.session.get(null));
            return Object.keys(values);
        })
        .not.toContain(`request:${requestId}`);
    await expect(page.locator('#webauthn-interceptor-iframe')).toHaveCount(0);
});

test('malformed messages cannot change a pending request', async ({ extension }) => {
    const { page, popup } = extension;
    await start(page);
    const requestId = new URL(
        (await page.locator('#webauthn-interceptor-iframe').getAttribute('src'))!,
    ).searchParams.get('requestId');
    for (const message of [
        { type: 'WEBAUTHN_UI_DECISION', payload: { requestId, action: 'proceed' } },
        { type: 'WEBAUTHN_UI_DECISION', payload: { requestId, action: 'other' } },
        { type: 'QUERY_BAD_AUTHENTICATOR', payload: { requestId, requestData: [] } },
        { type: 'CREDENTIAL_SELECTED', payload: { requestId, selectedCredentialId: 42 } },
        { type: 'UNKNOWN', payload: { requestId } },
    ]) {
        const result = await popup.evaluate((message) => chrome.runtime.sendMessage(message), message);
        expect(result.error).toBe('Invalid extension message.');
    }
    await expect(modal(page).locator('#proceedButton')).toBeEnabled();
    await modal(page).locator('#responseDisplay').fill('null');
    expect(await finish(page)).toMatchObject({ ok: true, credential: null });
});

test('recovery displays a saved response that never reached the panel', async ({ extension }) => {
    const { page, popup, context } = extension;
    await start(page);
    const requestId = new URL(
        (await page.locator('#webauthn-interceptor-iframe').getAttribute('src'))!,
    ).searchParams.get('requestId');
    const cdp = await context.newCDPSession(page);
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');
    await popup.evaluate(async (requestId) => {
        const key = `request:${requestId}`;
        const saved = (await chrome.storage.session.get(key))[key];
        saved.event.eventType = 'response';
        saved.event.responseData = null;
        saved.version = crypto.randomUUID();
        await chrome.storage.session.set({ [key]: saved });
        await chrome.runtime.sendMessage({ type: 'GET_INTERCEPTOR_PAYLOAD', payload: { requestId } });
    }, requestId);
    await expect(modal(page).locator('#responseDisplay')).toHaveValue('null');
    expect(await finish(page)).toMatchObject({ ok: true, credential: null });
});

test('queued requests survive worker restarts and cancellation stays final', async ({ extension }) => {
    const { page, popup, context } = extension;
    await start(page);
    const first = (await page.locator('#webauthn-interceptor-iframe').getAttribute('src'))!;
    const requestId = new URL(first).searchParams.get('requestId');
    await page.evaluate(() => {
        window.second = navigator.credentials.get({ publicKey: { challenge: new Uint8Array(32) } }).then(
            () => 'resolved',
            (error) => error.name,
        );
    });
    await expect
        .poll(async () => Object.keys(await popup.evaluate(() => chrome.storage.session.get(null))).length)
        .toBe(2);
    const cdp = await context.newCDPSession(page);
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');
    await modal(page).locator('#cancelButton').click();
    await expect(page.locator('#webauthn-interceptor-iframe')).not.toHaveAttribute('src', first);
    await expect(modal(page).locator('#modalHeader')).toContainText('authentication');
    await cdp.send('ServiceWorker.stopAllWorkers');
    const ended = await popup.evaluate(
        (requestId) =>
            chrome.runtime.sendMessage({ type: 'GET_INTERCEPTOR_PAYLOAD', payload: { requestId } }),
        requestId,
    );
    expect(ended.error).toContain('request has ended');
    await settleFrame(modal(page));
    await modal(page).locator('#responseDisplay').fill('null');
    await modal(page).locator('#proceedButton').click();
    expect(await page.evaluate(() => window.second)).toBe('resolved');
    await expect.poll(() => popup.evaluate(() => chrome.storage.session.get(null))).toEqual({});
});

test('pagehide rejects promises before a page enters the back-forward cache', async ({ extension }) => {
    const { page, popup } = extension;
    await start(page);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    await expect.poll(() => page.evaluate(() => window.result)).toMatchObject({ name: 'AbortError' });
    await expect(page.locator('#webauthn-interceptor-iframe')).toHaveCount(0);
    await expect.poll(() => popup.evaluate(() => chrome.storage.session.get(null))).toEqual({});
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await start(page);
    await modal(page).locator('#responseDisplay').fill('null');
    expect(await finish(page)).toMatchObject({ ok: true, credential: null });
});

test('malformed attestation bytes remain available when getters cannot be reconstructed', async ({
    extension,
}) => {
    const { page } = extension;
    function authData(key: Uint8Array = new Uint8Array(), idLength = 0): Uint8Array {
        const header = Buffer.alloc(55);
        header[32] = 0x40;
        header.writeUInt16BE(idLength, 53);
        return Buffer.concat([header, key]);
    }
    function cose(entries: [number, CBORType][]): Uint8Array {
        return encodeCBOR(new Map<number, CBORType>(entries));
    }
    const noAttestedData = authData(
        cose([
            [1, 2],
            [3, -7],
        ]),
    );
    noAttestedData[32] = 0;
    const cases: { name: string; data?: Uint8Array; algorithm?: number }[] = [
        { name: 'invalid outer CBOR' },
        { name: 'truncated header', data: new Uint8Array(54) },
        { name: 'missing attested-data flag', data: noAttestedData },
        { name: 'credential ID exceeds remaining bytes', data: authData(new Uint8Array([0]), 100) },
        { name: 'missing key', data: authData() },
        { name: 'invalid key CBOR', data: authData(new Uint8Array([0xff])) },
        {
            name: 'unknown key type',
            data: authData(
                cose([
                    [1, 99],
                    [3, -7],
                ]),
            ),
            algorithm: -7,
        },
        {
            name: 'missing EC coordinate',
            data: authData(
                cose([
                    [1, 2],
                    [3, -7],
                    [-1, 1],
                    [-2, new Uint8Array(32)],
                ]),
            ),
            algorithm: -7,
        },
        {
            name: 'invalid EC point',
            data: authData(
                cose([
                    [1, 2],
                    [3, -7],
                    [-1, 1],
                    [-2, new Uint8Array(32)],
                    [-3, new Uint8Array(32)],
                ]),
            ),
            algorithm: -7,
        },
        {
            name: 'unsupported EC curve',
            data: authData(
                cose([
                    [1, 2],
                    [3, -7],
                    [-1, 99],
                    [-2, new Uint8Array(32)],
                    [-3, new Uint8Array(32)],
                ]),
            ),
            algorithm: -7,
        },
    ];
    for (const sample of cases) {
        await test.step(sample.name, async () => {
            const bytes = sample.data
                ? encodeCBOR(new Map([['authData', sample.data]]))
                : new Uint8Array([0xff]);
            await start(page);
            await modal(page)
                .locator('#responseDisplay')
                .fill(
                    JSON.stringify({
                        id: 'AQID',
                        rawId: 'AQID',
                        type: 'public-key',
                        clientExtensionResults: {},
                        response: {
                            clientDataJSON: 'e30',
                            attestationObject: Buffer.from(bytes).toString('base64url'),
                        },
                    }),
                );
            expect(await finish(page)).toMatchObject({ ok: true });
            const fields = await page.evaluate(() => {
                const response = window.credential!.response as AuthenticatorAttestationResponse;
                let data: number[] | undefined;
                let algorithm: number | undefined;
                try {
                    data = [...new Uint8Array(response.getAuthenticatorData())];
                } catch {}
                try {
                    algorithm = response.getPublicKeyAlgorithm();
                } catch {}
                return {
                    bytes: [...new Uint8Array(response.attestationObject)],
                    data,
                    algorithm,
                    key: response.getPublicKey(),
                };
            });
            expect(fields.bytes).toEqual([...bytes]);
            expect(fields.data).toEqual(sample.data ? [...sample.data] : undefined);
            expect(fields.algorithm).toBe(sample.algorithm);
            expect(fields.key).toBeNull();
        });
    }
});

test('unexpected key conversion errors remain visible and can be retried', async ({ extension }) => {
    const { page } = extension;
    await start(page);
    await query(page);
    await page.evaluate(() => {
        Object.defineProperty(crypto.subtle, 'importKey', {
            configurable: true,
            value: () => {
                throw new Error('Unexpected key conversion failure');
            },
        });
    });
    try {
        await modal(page).locator('#proceedButton').click();
        await expect(modal(page).locator('#feedbackMessage')).toContainText(
            'Unexpected key conversion failure',
        );
        await expect(modal(page).locator('#proceedButton')).toBeEnabled();
    } finally {
        await page.evaluate(() => Reflect.deleteProperty(crypto.subtle, 'importKey'));
    }
    expect(await finish(page)).toMatchObject({ ok: true });
});
