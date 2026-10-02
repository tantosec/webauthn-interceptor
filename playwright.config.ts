import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: './tests',
    timeout: 45000,
    expect: { timeout: 10000 },
    workers: 1,
    retries: 0,
    use: { trace: 'retain-on-failure' },
    reporter: [['list'], ['html', { open: 'never' }]],
    projects: [{ name: 'local', testMatch: ['extension.spec.ts', 'protocol.spec.ts'] }],
});
