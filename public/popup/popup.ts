import { errorMessage } from '../../src/common_types';
import { parseAuthenticatorUrl } from '../../src/authenticator-url';

const enabled = document.getElementById('request-enableToggle') as HTMLInputElement;
const url = document.getElementById('badAuthenticatorUrl') as HTMLInputElement;
const token = document.getElementById('bearerToken') as HTMLInputElement;
const clear = document.getElementById('clearBadAuthenticatorConfig') as HTMLButtonElement;
const status = document.getElementById('settingsStatus') as HTMLParagraphElement;

async function save(values: Record<string, unknown>): Promise<void> {
    try {
        await chrome.storage.local.set(values);
        status.textContent = 'Saved.';
    } catch (error) {
        status.textContent = errorMessage(error);
    }
}

void chrome.storage.local
    .get(['request_interceptorEnabled', 'badAuthenticatorUrl', 'badAuthenticatorBearerToken'])
    .then((config) => {
        enabled.checked = config.request_interceptorEnabled !== false;
        url.value = config.badAuthenticatorUrl ?? '';
        token.value = config.badAuthenticatorBearerToken ?? '';
    })
    .catch((error) => {
        status.textContent = errorMessage(error);
        enabled.disabled = url.disabled = token.disabled = clear.disabled = true;
    });
enabled.addEventListener('change', () => {
    void save({ request_interceptorEnabled: enabled.checked });
});
url.addEventListener('input', () => url.setCustomValidity(''));
url.addEventListener('change', () => {
    const value = url.value.trim();
    try {
        if (value) parseAuthenticatorUrl(value);
    } catch (error) {
        url.setCustomValidity(errorMessage(error));
        url.reportValidity();
        return;
    }
    url.setCustomValidity('');
    void save({ badAuthenticatorUrl: value });
});
token.addEventListener('change', () => {
    void save({ badAuthenticatorBearerToken: token.value });
});
clear.addEventListener('click', async () => {
    try {
        await chrome.storage.local.remove(['badAuthenticatorUrl', 'badAuthenticatorBearerToken']);
        url.value = token.value = '';
        url.setCustomValidity('');
        status.textContent = 'Configuration cleared.';
    } catch (error) {
        status.textContent = errorMessage(error);
    }
});
