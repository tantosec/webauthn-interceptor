export type MessageType = 'info' | 'error' | 'success';

const feedback = document.getElementById('feedbackMessage') as HTMLParagraphElement;
let timer: number | undefined;

export function showMessage(message: string, type: MessageType = 'info', duration = 3000): void {
    window.clearTimeout(timer);
    feedback.textContent = message;
    feedback.style.color = { error: '#b91c1c', success: '#166534', info: '#111827' }[type];
    if (duration > 0)
        timer = window.setTimeout(() => {
            feedback.textContent = '';
        }, duration);
}
