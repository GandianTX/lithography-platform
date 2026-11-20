// e2e/helpers/c2-target-guard.ts
// 任务05 C2 目标守卫（Playwright globalSetup）。
//
// C2 会写入真实库并发起真实模型调用，因此必须在**首个业务请求之前**确认
// 「浏览器代理到的后端就是本轮一次性启动器启动的那个实例」：
// - 启用标志、显式后端地址、目标摘要文件三者齐全；
// - 后端地址不得是默认开发地址；
// - /health 的 uptime 必须与启动器记录的启动时间一致（排除复用未知实例）；
// - loopback 故障 provider 与前端入口都必须由本轮启动且可达。
//
// 任何一项不满足直接抛错，整轮测试不会产生登录／新建／提交请求。

import { existsSync, readFileSync } from 'node:fs';

const DEFAULT_DEV_BACKEND = 'http://127.0.0.1:3005';
const MAX_INSTANCE_AGE_SECONDS = 900;
const STARTUP_TOLERANCE_SECONDS = 30;

export interface C2TargetSummary {
  readonly apiBaseUrl: string;
  readonly apiPort: number;
  readonly databaseNameHash: string;
  readonly databaseInstanceHash: string;
  readonly frontendPort: number;
  readonly providerPort: number;
  readonly redisPort: number;
  readonly redisInstanceHash: string;
  readonly startedAt: string;
  readonly verified: boolean;
}

function fail(reason: string): never {
  throw new Error(`[c2-target-guard] ${reason}`);
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

async function readJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    fail(`${url} 返回 ${response.status}`);
  }
  return response.json();
}

export default async function c2TargetGuard(): Promise<void> {
  if (process.env.AI_E2E_C2 !== '1') {
    return;
  }

  const apiBaseUrl = normalizeBaseUrl(process.env.AI_E2E_BACKEND_URL ?? '');
  if (apiBaseUrl.length === 0) {
    fail('启用 C2 时必须显式提供 AI_E2E_BACKEND_URL（本轮启动器启动的 API）');
  }
  if (apiBaseUrl === DEFAULT_DEV_BACKEND) {
    fail('C2 不得指向默认开发后端 127.0.0.1:3005，请由隔离启动器给出本轮实例');
  }

  const targetFile = process.env.AI_E2E_C2_TARGET_FILE ?? '';
  if (targetFile.length === 0 || !existsSync(targetFile)) {
    fail(`缺少本轮目标摘要文件（AI_E2E_C2_TARGET_FILE=${targetFile || '<empty>'}）`);
  }
  const target = JSON.parse(readFileSync(targetFile, 'utf8')) as C2TargetSummary;
  if (target.verified !== true) {
    fail('目标摘要未标记为已核对（verified != true）');
  }
  if (normalizeBaseUrl(target.apiBaseUrl) !== apiBaseUrl) {
    fail(`目标摘要的 API 地址与本轮代理目标不一致：${target.apiBaseUrl} != ${apiBaseUrl}`);
  }

  const health = (await readJson(`${apiBaseUrl}/health`)) as {
    status?: string;
    service?: string;
    uptimeSeconds?: number;
  };
  if (health.status !== 'ok' || health.service !== 'api') {
    fail(`/health 返回异常：${JSON.stringify(health)}`);
  }

  const ready = (await readJson(`${apiBaseUrl}/health/readiness`)) as {
    status?: string;
    checks?: { database?: string };
  };
  if (ready.status !== 'ready' || ready.checks?.database !== 'up') {
    fail(`/health/readiness 未就绪：${JSON.stringify(ready)}`);
  }

  const uptime = health.uptimeSeconds ?? Number.NaN;
  const startedAtMs = Date.parse(target.startedAt);
  if (!Number.isFinite(uptime) || Number.isNaN(startedAtMs)) {
    fail('无法核对实例身份（缺少 uptimeSeconds 或 startedAt）');
  }
  const expectedAge = (Date.now() - startedAtMs) / 1000;
  if (Math.abs(expectedAge - uptime) > STARTUP_TOLERANCE_SECONDS) {
    fail(
      `实例身份不一致：摘要推算已运行 ${expectedAge.toFixed(1)}s，实际 uptime ${uptime}s，` +
        '说明该端口上的 API 不是本轮启动器启动的实例',
    );
  }
  if (uptime > MAX_INSTANCE_AGE_SECONDS) {
    fail(`API 已运行 ${uptime}s，超出一次性验收实例的允许时长`);
  }

  const providerHealth = (await readJson(`http://127.0.0.1:${target.providerPort}/health`)) as {
    service?: string;
  };
  if (providerHealth.service !== 'c2-fault-provider') {
    fail(`loopback 故障 provider 未就绪（端口 ${target.providerPort}）`);
  }

  const frontendResponse = await fetch(`http://127.0.0.1:${target.frontendPort}/`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!frontendResponse.ok) {
    fail(`前端入口不可达（端口 ${target.frontendPort}）`);
  }

  process.stdout.write(
    `[c2-target-guard] ok api=${apiBaseUrl} uptime=${uptime}s db=${target.databaseNameHash} ` +
      `dbInstance=${target.databaseInstanceHash} redis=${target.redisInstanceHash} ` +
      `providerPort=${target.providerPort} frontendPort=${target.frontendPort}\n`,
  );
}
