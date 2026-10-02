import { errorMessage, isRecord, WebAuthnInterceptorEventPayload } from '../common_types';
import {
    dismissPanel,
    panelRequestId,
    RequestState,
    sendBackground,
    WorkerConnectionError,
} from '../protocol';
import { showMessage } from './message-handler';

const header = document.getElementById('modalHeader') as HTMLHeadingElement;
const requestField = document.getElementById('requestDisplay') as HTMLTextAreaElement;
const responseField = document.getElementById('responseDisplay') as HTMLTextAreaElement;
const proceedButton = document.getElementById('proceedButton') as HTMLButtonElement;
const cancelButton = document.getElementById('cancelButton') as HTMLButtonElement;
const queryButton = document.getElementById('queryBadAuthenticator') as HTMLButtonElement;
const copyRequestButton = document.getElementById('copyRequestButton') as HTMLButtonElement;
const copyResponseButton = document.getElementById('copyResponseButton') as HTMLButtonElement;
const remoteSection = document.getElementById('remoteAuthenticatorSection') as HTMLElement;
const jsonError = document.getElementById('jsonError') as HTMLParagraphElement;
let requestLoaded = false;
let hasRemoteAuthenticator = false;

function setBusy(isBusy: boolean): void {
    proceedButton.disabled = isBusy;
    queryButton.disabled = isBusy || !hasRemoteAuthenticator;
    requestField.readOnly = isBusy;
    responseField.readOnly = isBusy;
}

function parseJson(text: string, label: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        throw new Error(`${label} is not valid JSON.`);
    }
}

function readRequest(): Record<string, unknown> {
    const value = parseJson(requestField.value, 'Request');
    if (!isRecord(value)) throw new Error('Request must be a JSON object.');
    return value;
}

function readResponse(): unknown {
    if (!responseField.value.trim()) return undefined;
    return parseJson(responseField.value, 'Response');
}

function validateJson(): void {
    try {
        readRequest();
        readResponse();
        jsonError.textContent = '';
    } catch (error) {
        jsonError.textContent = errorMessage(error);
    }
}

function showError(error: unknown): void {
    showMessage(errorMessage(error), 'error', 0);
}

function renderRequest(event: WebAuthnInterceptorEventPayload, state: RequestState): void {
    const operation = event.operationType === 'create' ? 'registration' : 'authentication';
    const suffix = event.eventType === 'response' ? ' response' : '';
    header.textContent = `WebAuthn ${operation}${suffix}`;
    requestField.value = JSON.stringify(event.requestData, null, 2);
    responseField.value = event.responseData === undefined ? '' : JSON.stringify(event.responseData, null, 2);

    hasRemoteAuthenticator = !!event.badAuthenticatorUrl;
    remoteSection.classList.toggle('hidden', !hasRemoteAuthenticator);
    requestLoaded = true;
    setBusy(state !== 'editing');
    copyRequestButton.disabled = false;
    copyResponseButton.disabled = false;

    if (event.errorData) showError(new Error(event.errorData.message));
    if (state !== 'editing') {
        showMessage('Waiting for the authenticator or credential selection. You can cancel.', 'info', 0);
    }
    requestField.focus();
}

async function loadRequest(): Promise<void> {
    setBusy(true);
    copyRequestButton.disabled = true;
    copyResponseButton.disabled = true;
    try {
        const { event, state } = await sendBackground({
            type: 'GET_INTERCEPTOR_PAYLOAD',
            payload: { requestId: panelRequestId() },
        });
        renderRequest(event, state);
    } catch (error) {
        showError(error);
        cancelButton.textContent = 'Close';
    }
}

async function handleActionError(error: unknown): Promise<void> {
    if (error instanceof WorkerConnectionError) {
        await loadRequest();
        return;
    }
    setBusy(false);
    showError(error);
}

async function proceedWithRequest(): Promise<void> {
    try {
        const requestData = readRequest();
        const responseData = readResponse();
        setBusy(true);
        await sendBackground({
            type: 'WEBAUTHN_UI_DECISION',
            payload: { requestId: panelRequestId(), action: 'proceed', requestData, responseData },
        });
        const message =
            responseData === undefined
                ? 'Waiting for the browser authenticator. You can cancel.'
                : 'Returning response…';
        showMessage(message, 'info', 0);
    } catch (error) {
        await handleActionError(error);
    }
}

async function queryAuthenticator(): Promise<void> {
    try {
        const requestData = readRequest();
        setBusy(true);
        showMessage('Waiting for badAuthenticator or credential selection. You can cancel.', 'info', 0);
        await sendBackground({
            type: 'QUERY_BAD_AUTHENTICATOR',
            payload: { requestId: panelRequestId(), requestData },
        });
    } catch (error) {
        await handleActionError(error);
    }
}

async function cancelRequest(): Promise<void> {
    cancelButton.disabled = true;
    try {
        if (requestLoaded) {
            await sendBackground({
                type: 'WEBAUTHN_UI_DECISION',
                payload: { requestId: panelRequestId(), action: 'cancel' },
            });
        }
    } catch {
        // The worker may have restarted or already removed this request.
    } finally {
        dismissPanel();
    }
}

async function copyJson(field: HTMLTextAreaElement, label: string): Promise<void> {
    if (!field.value.trim()) {
        showMessage('Nothing to copy.');
        return;
    }
    try {
        await navigator.clipboard.writeText(field.value);
        showMessage(`${label} copied.`, 'success');
    } catch {
        showMessage('Could not copy. Select the text and copy it manually.', 'error');
    }
}

proceedButton.addEventListener('click', proceedWithRequest);
queryButton.addEventListener('click', queryAuthenticator);
cancelButton.addEventListener('click', cancelRequest);
copyRequestButton.addEventListener('click', () => void copyJson(requestField, 'Request'));
copyResponseButton.addEventListener('click', () => void copyJson(responseField, 'Response'));
requestField.addEventListener('input', validateJson);
responseField.addEventListener('input', validateJson);
document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !cancelButton.disabled) cancelButton.click();
});
void loadRequest();
