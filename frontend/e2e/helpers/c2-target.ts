// e2e/helpers/c2-target.ts
// 任务05 C2 目标判定与核验（配置入口与 C2 用例共用同一结果）。
//
// 规则：
// - 没有任何 C2 专有变量：C2 只跳过，其他真实用例照常；
// - 存在任一 C2 专有变量但没有显式 `AI_E2E_C2=1`：拒绝（不允许「半启用」偷跑）；
// - 显式启用后缺目标／摘要／标记／控制地址：失败关闭；
// - 浏览器绑定必须与摘要前端端口一致，并经**同源代理**确认命中本轮后端实例。
//
// 本模块不读全局状态，所有输入显式注入，便于用替身覆盖反例。

import { existsSync, readFileSync } from 'node:fs';

export const C2_ENV = {
  controlUrl: 'AI_C2_CONTROL_URL',
  enable: 'AI_E2E_C2',
  failToken: 'AI_E2E_C2_TOKEN',
  okTag: 'AI_E2E_C2_OK_TAG',
  runTag: 'AI_E2E_C2_RUN_TAG',
  backend: 'AI_E2E_BACKEND_URL',
  targetFile: 'AI_E2E_C2_TARGET_FILE',
} as const;

/** 除启用开关外的 C2 专有变量；普通 AI 登录变量不在此列 */
const C2_OWNED_KEYS: readonly string[] = [
  C2_ENV.targetFile,
  C2_ENV.failToken,
  C2_ENV.okTag,
  C2_ENV.controlUrl,
  C2_ENV.runTag,
];

const DEFAULT_DEV_BACKEND = 'http://127.0.0.1:3005';
const HASH_PATTERN = /^[0-9a-f]{12}$/;
const MAX_INSTANCE_AGE_SECONDS = 900;
const STARTUP_TOLERANCE_SECONDS = 30;
export const C2_GRAPHQL_PATH = '/graphql';

/** The browser resolves the app's configured endpoint relative to its current origin. */
export function assertC2GraphQLBinding(baseURL: string, endpoint: string): void {
  const expected = new URL(C2_GRAPHQL_PATH, baseURL);
  if (new URL(endpoint, baseURL).href !== expected.href) {
    throw new Error('[c2-target] 浏览器 GraphQL 地址与本轮同源 /graphql 不一致');
  }
}

export interface C2TargetSummary {
  readonly apiBaseUrl: string;
  readonly apiPort: number;
  readonly databaseInstanceHash: string;
  readonly databaseNameHash: string;
  readonly frontendPort: number;
  readonly providerPort: number;
  readonly redisInstanceHash: string;
  readonly redisPort: number;
  readonly runTag: string;
  readonly startedAt: string;
  readonly verified: boolean;
}

export type C2Resolution =
  | { readonly kind: 'disabled' }
  | { readonly kind: 'invalid'; readonly reason: string }
  | {
      readonly backendUrl: string;
      readonly controlUrl: string;
      readonly failToken: string;
      readonly kind: 'enabled';
      readonly okTag: string;
      readonly runTag: string;
      readonly target: C2TargetSummary;
    };

export interface C2HealthPayload {
  readonly instanceTag?: string;
  readonly service?: string;
  readonly status?: string;
  readonly uptimeSeconds?: number;
}

export interface C2ResolveOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly exists?: (filePath: string) => boolean;
  readonly readFile?: (filePath: string) => string;
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function readEnv(env: NodeJS.ProcessEnv, key: string): string {
  return (env[key] ?? '').trim();
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost';
}

/** 解析并校验 C2 启用条件；配置入口、globalSetup 与 C2 用例共用 */
export function resolveC2Target(options: C2ResolveOptions = {}): C2Resolution {
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const readFile = options.readFile ?? ((filePath: string) => readFileSync(filePath, 'utf8'));

  const enabled = readEnv(env, C2_ENV.enable) === '1';
  const leftover = C2_OWNED_KEYS.filter((key) => readEnv(env, key).length > 0);

  if (!enabled) {
    if (leftover.length > 0) {
      return {
        kind: 'invalid',
        reason: `检测到 C2 专有变量但未显式启用 ${C2_ENV.enable}=1：${leftover.join('、')}`,
      };
    }
    return { kind: 'disabled' };
  }

  const required = [
    C2_ENV.backend,
    C2_ENV.targetFile,
    C2_ENV.failToken,
    C2_ENV.okTag,
    C2_ENV.controlUrl,
    C2_ENV.runTag,
  ];
  const missing = required.filter((key) => readEnv(env, key).length === 0);
  if (missing.length > 0) {
    return { kind: 'invalid', reason: `启用 C2 但缺少：${missing.join('、')}` };
  }

  const backendUrl = normalizeBaseUrl(readEnv(env, C2_ENV.backend));
  if (backendUrl === DEFAULT_DEV_BACKEND) {
    return { kind: 'invalid', reason: 'C2 不得使用默认开发地址 127.0.0.1:3005，必须由隔离启动器给出本轮实例' };
  }

  let backendOrigin: URL;
  let controlOrigin: URL;
  try {
    backendOrigin = new URL(backendUrl);
    controlOrigin = new URL(readEnv(env, C2_ENV.controlUrl));
  } catch {
    return { kind: 'invalid', reason: 'C2 的后端地址或控制地址不是合法 URL' };
  }
  if (!isLoopbackHost(backendOrigin.hostname) || !isLoopbackHost(controlOrigin.hostname)) {
    return { kind: 'invalid', reason: 'C2 只允许 loopback 目标（后端与控制地址）' };
  }

  const targetFile = readEnv(env, C2_ENV.targetFile);
  if (!exists(targetFile)) {
    return { kind: 'invalid', reason: `缺少本轮目标摘要文件：${targetFile}` };
  }

  let target: C2TargetSummary;
  try {
    target = JSON.parse(readFile(targetFile)) as C2TargetSummary;
  } catch {
    return { kind: 'invalid', reason: `目标摘要不是合法 JSON：${targetFile}` };
  }

  if (target.verified !== true) {
    return { kind: 'invalid', reason: '目标摘要未标记为已核对（verified != true）' };
  }
  for (const key of ['databaseNameHash', 'databaseInstanceHash', 'redisInstanceHash'] as const) {
    if (!HASH_PATTERN.test(target[key] ?? '')) {
      return { kind: 'invalid', reason: `目标摘要字段 ${key} 缺失或格式不合法` };
    }
  }
  if (normalizeBaseUrl(target.apiBaseUrl) !== backendUrl) {
    return {
      kind: 'invalid',
      reason: `目标摘要 API 地址与本轮目标不一致：${target.apiBaseUrl} != ${backendUrl}`,
    };
  }
  if (!Number.isInteger(target.frontendPort) || target.frontendPort <= 0) {
    return { kind: 'invalid', reason: '目标摘要缺少有效的 frontendPort' };
  }
  if (!Number.isInteger(target.providerPort) || target.providerPort <= 0) {
    return { kind: 'invalid', reason: '目标摘要缺少有效的 providerPort' };
  }
  if (controlOrigin.port !== String(target.providerPort)) {
    return {
      kind: 'invalid',
      reason: `控制地址端口与目标摘要不一致：${controlOrigin.port} != ${target.providerPort}`,
    };
  }

  const runTag = readEnv(env, C2_ENV.runTag);
  if (target.runTag !== runTag) {
    return {
      kind: 'invalid',
      reason: `目标摘要运行标识与本轮不一致：${target.runTag} != ${runTag}`,
    };
  }

  return {
    backendUrl,
    controlUrl: normalizeBaseUrl(readEnv(env, C2_ENV.controlUrl)),
    failToken: readEnv(env, C2_ENV.failToken),
    kind: 'enabled',
    okTag: readEnv(env, C2_ENV.okTag),
    runTag,
    target,
  };
}

/** 浏览器绑定校验：摘要前端地址必须就是本次运行的 baseURL（同步部分） */
export function validateC2BrowserBinding(input: {
  readonly resolution: Extract<C2Resolution, { kind: 'enabled' }>;
  readonly baseURL: string;
}): string | null {
  const baseURL = normalizeBaseUrl(input.baseURL);
  if (baseURL.length === 0) {
    return '缺少本次运行的 baseURL，无法确认浏览器代理目标';
  }

  let parsed: URL;
  try {
    parsed = new URL(baseURL);
  } catch {
    return `baseURL 不是合法 URL：${baseURL}`;
  }
  if (!isLoopbackHost(parsed.hostname)) {
    return `C2 浏览器入口必须是 loopback：${baseURL}`;
  }
  const port = parsed.port.length > 0 ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
  if (port !== input.resolution.target.frontendPort) {
    return (
      `目标摘要前端端口与本次浏览器入口不一致：` +
      `${input.resolution.target.frontendPort} != ${port}（baseURL=${baseURL}）`
    );
  }
  return null;
}

export type C2Fetch = (url: string) => Promise<{ json: () => Promise<unknown>; ok: boolean; status: number }>;

export interface C2RuntimeCheck {
  readonly browserHealth: C2HealthPayload;
  readonly directHealth: C2HealthPayload;
}

/**
 * 运行时核验：直连 API 可达且 uptime 与摘要一致；浏览器同源代理必须命中同一实例标识。
 *
 * 同源探测走前端代理（`${baseURL}/health`），因此能区分「直连 API 正常，但浏览器代理指向另一个 API」。
 */
export async function assertC2Runtime(input: {
  readonly baseURL: string;
  readonly fetchImpl?: C2Fetch;
  readonly now?: () => number;
  readonly resolution: Extract<C2Resolution, { kind: 'enabled' }>;
}): Promise<C2RuntimeCheck> {
  const bindingError = validateC2BrowserBinding({
    baseURL: input.baseURL,
    resolution: input.resolution,
  });
  if (bindingError !== null) {
    throw new Error(`[c2-target] ${bindingError}`);
  }

  const fetchImpl: C2Fetch =
    input.fetchImpl ??
    ((url: string) =>
      fetch(url, { signal: AbortSignal.timeout(10_000) }) as unknown as Promise<{
        json: () => Promise<unknown>;
        ok: boolean;
        status: number;
      }>);
  const now = input.now ?? (() => Date.now());
  const target = input.resolution.target;

  const directResponse = await fetchImpl(`${input.resolution.backendUrl}/health`);
  if (!directResponse.ok) {
    throw new Error(`[c2-target] 直连 API /health 返回 ${directResponse.status}`);
  }
  const directHealth = (await directResponse.json()) as C2HealthPayload;
  if (directHealth.service !== 'api' || directHealth.status !== 'ok') {
    throw new Error(`[c2-target] 直连 API /health 异常：${JSON.stringify(directHealth)}`);
  }

  const uptime = directHealth.uptimeSeconds ?? Number.NaN;
  const startedAtMs = Date.parse(target.startedAt);
  if (!Number.isFinite(uptime) || Number.isNaN(startedAtMs)) {
    throw new Error('[c2-target] 无法核对实例身份（缺少 uptimeSeconds 或 startedAt）');
  }
  const expectedAge = (now() - startedAtMs) / 1000;
  if (Math.abs(expectedAge - uptime) > STARTUP_TOLERANCE_SECONDS) {
    throw new Error(
      `[c2-target] 实例身份不一致：摘要推算 ${expectedAge.toFixed(1)}s，实际 uptime ${uptime}s`,
    );
  }
  if (uptime > MAX_INSTANCE_AGE_SECONDS) {
    throw new Error(`[c2-target] API 已运行 ${uptime}s，超出一次性验收实例允许时长`);
  }

  const browserBase = normalizeBaseUrl(input.baseURL);
  const browserResponse = await fetchImpl(`${browserBase}/health`);
  if (!browserResponse.ok) {
    throw new Error(
      `[c2-target] 浏览器同源代理 /health 返回 ${browserResponse.status}，无法确认代理目标`,
    );
  }
  const browserHealth = (await browserResponse.json()) as C2HealthPayload;
  if (browserHealth.instanceTag !== input.resolution.runTag) {
    throw new Error(
      `[c2-target] 浏览器代理命中的是其他实例：期望 ${input.resolution.runTag}，` +
        `实际 ${String(browserHealth.instanceTag)}`,
    );
  }

  return { browserHealth, directHealth };
}
