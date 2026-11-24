// scripts/task09-restore-selfcheck.sensitivity.ts

/**
 * 任务 09 · 恢复自检的**敏感性实测**（独立验收 P2-1）。
 *
 * 目的：证明自检脚本的哨兵与清理门禁**真的有鉴别力**，而不是"怎么跑都过"。
 *
 * 做法（计划要求：在**临时源码副本／可丢弃库**上注入故障）：
 * 1. 复制 `task09-restore-selfcheck.ts` 成**临时源码副本**（同目录 ⇒ `__dirname` 语义不变），
 *    在副本里注入一处**真实故障**（改库行／改文件字节／造外部引用／让清理中途失败）；
 * 2. 在**一次性可丢弃隔离库**上真实跑副本；
 * 3. 断言副本**必须在对应的哨兵／预检断言处失败**（不得靠数据库最后报外键错误冒充安全）；
 * 4. 对哨兵类反例再跑一次**旧口径副本**（把真实读回换回"内存 id ＋ 硬编码状态"、
 *    把文件指纹换回"存在／不存在"）⇒ 旧口径**必须检测不到**（否则说明本用例没有鉴别力）。
 *
 * 纪律：
 * - 全部走真实数据库与真实文件；不 mock、不改断言掩盖故障；
 * - 注入只发生在**本轮脚本自己造出来的对象**上（一次性隔离库），不触碰保留库与真实业务数据；
 * - 每个用例跑完按**登记的真实主键**精确回收运行期数据，只保留用例开始前就存在的哨兵；
 * - 临时源码副本跑完即删，零残留。
 *
 * 用法（与恢复自检同一套显式授权环境变量）：
 *   TASK09_RESTORE_ENV_FILE=... TASK09_RESTORE_DATABASE=... ... \
 *   TASK09_RESTORE_SENSITIVITY_EVIDENCE_FILE=... \
 *   npx ts-node -r tsconfig-paths/register scripts/task09-restore-selfcheck.sensitivity.ts
 */

import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { DataSource } from 'typeorm';

import { loadExplicitEnvConfig } from '@src/infrastructure/database/incremental-migration';
import { AppConfigModule } from '@src/infrastructure/config/config.module';
import { LoggerModule } from '@src/infrastructure/logger/logger.module';
import { TypeOrmModule } from '@nestjs/typeorm';

import {
  assertDisposableMarker,
  assertServerIdentity,
  readSelfcheckAuthorization,
} from './task09-restore-selfcheck.safety';

/** 被测脚本（本轮的唯一被测对象） */
const TARGET_SCRIPT = 'task09-restore-selfcheck.ts';
/** 临时源码副本前缀（跑完即删） */
const COPY_PREFIX = 'task09-restore-selfcheck.sensitivity-copy-';

/** 结果行标记（与被测脚本一致） */
const RESULT_MARKER = 'TASK09_SELFCHECK_RESULT ';

/** 运行期表（每个用例后按"基线保留 + 其余精确回收"复位） */
const RUNTIME_TABLES: ReadonlyArray<{ table: string; idColumn: string }> = [
  { table: 'management_audit_event', idColumn: 'event_id' },
  { table: 'local_write_hold', idColumn: 'hold_id' },
  { table: 'backup_restore_run', idColumn: 'restore_id' },
  { table: 'backup_asset', idColumn: 'backup_id' },
  { table: 'local_backup_run', idColumn: 'id' },
  { table: 'local_upload_task', idColumn: 'id' },
  { table: 'local_company_setting', idColumn: 'id' },
  { table: 'local_account_authorization', idColumn: 'id' },
];

type SensitivityCase = {
  readonly label: string;
  /** 相对"新实现"的额外期望 */
  readonly expectFailure: boolean;
  /** 失败时必须出现的特征（错误信息片段） */
  readonly expectFailureSignatures: ReadonlyArray<string>;
  /** 失败时**不得**出现的特征（例如外键错误） */
  readonly forbidFailureSignatures: ReadonlyArray<string>;
  /** 是否使用"旧口径"副本（把真实读回换回内存值） */
  readonly legacy: boolean;
  /** 生成副本时对源码做的替换／插入 */
  readonly patch: (source: string) => string;
  /** 期望的失败阶段说明（进证据） */
  readonly expectation: string;
};

/** 把"新读回指纹"换回旧口径（内存 id ＋ 硬编码状态 / 文件只看存在） */
function toLegacyFingerprint(source: string): string {
  let out = source;
  out = out.replace(
    /fingerprint: await readAuthorizationSentinelFingerprint\(\s*ctx\.dataSource,\s*String\(sentinelAuthorization\.id\),\s*\),/gu,
    'fingerprint: `${sentinelAuthorization.id}:ACTIVE`,',
  );
  out = out.replace(
    /fingerprint: await readHoldSentinelFingerprint\(ctx\.dataSource, sentinelHold\.holdId\),/gu,
    'fingerprint: `${sentinelHold.holdId}:ACTIVE`,',
  );
  out = out.replace(
    /fingerprint: fileContentFingerprint\(scope\.fileRoot, sentinelFile\),/gu,
    "fingerprint: existsSync(sentinelFile) ? 'present' : 'missing',",
  );
  return out;
}

/** 一次性插入：要求锚点在源码里**恰好出现一次**（否则视为注入失效） */
function insertAfter(source: string, anchor: string, injected: string): string {
  const occurrences = source.split(anchor).length - 1;
  if (occurrences !== 1) {
    throw new Error(`注入锚点必须恰好出现一次，实际 ${occurrences} 次：${anchor.slice(0, 60)}`);
  }
  return source.replace(anchor, `${anchor}\n${injected}`);
}

/**
 * 篡改授权哨兵：真实库行被改写（权限版本 +1）。
 *
 * 注入点必须在 **before 快照之后**：否则 before 也记录了被改后的值，
 * 前后一致 ⇒ 检不出故障（那不是鉴别力，是注入位置错了）。
 */
function patchTamperAuthorization(source: string): string {
  return insertAfter(
    source,
    '    // ── 5. 夹具（本轮新建，不覆盖既有）──',
    [
      '    // [敏感性注入] 篡改授权哨兵：真实库行被改写（内存快照看不见）',
      '    await ctx.dataSource.query(',
      "      'UPDATE local_account_authorization SET permission_version = permission_version + 1 WHERE id = ?',",
      '      [String(sentinelAuthorization.id)],',
      '    );',
    ].join('\n'),
  );
}

/**
 * 篡改哨兵文件：内容被改、文件仍在。
 *
 * 同样必须落在 **before 快照之后**（文件指纹是 before/after 的真实字节比对）。
 */
function patchTamperSentinelFile(source: string): string {
  const patched = source.replace(
    "import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';",
    "import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';",
  );
  return insertAfter(
    patched,
    '    // ── 5. 夹具（本轮新建，不覆盖既有）──',
    [
      '    // [敏感性注入] 篡改哨兵文件：内容被改、文件仍然存在',
      "    appendFileSync(sentinelFile, 'tampered by sensitivity check\\n', 'utf8');",
    ].join('\n'),
  );
}

/** 制造"本轮之外"的外部引用：一条不属于本轮的恢复运行指向本轮备份资产 */
function patchExternalReference(source: string): string {
  return insertAfter(
    source,
    '  const ownedByKey = new Map(owned.map((item) => [`${item.table}::${item.id}`, item]));',
    [
      '  // [敏感性注入] 制造外部引用：一条**不属于本轮**的恢复运行指向本轮备份资产',
      "  const injectedBackupId = plan.find((item) => item.table === 'backup_asset')?.id;",
      '  if (injectedBackupId !== undefined) {',
      '    await ctx.dataSource.query(',
      "      'INSERT INTO backup_restore_run (restore_id, backup_id, protection_backup_id, ' +",
      "        'target_installation_id, check_status, confirmation, organization_id, ' +",
      "        'started_by_account_id, status, check_snapshot, restored_scope, result_summary, ' +",
      "        'started_at, finished_at) ' +",
      "        'VALUES (?, ?, NULL, ?, NULL, NULL, ?, ?, ?, ?, NULL, NULL, NULL, NULL)',",
      '      [',
      "        '00000000-0000-4000-8000-00000000e0c1',",
      '        injectedBackupId,',
      '        scope.installationId,',
      '        scope.organizationId,',
      '        scope.superAdminAccountId,',
      "        'PENDING',",
      '        JSON.stringify({ schema_version: 1 }),',
      '      ],',
      '    );',
      '  }',
    ].join('\n'),
  );
}

/** 清理中途失败：数据库删除事务在第一条删除之前抛错 */
function patchCleanupFailure(source: string): string {
  return insertAfter(
    source,
    '    // 3.3 先子后父删除',
    [
      '    // [敏感性注入] 清理中途失败：数据库删除事务在第一条删除之前抛错',
      "    throw new Error('注入的清理中途失败');",
    ].join('\n'),
  );
}

const CASES: ReadonlyArray<SensitivityCase> = [
  {
    label: 'A1 篡改授权哨兵（新口径：真实读回）',
    expectFailure: true,
    expectFailureSignatures: ['非目标哨兵发生变化'],
    forbidFailureSignatures: ['Cannot delete or update a parent row', 'foreign key constraint'],
    legacy: false,
    patch: patchTamperAuthorization,
    expectation: '真实读回的字段指纹与 before 不同 ⇒ 必须在哨兵断言处失败',
  },
  {
    label: 'A2 篡改授权哨兵（旧口径：内存 id ＋ 硬编码状态）',
    expectFailure: false,
    expectFailureSignatures: [],
    forbidFailureSignatures: [],
    legacy: true,
    patch: (source) => patchTamperAuthorization(toLegacyFingerprint(source)),
    expectation: '旧口径**检测不到**篡改（本轮改动确实带来了鉴别力）',
  },
  {
    label: 'B1 篡改哨兵文件内容但保留文件（新口径：字节指纹）',
    expectFailure: true,
    expectFailureSignatures: ['非目标哨兵发生变化'],
    forbidFailureSignatures: ['Cannot delete or update a parent row', 'foreign key constraint'],
    legacy: false,
    patch: patchTamperSentinelFile,
    expectation: '文件字节指纹与 before 不同 ⇒ 必须在哨兵断言处失败',
  },
  {
    label: 'B2 篡改哨兵文件内容但保留文件（旧口径：只看存在）',
    expectFailure: false,
    expectFailureSignatures: [],
    forbidFailureSignatures: [],
    legacy: true,
    patch: (source) => patchTamperSentinelFile(toLegacyFingerprint(source)),
    expectation: '旧口径**检测不到**内容篡改（本轮改动确实带来了鉴别力）',
  },
  {
    label: 'C 制造外部引用（不得靠外键最后报错兜底）',
    expectFailure: true,
    expectFailureSignatures: ['存在本轮之外的引用'],
    forbidFailureSignatures: ['Cannot delete or update a parent row', 'foreign key constraint'],
    legacy: false,
    patch: patchExternalReference,
    expectation: '外部引用预检必须先拦下 ⇒ 失败点必须是预检，不是外键报错',
  },
  {
    label: 'D 清理中途失败（失败必须留痕且非零退出）',
    expectFailure: true,
    expectFailureSignatures: ['注入的清理中途失败'],
    forbidFailureSignatures: [],
    legacy: false,
    patch: patchCleanupFailure,
    expectation: '收尾失败必须留痕（cleanup.errors 非空）且退出码非零',
  },
];

type CaseResult = {
  readonly label: string;
  readonly expectation: string;
  readonly legacy: boolean;
  readonly exitCode: number | null;
  readonly passed: boolean | null;
  readonly failureSignatureFound: ReadonlyArray<string>;
  readonly forbiddenSignatureFound: ReadonlyArray<string>;
  readonly cleanupErrors: ReadonlyArray<string>;
  readonly resultLinePresent: boolean;
  readonly stdoutTail: string;
  readonly stderrTail: string;
  readonly outcome: 'PASS' | 'FAIL';
  readonly outcomeDetail: string;
};

/** 运行一次副本脚本 */
function runCopy(
  scriptPath: string,
  cwd: string,
): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolvePromise) => {
    const child = spawn(
      join(cwd, 'node_modules/.bin/ts-node'),
      ['-r', 'tsconfig-paths/register', scriptPath],
      {
        cwd,
        // eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
        env: process.env,
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('close', (code) => {
      resolvePromise({ exitCode: code, stdout, stderr });
    });
  });
}

/** 从混合输出里取回结果行 */
function parseResultLine(stdout: string): Record<string, unknown> | null {
  const index = stdout.lastIndexOf(RESULT_MARKER);
  if (index < 0) {
    return null;
  }
  const tail = stdout.slice(index + RESULT_MARKER.length);
  const end = tail.indexOf('\n');
  const line = end < 0 ? tail : tail.slice(0, end);
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function tailOf(text: string, lines: number): string {
  return text
    .split('\n')
    .filter((item) => item.trim().length > 0)
    .slice(-lines)
    .join(' | ')
    .slice(0, 1200);
}

async function main(): Promise<void> {
  // eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
  const authorization = readSelfcheckAuthorization(process.env);
  const cwd = resolve(__dirname, '..');
  const targetPath = join(cwd, 'scripts', TARGET_SCRIPT);

  // 真实连接核对（与被测脚本同一套安全边界）
  const config = loadExplicitEnvConfig(authorization.envFile, authorization.database);
  const moduleRef = await (
    await import('@nestjs/testing')
  ).Test.createTestingModule({
    imports: [
      AppConfigModule,
      LoggerModule,
      TypeOrmModule.forRoot({
        type: 'mysql',
        host: config.host,
        port: config.port,
        username: config.username,
        password: config.password,
        database: config.database,
        timezone: config.timezone,
        charset: config.charset,
        synchronize: false,
        logging: false,
        entities: [join(__dirname, '../src/modules/**/*.entity.ts')],
      }),
    ],
  }).compile();
  const dataSource = moduleRef.get(DataSource);
  try {
    const markerRows: unknown = await dataSource.query(
      'SELECT marker_key, marker_value FROM task09_disposable_marker',
    );
    assertDisposableMarker(
      (markerRows as Array<{ marker_key?: string; marker_value?: string }>).map((row) => ({
        markerKey: String(row.marker_key ?? ''),
        markerValue: String(row.marker_value ?? ''),
      })),
      authorization.disposableMarker,
    );
    assertServerIdentity(
      {
        database: String(config.database),
        serverUuid: await readServerUuid(dataSource),
        host: String(config.host),
        port: Number(config.port),
      },
      authorization,
    );

    // ── 用例开始前的运行期基线（登记为"必须保留"的既有数据）──
    const baseline = await snapshotRuntimeIds(dataSource);

    const source = readFileSync(targetPath, 'utf8');
    const results: CaseResult[] = [];

    for (const testCase of CASES) {
      const copyName = `${COPY_PREFIX}${testCase.legacy ? 'legacy-' : 'new-'}${slug(testCase.label)}.ts`;
      const copyPath = join(cwd, 'scripts', copyName);
      try {
        const patched = testCase.patch(source);
        writeFileSync(copyPath, patched, 'utf8');
        const run = await runCopy(join('scripts', copyName), cwd);
        const result = parseResultLine(run.stdout);
        const stdoutAll = `${run.stdout}\n${run.stderr}`;
        const failureFound = testCase.expectFailureSignatures.filter((signature) =>
          stdoutAll.includes(signature),
        );
        const forbiddenFound = testCase.forbidFailureSignatures.filter((signature) =>
          stdoutAll.includes(signature),
        );
        const cleanupSection = (result?.['cleanup'] ?? {}) as { errors?: unknown };
        const cleanupErrors = Array.isArray(cleanupSection.errors)
          ? (cleanupSection.errors as string[])
          : [];
        const resultPassed = result === null ? null : result['passed'] === true;

        let outcome: 'PASS' | 'FAIL' = 'PASS';
        let outcomeDetail = '';
        if (testCase.expectFailure) {
          if (run.exitCode === 0) {
            outcome = 'FAIL';
            outcomeDetail = '注入了真实故障却没有失败（脚本没有鉴别力）';
          } else if (failureFound.length !== testCase.expectFailureSignatures.length) {
            outcome = 'FAIL';
            outcomeDetail = `失败点不在目标断言处（期望 ${testCase.expectFailureSignatures.join('/')}，实际命中 ${failureFound.join('/') || '无'}）`;
          } else if (forbiddenFound.length > 0) {
            outcome = 'FAIL';
            outcomeDetail = `失败点落在禁止的特征上：${forbiddenFound.join('/')}`;
          } else if (result === null) {
            outcome = 'FAIL';
            outcomeDetail = '异常退出却没有输出独立结果行';
          } else {
            outcomeDetail = `退出码 ${String(run.exitCode)}，失败点命中：${failureFound.join('/')}`;
          }
        } else {
          // 旧口径对照：注入同样故障时**应当检测不到**（本轮改动确实带来了鉴别力）
          if (run.exitCode !== 0) {
            outcome = 'FAIL';
            outcomeDetail = '旧口径副本竟然发现了故障（对照不成立：注入可能没生效）';
          } else {
            outcomeDetail = '旧口径副本未发现该故障（与预期一致）';
          }
        }

        results.push({
          label: testCase.label,
          expectation: testCase.expectation,
          legacy: testCase.legacy,
          exitCode: run.exitCode,
          passed: resultPassed,
          failureSignatureFound: failureFound,
          forbiddenSignatureFound: forbiddenFound,
          cleanupErrors,
          resultLinePresent: result !== null,
          stdoutTail: tailOf(run.stdout, 6),
          stderrTail: tailOf(run.stderr, 6),
          outcome,
          outcomeDetail,
        });
      } finally {
        rmSync(copyPath, { force: true });
        // 每个用例后复位运行期数据（只保留用例开始前就存在的行）
        await resetRuntimeTables(dataSource, baseline);
      }
    }

    // ── 收尾：临时源码副本零残留 ＋ 运行期数据复位 ──
    const leftoverCopies = listLeftoverCopies(cwd);
    const residue = await snapshotRuntimeIds(dataSource);
    const residueDiff = diffRuntimeIds(baseline, residue);
    const runtimeBaselineRows: Record<string, number> = {};
    for (const [table, ids] of baseline.entries()) {
      runtimeBaselineRows[table] = ids.length;
    }

    const failed = results.filter((item) => item.outcome === 'FAIL');
    const payload = {
      capturedAt: new Date().toISOString(),
      database: authorization.database,
      installationId: authorization.installationId,
      organizationId: authorization.organizationId,
      cases: results,
      cleanup: {
        leftoverSourceCopies: leftoverCopies,
        runtimeRowsAfterAllCases: residueDiff,
        runtimeBaselineRows: runtimeBaselineRows,
      },
      passed: failed.length === 0 && leftoverCopies.length === 0 && residueDiff.length === 0,
      total: results.length,
      failedCount: failed.length,
    };
    // eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
    const evidenceFile = process.env['TASK09_RESTORE_SENSITIVITY_EVIDENCE_FILE'];
    if (evidenceFile !== undefined && evidenceFile.trim().length > 0) {
      writeFileSync(evidenceFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    }
    process.stdout.write(`${RESULT_MARKER}${JSON.stringify(payload)}\n`);
    if (!payload.passed) {
      throw new Error(
        `敏感性实测未全部通过：${failed.map((item) => `${item.label}（${item.outcomeDetail}）`).join('；')}`,
      );
    }
  } finally {
    await dataSource.destroy();
  }
}

async function readServerUuid(dataSource: DataSource): Promise<string> {
  const rows: unknown = await dataSource.query('SELECT @@server_uuid AS server_uuid');
  return String((rows as Array<{ server_uuid: string }>)[0]?.server_uuid ?? '').toLowerCase();
}

async function snapshotRuntimeIds(dataSource: DataSource): Promise<Map<string, string[]>> {
  const snapshot = new Map<string, string[]>();
  for (const managed of RUNTIME_TABLES) {
    const rows: unknown = await dataSource.query(
      `SELECT \`${managed.idColumn}\` AS id FROM \`${managed.table}\``,
    );
    snapshot.set(
      managed.table,
      (rows as Array<{ id: unknown }>).map((row) => String(row.id)),
    );
  }
  return snapshot;
}

/**
 * 复位：删除"不在基线里"的运行期行。
 *
 * 顺序必须是**先子后父**（`RUNTIME_TABLES` 已是子→父序）：
 * `backup_restore_run` → `backup_asset` → `local_backup_run`（`backup_asset.run_id` 是外键）。
 */
async function resetRuntimeTables(
  dataSource: DataSource,
  baseline: ReadonlyMap<string, ReadonlyArray<string>>,
): Promise<void> {
  for (const managed of RUNTIME_TABLES) {
    const keep = baseline.get(managed.table) ?? [];
    const rows: unknown = await dataSource.query(
      `SELECT \`${managed.idColumn}\` AS id FROM \`${managed.table}\``,
    );
    const stale = (rows as Array<{ id: unknown }>)
      .map((row) => String(row.id))
      .filter((id) => !keep.includes(id));
    for (const id of stale) {
      await dataSource.query(`DELETE FROM \`${managed.table}\` WHERE \`${managed.idColumn}\` = ?`, [
        id,
      ]);
    }
  }
}

function diffRuntimeIds(
  before: ReadonlyMap<string, ReadonlyArray<string>>,
  after: ReadonlyMap<string, ReadonlyArray<string>>,
): string[] {
  const diff: string[] = [];
  for (const [table, ids] of after.entries()) {
    const known = before.get(table) ?? [];
    for (const id of ids) {
      if (!known.includes(id)) {
        diff.push(`${table}#${id}`);
      }
    }
  }
  return diff;
}

function listLeftoverCopies(cwd: string): string[] {
  const scriptsDir = join(cwd, 'scripts');
  const found: string[] = [];
  for (const name of readdirSync(scriptsDir)) {
    if (name.startsWith(COPY_PREFIX)) {
      found.push(name);
    }
  }
  return found;
}

function slug(text: string): string {
  return text
    .replace(/[^a-zA-Z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .toLowerCase();
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
