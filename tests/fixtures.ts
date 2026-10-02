import { test as base, chromium, expect, BrowserContext, Page, Worker, FrameLocator } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import type { PublicKeyCredentialJSON } from '../src/common_types';

interface TestResult {
    ok: boolean;
    credential?: PublicKeyCredentialJSON | null;
    isCredential?: boolean;
    name?: string;
    message?: string;
}

declare global {
    interface Window {
        result?: TestResult;
        frameResult?: string;
        credential?: PublicKeyCredential | null;
        abortController: AbortController;
        second: Promise<string>;
        downstreamCalls: number;
        releaseNative?: () => void;
    }
}

type Authenticator = { url: string; token: string };
type Extension = { context: BrowserContext; worker: Worker; popup: Page; page: Page };
export const test = base.extend<{ extension: Extension }, { authenticator: Authenticator }>({
    authenticator: [
        async ({}, use) => {
            const token = randomBytes(24).toString('hex');
            const id = execFileSync(
                'docker',
                [
                    'run',
                    '--rm',
                    '-d',
                    '-p',
                    '127.0.0.1::8080',
                    '-e',
                    `BAD_AUTHENTICATOR_BEARER_TOKENS=${token}`,
                    process.env.BAD_AUTHENTICATOR_IMAGE ?? 'webauthn-interceptor-badauthenticator',
                    '--keystore-dir',
                    '/data/badauthenticator-keystore',
                    'serve',
                    '--bind-address',
                    '0.0.0.0',
                    '--port',
                    '8080',
                ],
                { encoding: 'utf8' },
            ).trim();
            try {
                const address = execFileSync('docker', ['port', id, '8080/tcp'], { encoding: 'utf8' }).trim();
                const url = `http://${address}`;
                await expect
                    .poll(async () => {
                        try {
                            return (
                                await fetch(`${url}/api/v1/listCredentials?rpid=webauthn.io`, {
                                    headers: { Authorization: `Bearer ${token}` },
                                })
                            ).status;
                        } catch {
                            return 0;
                        }
                    })
                    .toBe(200);
                await use({ url, token });
            } finally {
                execFileSync('docker', ['stop', id], { stdio: 'pipe' });
            }
        },
        { scope: 'worker' },
    ],
    extension: async ({ authenticator }, use, testInfo) => {
        const profile = await mkdtemp(join(tmpdir(), 'webauthn-interceptor-'));
        const path = resolve('dist');
        const context = await chromium.launchPersistentContext(profile, {
            channel: 'chromium',
            headless: true,
            args: [`--disable-extensions-except=${path}`, `--load-extension=${path}`],
            viewport: { width: 1440, height: 1100 },
        });
        try {
            const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
            const extensionId = new URL(worker.url()).host;
            const popup = await context.newPage();
            await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
            await popup.locator('#badAuthenticatorUrl').fill(authenticator.url);
            await popup.locator('#badAuthenticatorUrl').press('Tab');
            await popup.locator('#bearerToken').fill(authenticator.token);
            await popup.locator('#bearerToken').press('Tab');
            await expect
                .poll(() => worker.evaluate(() => chrome.storage.local.get('badAuthenticatorBearerToken')))
                .toMatchObject({ badAuthenticatorBearerToken: authenticator.token });
            const page = await context.newPage();
            await use({ context, worker, popup, page });
            if (testInfo.status !== testInfo.expectedStatus) {
                await page.screenshot({ path: testInfo.outputPath('failure.png'), fullPage: true });
            }
        } finally {
            await context.close();
            await rm(profile, { recursive: true, force: true });
        }
    },
});
export { expect };
export const modal = (page: Page) => page.frameLocator('#webauthn-interceptor-iframe');
export const selector = (page: Page) => page.frameLocator('#webauthn-credential-selector');

export async function settleFrame(frame: FrameLocator): Promise<void> {
    // Chrome may discard input just after a cross-origin frame moves. Give each
    // new extension frame time to settle before sending pointer or keyboard input.
    await expect
        .poll(() => frame.locator('html').evaluate(() => performance.now()), { intervals: [100] })
        .toBeGreaterThan(1000);
}

export async function localPage(page: Page): Promise<void> {
    await page.route('https://interceptor.test/**', (route) =>
        route.fulfill({
            contentType: 'text/html',
            body: '<!doctype html><html><body><h1>WebAuthn test</h1></body></html>',
        }),
    );
    await page.goto('https://interceptor.test');
    await expect
        .poll(() => page.evaluate(() => document.documentElement.dataset.requestInterceptorEnabled))
        .toBe('true');
}

export async function start(
    page: Page,
    operation: 'create' | 'get' = 'create',
    overrides = {},
    topLevel = {},
): Promise<void> {
    await page.evaluate(
        ({ operation, overrides, topLevel }) => {
            const state = window;
            state.result = undefined;
            state.abortController = new AbortController();
            const publicKey =
                operation === 'create'
                    ? {
                          rp: { id: location.hostname, name: 'Interceptor tests' },
                          user: {
                              id: new Uint8Array([1, 2, 3]),
                              name: 'test-user',
                              displayName: 'Test user',
                          },
                          challenge: crypto.getRandomValues(new Uint8Array(32)),
                          pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
                          authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
                      }
                    : {
                          challenge: crypto.getRandomValues(new Uint8Array(32)),
                          rpId: location.hostname,
                          userVerification: 'required',
                      };
            const options = {
                publicKey: { ...publicKey, ...overrides },
                signal: state.abortController.signal,
                ...topLevel,
            };
            const pending =
                operation === 'create'
                    ? navigator.credentials.create(options as CredentialCreationOptions)
                    : navigator.credentials.get(options as CredentialRequestOptions);
            pending
                .then((value) => {
                    const credential = value as PublicKeyCredential | null;
                    state.credential = credential;
                    state.result = {
                        ok: true,
                        credential: credential ? (credential.toJSON() as PublicKeyCredentialJSON) : null,
                        isCredential: value instanceof PublicKeyCredential,
                    };
                })
                .catch((error) => {
                    state.result = { ok: false, name: error.name, message: error.message };
                });
        },
        { operation, overrides, topLevel },
    );
    await expect(modal(page).locator('#proceedButton')).toBeEnabled();
    await settleFrame(modal(page));
}

export async function query(page: Page): Promise<PublicKeyCredentialJSON> {
    await settleFrame(modal(page));
    await modal(page).getByRole('button', { name: 'Query badAuthenticator', exact: true }).click();
    await expect
        .poll(async () => {
            const value = await modal(page).locator('#responseDisplay').inputValue();
            const feedback = await modal(page).locator('#feedbackMessage').innerText();
            return value || (feedback.startsWith('Waiting') ? '' : feedback);
        })
        .not.toBe('');
    const response = await modal(page).locator('#responseDisplay').inputValue();
    if (!response) throw new Error(await modal(page).locator('#feedbackMessage').innerText());
    await settleFrame(modal(page));
    return JSON.parse(await modal(page).locator('#responseDisplay').inputValue());
}

export async function finish(page: Page): Promise<TestResult> {
    await settleFrame(modal(page));
    await modal(page).getByRole('button', { name: 'Proceed', exact: true }).click();
    await expect(page.locator('#webauthn-interceptor-iframe')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => window.result)).not.toBeUndefined();
    return page.evaluate(() => window.result!);
}
