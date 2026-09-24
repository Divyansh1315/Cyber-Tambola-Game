/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Vitest configuration for Module 3 tests.
// Uses the jsdom environment so React Testing Library component tests
// can render, and loads a setup file that registers jest-dom matchers.
//
// envDir points at a directory with no .env files: Vite's default env
// loading otherwise picks up a developer's local .env.local (e.g. real
// VITE_SUPABASE_URL/VITE_SUPABASE_ANON_KEY set up for Module 6) even under
// Vitest, which every test in this suite assumes never happens -- none of
// them mock the real Supabase client, so a real .env.local would make
// GameSessionContext attempt genuine network calls during test runs.
export default defineConfig({
  plugins: [react()],
  envDir: '.vitest-env',
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: [
      'src/**/*.{test,spec}.{ts,tsx}',
      'supabase/**/*.{test,spec}.{ts,tsx}',
    ],
  },
})