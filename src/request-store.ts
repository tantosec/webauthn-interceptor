import { isPageInterceptorEvent, isRecord, WebAuthnInterceptorEventPayload } from './common_types';
import { isRequestState, RequestState } from './protocol';

export interface RequestSession {
    event: WebAuthnInterceptorEventPayload;
    tabId: number;
    frameId: number;
    documentId: string;
    defaultRpId: string;
    state: RequestState;
    version: string;
    attemptId?: string;
}
const prefix = 'request:';

function isSession(value: unknown): value is RequestSession {
    return (
        isRecord(value) &&
        isPageInterceptorEvent(value.event) &&
        Number.isInteger(value.tabId) &&
        Number.isInteger(value.frameId) &&
        typeof value.documentId === 'string' &&
        typeof value.defaultRpId === 'string' &&
        isRequestState(value.state) &&
        typeof value.version === 'string' &&
        (value.attemptId === undefined || typeof value.attemptId === 'string') &&
        ((value.state !== 'native' && value.state !== 'returning') || typeof value.attemptId === 'string')
    );
}

// Only short state changes run in this queue. Authenticator I/O runs outside it,
// so a slow server cannot hold up cancellation or another request.
export class RequestStore {
    private sessions = new Map<string, RequestSession>();
    private ready = this.restore();
    private tail: Promise<unknown> = Promise.resolve();

    private async restore(): Promise<void> {
        const values: Record<string, unknown> = await chrome.storage.session.get(null);
        for (const [key, value] of Object.entries(values)) {
            if (!key.startsWith(prefix)) continue;
            if (isSession(value) && key === prefix + value.event.requestId) {
                this.sessions.set(value.event.requestId, value);
            } else {
                await chrome.storage.session.remove(key);
            }
        }
    }
    run<T>(action: () => Promise<T>): Promise<T> {
        const result = this.tail.then(async () => {
            await this.ready;
            return action();
        });
        // Let the next action run even if this one fails. Return the failure to this caller.
        this.tail = result.catch(() => {});
        return result;
    }
    get(id: string): RequestSession | undefined {
        return this.sessions.get(id);
    }
    all(): RequestSession[] {
        return [...this.sessions.values()];
    }
    async put(session: RequestSession): Promise<void> {
        session.version = crypto.randomUUID();
        await chrome.storage.session.set({ [prefix + session.event.requestId]: session });
        this.sessions.set(session.event.requestId, session);
    }
    async remove(id: string): Promise<void> {
        await chrome.storage.session.remove(prefix + id);
        this.sessions.delete(id);
    }
}
