// test/run-v13-authoritative-spec.ts
//
// 本轮 V13 实库专项的唯一启动入口（需 ts-node 运行）。
//
// 安全职责：
// 1. 只接受显式的 group（delivery / upgrade），并从 V13_SPEC_TARGET_DB 与
//    V13_SPEC_CONFIG_FILE 派生所有规格所需的目标变量；不接受多目标白名单；
// 2. 配置文件必须为 0600、所在目录 0700，且其 DB_NAME 必须等于目标库；
// 3. 强制 E2E_ALLOW_PHYSICAL_CLEANUP=1；其余实库开关按 group 显式启用；
// 4. 清除 E2E_DOTENV，并强制 NODE_ENV=test，禁止 e2e env 回退；
// 5. 先用完全相同的配置、环境和 --runTestsByPath 路径运行 --listTests，
//    机器核对文件集合完全一致后才真正执行；任何异常都在执行前失败关闭；
// 6. 只打印文件路径与退出码，不打印任何凭据或环境值。
//
// 运行示例（在 backend/ 下）：
//   V13_AUTHORITATIVE_SPECS=1 V13_SPEC_GROUP=delivery \
//   V13_SPEC_CONFIG_FILE=<0600 env> V13_SPEC_TARGET_DB=<库名> \
//   V13_SPEC_SERVER_UUID=<uuid> E2E_ALLOW_PHYSICAL_CLEANUP=1 \
//   npx ts-node -r tsconfig-paths/register test/run-v13-authoritative-spec.ts delivery
//
// 专用隔离实例注入（默认 none）：
//   V13_SPEC_INJECTION_PROFILE=normal|conflict|fault V13_SPEC_ISOLATED_INSTANCE=1
//   仅允许回环地址且 DB_PORT != 3306；normal 启用 P1/P2 线程与上游 consumer 注入，
//   conflict 追加 R02-CONFLICT、FAULT-UPDATE 受控故障与第二连接；
//   fault 只启用 FAULT-UPDATE 受控故障并明确关闭 E2E_V13_SECOND_CONNECTION，
//   可通过 V13_SPEC_INSTRUMENT_FAULT_CASE=UNKNOWN|ASSERT-AFTER 追加停采收尾验收。

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import * as dotenv from 'dotenv';

import {
  assertExactSpecSet,
  parseListTestsOutput,
  resolveSpecPaths,
  V13_SPEC_GROUPS,
  type V13SpecGroup,
} from './utils/v13-spec-set-guard';

const BACKEND_ROOT = path.resolve(__dirname, '..');
const JEST_CONFIG = path.resolve(BACKEND_ROOT, 'test/jest-v13-authoritative.config.js');

const fail = (message: string): never => {
  throw new Error(message);
};

const requireEnv = (key: string): string => {
  const value = (process.env[key] ?? '').trim();
  if (value.length === 0) {
    return fail(`拒绝执行：缺少 ${key}`);
  }
  return value;
};

const assertRestrictedFile = (filePath: string): void => {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    fail(`拒绝执行：配置不是普通文件 ${filePath}`);
  }
  const fileMode = stat.mode & 0o777;
  if (fileMode !== 0o600) {
    fail(`拒绝执行：配置文件权限必须为 0600，实际 ${fileMode.toString(8)}`);
  }
  const dirStat = fs.statSync(path.dirname(filePath));
  const dirMode = dirStat.mode & 0o777;
  if (dirMode !== 0o700) {
    fail(`拒绝执行：配置目录权限必须为 0700，实际 ${dirMode.toString(8)}`);
  }
};

const resolveGroup = (): V13SpecGroup => {
  if (process.env.V13_AUTHORITATIVE_SPECS !== '1') {
    return fail('拒绝执行：缺少 V13_AUTHORITATIVE_SPECS=1');
  }
  const raw = (process.argv[2] ?? '').trim().toLowerCase();
  if (raw !== 'delivery' && raw !== 'upgrade') {
    return fail('拒绝执行：必须显式传入 group（delivery 或 upgrade）');
  }
  return V13_SPEC_GROUPS[raw];
};

type InjectionProfile = 'none' | 'normal' | 'conflict' | 'fault';

const INJECTION_PROFILE_FLAG = 'V13_SPEC_INJECTION_PROFILE';
const ISOLATED_INSTANCE_FLAG = 'V13_SPEC_ISOLATED_INSTANCE';
const INSTRUMENT_FAULT_FLAG = 'V13_SPEC_INSTRUMENT_FAULT_CASE';
const CONFLICT_FAULT_CASES = 'R02-CONFLICT,FAULT-UPDATE';
const FAULT_UPDATE_ONLY = 'FAULT-UPDATE';

const resolveInjectionProfile = (): InjectionProfile => {
  const raw = (process.env[INJECTION_PROFILE_FLAG] ?? 'none').trim().toLowerCase();
  if (raw !== 'none' && raw !== 'normal' && raw !== 'conflict' && raw !== 'fault') {
    return fail(`拒绝执行：${INJECTION_PROFILE_FLAG} 只接受 none、normal、conflict 或 fault`);
  }
  if (raw !== 'none' && process.env[ISOLATED_INSTANCE_FLAG] !== '1') {
    return fail(
      `拒绝执行：注入 profile=${raw} 必须在专用隔离实例显式设置 ${ISOLATED_INSTANCE_FLAG}=1`,
    );
  }
  return raw;
};

const resolveInstrumentFaultCase = (profile: InjectionProfile): string => {
  const raw = (process.env[INSTRUMENT_FAULT_FLAG] ?? '').trim().toUpperCase();
  if (raw === '') {
    return '';
  }
  if (profile !== 'fault') {
    return fail(`拒绝执行：${INSTRUMENT_FAULT_FLAG} 只允许与 fault profile 一起使用`);
  }
  if (raw !== 'UNKNOWN' && raw !== 'ASSERT-AFTER') {
    return fail(`拒绝执行：${INSTRUMENT_FAULT_FLAG} 只接受 UNKNOWN 或 ASSERT-AFTER`);
  }
  return raw;
};

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * 注入 profile 只允许命中本机回环且非 3306 的实例；
 * 该检查在建立任何连接前完成，避免误改承载其他开发库的共享实例。
 */
const assertIsolatedTarget = (parsed: Record<string, string>, profile: InjectionProfile): void => {
  if (profile === 'none') {
    return;
  }
  const host = (parsed.DB_HOST ?? '').trim().toLowerCase();
  if (!LOOPBACK_HOSTS.has(host)) {
    fail(`拒绝执行：注入 profile 只允许回环 DB_HOST，实际 "${host || '(缺失)'}"`);
  }
  const port = Number((parsed.DB_PORT ?? '').trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail(`拒绝执行：DB_PORT 非法 "${parsed.DB_PORT ?? '(缺失)'}"`);
  }
  if (port === 3306) {
    fail('拒绝执行：注入 profile 禁止使用 3306 共享实例');
  }
};

/**
 * 配置文件只接受明确列举的连接字段与字段加密参数。
 * 不使用 `DB_*` 或其他大写变量通配，避免未来新增的 DB_/控制变量被静默放行。
 */
const CONFIG_KEY_ALLOWLIST: ReadonlySet<string> = new Set([
  'DB_HOST',
  'DB_PORT',
  'DB_USER',
  'DB_PASS',
  'DB_NAME',
  'DB_TIMEZONE',
  'DB_SYNCHRONIZE',
  'FIELD_ENCRYPTION_KEY',
  'FIELD_ENCRYPTION_IV',
]);

/**
 * UUID、目标库、白名单、组别、清理许可等控制变量只能由本入口显式注入，
 * 不从父进程继承，也不能由 0600 配置文件夹带覆盖。
 */
const CONTROLLED_ENV_PREFIXES = ['V13_', 'E2E_', 'D3_', 'DB_', 'FIELD_ENCRYPTION_'] as const;

const buildBaseEnvironment = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) {
      continue;
    }
    if (key === 'NODE_ENV' || CONTROLLED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      continue;
    }
    env[key] = value;
  }
  return env;
};

const assertConfigKeysAllowed = (parsed: Record<string, string>): void => {
  for (const key of Object.keys(parsed)) {
    if (!CONFIG_KEY_ALLOWLIST.has(key)) {
      return fail(`拒绝执行：配置文件包含保留变量 ${key}`);
    }
  }
};

const assertEntryConfirmed = (
  env: NodeJS.ProcessEnv,
  expected: {
    readonly group: V13SpecGroup;
    readonly targetDb: string;
    readonly serverUuid: string;
    readonly injectionProfile: InjectionProfile;
    readonly instrumentFaultCase: string;
  },
): void => {
  const checks: Array<readonly [string, string]> = [
    ['V13_AUTHORITATIVE_SPECS', '1'],
    ['V13_SPEC_GROUP', expected.group.name],
    ['V13_SPEC_TARGET_DB', expected.targetDb],
    ['V13_SPEC_SERVER_UUID', expected.serverUuid],
    ['V13_SPEC_INJECTION_PROFILE', expected.injectionProfile],
    ['E2E_ALLOW_PHYSICAL_CLEANUP', '1'],
    ['E2E_REAL_DB_NAME', expected.targetDb],
    ['E2E_ALLOWED_DB_NAMES', expected.targetDb],
    ['E2E_EXPECTED_SERVER_UUID', expected.serverUuid],
  ];
  if (expected.injectionProfile !== 'none') {
    checks.push(
      [ISOLATED_INSTANCE_FLAG, '1'],
      ['E2E_V13_INSTRUMENT_INJECTION', '1'],
      ['E2E_V13_UPSTREAM_CONSUMER_INJECTION', '1'],
    );
  }
  if (expected.injectionProfile === 'conflict') {
    checks.push(
      ['E2E_V13_CONTROLLED_FAULT', '1'],
      ['E2E_V13_CONTROLLED_FAULT_CASE', CONFLICT_FAULT_CASES],
      ['E2E_V13_SECOND_CONNECTION', '1'],
    );
  }
  if (expected.injectionProfile === 'fault') {
    checks.push(
      ['E2E_V13_CONTROLLED_FAULT', '1'],
      ['E2E_V13_CONTROLLED_FAULT_CASE', FAULT_UPDATE_ONLY],
    );
    if (env.E2E_V13_SECOND_CONNECTION !== undefined) {
      return fail('拒绝执行：fault profile 必须明确关闭 E2E_V13_SECOND_CONNECTION');
    }
    if (expected.instrumentFaultCase === '') {
      if (env.E2E_V13_INSTRUMENT_FAULT_CASE !== undefined) {
        return fail('拒绝执行：未请求停采受控故障却注入了 E2E_V13_INSTRUMENT_FAULT_CASE');
      }
    } else {
      checks.push(['E2E_V13_INSTRUMENT_FAULT_CASE', expected.instrumentFaultCase]);
    }
  }
  for (const [key, value] of checks) {
    if (env[key] !== value) {
      return fail(`拒绝执行：入口控制变量 ${key} 未被独立确认`);
    }
  }
};

export const buildEnvironment = (group: V13SpecGroup): NodeJS.ProcessEnv => {
  if (process.env.E2E_ALLOW_PHYSICAL_CLEANUP !== '1') {
    return fail('拒绝执行：缺少 E2E_ALLOW_PHYSICAL_CLEANUP=1');
  }
  const injectionProfile = resolveInjectionProfile();
  const instrumentFaultCase = resolveInstrumentFaultCase(injectionProfile);
  const configFile = requireEnv('V13_SPEC_CONFIG_FILE');
  if (!path.isAbsolute(configFile)) {
    return fail('拒绝执行：V13_SPEC_CONFIG_FILE 必须是绝对路径');
  }
  if (!fs.existsSync(configFile)) {
    return fail(`拒绝执行：配置不存在 ${configFile}`);
  }
  assertRestrictedFile(configFile);

  const targetDb = requireEnv('V13_SPEC_TARGET_DB').toLowerCase();
  const serverUuid = requireEnv('V13_SPEC_SERVER_UUID');

  const parsed = dotenv.parse(fs.readFileSync(configFile));
  assertConfigKeysAllowed(parsed);
  assertIsolatedTarget(parsed, injectionProfile);
  const configDb = (parsed.DB_NAME ?? '').trim().toLowerCase();
  if (configDb !== targetDb) {
    return fail(`拒绝执行：配置 DB_NAME=${configDb || '(缺失)'} 与目标库 ${targetDb} 不一致`);
  }

  const env: NodeJS.ProcessEnv = {
    ...buildBaseEnvironment(),
    NODE_ENV: 'test',
    V13_AUTHORITATIVE_SPECS: '1',
    V13_SPEC_GROUP: group.name,
    V13_SPEC_TARGET_DB: targetDb,
    V13_SPEC_SERVER_UUID: serverUuid,
    V13_SPEC_INJECTION_PROFILE: injectionProfile,
    E2E_ALLOW_PHYSICAL_CLEANUP: '1',
    E2E_REAL_DB_NAME: targetDb,
    E2E_ALLOWED_DB_NAMES: targetDb,
    E2E_EXPECTED_SERVER_UUID: serverUuid,
    E2E_REAL_DB_CONFIG_FILE: configFile,
  };
  if (injectionProfile !== 'none') {
    env[ISOLATED_INSTANCE_FLAG] = '1';
    env.E2E_V13_INSTRUMENT_INJECTION = '1';
    env.E2E_V13_UPSTREAM_CONSUMER_INJECTION = '1';
  }
  if (injectionProfile === 'conflict') {
    env.E2E_V13_CONTROLLED_FAULT = '1';
    env.E2E_V13_CONTROLLED_FAULT_CASE = CONFLICT_FAULT_CASES;
    env.E2E_V13_SECOND_CONNECTION = '1';
  }
  if (injectionProfile === 'fault') {
    env.E2E_V13_CONTROLLED_FAULT = '1';
    env.E2E_V13_CONTROLLED_FAULT_CASE = FAULT_UPDATE_ONLY;
    // 明确关闭第二连接干扰：保留登记不得依赖 conflictArmed。
    delete env.E2E_V13_SECOND_CONNECTION;
    if (instrumentFaultCase !== '') {
      env.E2E_V13_INSTRUMENT_FAULT_CASE = instrumentFaultCase;
    }
  }
  // 只注入白名单内的连接字段；控制变量已在上面由入口独立写入。
  for (const [key, value] of Object.entries(parsed)) {
    if (CONFIG_KEY_ALLOWLIST.has(key)) {
      env[key] = value;
    }
  }
  delete env.E2E_DOTENV;

  if (group.name === 'delivery') {
    env.E2E_REAL_DB_SPECS = '1';
    env.D3_CONSTRAINT_SPECS = '1';
    env.D3_ALLOW_PHYSICAL_CLEANUP = '1';
    env.D3_CONFIG_FILE = configFile;
    env.D3_ALLOWED_DB_NAMES = targetDb;
    env.D3_EXPECTED_SERVER_UUID = serverUuid;
    env.E2E_OWNED_FIXTURE_SPECS = '1';
    env.E2E_OWNED_FIXTURE_CONFIG_FILE = configFile;
    env.E2E_OWNED_FIXTURE_TARGET_DB = targetDb;
    env.E2E_OWNED_FIXTURE_EXPECTED_SERVER_UUID = serverUuid;
  } else {
    env.E2E_REAL_DB_SPECS = '1';
    env.E2E_ALLOW_MIGRATION_43_UPGRADE = '1';
  }

  // 注入完成后由入口再次独立确认：配置与父进程都不能改写这些控制值。
  assertEntryConfirmed(env, {
    group,
    targetDb,
    serverUuid,
    injectionProfile,
    instrumentFaultCase,
  });

  return env;
};

const runJest = (args: readonly string[], env: NodeJS.ProcessEnv, capture: boolean): string => {
  const result = spawnSync('npx', ['jest', ...args], {
    cwd: BACKEND_ROOT,
    env,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.error) {
    return fail(`执行 jest 失败：${result.error.message}`);
  }
  if (result.status !== 0) {
    if (capture) {
      process.stderr.write(result.stderr ?? '');
    }
    return fail(`jest 退出码 ${String(result.status)}`);
  }
  return result.stdout ?? '';
};

const main = (): void => {
  const group = resolveGroup();
  const env = buildEnvironment(group);
  const specPaths = resolveSpecPaths(BACKEND_ROOT, group.specs);

  const baseArgs = ['--config', JEST_CONFIG, '--runTestsByPath', ...specPaths];

  const listed = runJest([...baseArgs, '--listTests'], env, true);
  assertExactSpecSet(specPaths, parseListTestsOutput(listed));

  console.log(`[v13-spec] group=${group.name} files=${specPaths.length}`);
  for (const specPath of specPaths) {
    console.log(`[v13-spec] ${path.relative(BACKEND_ROOT, specPath)}`);
  }
  console.log(`[v13-spec] listTests 集合校验通过`);

  if (process.env.V13_SPEC_LIST_ONLY === '1') {
    console.log(`[v13-spec] 仅核对文件集合，不执行测试`);
    return;
  }

  runJest([...baseArgs, '--runInBand', '--verbose'], env, false);
  console.log(`[v13-spec] group=${group.name} 执行完成`);
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[v13-spec] 失败关闭：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
