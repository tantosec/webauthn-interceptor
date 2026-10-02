import { dismissPanel, panelRequestId, sendBackground, WorkerConnectionError } from '../protocol';

const list = document.getElementById('credentialList') as HTMLDivElement;
const status = document.getElementById('loadingMessage') as HTMLParagraphElement;
const select = document.getElementById('selectButton') as HTMLButtonElement;
const cancel = document.getElementById('cancelButton') as HTMLButtonElement;
let selectedId: string | undefined;

function showError(error: unknown): void {
    status.hidden = false;
    status.textContent = error instanceof Error ? error.message : String(error);
    status.style.color = '#b91c1c';
}

async function load(retry = true): Promise<void> {
    try {
        list.replaceChildren(status);
        status.hidden = false;
        const { credentials, rpid } = await sendBackground({
            type: 'FETCH_CREDENTIALS_FOR_RPID',
            payload: { requestId: panelRequestId() },
        });
        if (!credentials.length) {
            status.textContent = `No credentials found for ${rpid}.`;
            return;
        }
        status.hidden = true;
        for (const credential of credentials) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className =
                'credential-item block w-full text-left p-3 border border-gray-300 rounded hover:bg-gray-100 focus:ring-2 focus:ring-red-500';
            button.setAttribute('role', 'option');
            button.setAttribute('aria-selected', 'false');
            const date =
                credential.creationDate === undefined
                    ? 'Unknown'
                    : new Date(credential.creationDate).toLocaleString();
            for (const text of [
                `ID: ${credential.credentialId}`,
                `User: ${credential.userHandle || 'Unknown'}`,
                `Created: ${date}`,
            ]) {
                const line = document.createElement('p');
                line.className = 'font-mono text-xs break-all';
                line.textContent = text;
                button.appendChild(line);
            }
            button.addEventListener('click', () => {
                for (const option of list.querySelectorAll('[role="option"]')) {
                    const chosen = option === button;
                    option.setAttribute('aria-selected', String(chosen));
                    option.classList.toggle('bg-red-100', chosen);
                }
                selectedId = credential.credentialId;
                select.disabled = false;
            });
            list.appendChild(button);
        }
        list.querySelector<HTMLButtonElement>('button')?.focus();
    } catch (error) {
        if (retry && error instanceof WorkerConnectionError) await load(false);
        else showError(error);
    }
}
select.addEventListener('click', async () => {
    if (!selectedId) return;
    select.disabled = true;
    try {
        await sendBackground({
            type: 'CREDENTIAL_SELECTED',
            payload: { requestId: panelRequestId(), selectedCredentialId: selectedId },
        });
    } catch (error) {
        select.disabled = false;
        if (error instanceof WorkerConnectionError) {
            // Reading the request wakes the worker and recovers an interrupted call.
            try {
                await sendBackground({
                    type: 'GET_INTERCEPTOR_PAYLOAD',
                    payload: { requestId: panelRequestId() },
                });
            } catch {}
        }
        showError(error);
    }
});
cancel.addEventListener('click', async () => {
    try {
        await sendBackground({
            type: 'CANCEL_WEBAUTHN_FROM_SELECTOR',
            payload: { requestId: panelRequestId() },
        });
    } catch {
        // Closing the panel must also work after the session has ended.
    } finally {
        dismissPanel();
    }
});
document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') cancel.click();
});
void load();
