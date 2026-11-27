// backend/scripts/task09-script-utils.ts

/**
 * 任务 09 取证脚本的**共享工具**（单一真源）。
 *
 * 为什么要有这个文件：四个取证脚本（跨安装身份反例矩阵／恢复并发竞态／
 * 「使用云端」整链／隔离夹具）各自实现了一遍**逐字相同**的 `text()`，
 * 三个脚本各自实现了一遍**逐字相同**的断言收集器；`loadEnvFile()`、
 * `readInstallationId()`、`readServerUuid()` 也各有两份。
 *
 * 重复实现的代价是实打实的：上一轮 lint 修复（`no-base-to-string`）时，
 * 同一段 helper 被复制了四份；此后任何口径调整都要改 N 处，漏一处就出现
 * "两个脚本对同一事实给出不同文本"的漂移。这里收敛为一份，**行为保持不变**。
 *
 * 边界：只收敛**逐字相同**的实现；语义不同者（例如"查不到组织"时
 * 一个抛错、一个返回 null）仍留在各自脚本内，不强行合并。
 */

import { readFileSync } from 'node:fs';

import { parse as parseDotenv } from 'dotenv';
import type { DataSource } from 'typeorm';

/** 数据库行取值统一转文本（不用 String(unknown)：那会退化成默认字符串化） */
export function text(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value);
  }
  if (value === null || value === undefined) {
    return '';
  }
  return JSON.stringify(value) ?? '';
}

/** 断言条目 */
export type ScriptAssertion = { name: string; passed: boolean; detail: string };

/**
 * 断言收集器（各脚本自行决定输出格式与退出码）。
 *
 * 断言**只收集**、不自行决定成败：不同脚本的"失败即退出"口径不同
 * （例如并发竞态脚本需要复现缺陷时以非零码退出），故由调用方判定。
 */
export function createAssertionCollector(): {
  assertions: ScriptAssertion[];
  check: (name: string, passed: boolean, detail: string) => void;
} {
  const assertions: ScriptAssertion[] = [];
  return {
    assertions,
    check(name: string, passed: boolean, detail: string): void {
      assertions.push({ name, passed, detail });
    },
  };
}

/** 读取环境文件到 process.env（受控 wiring） */
export function loadEnvFile(envFile: string): void {
  const parsed: Record<string, string> = parseDotenv(readFileSync(envFile, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    // eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
    process.env[key] = value;
  }
}

/** 读取库内安装标识（`local_installation.installation_id`） */
export async function readInstallationId(dataSource: DataSource): Promise<string | null> {
  const rows: unknown = await dataSource.query(
    'SELECT installation_id AS installationId FROM local_installation LIMIT 1',
  );
  const list = rows as ReadonlyArray<{ installationId: string }>;
  return list[0]?.installationId ?? null;
}

/** 读取实例 UUID（`@@server_uuid`） */
export async function readServerUuid(dataSource: DataSource): Promise<string | null> {
  const rows: unknown = await dataSource.query('SELECT @@server_uuid AS serverUuid');
  const list = rows as ReadonlyArray<{ serverUuid: string }>;
  return list[0]?.serverUuid ?? null;
}
