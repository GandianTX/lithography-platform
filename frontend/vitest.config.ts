import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    // e2e-real 目录只收纯逻辑单测（环境校验与证据策略）；
    // 其余 *-real.spec.ts 是 Playwright 真实用例（由专用 playwright 配置收集），绝不进入 vitest
    include: [
      'src/**/*.spec.{ts,tsx}',
      'e2e/helpers/*.spec.ts',
      'e2e-real/dedicated-e2e-environment.spec.ts',
      'e2e-real/credential-evidence-policy.spec.ts',
    ],
    setupFiles: ['./src/test/setup.ts'],
  },
});
