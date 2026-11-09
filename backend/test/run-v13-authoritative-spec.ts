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

const buildEnvironment = (group: V13SpecGroup): NodeJS.ProcessEnv => {
  if (process.env.E2E_ALLOW_PHYSICAL_CLEANUP !== '1') {
    return fail('拒绝执行：缺少 E2E_ALLOW_PHYSICAL_CLEANUP=1');
  }
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
  const configDb = (parsed.DB_NAME ?? '').trim().toLowerCase();
  if (configDb !== targetDb) {
    return fail(`拒绝执行：配置 DB_NAME=${configDb || '(缺失)'} 与目标库 ${targetDb} 不一致`);
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'test',
    V13_AUTHORITATIVE_SPECS: '1',
    V13_SPEC_GROUP: group.name,
    E2E_ALLOW_PHYSICAL_CLEANUP: '1',
    E2E_REAL_DB_NAME: targetDb,
    E2E_ALLOWED_DB_NAMES: targetDb,
    E2E_EXPECTED_SERVER_UUID: serverUuid,
    E2E_REAL_DB_CONFIG_FILE: configFile,
  };
  // 把显式配置注入子进程（规格自身按 DB_* 建立连接），只来自受限配置文件。
  for (const [key, value] of Object.entries(parsed)) {
    if (/^[A-Z][A-Z0-9_]*$/.test(key)) {
      env[key] = value;
    }
  }
  delete env.E2E_DOTENV;
  // 显式覆盖，避免外部残留的多目标白名单混入。
  env.E2E_ALLOWED_DB_NAMES = targetDb;

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

try {
  main();
} catch (error) {
  console.error(`[v13-spec] 失败关闭：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
