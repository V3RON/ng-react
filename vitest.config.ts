import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  test: {
    // Projects legitimately start empty and fill in stage by stage.
    passWithNoTests: true,
    projects: [
      {
        // Pure kernel tests: no DOM, no React renderer.
        // Enforces that the kernel + createTestKernel work in a plain Node env.
        test: {
          name: 'kernel',
          root: './packages/ng-react',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          globals: true,
        },
      },
      {
        // React binding tests. Convention: any test needing a renderer is a .tsx file.
        plugins: [react()],
        test: {
          name: 'kernel-dom',
          root: './packages/ng-react',
          environment: 'jsdom',
          include: ['src/**/*.test.tsx'],
          globals: true,
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'demo',
          root: './apps/react',
          environment: 'jsdom',
          include: ['src/**/*.test.{ts,tsx}'],
          globals: true,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      include: ['packages/ng-react/src/**'],
    },
  },
});
