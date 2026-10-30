import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser', timeout: 45000, fullyParallel: false, workers: 1,
  reporter: [['list'], ['json', { outputFile: 'artifacts/browser-results.json' }]],
  use: { browserName: 'chromium', viewport: { width: 1440, height: 900 }, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'local', testMatch: /plaza\.spec\.js/, use: { baseURL: 'http://127.0.0.1:3107' } },
    { name: 'accounts', testMatch: /(?:accounts|skill-pairing|spectator|autonomy|passwordless|games|adventure|life|pixel-world|speech|observer)\.spec\.js/, use: { baseURL: 'http://127.0.0.1:3108' } },
  ],
  webServer: [
    { command: 'node tests/e2e-server.js', url: 'http://127.0.0.1:3107/api/health', reuseExistingServer: false, timeout: 30000 },
    { command: 'node tests/accounts-e2e-server.js', url: 'http://127.0.0.1:3108/api/health', reuseExistingServer: false, timeout: 30000 },
  ],
});
