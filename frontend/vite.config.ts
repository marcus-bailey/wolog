/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The app lives at /wolog/, as on the apps server (spec §8). In development, Vite's server
// sends /wolog/api/ and /wolog/health to the API without the prefix (on the server, its nginx
// does that).
const PREFIX = '/wolog';
const api = {
  target: process.env.API_TARGET ?? 'http://localhost:8000',
  rewrite: (path: string) => path.slice(PREFIX.length),
};

export default defineConfig({
  base: `${PREFIX}/`,
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { [`${PREFIX}/api`]: api, [`${PREFIX}/health`]: api },
  },
  test: {
    environment: 'jsdom',
    // Vitest doesn't apply `base`; tests run with the production base path.
    env: { BASE_URL: `${PREFIX}/` },
    restoreMocks: true,
    setupFiles: ['./src/test-setup.ts'],
  },
});
