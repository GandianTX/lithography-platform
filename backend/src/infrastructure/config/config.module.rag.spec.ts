// src/infrastructure/config/config.module.rag.spec.ts
// P2-04 定向验证：用隔离子进程 + 合成生产变量加载真实 AppConfigModule。
//
// 覆盖：
// - 显式 disabled 时，无 RAG 配置、仅有残留 URL、残留非法超时／布尔值都能启动，且不解析 RAG 参数；
// - remote 完整配置可启动并正确解析；未设置模式保留既有 remote 默认；
// - remote 缺密钥、未设置模式只有 URL、非法模式／超时／布尔值按生产预检拒绝。
//
// 子进程只读取合成变量，不连接数据库、Redis 或任何真实服务。

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

jest.setTimeout(120_000);

const BACKEND_ROOT = join(__dirname, '..', '..', '..');

const LOAD_SCRIPT = `
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { ConfigService } = require('@nestjs/config');
const { AppConfigModule } = require('./src/infrastructure/config/config.module');
(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppConfigModule] }).compile();
  const config = moduleRef.get(ConfigService);
  console.log('RAG_CONFIG_RESULT:' + JSON.stringify(config.get('ragDiagnosis')));
  await moduleRef.close();
})().catch((error) => {
  console.error('RAG_CONFIG_ERROR:' + (error && error.message ? error.message : String(error)));
  process.exit(1);
});
`;

/** 仅满足生产必填与格式校验的最小合成变量，不含任何真实凭据。 */
const BASE_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  TS_NODE_COMPILER_OPTIONS: '{"rootDir":"."}',
  APP_HOST: '127.0.0.1',
  APP_PORT: '3000',
  APP_CORS_ENABLED: 'false',
  APP_CORS_CREDENTIALS: 'false',
  GRAPHQL_SANDBOX_ENABLED: 'false',
  GRAPHQL_INTROSPECTION_ENABLED: 'false',
  DB_HOST: '127.0.0.1',
  DB_PORT: '3306',
  DB_USER: 'synthetic',
  DB_PASS: 'synthetic',
  DB_NAME: 'synthetic',
  DB_SYNCHRONIZE: 'false',
  DB_LOGGING: 'false',
  REDIS_HOST: '127.0.0.1',
  REDIS_PORT: '6379',
  REDIS_DB: '0',
  REDIS_TLS: 'false',
  BULLMQ_PREFIX: 'synthetic',
  JWT_SECRET: 'synthetic-jwt-secret',
  JWT_ENABLE_REFRESH: 'false',
  PAGINATION_HMAC_SECRET: 'synthetic-pagination-secret',
  FIELD_ENCRYPTION_KEY: 'synthetic-field-key-32-bytes-long',
  FIELD_ENCRYPTION_IV: 'synthetic-field-iv',
  AI_PROVIDER_MODE: 'mock',
  AI_QUEUE_DEBUG_ENABLED: 'false',
  EMAIL_QUEUE_DEBUG_ENABLED: 'false',
};

const buildChildEnv = (extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('LITHO_RAG_')) {
      delete env[key];
    }
  }
  return { ...env, ...BASE_ENV, ...extra };
};

const runConfigModule = (extra: NodeJS.ProcessEnv) =>
  spawnSync(
    process.execPath,
    ['-r', 'ts-node/register/transpile-only', '-r', 'tsconfig-paths/register', '-e', LOAD_SCRIPT],
    {
      cwd: BACKEND_ROOT,
      env: buildChildEnv(extra),
      encoding: 'utf8',
      timeout: 60_000,
    },
  );

const parseRagConfig = (stdout: string): Record<string, unknown> => {
  const prefix = 'RAG_CONFIG_RESULT:';
  const line = stdout.split('\n').find((item) => item.startsWith(prefix));
  if (!line) {
    throw new Error(`子进程未输出 RAG 配置：${stdout}`);
  }
  return JSON.parse(line.slice(prefix.length)) as Record<string, unknown>;
};

const DISABLED_EXPECTED = {
  mode: 'disabled',
  baseUrl: '',
  apiKey: '',
  allowInsecureHttp: false,
  timeoutMs: 30000,
};

describe('AppConfigModule 的 RAG 生产配置入口', () => {
  it.each([
    ['disabled 且无 RAG 配置', { LITHO_RAG_MODE: 'disabled' }, DISABLED_EXPECTED],
    [
      'disabled 且只有残留 URL',
      { LITHO_RAG_MODE: 'disabled', LITHO_RAG_BASE_URL: 'https://rag.synthetic.invalid' },
      DISABLED_EXPECTED,
    ],
    [
      'disabled 且残留非法超时与布尔值',
      {
        LITHO_RAG_MODE: 'disabled',
        LITHO_RAG_TIMEOUT_MS: 'not-a-number',
        LITHO_RAG_ALLOW_TAILNET_HTTP: 'maybe',
      },
      DISABLED_EXPECTED,
    ],
    [
      '未设置模式且无 RAG 配置时保留 remote 默认',
      {},
      {
        mode: 'remote',
        baseUrl: '',
        apiKey: '',
        allowInsecureHttp: false,
        timeoutMs: 30000,
      },
    ],
    [
      'remote 完整配置',
      {
        LITHO_RAG_MODE: 'remote',
        LITHO_RAG_BASE_URL: 'https://rag.synthetic.invalid',
        LITHO_RAG_API_KEY: 'synthetic-rag-key',
        LITHO_RAG_TIMEOUT_MS: '15000',
        LITHO_RAG_ALLOW_TAILNET_HTTP: 'true',
      },
      {
        mode: 'remote',
        baseUrl: 'https://rag.synthetic.invalid',
        apiKey: 'synthetic-rag-key',
        allowInsecureHttp: true,
        timeoutMs: 15000,
      },
    ],
    [
      '未设置模式但 URL 与密钥齐全',
      {
        LITHO_RAG_BASE_URL: 'https://rag.synthetic.invalid',
        LITHO_RAG_API_KEY: 'synthetic-rag-key',
      },
      {
        mode: 'remote',
        baseUrl: 'https://rag.synthetic.invalid',
        apiKey: 'synthetic-rag-key',
        allowInsecureHttp: false,
        timeoutMs: 30000,
      },
    ],
  ])('%s 时进程可启动且配置正确', (_title, extra, expected) => {
    const result = runConfigModule(extra);
    expect(result.status).toBe(0);
    expect(parseRagConfig(result.stdout)).toEqual(expected);
  });

  it.each([
    [
      'remote 有 URL 但缺密钥',
      { LITHO_RAG_MODE: 'remote', LITHO_RAG_BASE_URL: 'https://rag.synthetic.invalid' },
      'LITHO_RAG_MODE=remote requires LITHO_RAG_BASE_URL and LITHO_RAG_API_KEY',
    ],
    [
      '未设置模式但只有 URL',
      { LITHO_RAG_BASE_URL: 'https://rag.synthetic.invalid' },
      'LITHO_RAG_BASE_URL and LITHO_RAG_API_KEY must be configured together',
    ],
    ['非法模式', { LITHO_RAG_MODE: 'bogus' }, 'LITHO_RAG_MODE must be either disabled or remote'],
    [
      'remote 非法超时',
      {
        LITHO_RAG_MODE: 'remote',
        LITHO_RAG_BASE_URL: 'https://rag.synthetic.invalid',
        LITHO_RAG_API_KEY: 'synthetic-rag-key',
        LITHO_RAG_TIMEOUT_MS: 'not-a-number',
      },
      'LITHO_RAG_TIMEOUT_MS must be an integer',
    ],
    [
      'remote 非法私网开关',
      {
        LITHO_RAG_MODE: 'remote',
        LITHO_RAG_BASE_URL: 'https://rag.synthetic.invalid',
        LITHO_RAG_API_KEY: 'synthetic-rag-key',
        LITHO_RAG_ALLOW_TAILNET_HTTP: 'maybe',
      },
      'LITHO_RAG_ALLOW_TAILNET_HTTP must be a boolean-like value',
    ],
  ])('%s 时按生产预检拒绝启动', (_title, extra, message) => {
    const result = runConfigModule(extra);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(message);
  });
});
