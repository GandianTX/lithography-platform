#!/usr/bin/env node
//
// 凭据失败附件隔离的可复现验证入口。
//
// 对两个凭据专用 Playwright 配置分别运行派生探针的正/负对照：
// - 负对照（CREDENTIAL_PROBE_SKIP_ISOLATION=1）：撤掉隔离后，
//   error-context.md 必须能检出运行时哨兵，证明扫描器与断言确实敏感；
// - 正对照：保留正式配置的隔离调用，子进程仍按预期失败退出，
//   但 stdout / stderr / 全部输出与附件都不得检出哨兵，也不得生成 trace / video / 截图。
//
// 另外核对：两个正式配置仍拒绝 CLI 证据覆盖；探针不进入默认入口，
// 两条正式规格仍在各自专用入口中。
//
// 判据是「内容无秘密」，不是「没有 error-context.md」；刻意失败的探针本身预期 exit 非零。
// 输出目录位于 test-results/（已 gitignore），禁止提交。

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const playwrightCli = path.join(frontendRoot, 'node_modules', 'playwright', 'cli.js');
const resultsRoot = path.join(frontendRoot, 'test-results');
const summaryFile = path.join(resultsRoot, 'credential-probe-verification', 'summary.log');

const PROBE_SPEC = 'credential-artifact.probe.spec.ts';
const COMPANIES_REAL_CONFIG = 'playwright.admin-companies-real.config.ts';
const USERS_REAL_CONFIG = 'playwright.admin-user-management-real.config.ts';

const probeTargets = [
  {
    config: 'playwright.credential-probe-companies.config.ts',
    name: 'companies',
  },
  {
    config: 'playwright.credential-probe-users.config.ts',
    name: 'users',
  },
];

const checks = [];
const failures = [];

function record(ok, label, detail = '') {
  checks.push({ detail, label, ok });
  if (!ok) failures.push(detail === '' ? label : `${label}：${detail}`);
}

/** 子进程环境：剥离代理、外部隔离变量与可能改变配置目标库的变量，再补合成连接值 */
function buildChildEnv(extra = {}) {
  const env = { ...process.env };

  for (const key of [
    'PLAYWRIGHT_NO_COPY_PROMPT',
    'CREDENTIAL_PROBE_OUTPUT_DIR',
    'CREDENTIAL_PROBE_SENTINEL',
    'CREDENTIAL_PROBE_SKIP_ISOLATION',
    'MIGRATION_DRILL_DATABASE',
    'MIGRATION_DRILL_CREATE_TEMP_DB',
    'MIGRATION_DRILL_DOTENV',
    'SEED_DOTENV',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'http_proxy',
    'https_proxy',
    'ALL_PROXY',
    'all_proxy',
    'NO_PROXY',
    'no_proxy',
  ]) {
    delete env[key];
  }

  const fill = (key, value) => {
    if (env[key] === undefined || env[key].trim() === '') env[key] = value;
  };

  fill('DB_HOST', '127.0.0.1');
  fill('DB_PORT', '3306');
  fill('DB_USER', 'credential-probe-synthetic');
  fill('DB_PASS', 'credential-probe-synthetic');
  fill('E2E_BACKEND_ORIGIN', 'http://127.0.0.1:3100');
  fill('ADMIN_DEFAULT_RESET_PASSWORD', 'credential-probe-synthetic');

  return { ...env, ...extra };
}

function runPlaywright({ config, extraArgs = [], env = {} }) {
  const result = spawnSync(
    process.execPath,
    [playwrightCli, 'test', `--config=${config}`, ...extraArgs],
    {
      cwd: frontendRoot,
      encoding: 'utf8',
      env: buildChildEnv(env),
      maxBuffer: 16 * 1024 * 1024,
      timeout: 180_000,
    },
  );

  return {
    signal: result.signal,
    status: result.status,
    stderr: result.stderr ?? '',
    stdout: result.stdout ?? '',
  };
}

function listFiles(dir) {
  if (!statExists(dir)) return [];

  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(full));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }

  return files;
}

function statExists(target) {
  try {
    statSync(target);
    return true;
  } catch {
    return false;
  }
}

function scanDirectory(dir, sentinel) {
  const files = listFiles(dir);
  const artifactFiles = [];
  const secretFiles = [];
  let secretOccurrences = 0;

  for (const file of files) {
    const relative = path.relative(frontendRoot, file);
    const base = path.basename(file);

    if (/\.(png|jpe?g|webm|mp4|zip)$/i.test(base)) artifactFiles.push(relative);

    let content = '';
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    const count = content.split(sentinel).length - 1;
    if (count > 0) {
      secretOccurrences += count;
      secretFiles.push({ count, file: relative });
    }
  }

  return { artifactFiles, fileCount: files.length, secretFiles, secretOccurrences };
}

function hasErrorContext(dir) {
  return listFiles(dir).some((file) => path.basename(file) === 'error-context.md');
}

const sentinel = [
  'NONSECRET',
  'PROBE',
  Date.now().toString(36),
  randomBytes(6).toString('hex'),
].join('_');

mkdirSync(resultsRoot, { recursive: true });

for (const target of probeTargets) {
  const negativeDir = path.join(resultsRoot, `credential-probe-${target.name}-negative`);
  const positiveDir = path.join(resultsRoot, `credential-probe-${target.name}-positive`);

  rmSync(negativeDir, { force: true, recursive: true });
  rmSync(positiveDir, { force: true, recursive: true });

  const negative = runPlaywright({
    config: target.config,
    env: {
      CREDENTIAL_PROBE_OUTPUT_DIR: negativeDir,
      CREDENTIAL_PROBE_SENTINEL: sentinel,
      CREDENTIAL_PROBE_SKIP_ISOLATION: '1',
    },
  });
  const negativeScan = scanDirectory(negativeDir, sentinel);

  record(
    negative.status !== null && negative.status !== 0,
    `${target.name} 负对照应按刻意失败退出非零`,
    `status=${String(negative.status)} signal=${String(negative.signal)}`,
  );
  record(/1 failed/.test(negative.stdout), `${target.name} 负对照应真实执行 1 条失败用例`);
  record(
    negativeScan.secretFiles.some((item) => item.file.endsWith('error-context.md')),
    `${target.name} 负对照应在 error-context.md 检出哨兵（扫描器敏感性）`,
    JSON.stringify(negativeScan.secretFiles),
  );

  const positive = runPlaywright({
    config: target.config,
    env: {
      CREDENTIAL_PROBE_OUTPUT_DIR: positiveDir,
      CREDENTIAL_PROBE_SENTINEL: sentinel,
    },
  });
  const positiveScan = scanDirectory(positiveDir, sentinel);
  const positiveOutput = `${positive.stdout}\n${positive.stderr}`;

  record(
    positive.status !== null && positive.status !== 0,
    `${target.name} 正对照应按刻意失败退出非零`,
    `status=${String(positive.status)} signal=${String(positive.signal)}`,
  );
  record(/1 failed/.test(positive.stdout), `${target.name} 正对照应真实执行 1 条失败用例`);
  record(
    hasErrorContext(positiveDir),
    `${target.name} 正对照应实际生成 error-context.md（证明走了失败附件路径）`,
  );
  record(
    positiveScan.secretFiles.length === 0,
    `${target.name} 正对照附件不得检出哨兵`,
    JSON.stringify(positiveScan.secretFiles),
  );
  record(!positiveOutput.includes(sentinel), `${target.name} 正对照 stdout/stderr 不得检出哨兵`);
  record(
    positiveScan.artifactFiles.length === 0,
    `${target.name} 正对照不得生成 trace/video/失败截图`,
    JSON.stringify(positiveScan.artifactFiles),
  );
  record(positiveScan.fileCount > 0, `${target.name} 正对照应扫描到至少一个失败输出文件`);

  process.stdout.write(
    `[${target.name}] 负对照 status=${String(negative.status)} 扫描文件=${negativeScan.fileCount} ` +
      `哨兵命中文件=${negativeScan.secretFiles.length}\n`,
  );
  process.stdout.write(
    `[${target.name}] 正对照 status=${String(positive.status)} 扫描文件=${positiveScan.fileCount} ` +
      `哨兵命中=${positiveScan.secretOccurrences} 证据附件=${positiveScan.artifactFiles.length}\n`,
  );
}

// CLI 覆盖仍被两个正式配置拒绝
const cliOverrides = [
  { args: ['--trace=on'], config: COMPANIES_REAL_CONFIG },
  { args: ['--trace', 'on'], config: COMPANIES_REAL_CONFIG },
  { args: ['--reporter=html'], config: COMPANIES_REAL_CONFIG },
  { args: ['--reporter=html'], config: USERS_REAL_CONFIG },
];

for (const item of cliOverrides) {
  const result = runPlaywright({ config: item.config, extraArgs: item.args });
  const output = `${result.stdout}\n${result.stderr}`;

  record(
    result.status !== null && result.status !== 0,
    `${item.config} 应以非零退出拒绝 ${item.args.join(' ')}`,
  );
  record(
    output.includes('拒绝覆盖证据开关'),
    `${item.config} 应给出拒绝 ${item.args.join(' ')} 的原因`,
  );
}

// 收集范围：探针不进入默认入口；正式规格仍在各自专用入口
const defaultList = runPlaywright({ config: 'playwright.config.ts', extraArgs: ['--list'] });
record(
  !defaultList.stdout.includes(PROBE_SPEC),
  '默认入口不得收集凭据失败探针',
  defaultList.stdout.slice(0, 400),
);
record(
  !defaultList.stdout.includes('admin-companies-real.spec.ts'),
  '默认入口不得收集公司真实规格',
);

for (const target of probeTargets) {
  const probeList = runPlaywright({ config: target.config, extraArgs: ['--list'] });
  record(
    probeList.stdout.includes(PROBE_SPEC) && probeList.stdout.includes('Total: 1 test'),
    `${target.config} 应只收集 1 条探针`,
    probeList.stdout.slice(0, 400),
  );
}

for (const item of [
  { config: COMPANIES_REAL_CONFIG, spec: 'admin-companies-real.spec.ts' },
  { config: USERS_REAL_CONFIG, spec: 'admin-user-management-real.spec.ts' },
]) {
  const list = runPlaywright({ config: item.config, extraArgs: ['--list'] });
  record(
    list.stdout.includes(item.spec),
    `${item.config} 应收集 ${item.spec}`,
    list.stdout.slice(0, 400),
  );
  record(!list.stdout.includes(PROBE_SPEC), `${item.config} 不得收集凭据失败探针`);
}

mkdirSync(path.dirname(summaryFile), { recursive: true });

const lines = [
  '凭据失败附件隔离验证',
  `时间：${new Date().toISOString()}`,
  `哨兵长度：${sentinel.length}（不写入本文件）`,
  ...checks.map(
    (check) =>
      `${check.ok ? 'PASS' : 'FAIL'} ${check.label}${check.detail ? ` | ${check.detail}` : ''}`,
  ),
  `结果：${failures.length === 0 ? 'PASS' : `FAIL(${failures.length})`}`,
];

writeFileSync(summaryFile, `${lines.join('\n')}\n`, 'utf8');
process.stdout.write(`${lines.join('\n')}\n`);

if (failures.length > 0) process.exitCode = 1;
