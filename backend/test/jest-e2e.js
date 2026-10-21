// test/jest-e2e.js

const GROUPS = {
  core: {
    specs: [
      'test/00-app/00-app.e2e-spec.ts',
      'test/01-auth/auth-identity.e2e-spec.ts',
      'test/01-auth/auth.e2e-spec.ts',
      'test/02-register/register.e2e-spec.ts',
      'test/02-register/register-email-active.e2e-spec.ts',
      'test/02-register/weapp-register-active.e2e-spec.ts',
      'test/03-roles-guard/roles-guard.e2e-spec.ts',
      'test/04-user-info/update-access-group.e2e-spec.ts',
      'test/04-user-info/update-visible-user-info.e2e-spec.ts',
      'test/04-user-info/user-state-write-guard.e2e-spec.ts',
      'test/04-user-info/admin-user-management.e2e-spec.ts',
      'test/04-user-info/my-account-settings.e2e-spec.ts',
      'test/04-user-info/my-account-settings-write.e2e-spec.ts',
      'test/04-user-info/my-account-settings-write-production.e2e-spec.ts',
      'test/05-verification-record/verification-record-types.e2e-spec.ts',
      'test/05-verification-record/verification-record-invite.e2e-spec.ts',
      'test/06-repair-request/repair-request-auth.e2e-spec.ts',
      'test/06-repair-request/repair-request-delete.e2e-spec.ts',
      'test/06-repair-request/repair-request-flow.e2e-spec.ts',
      'test/06-repair-request/repair-request-read.e2e-spec.ts',
      'test/06-repair-request/repair-request-accept.e2e-spec.ts',
      'test/06-repair-request/repair-request-fixture-ownership.e2e-spec.ts',
      'test/06-repair-request/repair-request-production-input.e2e-spec.ts',
      'test/06-repair-request/repair-request-response.e2e-spec.ts',
      'test/07-pagination-sort-search/pagination.e2e-spec.ts',
      'test/07-pagination-sort-search/search.e2e-spec.ts',
      'test/07-pagination-sort-search/sort.e2e-spec.ts',
      'test/09-reference-document/reference-document.e2e-spec.ts',
      'test/10-admin-document-database/admin-document-database.e2e-spec.ts',
      'test/10-admin-document-database/admin-document-database-fixture-ownership.e2e-spec.ts',
      'test/10-admin-document-database/admin-document-database-cleanup-failure.e2e-spec.ts',
      'test/10-admin-document-database/admin-document-database-production.e2e-spec.ts',
      'test/10-admin-document-database/admin-document-database-production-ownership.e2e-spec.ts',
      'test/11-content-submission/content-submission-integration.e2e-spec.ts',
      'test/11-content-submission/content-submission-graphql.e2e-spec.ts',
      'test/12-reference-document-case/reference-document-case.e2e-spec.ts',
      'test/11-content-submission/frontend-response-samples.e2e-spec.ts',
      'test/utils/e2e-db-guard.e2e-spec.ts',
      'test/utils/e2e-scoped-cleanup.e2e-spec.ts',
      'test/utils/e2e-scoped-cleanup-ownership.e2e-spec.ts',
      'test/utils/test-accounts-atomicity.e2e-spec.ts',
    ],
    needs: {
      mysql: true,
      redis: false,
      bullmq: false,
      external: false,
    },
    runInBand: true,
  },
  worker: {
    specs: [
      'test/08-qm-worker/email-queue-consume.e2e-spec.ts',
      'test/08-qm-worker/ai-graphql-queue.e2e-spec.ts',
      'test/08-qm-worker/ai-worker-consume-persistence.e2e-spec.ts',
      'test/08-qm-worker/ai-worker-consume-execution.e2e-spec.ts',
      'test/08-qm-worker/ai-workflow-generic-handler.e2e-spec.ts',
    ],
    needs: {
      mysql: true,
      redis: true,
      bullmq: true,
      external: false,
    },
    runInBand: true,
  },
  smoke: {
    specs: [
      'test/99-third-party-live-smoke/email-delivery-real.e2e-spec.ts',
      'test/99-third-party-live-smoke/ai-qwen-generate-real.e2e-spec.ts',
      'test/99-third-party-live-smoke/weapp-qrcode-real.e2e-spec.ts',
    ],
    needs: {
      mysql: true,
      redis: true,
      bullmq: true,
      external: true,
    },
    runInBand: true,
  },
};

const DEFAULT_GROUP = 'core';

// 为了确保 rootDir 解析稳定，使用绝对路径
const path = require('path');

const parseCsv = (raw) =>
  (raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const normalizeSpecPath = (raw) => {
  const spec = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (spec.startsWith('<rootDir>/') || path.isAbsolute(spec)) {
    return spec;
  }
  return `<rootDir>/${spec}`;
};

const requestedGroup = (process.env.E2E_GROUP || '').trim();
const selectedGroupName = requestedGroup || DEFAULT_GROUP;
const selectedGroup = GROUPS[selectedGroupName];

if (!selectedGroup) {
  throw new Error(`Unknown E2E_GROUP: ${selectedGroupName}`);
}

const fromEnv = parseCsv(process.env.E2E_SPECS);
const selectedSpecs = fromEnv.length ? fromEnv : selectedGroup.specs;
const selected = selectedSpecs.map(normalizeSpecPath);

process.env.E2E_GROUP = selectedGroupName;
if (!process.env.E2E_NEEDS || process.env.E2E_NEEDS.trim().length === 0) {
  process.env.E2E_NEEDS = Object.entries(selectedGroup.needs)
    .filter((entry) => entry[1] === true)
    .map((entry) => entry[0])
    .join(',');
}

const fallbackPattern = ['<rootDir>/test/**/?(*.)e2e-spec.ts'];
const isWatchMode = process.argv.some((arg) => arg === '--watch' || arg === '--watchAll');

const jestConfig = {
  preset: 'ts-jest',
  // 原来是 '../'，改为绝对路径更稳妥
  rootDir: path.resolve(__dirname, '..'),
  testEnvironment: 'node',

  moduleFileExtensions: ['ts', 'js', 'json'],

  // 关键：文件级开关
  testMatch: selected.length ? selected : fallbackPattern,

  testPathIgnorePatterns: ['/node_modules/', '\\.skip\\.ts$', '/__.*\\.skip__/', '/.*\\.skip/'],

  transform: {
    '^.+\\.(t|j)s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },

  dependencyExtractor: '<rootDir>/test/jest-type-dependency-extractor.js',

  setupFiles: ['tsconfig-paths/register'],

  globalSetup: '<rootDir>/test/global-setup-e2e.ts',
  globalTeardown: '<rootDir>/test/global-teardown-e2e.ts',

  moduleNameMapper: {
    '^@src/(.*)$': '<rootDir>/src/$1',
    '^@core/(.*)$': '<rootDir>/src/core/$1',
    '^@modules/(.*)$': '<rootDir>/src/modules/$1',
    '^@usecases/(.*)$': '<rootDir>/src/usecases/$1',
    '^@adapters/(.*)$': '<rootDir>/src/adapters/$1',
    '^@shared/(.*)$': '<rootDir>/src/shared/$1',
    '^@app-types/(.*)$': '<rootDir>/src/types/$1',
    '^src/(.*)$': '<rootDir>/src/$1',
  },

  testTimeout: 30000,

  // 串行执行由 CLI --runInBand 控制；避免与 CLI 互斥参数冲突
  // 如需并发可移除此配置，改用 CLI 侧控制
  // maxWorkers: 1,

  forceExit: true,
  detectOpenHandles: true,
};

if (isWatchMode) {
  // ts-jest can reuse stale semantic diagnostics for erased type-only imports in watch mode.
  // Keep normal one-shot e2e runs cached; make watch reloads deterministic.
  jestConfig.cache = false;
}

module.exports = jestConfig;
Object.defineProperty(module.exports, '__GROUPS', {
  value: GROUPS,
  enumerable: false,
});
