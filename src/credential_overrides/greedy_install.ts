import { CreateBypass, GetBypass } from './common_override_utils';

type CreateFn = typeof navigator.credentials.create;
type GetFn = typeof navigator.credentials.get;

export interface GreedyResult {
    passthroughCreate: CreateFn;
    passthroughGet: GetFn;
}

// Keep the iframe attached. Its methods fail after removal.
function captureNativeFromIframe(container: CredentialsContainer): {
    nativeCreate?: CreateFn;
    nativeGet?: GetFn;
} {
    try {
        const root = document.documentElement || document.head || document.body;
        if (!root) {
            return {};
        }

        const iframe = document.createElement('iframe');
        iframe.setAttribute('aria-hidden', 'true');
        iframe.tabIndex = -1;
        iframe.style.cssText =
            'display:none !important;width:0;height:0;border:0;position:absolute;left:-9999px;';
        root.appendChild(iframe);

        const win = iframe.contentWindow as (Window & typeof globalThis) | null;
        const creds = win?.navigator?.credentials;
        if (!creds) {
            return {};
        }
        return {
            nativeCreate: creds.create.bind(container) as CreateFn,
            nativeGet: creds.get.bind(container) as GetFn,
        };
    } catch (error) {
        console.warn('WebAuthn Interceptor could not capture the browser credential methods.', error);
        return {};
    }
}

export function installGreedyCredentialOverrides(
    makeCreateOverride: (downstream: CreateFn, bypass: CreateBypass) => CreateFn,
    makeGetOverride: (downstream: GetFn, bypass: GetBypass) => GetFn,
): GreedyResult | null {
    const container = navigator.credentials;
    if (typeof container === 'undefined') {
        return null;
    }
    let downstreamCreate: CreateFn = container.create.bind(container);
    let downstreamGet: GetFn = container.get.bind(container);
    const native = captureNativeFromIframe(container);
    const nativeCreate: CreateFn = native.nativeCreate ?? downstreamCreate;
    const nativeGet: GetFn = native.nativeGet ?? downstreamGet;
    const createBypass: CreateBypass = { native: nativeCreate, guard: { active: false } };
    const getBypass: GetBypass = { native: nativeGet, guard: { active: false } };
    const passthroughCreate: CreateFn = (async (options?: CredentialCreationOptions) => {
        createBypass.guard.active = true;
        try {
            return await downstreamCreate.call(container, options);
        } finally {
            createBypass.guard.active = false;
        }
    }) as CreateFn;
    const passthroughGet: GetFn = (async (options?: CredentialRequestOptions) => {
        getBypass.guard.active = true;
        try {
            return await downstreamGet.call(container, options);
        } finally {
            getBypass.guard.active = false;
        }
    }) as GetFn;

    const ourCreate = makeCreateOverride(passthroughCreate, createBypass);
    const ourGet = makeGetOverride(passthroughGet, getBypass);

    // Preserve our wrapper when a later hook assigns to navigator.credentials.
    const lockAccessor = (
        prop: 'create' | 'get',
        ours: CreateFn | GetFn,
        capture: (fn: CreateFn | GetFn) => void,
    ): boolean => {
        try {
            Object.defineProperty(container, prop, {
                configurable: false,
                enumerable: true,
                get() {
                    return ours;
                },
                set(value: unknown) {
                    if (typeof value === 'function' && value !== ours) {
                        capture(value as CreateFn | GetFn);
                    }
                },
            });
            return true;
        } catch {
            return false;
        }
    };

    const lockedCreate = lockAccessor('create', ourCreate, (fn) => {
        downstreamCreate = (fn as CreateFn).bind(container);
    });
    const lockedGet = lockAccessor('get', ourGet, (fn) => {
        downstreamGet = (fn as GetFn).bind(container);
    });
    if (!lockedCreate || !lockedGet) {
        let warned = false;
        const reassert = (): void => {
            try {
                if (!lockedCreate && container.create !== ourCreate) {
                    if (typeof container.create === 'function') {
                        downstreamCreate = container.create.bind(container);
                    }
                    container.create = ourCreate;
                }
                if (!lockedGet && container.get !== ourGet) {
                    if (typeof container.get === 'function') {
                        downstreamGet = container.get.bind(container);
                    }
                    container.get = ourGet;
                }
            } catch (error) {
                if (!warned) {
                    console.warn(
                        'WebAuthn Interceptor could not replace an existing credential hook.',
                        error,
                    );
                    warned = true;
                }
            }
        };
        reassert();
        const intervalId = window.setInterval(reassert, 50);
        window.setTimeout(() => window.clearInterval(intervalId), 3000);
    }

    return { passthroughCreate, passthroughGet };
}
