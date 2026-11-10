// src/infrastructure/database/e2e-scoped-cleanup.v13.realdb.spec.ts
//
// S4-E：V13 新增 17 表清理闭包的实库专项（默认不连库）。
//
// 安全门（默认 skip，不创建 DataSource、不建立任何连接）：
//   必须同时设置以下环境变量才会执行：
//     E2E_REAL_DB_SPECS=1                 显式启用实库规格
//     E2E_ALLOW_PHYSICAL_CLEANUP=1        物理清理许可
//     E2E_REAL_DB_NAME=<库名>             预期目标库
//     E2E_ALLOWED_DB_NAMES=<同一库名>     单目标白名单，必须与目标库完全一致（不允许逗号多目标）
//     E2E_EXPECTED_SERVER_UUID=<实例UUID> 必填，与 @@server_uuid 一致
//   任一缺失或不一致时，模块加载即抛出明确拒绝，绝不静默跳过。
//   启用后第一条写 SQL 前独立核验：
//     1. 目标库在 E2E_ALLOWED_DB_NAMES 白名单内（assertAllowedE2eDatabase）；
//     2. 实际连接库 === E2E_REAL_DB_NAME（assertManagerOnExpectedE2eDatabase）；
//     3. E2E_EXPECTED_SERVER_UUID 与 @@server_uuid 一致（必填）；
//     4. 事务观测能力：threads 可见性 + events_transactions_current/threads 关联查询
//        + consumer/instrument 均已启用（缺失即在造数前零写入拒绝）。
//
// 受控中断（默认关闭，仅限另行授权的专用库）：
//   E2E_V13_CONTROLLED_FAULT=1 且 E2E_V13_CONTROLLED_FAULT_CASE 指定用例
//   （R01|R02|R03|R02-CONFLICT|FAULT-UPDATE）时，在原危险窗口注入一次读取失败；
//   finally 仍按测试执行者台账精确回收/恢复。
//   FAULT-UPDATE 的实际恢复冲突由受控外部连接制造，不依赖 E2E_V13_SECOND_CONNECTION；
//   冲突在恢复阶段实际发生后立即登记套件级保留。
//
// 覆盖映射：docs/database/v13-deployment/schema-dictionary.md 与 review-response.md。
//   R01 父行在范围、子行未登记        → repair_request_intake → intake_analysis_attempt
//   R02 已登记事实被改写              → stored_file（字符串主键 + 事实核验）
//   R03 集合外记录引用本轮目标        → repair_request.intake_id（整数主键 + 闭包拒绝）
//   R04 合法精确清理                  → 17 表全量 + intake↔request 解环 + 依赖顺序
//   R05 后序删除失败                  → Proxy 注入 stored_file 删除失败，前序全回滚
//   R06 清理完成后重复执行            → 幂等、零新增删除、非目标不变
//   R07a 合法循环引用                 → 解环 UPDATE 后按序回收
//   R07b 额外引用                     → 零解环、零删除、逐字段不变
//   R08 多态 stored_file 引用         → 按事实核验，不自动认领
//
// 运行（授权后，仅目标库）：
//   E2E_REAL_DB_SPECS=1 E2E_ALLOW_PHYSICAL_CLEANUP=1 \
//   E2E_REAL_DB_NAME=lithography_v13_spec E2E_ALLOWED_DB_NAMES=lithography_v13_spec \
//   E2E_EXPECTED_SERVER_UUID=909f9587-9fce-11f1-a353-00e0709ef3a9 \
//   npx jest src/infrastructure/database/e2e-scoped-cleanup.v13.realdb.spec.ts --runInBand
//
// 纪律：
// - CREATE/INSERT 成功后立即登记真实 ID 与不可变归属事实；回读只核验，不重新认领。
// - 外部记录（maintenance_report / ai_conversation / local_backup_run 等无登记类别）
//   也由本轮创建，使用独立的 externalLedger，绝不参与任何用例台账的删除范围。
// - 造数与断言从创建前进入 try/finally；主错误、回收、回滚与关闭错误分别保留。
// - 故障注入只用可恢复的 Proxy 包装，不创建临时触发器。

import { randomUUID } from 'node:crypto';
import * as path from 'path';

import { AccountStatus, IdentityTypeEnum } from '@app-types/models/account.types';
import { DataSource, type EntityManager, type QueryRunner } from 'typeorm';
import {
  assertAllowedE2eDatabase,
  assertManagerOnExpectedE2eDatabase,
} from '../../../test/utils/e2e-db-guard';
import { readRepositoryMigrations } from './incremental-migration';
import { disableConsumerWithRecovery } from '../../../test/utils/consumer-instrumentation';
import {
  assertCasRestoreAffectedOne,
  assertTransactionObservationCapability,
  byteExactTextMatchCondition,
  classifyThreadInstrumentationWrite,
  countActiveOwnTransactions,
  createOwnedResourceLedger,
  planThreadInstrumentationRecovery,
  recordOwnedResource,
  runGuardedScopedCleanup,
  runGuardedSpecCleanup,
  type OwnedResourceLedger,
  type RetainedCleanupResources,
  type ThreadInstrumentationWriteDecision,
} from '../../../test/utils/e2e-scoped-cleanup';
import {
  ACCOUNT_WRITE_FIXTURE_ENTITIES,
  createTestAccount,
} from '../../../test/utils/test-accounts';

const REQUESTED = process.env.E2E_REAL_DB_SPECS === '1';
// RQ6：受控故障注入默认关闭；仅在另行授权时显式开启。
const CONTROLLED_FAULT = process.env.E2E_V13_CONTROLLED_FAULT === '1';
// R01/R02/R03 的读取中断按用例选择，默认空值表示不注入。
const CONTROLLED_FAULT_CASE = (process.env.E2E_V13_CONTROLLED_FAULT_CASE ?? '')
  .trim()
  .toUpperCase();
// RQ6 线程停采反例：默认关闭；必须另行授权并具备 performance_schema.threads 更新权限。
const INSTRUMENT_INJECTION = process.env.E2E_V13_INSTRUMENT_INJECTION === '1';
// P1 收尾验收：首次写入结果未知 / 成功后断言失败的受控故障，默认关闭。
const INSTRUMENT_FAULT_CASE = (process.env.E2E_V13_INSTRUMENT_FAULT_CASE ?? '')
  .trim()
  .toUpperCase();
if (INSTRUMENT_INJECTION && !['', 'UNKNOWN', 'ASSERT-AFTER'].includes(INSTRUMENT_FAULT_CASE)) {
  throw new Error(`S4-E 拒绝执行：未知的 E2E_V13_INSTRUMENT_FAULT_CASE=${INSTRUMENT_FAULT_CASE}`);
}
/**
 * 上游 consumer（global_instrumentation / thread_instrumentation）注入会改变实例级状态，
 * 只允许在专用隔离实例开启；恢复责任由用例 finally 逐项确认。
 */
const UPSTREAM_CONSUMER_INJECTION = process.env.E2E_V13_UPSTREAM_CONSUMER_INJECTION === '1';
// R02 第二连接干扰反例：默认关闭；必须另行授权第二受控连接写入目标库。
const SECOND_CONNECTION_INTERFERENCE = process.env.E2E_V13_SECOND_CONNECTION === '1';

export interface V13CleanupTarget {
  readonly database: string;
  readonly serverUuid: string;
}

/**
 * 解析 S4-E 显式目标；缺任一参数、多目标白名单或白名单与目标不一致时直接拒绝。
 * 不回退默认库，也不允许通过 E2E_ALLOWED_DB_NAMES 的多目标写法放宽范围。
 */
export const resolveV13CleanupTarget = (env: NodeJS.ProcessEnv): V13CleanupTarget => {
  if (env.E2E_REAL_DB_SPECS !== '1') {
    throw new Error('S4-E 拒绝执行：缺少 E2E_REAL_DB_SPECS=1');
  }
  if (env.E2E_ALLOW_PHYSICAL_CLEANUP !== '1') {
    throw new Error('S4-E 拒绝执行：缺少 E2E_ALLOW_PHYSICAL_CLEANUP=1');
  }
  const database = (env.E2E_REAL_DB_NAME ?? '').trim().toLowerCase();
  if (database.length === 0) {
    throw new Error('S4-E 拒绝执行：缺少 E2E_REAL_DB_NAME');
  }
  const allowed = (env.E2E_ALLOWED_DB_NAMES ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
  if (allowed.length === 0) {
    throw new Error('S4-E 拒绝执行：缺少 E2E_ALLOWED_DB_NAMES');
  }
  if (allowed.length !== 1) {
    throw new Error('S4-E 拒绝执行：E2E_ALLOWED_DB_NAMES 必须是单一目标库');
  }
  if (allowed[0] !== database) {
    throw new Error(
      `S4-E 拒绝执行：单目标白名单 ${allowed[0]} 与 E2E_REAL_DB_NAME=${database} 不一致`,
    );
  }
  const serverUuid = (env.E2E_EXPECTED_SERVER_UUID ?? '').trim();
  if (serverUuid.length === 0) {
    throw new Error('S4-E 拒绝执行：缺少 E2E_EXPECTED_SERVER_UUID');
  }
  return { database, serverUuid };
};

/**
 * 冻结种子基线核验：`local_installation` 必须恰好一行、主键为 1、UUID 非空，
 * 且事实字段合法。只作为只读外部基线，绝不登记为本轮创建或删除。
 */
export const assertSeedInstallation = (rows: ReadonlyArray<Record<string, unknown>>): string => {
  if (rows.length !== 1) {
    throw new Error(`S4-E 前置条件失败：local_installation 种子行数量=${rows.length}，期望 1`);
  }
  const row = rows[0];
  if (Number(row.id) !== 1) {
    throw new Error(`S4-E 前置条件失败：local_installation 种子主键=${String(row.id)}，期望 1`);
  }
  const rawInstallationId = row.installation_id;
  const installationId = typeof rawInstallationId === 'string' ? rawInstallationId.trim() : '';
  if (installationId.length === 0) {
    throw new Error('S4-E 前置条件失败：local_installation.installation_id 为空');
  }
  if (![0, 1].includes(Number(row.auto_upload_enabled))) {
    throw new Error(
      `S4-E 前置条件失败：local_installation.auto_upload_enabled=${String(row.auto_upload_enabled)} 非法`,
    );
  }
  if (Number(row.backup_interval_days) <= 0) {
    throw new Error(
      `S4-E 前置条件失败：local_installation.backup_interval_days=${String(row.backup_interval_days)} 非法`,
    );
  }
  return installationId;
};

const TARGET = REQUESTED ? resolveV13CleanupTarget(process.env) : null;
const ENABLED = TARGET !== null;
const EXPECTED_DB = TARGET?.database ?? '';
const EXPECTED_SERVER_UUID = TARGET?.serverUuid ?? '';

const describeRealDb = ENABLED ? describe : describe.skip;

jest.setTimeout(180000);

type Row = Record<string, unknown>;

interface DestructiveCall {
  readonly kind: 'DELETE' | 'UPDATE';
  readonly table: string;
  readonly affectedRows: number;
}

/**
 * 测试执行者登记的 CAS 恢复条件。
 * 原值、写入值与条件同时登记，回收时不从当前库值临时拼装。
 * `targetId` 只用于冲突诊断，证明保留的是哪一行。
 */
interface ExecutorCasRestore {
  readonly label: string;
  readonly targetId: string | number;
  readonly sql: string;
  readonly parameters: unknown[];
}

const messageOf = (error: unknown): string => {
  if (error instanceof AggregateError) {
    return `${error.message}: ${error.errors.map(messageOf).join(' | ')}`;
  }
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    return cause === undefined ? error.message : `${error.message} <- ${messageOf(cause)}`;
  }
  return String(error);
};

/**
 * 将数据库时间字符串规范化为 timestamp(3) 的毫秒精度。
 *
 * 只截断超出毫秒的尾随数字；不重新解释时区，也不在应用侧猜测数据库当前时间。
 */
const normalizeDbMillisecondTimestamp = (value: string): string => {
  const match = /^(.*\.\d{3})\d*$/.exec(value);
  return match === null ? value : match[1];
};

/** 从 DELETE/UPDATE 语句提取目标表；仅用于计数与故障注入，不做任何改写。 */
const parseDestructive = (sql: string): Pick<DestructiveCall, 'kind' | 'table'> | null => {
  const match = /^\s*(DELETE\s+FROM|UPDATE)\s+(`?)([A-Za-z0-9_]+)\2/i.exec(sql);
  if (!match) {
    return null;
  }
  return {
    kind: match[1].toUpperCase().startsWith('DELETE') ? 'DELETE' : 'UPDATE',
    table: match[3],
  };
};

/**
 * 可恢复故障注入 + 破坏性调用计数。
 *
 * 只在事务 manager.query 上拦截 DELETE/UPDATE：记录真实 affectedRows；
 * 指定 failOnDeleteTable 时在“该条 DELETE 执行前”抛错一次，交给 TypeORM 回滚。
 */
const createDestructiveRecorder = (
  source: DataSource,
  options: { readonly failOnDeleteTable?: string } = {},
): { readonly dataSource: DataSource; readonly calls: DestructiveCall[] } => {
  const calls: DestructiveCall[] = [];
  let armed = true;

  const wrapped = new Proxy(source, {
    get(target, property, receiver) {
      if (property === 'transaction') {
        return (callback: (manager: EntityManager) => Promise<unknown>) =>
          target.transaction(async (manager) => {
            const managerProxy = new Proxy(manager, {
              get(managerTarget, managerProperty) {
                if (managerProperty === 'query') {
                  return async (sql: string, parameters?: unknown[]) => {
                    const destructive = parseDestructive(sql);
                    if (
                      destructive &&
                      options.failOnDeleteTable &&
                      armed &&
                      destructive.kind === 'DELETE' &&
                      destructive.table === options.failOnDeleteTable
                    ) {
                      armed = false;
                      throw new Error(`INJECTED_DELETE_FAILURE:${destructive.table}`);
                    }
                    const result = await managerTarget.query(sql, parameters);
                    if (destructive) {
                      calls.push({
                        ...destructive,
                        affectedRows: Number(
                          (result as { affectedRows?: number } | undefined)?.affectedRows ?? 0,
                        ),
                      });
                    }
                    return result;
                  };
                }
                const value = Reflect.get(managerTarget, managerProperty, managerTarget);
                return typeof value === 'function' ? value.bind(managerTarget) : value;
              },
            });
            return callback(managerProxy);
          });
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  return { dataSource: wrapped, calls };
};

describeRealDb('S4-E V13 新增 17 表清理实库专项', () => {
  let dataSource: DataSource;
  /**
   * 观测专用连接：预检、活动事务计数与收尾复验都固定在这一条实际连接上，
   * 避免“预检连接通过、后续池连接未知”。池内其他连接由 helper 的同用户前台线程检查覆盖。
   */
  let observationRunner: QueryRunner;
  let externalLedger: OwnedResourceLedger;
  let caseLedger: OwnedResourceLedger;
  let caseDirectCleanups: Array<() => Promise<void>>;
  /**
   * 测试执行者的独立收尾台账。
   *
   * 与“被测清理器台账”严格区分：R01 的未登记子行只登记在这里，
   * 绝不重新塞回被测台账，否则会取消原本要验证的拒绝行为。
   * R03 的集合外工单因归属核验要求客户账号/机型同在删除范围，
   * 改用 caseDirectCleanups 登记精确删除。
   */
  let executorLedger: OwnedResourceLedger;
  let executorCasRestores: ExecutorCasRestore[];
  /**
   * 套件级保留集合（P3）：冲突现场及其必要父资源一旦登记，
   * 用例收尾、通用清理和 afterAll 都不得再次认领删除；也不得为追求零残留反向删除。
   */
  const retainedResources = {
    storedFileIds: new Set<string>(),
    backupRunIds: new Set<number>(),
    accountIds: new Set<number>(),
    organizationIds: new Set<number>(),
  };
  // RQ6：只有能力预检通过且开始造数后才允许 afterAll 进入清理路径。
  let setupAllowed = false;
  let consumerInjectionBlocked = false;

  const runTag = `${Date.now().toString(36)}${randomUUID().slice(0, 8)}`;
  // `local_installation.installation_id` 由迁移以 `UUID()` 随机生成，每个库不同；
  // 规格必须读取本库真实种子值，不能硬编码某一台机器迁移时得到的结果。
  let installationId = '';

  const external = {
    organizationId: 0,
    accountId: 0,
    equipmentModelId: 0,
    reportId: 0,
    conversationId: 0,
    questionMessageId: 0,
    answerMessageId: 0,
    backupRunId: 0,
  };

  let baseline: {
    seedOrganization: Row[];
    seedInstallation: Row[];
    migrations: Row[];
    triggerCount: number;
  };

  /**
   * 把套件级保留集合转换为通用清理的排除视角。
   * 每轮清理都重新取一次视图，确保用例中途登记的保留项立即生效。
   */
  const retainedCleanupView = (): RetainedCleanupResources => ({
    organizationIds: retainedResources.organizationIds,
    accountIds: retainedResources.accountIds,
    storedFileIds: retainedResources.storedFileIds,
  });

  /** 冲突文件保留：文件本身及被其引用的账号/组织父资源一并进入套件级集合。 */
  const retainConflictFile = (fileId: string): void => {
    retainedResources.storedFileIds.add(fileId);
    if (external.accountId > 0) {
      retainedResources.accountIds.add(external.accountId);
    }
    if (external.organizationId > 0) {
      retainedResources.organizationIds.add(external.organizationId);
    }
  };

  /** 冲突备份记录保留：仅登记真实 backup_run_id，其父安装种子由既有基线保护。 */
  const retainConflictBackupRun = (backupRunId: number): void => {
    if (backupRunId > 0) {
      retainedResources.backupRunIds.add(backupRunId);
    }
  };

  const insertIdOf = (result: unknown): number =>
    Number((result as { insertId?: number }).insertId);

  const rowsOf = async (sql: string, parameters: unknown[] = []): Promise<Row[]> =>
    dataSource.query<Row[]>(sql, parameters);

  const plainRows = async (sql: string, parameters: unknown[] = []): Promise<Row[]> =>
    JSON.parse(JSON.stringify(await rowsOf(sql, parameters))) as Row[];

  const countOf = async (table: string): Promise<number> => {
    const rows = await rowsOf(`SELECT COUNT(*) AS count FROM \`${table}\``);
    return Number(rows[0].count);
  };

  const snapshotRows = async (
    table: string,
    keyColumn: string,
    ids: ReadonlyArray<string | number>,
  ): Promise<Row[]> => {
    if (ids.length === 0) {
      return [];
    }
    const placeholders = ids.map(() => '?').join(', ');
    const rows = await dataSource.query<Row[]>(
      `SELECT * FROM \`${table}\` WHERE \`${keyColumn}\` IN (${placeholders}) ORDER BY \`${keyColumn}\``,
      [...ids],
    );
    return JSON.parse(JSON.stringify(rows)) as Row[];
  };

  const assertNoActiveTransactions = async (): Promise<void> => {
    // RQ6：观测固定在实际 observationRunner 连接上；计数前由 helper 再次核验
    // 该线程 INSTRUMENTED、池内其他前台线程、consumer/instrument 与关联查询。
    // 不再读取需要全局 PROCESS 的 information_schema.innodb_trx。
    expect(observationRunner.isReleased).toBe(false);
    expect(observationRunner.isTransactionActive).toBe(false);
    const connection = (await observationRunner.query(
      'SELECT CONNECTION_ID() AS connection_id',
    )) as Row[];
    expect(Number(connection[0]?.connection_id)).toBeGreaterThan(0);

    await expect(countActiveOwnTransactions((sql) => observationRunner.query(sql))).resolves.toBe(
      0,
    );
    // 连接池可用（事务连接已归还，未被悬挂）。
    await expect(dataSource.query('SELECT 1 AS ok')).resolves.toBeDefined();
  };

  const guardedDirect = async (sql: string, parameters: unknown[]): Promise<number> => {
    let affectedRows = -1;
    await runGuardedScopedCleanup({
      dataSource,
      helper: 'S4-E/干扰行精确回收',
      expectedDatabase: EXPECTED_DB,
      cleanup: async (target) => {
        const result = await target.query(sql, parameters);
        affectedRows = Number((result as { affectedRows?: number } | undefined)?.affectedRows);
      },
    });
    return affectedRows;
  };

  /**
   * 测试执行者 CAS 恢复：必须在单行命中时才视为成功。
   * 未命中表示行被另一连接改写或已不存在，立即失败并保留现场；
   * 调用方（cleanupCase）在收到该错误后跳过后续通用清理，避免再次认领删除。
   */
  const guardedCasRestore = async (restore: ExecutorCasRestore): Promise<void> => {
    const affectedRows = await guardedDirect(restore.sql, restore.parameters);
    assertCasRestoreAffectedOne({
      label: restore.label,
      targetId: restore.targetId,
      affectedRows,
    });
  };

  type ConflictFileReclaimResult =
    | { readonly kind: 'absent' }
    | { readonly kind: 'reclaimed' }
    | { readonly kind: 'retained'; readonly currentFilename: string }
    | { readonly kind: 'mismatch'; readonly currentRows: number };

  /**
   * R02-CONFLICT 独立收尾：删除条件只使用受控修改前登记的预期字节值。
   *
   * 回读只用于判断行是否仍在、比较当前值与定位；不得用当前值替换预期事实。
   * `DELETE` 未命中（0 行）绝不视为回收成功：当前值等于预期值时按未知并发失败；
   * 当前值不等于预期值时视为未登记第三方值，保留文件并交由调用方报告。
   */
  const reclaimConflictFileByExpectedBytes = async (
    fileId: string,
    expectedFilename: string,
  ): Promise<ConflictFileReclaimResult> => {
    const beforeDelete = await snapshotRows('stored_file', 'file_id', [fileId]);
    if (beforeDelete.length === 0) {
      return { kind: 'absent' };
    }
    const deleted = await guardedDirect(
      'DELETE FROM stored_file WHERE file_id = ? ' +
        `AND ${byteExactTextMatchCondition('file_id')} ` +
        `AND ${byteExactTextMatchCondition('original_filename')}`,
      [fileId, fileId, expectedFilename],
    );
    if (deleted === 1) {
      const remaining = await snapshotRows('stored_file', 'file_id', [fileId]);
      if (remaining.length !== 0) {
        throw new Error(
          `R02-CONFLICT 独立回收后仍有残留：file_id=${fileId} rows=${remaining.length}`,
        );
      }
      return { kind: 'reclaimed' };
    }
    if (deleted !== 0) {
      throw new Error(
        `R02-CONFLICT 独立回收异常：file_id=${fileId} affectedRows=${deleted}，期望 0 或 1`,
      );
    }
    const afterDelete = await snapshotRows('stored_file', 'file_id', [fileId]);
    const currentFilename =
      afterDelete.length === 1 ? String(afterDelete[0].original_filename) : undefined;
    if (currentFilename !== undefined && currentFilename !== expectedFilename) {
      return { kind: 'retained', currentFilename };
    }
    return { kind: 'mismatch', currentRows: afterDelete.length };
  };

  /**
   * 读取一条实际连接在 performance_schema.threads 中的线程事实。
   * 仅用于默认关闭的线程停采反例；不用于被测清理器。
   */
  const readObservationThreadState = async (
    runner: QueryRunner,
  ): Promise<{
    threadId: number;
    connectionId: number;
    instrumented: string;
    processlistUser: string;
    threadType: string;
    currentUser: string;
  }> => {
    const rows = (await runner.query(
      `SELECT th.THREAD_ID AS thread_id,
              th.PROCESSLIST_ID AS processlist_id,
              th.PROCESSLIST_USER AS processlist_user,
              th.INSTRUMENTED AS instrumented,
              th.TYPE AS thread_type,
              CONNECTION_ID() AS connection_id,
              CURRENT_USER() AS current_user_value
         FROM performance_schema.threads AS th
        WHERE th.PROCESSLIST_ID = CONNECTION_ID()
        LIMIT 1`,
    )) as Row[];
    expect(rows).toHaveLength(1);
    const rawProcesslistUser = rows[0].processlist_user;
    const rawThreadType = rows[0].thread_type;
    const rawCurrentUser = rows[0].current_user_value;
    return {
      threadId: Number(rows[0].thread_id),
      connectionId: Number(rows[0].connection_id),
      instrumented: String(rows[0].instrumented).toUpperCase(),
      processlistUser: typeof rawProcesslistUser === 'string' ? rawProcesslistUser : '',
      threadType: typeof rawThreadType === 'string' ? rawThreadType.toUpperCase() : '',
      currentUser: typeof rawCurrentUser === 'string' ? rawCurrentUser : '',
    };
  };

  /**
   * 线程停采恢复：只在已核验的本轮连接/线程/用户/前台类型与原状态上精确恢复。
   * 未精确命中 1 行即报错并停止后续写入，绝不按用户名批量恢复。
   */
  const restoreObservationThread = async (
    runner: QueryRunner,
    facts: {
      readonly threadId: number;
      readonly connectionId: number;
      readonly processlistUser: string;
      readonly originalInstrumented: string;
    },
  ): Promise<void> => {
    const expectedInstrumented = facts.originalInstrumented || 'YES';
    if (facts.threadId <= 0 || facts.connectionId <= 0 || facts.processlistUser === '') {
      throw new Error('线程停采恢复缺少已核验的连接/线程/用户事实；停止后续写入');
    }
    const restoredResult = await dataSource.query(
      `UPDATE performance_schema.threads
          SET INSTRUMENTED = ?
        WHERE THREAD_ID = ?
          AND PROCESSLIST_ID = ?
          AND PROCESSLIST_USER = ?
          AND TYPE = 'FOREGROUND'
          AND UPPER(INSTRUMENTED) = 'NO'`,
      [expectedInstrumented, facts.threadId, facts.connectionId, facts.processlistUser],
    );
    const restoredRows = Number(
      (restoredResult as { affectedRows?: number } | undefined)?.affectedRows,
    );
    if (restoredRows !== 1) {
      throw new Error(
        `线程停采恢复未精确命中：thread_id=${facts.threadId} 原值=${expectedInstrumented} ` +
          `affectedRows=${String(restoredRows)}；停止后续写入`,
      );
    }
    const restored = await readObservationThreadState(runner);
    if (restored.instrumented !== expectedInstrumented) {
      throw new Error(
        `线程停采恢复失败：thread_id=${facts.threadId} 当前=${restored.instrumented} ` +
          `期望=${expectedInstrumented}；停止后续写入`,
      );
    }
  };

  const resetCase = (): void => {
    caseLedger = createOwnedResourceLedger();
    caseDirectCleanups = [];
    executorLedger = createOwnedResourceLedger();
    executorCasRestores = [];
  };

  const faultArmedFor = (caseId: string): boolean =>
    CONTROLLED_FAULT &&
    CONTROLLED_FAULT_CASE.split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
      .includes(caseId);

  /**
   * 受控读取中断：默认关闭；开启时在指定危险窗口抛出一次读取失败。
   * 只在专用库规格内可用，不增加任何公开业务入口。
   */
  const readWithControlledFault = async <T>(
    caseId: string,
    stage: string,
    read: () => Promise<T>,
  ): Promise<T> => {
    if (faultArmedFor(caseId)) {
      throw new Error(`INJECTED_READ_FAILURE:${caseId}:${stage}`);
    }
    return read();
  };

  const captureFailure = async (body: () => Promise<void>): Promise<unknown> => {
    try {
      await body();
      return undefined;
    } catch (error) {
      return error;
    }
  };

  /** 受控中断后的非目标基线：种子行必须与 beforeAll 完全一致。 */
  const assertSeedBaselineUnchanged = async (): Promise<void> => {
    expect(await snapshotRows('organization', 'id', [1])).toEqual(baseline.seedOrganization);
    expect(await snapshotRows('local_installation', 'installation_id', [installationId])).toEqual(
      baseline.seedInstallation,
    );
  };

  /**
   * 用例收尾：先执行测试执行者登记的恢复/回收，再回收干扰行，最后按被测台账回收。
   * 任一步失败即停止，不扩大删除范围；内存台账始终复位，避免后续用例误认领现场。
   */
  const cleanupCase = async (helper: string): Promise<unknown[]> => {
    const diagnostics: unknown[] = [];
    try {
      for (const restore of executorCasRestores.splice(0)) {
        try {
          await guardedCasRestore(restore);
        } catch (error) {
          diagnostics.push(
            new Error(`${helper} 测试执行者恢复失败: ${restore.label}`, { cause: error }),
          );
          // 冲突行按设计保留：立即停止，绝不进入后续通用清理再次认领/删除。
          return diagnostics;
        }
      }
      try {
        await runGuardedSpecCleanup({
          dataSource,
          helper: `${helper}/测试执行者台账回收`,
          owned: executorLedger,
          retained: retainedCleanupView(),
          expectedDatabase: EXPECTED_DB,
        });
      } catch (error) {
        diagnostics.push(new Error(`${helper} 测试执行者台账回收失败`, { cause: error }));
        return diagnostics;
      }
      for (const step of caseDirectCleanups.splice(0)) {
        try {
          await step();
        } catch (error) {
          diagnostics.push(new Error(`${helper} 干扰行回收失败`, { cause: error }));
          return diagnostics;
        }
      }
      try {
        await runGuardedSpecCleanup({
          dataSource,
          helper: `${helper}/台账回收`,
          owned: caseLedger,
          retained: retainedCleanupView(),
          expectedDatabase: EXPECTED_DB,
        });
      } catch (error) {
        diagnostics.push(new Error(`${helper} 用例台账回收失败`, { cause: error }));
      }
    } finally {
      resetCase();
    }
    return diagnostics;
  };

  const rejectWithoutDestructiveCalls = async (
    ledger: OwnedResourceLedger,
    helper: string,
    expectedMessage: string,
  ): Promise<void> => {
    const recorder = createDestructiveRecorder(dataSource);
    let caught: unknown;
    try {
      await runGuardedSpecCleanup({
        dataSource: recorder.dataSource,
        helper,
        owned: ledger,
        expectedDatabase: EXPECTED_DB,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(messageOf(caught)).toContain(expectedMessage);
    expect(recorder.calls).toEqual([]);
    await assertNoActiveTransactions();
  };

  // =========================================================================
  // 造数：用例级父行（组织/账号/机型）与 17 表行
  // =========================================================================

  const createCaseParents = async (
    ledger: OwnedResourceLedger,
    tag: string,
  ): Promise<{
    organizationId: number;
    accountId: number;
    equipmentModelId: number;
  }> => {
    const organizationCode = `S4E-${tag}-${runTag}`;
    const organizationName = `S4-E 组织 ${tag} ${runTag}`;
    const orgResult = await dataSource.query(
      `INSERT INTO organization (organization_code, name, kind, status) VALUES (?, ?, 'CLIENT', 'ACTIVE')`,
      [organizationCode, organizationName],
    );
    const organizationId = insertIdOf(orgResult);
    recordOwnedResource(ledger, 'organization', organizationId, {
      organizationCode,
      name: organizationName,
      kind: 'CLIENT',
      status: 'ACTIVE',
    });

    const account = await createTestAccount(
      dataSource,
      null,
      {
        loginName: `s4e_${tag}_${runTag}`,
        loginEmail: `s4e_${tag}_${runTag}@example.com`,
        loginPassword: 'S4eSpec!Passw0rd',
        status: AccountStatus.ACTIVE,
        identityType: IdentityTypeEnum.ENGINEER,
        accessGroup: [IdentityTypeEnum.ENGINEER],
      },
      ledger,
    );

    const modelCode = `S4EMDL-${tag}-${runTag}`;
    const modelName = `S4-E 机型 ${tag} ${runTag}`;
    const modelResult = await dataSource.query(
      `INSERT INTO equipment_model (model_code, model_name, enabled, sort_order) VALUES (?, ?, 1, 0)`,
      [modelCode, modelName],
    );
    const equipmentModelId = insertIdOf(modelResult);
    recordOwnedResource(ledger, 'equipmentModel', equipmentModelId, {
      modelCode,
      modelName,
      enabled: true,
      sortOrder: 0,
    });

    return { organizationId, accountId: account.accountId, equipmentModelId };
  };

  const insertStoredFile = async (
    ledger: OwnedResourceLedger,
    parameters: {
      readonly uploaderAccountId: number;
      readonly ownerOrganizationId: number;
      readonly tag: string;
      readonly originalFilename?: string;
    },
  ): Promise<string> => {
    const fileId = randomUUID();
    const uploadContextId = randomUUID();
    const storageReference = `oss://s4e/${fileId}`;
    const originalFilename = parameters.originalFilename ?? `s4e-${parameters.tag}.txt`;
    const checksumSha256 = 'a'.repeat(64);
    await dataSource.query(
      `INSERT INTO stored_file
         (file_id, uploaded_by_account_id, owner_organization_id, storage_reference,
          original_filename, mime_type, byte_size, checksum_sha256, status, business_type,
          business_id, upload_context_id, binding_status)
       VALUES (?, ?, ?, ?, ?, 'text/plain', 100, ?, 'STAGING', 'REPAIR', NULL, ?, 'TEMPORARY')`,
      [
        fileId,
        parameters.uploaderAccountId,
        parameters.ownerOrganizationId,
        storageReference,
        originalFilename,
        checksumSha256,
        uploadContextId,
      ],
    );
    recordOwnedResource(ledger, 'storedFile', fileId, {
      uploadedByAccountId: parameters.uploaderAccountId,
      ownerOrganizationId: parameters.ownerOrganizationId,
      storageReference,
      originalFilename,
      checksumSha256,
      uploadContextId,
    });
    return fileId;
  };

  const insertIntake = async (
    ledger: OwnedResourceLedger,
    parameters: {
      readonly customerAccountId: number;
      readonly customerOrganizationId: number;
      readonly serviceOrganizationId: number;
      readonly equipmentModelId: number;
      readonly tag: string;
      readonly fileId?: string | null;
      readonly convertedRequestId?: number | null;
    },
  ): Promise<number> => {
    const recordUuid = randomUUID();
    const errorCode = 'E001';
    const faultDescription = `S4-E 故障 ${parameters.tag}`;
    const fileId = parameters.fileId ?? null;
    const convertedRequestId = parameters.convertedRequestId ?? null;
    const result = await dataSource.query(
      `INSERT INTO repair_request_intake
         (record_uuid, customer_account_id, customer_organization_id, service_organization_id,
          equipment_model_id, error_code, fault_description, file_id, analysis_status,
          analysis_generation, converted_request_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'WAITING', 0, ?)`,
      [
        recordUuid,
        parameters.customerAccountId,
        parameters.customerOrganizationId,
        parameters.serviceOrganizationId,
        parameters.equipmentModelId,
        errorCode,
        faultDescription,
        fileId,
        convertedRequestId,
      ],
    );
    const intakeId = insertIdOf(result);
    recordOwnedResource(ledger, 'repairRequestIntake', intakeId, {
      recordUuid,
      customerAccountId: parameters.customerAccountId,
      customerOrganizationId: parameters.customerOrganizationId,
      serviceOrganizationId: parameters.serviceOrganizationId,
      equipmentModelId: parameters.equipmentModelId,
      errorCode,
      faultDescription,
      fileId,
    });
    return intakeId;
  };

  const insertAttempt = async (
    ledger: OwnedResourceLedger,
    intakeId: number,
    generationNo = 0,
  ): Promise<number> => {
    const result = await dataSource.query(
      `INSERT INTO intake_analysis_attempt (intake_id, generation_no, status)
       VALUES (?, ?, 'RUNNING')`,
      [intakeId, generationNo],
    );
    const attemptId = insertIdOf(result);
    recordOwnedResource(ledger, 'intakeAnalysisAttempt', attemptId, {
      intakeId,
      generationNo,
    });
    return attemptId;
  };

  const insertRepairRequest = async (
    ledger: OwnedResourceLedger,
    parameters: {
      readonly customerAccountId: number;
      readonly equipmentModelId: number;
      readonly organizationId: number;
      readonly tag: string;
      readonly intakeId?: number | null;
    },
  ): Promise<number> => {
    const requestNo = `S4E-REQ-${parameters.tag}-${runTag}`;
    const errorCode = 'E001';
    const faultDescription = `S4-E 故障描述 ${parameters.tag}`;
    const intakeId = parameters.intakeId ?? null;
    const result = await dataSource.query(
      `INSERT INTO repair_request
         (request_no, customer_account_id, equipment_model_id, error_code, fault_description,
          content_md, intake_id, customer_organization_id, service_organization_id,
          owner_organization_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        requestNo,
        parameters.customerAccountId,
        parameters.equipmentModelId,
        errorCode,
        faultDescription,
        `S4-E 内容 ${parameters.tag}`,
        intakeId,
        parameters.organizationId,
        parameters.organizationId,
        parameters.organizationId,
      ],
    );
    const requestId = insertIdOf(result);
    recordOwnedResource(ledger, 'repairRequest', requestId, {
      requestNo,
      customerAccountId: parameters.customerAccountId,
      equipmentModelId: parameters.equipmentModelId,
      errorCode,
      faultDescription,
    });
    return requestId;
  };

  const insertProcessEntry = async (
    ledger: OwnedResourceLedger,
    parameters: {
      readonly requestId: number;
      readonly authorAccountId: number;
      readonly fileId: string;
      readonly tag: string;
    },
  ): Promise<number> => {
    const entryUuid = randomUUID();
    const result = await dataSource.query(
      `INSERT INTO repair_process_entry
         (entry_uuid, request_id, author_account_id, operation_text, time_source, file_id, version_no)
       VALUES (?, ?, ?, ?, 'AUTO', ?, 1)`,
      [
        entryUuid,
        parameters.requestId,
        parameters.authorAccountId,
        `S4-E 处理记录 ${parameters.tag}`,
        parameters.fileId,
      ],
    );
    const entryId = insertIdOf(result);
    recordOwnedResource(ledger, 'repairProcessEntry', entryId, {
      entryUuid,
      requestId: parameters.requestId,
      authorAccountId: parameters.authorAccountId,
      fileId: parameters.fileId,
    });
    return entryId;
  };

  const insertAiMessageAnalysis = async (ledger: OwnedResourceLedger): Promise<string> => {
    const questionUuid = randomUUID();
    await dataSource.query(
      `INSERT INTO ai_message_analysis
         (question_uuid, conversation_id, question_message_id, answer_message_id,
          status, content_version)
       VALUES (?, ?, ?, ?, 'PENDING', 1)`,
      [questionUuid, external.conversationId, external.questionMessageId, external.answerMessageId],
    );
    recordOwnedResource(ledger, 'aiMessageAnalysis', questionUuid, {
      conversationId: external.conversationId,
      questionMessageId: external.questionMessageId,
      answerMessageId: external.answerMessageId,
    });
    return questionUuid;
  };

  const insertMaintenanceReportFault = async (
    ledger: OwnedResourceLedger,
    tag: string,
  ): Promise<number> => {
    const faultUuid = randomUUID();
    const faultDescription = `S4-E 报告故障 ${tag}`;
    const result = await dataSource.query(
      `INSERT INTO maintenance_report_fault
         (report_id, fault_uuid, branch_kind, step_code, fault_description,
          is_active, lifecycle_status, lifecycle_source)
       VALUES (?, ?, 'INITIAL_PANEL', NULL, ?, 1, 'OPEN', 'SYSTEM')`,
      [external.reportId, faultUuid, faultDescription],
    );
    const faultId = insertIdOf(result);
    recordOwnedResource(ledger, 'maintenanceReportFault', faultId, {
      reportId: external.reportId,
      faultUuid,
      branchKind: 'INITIAL_PANEL',
      stepCode: null,
      lifecycleSource: 'SYSTEM',
    });
    return faultId;
  };

  const insertRepairRequestRevision = async (
    ledger: OwnedResourceLedger,
    parameters: {
      readonly requestId: number;
      readonly actorAccountId: number;
      readonly tag: string;
    },
  ): Promise<number> => {
    const snapshot = JSON.stringify({ schema_version: 1, tag: parameters.tag });
    const result = await dataSource.query(
      `INSERT INTO repair_request_revision
         (request_id, revision_no, previous_version, before_snapshot, after_snapshot, schema_version,
          actor_account_id, reason)
       VALUES (?, 1, 0, ?, ?, 1, ?, ?)`,
      [
        parameters.requestId,
        snapshot,
        snapshot,
        parameters.actorAccountId,
        `S4-E 修订 ${parameters.tag}`,
      ],
    );
    const revisionId = insertIdOf(result);
    recordOwnedResource(ledger, 'repairRequestRevision', revisionId, {
      requestId: parameters.requestId,
      revisionNo: 1,
      actorAccountId: parameters.actorAccountId,
      schemaVersion: 1,
    });
    return revisionId;
  };

  const insertReferenceDocument = async (
    ledger: OwnedResourceLedger,
    parameters: {
      readonly ownerOrganizationId: number;
      readonly createdByAccountId: number;
      readonly tag: string;
    },
  ): Promise<number> => {
    const result = await dataSource.query(
      `INSERT INTO reference_document
         (title, document_type, created_by_account_id, owner_organization_id, ingest_method,
          publication_status, ownership_status, source_kind, content_text, schema_version)
       VALUES (?, 'MATERIAL', ?, ?, 'ADMIN_DIRECT', 'ONLINE', 'CONFIRMED', 'MATERIAL', ?, 1)`,
      [
        `S4-E 资料 ${parameters.tag}`,
        parameters.createdByAccountId,
        parameters.ownerOrganizationId,
        `S4-E 资料正文 ${parameters.tag}`,
      ],
    );
    const documentId = insertIdOf(result);
    recordOwnedResource(ledger, 'document', documentId, {
      ownerOrganizationId: parameters.ownerOrganizationId,
      createdByAccountId: parameters.createdByAccountId,
      sourceSubmissionId: null,
      sourceRevisionId: null,
      equipmentModelId: null,
    });
    return documentId;
  };

  const insertReferenceDocumentRevision = async (
    ledger: OwnedResourceLedger,
    parameters: {
      readonly documentId: number;
      readonly actorAccountId: number;
      readonly tag: string;
    },
  ): Promise<number> => {
    const snapshot = JSON.stringify({ schema_version: 1, tag: parameters.tag });
    const result = await dataSource.query(
      `INSERT INTO reference_document_revision
         (document_id, revision_no, before_snapshot, after_snapshot, actor_account_id, reason)
       VALUES (?, 1, ?, ?, ?, ?)`,
      [
        parameters.documentId,
        snapshot,
        snapshot,
        parameters.actorAccountId,
        `S4-E 资料修订 ${parameters.tag}`,
      ],
    );
    const revisionId = insertIdOf(result);
    recordOwnedResource(ledger, 'referenceDocumentRevision', revisionId, {
      documentId: parameters.documentId,
      revisionNo: 1,
      actorAccountId: parameters.actorAccountId,
    });
    return revisionId;
  };

  const insertLocalAccountAuthorization = async (
    ledger: OwnedResourceLedger,
    parameters: { readonly organizationId: number; readonly accountId: number },
  ): Promise<number> => {
    const result = await dataSource.query(
      `INSERT INTO local_account_authorization
         (installation_id, account_id, organization_id, authorization_status)
       VALUES (?, ?, ?, 'ACTIVE')`,
      [installationId, parameters.accountId, parameters.organizationId],
    );
    const authorizationId = insertIdOf(result);
    recordOwnedResource(ledger, 'localAccountAuthorization', authorizationId, {
      installationId,
      accountId: parameters.accountId,
      organizationId: parameters.organizationId,
    });
    return authorizationId;
  };

  const insertLocalCompanySetting = async (
    ledger: OwnedResourceLedger,
    organizationId: number,
  ): Promise<number> => {
    const settingSource = 'LOCAL_MANUAL';
    const result = await dataSource.query(
      `INSERT INTO local_company_setting
         (installation_id, organization_id, setting_source, is_current)
       VALUES (?, ?, ?, 0)`,
      [installationId, organizationId, settingSource],
    );
    const settingId = insertIdOf(result);
    recordOwnedResource(ledger, 'localCompanySetting', settingId, {
      installationId,
      organizationId,
      settingSource,
    });
    return settingId;
  };

  const insertSyncReceipt = async (
    ledger: OwnedResourceLedger,
    parameters: { readonly organizationId: number; readonly tag: string },
  ): Promise<string> => {
    const receiptId = randomUUID();
    const recordUuid = randomUUID();
    const resourceType = 'REPAIR';
    const versionNo = 1;
    const sourceSystem = 'CLOUD';
    const manifestChecksum = 'b'.repeat(64);
    await dataSource.query(
      `INSERT INTO sync_receipt
         (receipt_id, record_uuid, organization_id, resource_type, version_no,
          source_system, source_installation_id, receipt_status, manifest_checksum)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)`,
      [
        receiptId,
        recordUuid,
        parameters.organizationId,
        resourceType,
        versionNo,
        sourceSystem,
        randomUUID(),
        manifestChecksum,
      ],
    );
    recordOwnedResource(ledger, 'syncReceipt', receiptId, {
      recordUuid,
      organizationId: parameters.organizationId,
      resourceType,
      versionNo,
      sourceSystem,
    });
    return receiptId;
  };

  const insertSyncConflict = async (
    ledger: OwnedResourceLedger,
    parameters: { readonly organizationId: number; readonly tag: string },
  ): Promise<string> => {
    const conflictId = randomUUID();
    const recordUuid = randomUUID();
    const resourceType = 'REPAIR';
    const versionNo = 1;
    const snapshot = JSON.stringify({ schema_version: 1, tag: parameters.tag });
    await dataSource.query(
      `INSERT INTO sync_conflict
         (conflict_id, record_uuid, organization_id, resource_type, version_no,
          local_snapshot, cloud_snapshot, conflict_reason, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')`,
      [
        conflictId,
        recordUuid,
        parameters.organizationId,
        resourceType,
        versionNo,
        snapshot,
        snapshot,
        `S4-E 冲突 ${parameters.tag}`,
      ],
    );
    recordOwnedResource(ledger, 'syncConflict', conflictId, {
      recordUuid,
      organizationId: parameters.organizationId,
      resourceType,
      versionNo,
    });
    return conflictId;
  };

  const insertRecordPackage = async (
    ledger: OwnedResourceLedger,
    parameters: {
      readonly organizationId: number;
      readonly importedByAccountId: number;
      readonly tag: string;
    },
  ): Promise<string> => {
    const packageId = randomUUID();
    const manifestChecksum = 'c'.repeat(64);
    await dataSource.query(
      `INSERT INTO record_package_import
         (package_id, organization_id, imported_by_account_id, manifest_json,
          manifest_checksum, status)
       VALUES (?, ?, ?, ?, ?, 'PENDING')`,
      [
        packageId,
        parameters.organizationId,
        parameters.importedByAccountId,
        JSON.stringify({ schema_version: 1, tag: parameters.tag }),
        manifestChecksum,
      ],
    );
    recordOwnedResource(ledger, 'recordPackageImport', packageId, {
      organizationId: parameters.organizationId,
      importedByAccountId: parameters.importedByAccountId,
      manifestChecksum,
    });
    return packageId;
  };

  const insertRecordPackageItem = async (
    ledger: OwnedResourceLedger,
    parameters: {
      readonly packageId: string;
      readonly receiptId: string;
      readonly tag: string;
    },
  ): Promise<number> => {
    const recordUuid = randomUUID();
    const resourceType = 'REPAIR';
    const versionNo = 1;
    const result = await dataSource.query(
      `INSERT INTO record_package_item
         (package_id, record_uuid, resource_type, version_no, check_result, result, receipt_id)
       VALUES (?, ?, ?, ?, 'PASSED', 'SUCCEEDED', ?)`,
      [parameters.packageId, recordUuid, resourceType, versionNo, parameters.receiptId],
    );
    const itemId = insertIdOf(result);
    recordOwnedResource(ledger, 'recordPackageItem', itemId, {
      packageId: parameters.packageId,
      recordUuid,
      resourceType,
      versionNo,
      receiptId: parameters.receiptId,
    });
    return itemId;
  };

  const insertBackupAsset = async (
    ledger: OwnedResourceLedger,
    parameters: { readonly organizationId: number; readonly tag: string },
  ): Promise<string> => {
    const backupId = randomUUID();
    const storageReference = `oss://s4e/backup-${backupId}`;
    const fileSha256 = 'd'.repeat(64);
    await dataSource.query(
      `INSERT INTO backup_asset
         (backup_id, run_id, organization_id, installation_id, format_version, data_version,
          manifest_checksum, encryption_key_id, storage_reference, file_sha256, byte_size,
          cloud_status, local_status)
       VALUES (?, ?, ?, ?, 1, 'v13', ?, 'field-key-v1', ?, ?, 100, 'PENDING', 'PENDING')`,
      [
        backupId,
        external.backupRunId,
        parameters.organizationId,
        randomUUID(),
        'e'.repeat(64),
        storageReference,
        fileSha256,
      ],
    );
    recordOwnedResource(ledger, 'backupAsset', backupId, {
      runId: external.backupRunId,
      organizationId: parameters.organizationId,
      storageReference,
      fileSha256,
      localCleanupRunId: null,
    });
    return backupId;
  };

  const insertBackupRestoreRun = async (
    ledger: OwnedResourceLedger,
    parameters: {
      readonly backupId: string;
      readonly protectionBackupId: string;
      readonly organizationId: number;
      readonly startedByAccountId: number;
    },
  ): Promise<string> => {
    const restoreId = randomUUID();
    await dataSource.query(
      `INSERT INTO backup_restore_run
         (restore_id, backup_id, protection_backup_id, target_installation_id,
          check_status, confirmation, organization_id, started_by_account_id,
          status, check_snapshot, started_at)
       VALUES (?, ?, ?, ?, 'PASSED', ?, ?, ?, 'RUNNING', ?, CURRENT_TIMESTAMP(3))`,
      [
        restoreId,
        parameters.backupId,
        parameters.protectionBackupId,
        installationId,
        JSON.stringify({ confirmed: true }),
        parameters.organizationId,
        parameters.startedByAccountId,
        JSON.stringify({ schema_version: 1 }),
      ],
    );
    recordOwnedResource(ledger, 'backupRestoreRun', restoreId, {
      backupId: parameters.backupId,
      protectionBackupId: parameters.protectionBackupId,
      organizationId: parameters.organizationId,
      startedByAccountId: parameters.startedByAccountId,
    });
    return restoreId;
  };

  const insertManagementAuditEvent = async (
    ledger: OwnedResourceLedger,
    parameters: {
      readonly actorAccountId: number;
      readonly organizationId: number;
      readonly tag: string;
    },
  ): Promise<string> => {
    const eventId = randomUUID();
    await dataSource.query(
      `INSERT INTO management_audit_event
         (event_id, actor_account_id, actor_admin_level, organization_id, operation,
          target_type, target_id, result)
       VALUES (?, ?, 2, ?, 'RESTORE_LOCAL_BUSINESS', 'REPAIR_REQUEST', ?, 'SUCCEEDED')`,
      [
        eventId,
        parameters.actorAccountId,
        parameters.organizationId,
        `S4E-${parameters.tag}-${runTag}`,
      ],
    );
    recordOwnedResource(ledger, 'managementAuditEvent', eventId, {
      actorAccountId: parameters.actorAccountId,
      organizationId: parameters.organizationId,
      operation: 'RESTORE_LOCAL_BUSINESS',
      targetType: 'REPAIR_REQUEST',
      targetId: `S4E-${parameters.tag}-${runTag}`,
      result: 'SUCCEEDED',
    });
    return eventId;
  };

  // =========================================================================
  // 生命周期
  // =========================================================================

  beforeAll(async () => {
    assertAllowedE2eDatabase(EXPECTED_DB);

    dataSource = new DataSource({
      type: 'mysql',
      host: process.env.DB_HOST ?? '127.0.0.1',
      port: Number(process.env.DB_PORT ?? 3306),
      username: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: EXPECTED_DB,
      timezone: process.env.DB_TIMEZONE ?? '+08:00',
      synchronize: false,
      migrationsRun: false,
      entities: [...ACCOUNT_WRITE_FIXTURE_ENTITIES],
      // 只加载迁移类用于核对历史名称与顺序，不执行迁移。
      migrations: [
        path.resolve(__dirname, './migrations/*.migration.ts'),
        path.resolve(__dirname, './migrations/*.migration.js'),
      ],
    });
    await dataSource.initialize();

    await assertManagerOnExpectedE2eDatabase(dataSource.createEntityManager(), EXPECTED_DB);

    // 上游 consumer 注入只允许专用隔离实例：回环且非 3306；在造数与任何开关写入前拒绝。
    if (UPSTREAM_CONSUMER_INJECTION) {
      const host = String(process.env.DB_HOST ?? '127.0.0.1').toLowerCase();
      const port = Number(process.env.DB_PORT ?? 3306);
      if (!['127.0.0.1', 'localhost', '::1'].includes(host) || port === 3306) {
        throw new Error(
          `S4-E 拒绝执行：上游 consumer 注入只允许回环且非 3306 的专用隔离实例，` +
            `实际 host=${host || '(缺失)'} port=${String(port)}`,
        );
      }
    }

    // 实例 UUID 为必填项：缺失时 resolveV13CleanupTarget 已在模块加载阶段拒绝。
    const uuidRows = await rowsOf('SELECT @@server_uuid AS server_uuid');
    if (String(uuidRows[0].server_uuid) !== EXPECTED_SERVER_UUID) {
      throw new Error(
        `S4-E 拒绝执行：实际 server_uuid=${String(uuidRows[0].server_uuid)}，` +
          `与 E2E_EXPECTED_SERVER_UUID=${EXPECTED_SERVER_UUID} 不一致。`,
      );
    }

    // RQ6：在任何造数、任何 DDL/DML 之前确认事务观测能力；缺失时零造数失败关闭。
    // 固定使用 observationRunner 这一条实际连接完成预检与后续计数，
    // 并对池内当前用户前台线程的 INSTRUMENTED 状态一起核验。
    observationRunner = dataSource.createQueryRunner();
    await observationRunner.connect();
    await assertTransactionObservationCapability((sql) => observationRunner.query(sql));

    // 迁移历史必须与仓库冻结清单逐条一致（名称、时间戳、顺序），不只比较数量。
    const repositoryMigrations = readRepositoryMigrations(dataSource);
    const historyMigrations = await plainRows(
      'SELECT id, name, timestamp FROM migrations ORDER BY id',
    );
    expect(
      historyMigrations.map((row) => ({
        name: String(row.name),
        timestamp: Number(row.timestamp),
      })),
    ).toEqual(repositoryMigrations);
    expect(repositoryMigrations).toHaveLength(44);

    // 冻结种子按业务标识定位：读取单行表并核验唯一性/事实，再以 installation_id 为只读基线键。
    const seedInstallationRows = await plainRows(
      'SELECT id, installation_id, organization_id, organization_code_snapshot, ' +
        'auto_upload_enabled, backup_interval_days FROM local_installation',
    );
    installationId = assertSeedInstallation(seedInstallationRows);

    baseline = {
      seedOrganization: await snapshotRows('organization', 'id', [1]),
      seedInstallation: await snapshotRows('local_installation', 'installation_id', [
        installationId,
      ]),
      migrations: historyMigrations,
      triggerCount: Number(
        (
          await rowsOf(
            `SELECT COUNT(*) AS count FROM information_schema.triggers WHERE trigger_schema = ?`,
            [EXPECTED_DB],
          )
        )[0].count,
      ),
    };

    externalLedger = createOwnedResourceLedger();
    setupAllowed = true;

    const organizationCode = `S4E-EXT-${runTag}`;
    const organizationName = `S4-E 外部组织 ${runTag}`;
    const orgResult = await dataSource.query(
      `INSERT INTO organization (organization_code, name, kind, status) VALUES (?, ?, 'PEER', 'ACTIVE')`,
      [organizationCode, organizationName],
    );
    external.organizationId = insertIdOf(orgResult);
    recordOwnedResource(externalLedger, 'organization', external.organizationId, {
      organizationCode,
      name: organizationName,
      kind: 'PEER',
      status: 'ACTIVE',
    });

    const account = await createTestAccount(
      dataSource,
      null,
      {
        loginName: `s4e_ext_${runTag}`,
        loginEmail: `s4e_ext_${runTag}@example.com`,
        loginPassword: 'S4eSpec!Passw0rd',
        status: AccountStatus.ACTIVE,
        identityType: IdentityTypeEnum.ENGINEER,
        accessGroup: [IdentityTypeEnum.ENGINEER],
      },
      externalLedger,
    );
    external.accountId = account.accountId;

    const modelCode = `S4EMDL-EXT-${runTag}`;
    const modelName = `S4-E 外部机型 ${runTag}`;
    const modelResult = await dataSource.query(
      `INSERT INTO equipment_model (model_code, model_name, enabled, sort_order) VALUES (?, ?, 1, 0)`,
      [modelCode, modelName],
    );
    external.equipmentModelId = insertIdOf(modelResult);
    recordOwnedResource(externalLedger, 'equipmentModel', external.equipmentModelId, {
      modelCode,
      modelName,
      enabled: true,
      sortOrder: 0,
    });

    const reportResult = await dataSource.query(
      `INSERT INTO maintenance_report
         (owner_organization_id, source_type, maintenance_engineer_account_id,
          maintenance_engineer_name_snapshot, created_by_account_id, updated_by_account_id,
          status, current_version_no)
       VALUES (?, 'HISTORICAL_CASE', ?, ?, ?, ?, 'DRAFT', 0)`,
      [
        external.organizationId,
        external.accountId,
        `S4-E 外部工程师 ${runTag}`,
        external.accountId,
        external.accountId,
      ],
    );
    external.reportId = insertIdOf(reportResult);

    const conversationResult = await dataSource.query(
      `INSERT INTO ai_conversation (engineer_account_id) VALUES (?)`,
      [external.accountId],
    );
    external.conversationId = insertIdOf(conversationResult);

    const questionResult = await dataSource.query(
      `INSERT INTO ai_message
         (conversation_id, message_seq, turn_no, role, content_text, content_version)
       VALUES (?, 1, 1, 'USER', ?, 1)`,
      [external.conversationId, `S4-E 外部问题 ${runTag}`],
    );
    external.questionMessageId = insertIdOf(questionResult);

    const answerResult = await dataSource.query(
      `INSERT INTO ai_message
         (conversation_id, message_seq, turn_no, role, content_text, content_version)
       VALUES (?, 2, 2, 'ASSISTANT', ?, 1)`,
      [external.conversationId, `S4-E 外部回答 ${runTag}`],
    );
    external.answerMessageId = insertIdOf(answerResult);

    const backupRunResult = await dataSource.query(
      `INSERT INTO local_backup_run
         (installation_id, trigger_type, status, started_at)
       VALUES (?, 'MANUAL', 'RUNNING', CURRENT_TIMESTAMP(3))`,
      [installationId],
    );
    external.backupRunId = insertIdOf(backupRunResult);

    resetCase();
  });

  beforeEach(() => {
    if (consumerInjectionBlocked) {
      throw new Error('consumer 状态未确认：已停止本实例上的后续测试及故障注入，等待执行者处置');
    }
  });

  afterAll(async () => {
    const diagnostics: unknown[] = [];

    if (setupAllowed) {
      // 先精确回收无登记类别的外部父行；任一步失败即停止，保留现场。
      try {
        await runGuardedScopedCleanup({
          dataSource,
          helper: 'S4-E/外部父行回收',
          expectedDatabase: EXPECTED_DB,
          cleanup: async (target) => {
            await target.query('DELETE FROM ai_message WHERE conversation_id = ?', [
              external.conversationId,
            ]);
            await target.query('DELETE FROM ai_conversation WHERE id = ?', [
              external.conversationId,
            ]);
            await target.query('DELETE FROM maintenance_report WHERE id = ?', [external.reportId]);
            if (retainedResources.backupRunIds.has(external.backupRunId)) {
              // P3：冲突备份行及其外部写入值属于套件级保留集合，afterAll 不得再次认领删除。
              console.warn(
                `[S4-E] 冲突备份保留：backup_run_id=${external.backupRunId}，afterAll 跳过删除`,
              );
              return;
            }
            await target.query('DELETE FROM local_backup_run WHERE id = ?', [external.backupRunId]);
          },
        });
      } catch (error) {
        diagnostics.push(new Error('S4-E 外部父行回收失败', { cause: error }));
      }

      if (diagnostics.length === 0) {
        try {
          if (retainedResources.storedFileIds.size > 0) {
            console.warn(
              `[S4-E] 冲突文件及必要父资源保留：file_ids=${[
                ...retainedResources.storedFileIds,
              ].join(',')} account_ids=${[...retainedResources.accountIds].join(
                ',',
              )} organization_ids=${[...retainedResources.organizationIds].join(',')}`,
            );
          }
          // 通用清理尊重套件级保留集合：即使资源仍在台账中，也不会再次认领删除。
          await runGuardedSpecCleanup({
            dataSource,
            helper: 'S4-E/外部台账回收',
            owned: externalLedger,
            retained: retainedCleanupView(),
            expectedDatabase: EXPECTED_DB,
          });
        } catch (error) {
          diagnostics.push(new Error('S4-E 外部台账回收失败', { cause: error }));
        }
      }

      if (diagnostics.length === 0) {
        // 非目标基线：种子行、44 条迁移与触发器数量必须完全不变。
        try {
          expect(await snapshotRows('organization', 'id', [1])).toEqual(baseline.seedOrganization);
          expect(
            await snapshotRows('local_installation', 'installation_id', [installationId]),
          ).toEqual(baseline.seedInstallation);
          expect(await plainRows('SELECT id, name, timestamp FROM migrations ORDER BY id')).toEqual(
            baseline.migrations,
          );
          expect(
            Number(
              (
                await rowsOf(
                  `SELECT COUNT(*) AS count FROM information_schema.triggers WHERE trigger_schema = ?`,
                  [EXPECTED_DB],
                )
              )[0].count,
            ),
          ).toBe(baseline.triggerCount);
        } catch (error) {
          diagnostics.push(new Error('S4-E 非目标基线核对失败', { cause: error }));
        }
      }
    }

    if (observationRunner && !observationRunner.isReleased) {
      if (observationRunner.isTransactionActive) {
        try {
          await observationRunner.rollbackTransaction();
        } catch (error) {
          diagnostics.push(new Error('S4-E 观测连接回滚失败', { cause: error }));
        }
      }
      try {
        await observationRunner.release();
      } catch (error) {
        diagnostics.push(new Error('S4-E 观测连接释放失败', { cause: error }));
      }
    }

    if (dataSource?.isInitialized) {
      try {
        await dataSource.destroy();
      } catch (error) {
        diagnostics.push(new Error('S4-E DataSource 关闭失败', { cause: error }));
      }
    }

    if (diagnostics.length > 0) {
      throw new AggregateError(diagnostics, 'S4-E afterAll 存在失败诊断');
    }
  });

  const runCase = async (name: string, body: () => Promise<void>): Promise<void> => {
    let primary: unknown;
    let hasPrimary = false;
    const diagnostics: unknown[] = [];
    try {
      await body();
    } catch (error) {
      primary = error;
      hasPrimary = true;
    } finally {
      try {
        diagnostics.push(...(await cleanupCase(name)));
      } catch (error) {
        diagnostics.push(new Error(`${name} 收尾诊断收集失败`, { cause: error }));
      }
    }
    if (hasPrimary && diagnostics.length > 0) {
      throw new AggregateError([primary, ...diagnostics], `${name} 主错误与收尾错误`);
    }
    if (hasPrimary) {
      throw primary;
    }
    if (diagnostics.length > 0) {
      throw new AggregateError(diagnostics, `${name} 收尾失败`);
    }
  };

  // =========================================================================
  // R01：父行在范围、子行未登记
  // =========================================================================

  it('R01 父行在范围但子行未登记：首删前拒绝且零破坏', async () => {
    let intakeId = 0;
    let attemptId = 0;
    const failure = await captureFailure(async () =>
      runCase('S4-E/R01', async () => {
        intakeId = await insertIntake(caseLedger, {
          customerAccountId: external.accountId,
          customerOrganizationId: external.organizationId,
          serviceOrganizationId: external.organizationId,
          equipmentModelId: external.equipmentModelId,
          tag: 'r01',
        });
        attemptId = await insertAttempt(caseLedger, intakeId);
        // 独立测试执行者收尾责任：先按真实创建事实登记，再移除被测台账记录。
        // 这样“移除台账 → 后续读取/断言”之间发生异常时仍能精确回收子行。
        recordOwnedResource(executorLedger, 'intakeAnalysisAttempt', attemptId, {
          intakeId,
          generationNo: 0,
        });
        // 干扰：父行（intake）已登记，子行（attempt）故意不登记。
        caseLedger.intakeAnalysisAttemptIds.splice(0, caseLedger.intakeAnalysisAttemptIds.length);
        caseLedger.facts.intakeAnalysisAttempt.clear();

        const before = {
          intake: await readWithControlledFault('R01', 'intake-snapshot', () =>
            snapshotRows('repair_request_intake', 'id', [intakeId]),
          ),
          attempt: await readWithControlledFault('R01', 'attempt-snapshot', () =>
            snapshotRows('intake_analysis_attempt', 'id', [attemptId]),
          ),
        };

        await rejectWithoutDestructiveCalls(caseLedger, 'S4-E/R01', '该子行未登记归属证据');

        expect({
          intake: await snapshotRows('repair_request_intake', 'id', [intakeId]),
          attempt: await snapshotRows('intake_analysis_attempt', 'id', [attemptId]),
        }).toEqual(before);
      }),
    );

    if (!faultArmedFor('R01')) {
      if (failure !== undefined) {
        throw failure instanceof Error ? failure : new Error(messageOf(failure));
      }
      return;
    }

    // 受控中断：主错误必须可追溯，finally 仍精确回收子行与父行，非目标种子不变。
    expect(messageOf(failure)).toContain('INJECTED_READ_FAILURE:R01');
    expect(await snapshotRows('repair_request_intake', 'id', [intakeId])).toEqual([]);
    expect(await snapshotRows('intake_analysis_attempt', 'id', [attemptId])).toEqual([]);
    await assertSeedBaselineUnchanged();
  });

  // =========================================================================
  // R02：已登记事实被改写
  // =========================================================================

  it('R02 已登记资源事实被改写：首删前拒绝且零破坏', async () => {
    let fileId = '';
    const failure = await captureFailure(async () =>
      runCase('S4-E/R02', async () => {
        const originalFilename = 's4e-r02.txt';
        fileId = await insertStoredFile(caseLedger, {
          uploaderAccountId: external.accountId,
          ownerOrganizationId: external.organizationId,
          tag: 'r02',
          originalFilename,
        });
        const driftedFilename = `drifted-${runTag}.txt`;
        await dataSource.query('UPDATE stored_file SET original_filename = ? WHERE file_id = ?', [
          driftedFilename,
          fileId,
        ]);
        // 改写成功立即登记原值、写入值与字节精确 CAS 恢复条件，早于任何读取/断言。
        // 不使用 utf8mb4_0900_ai_ci 的普通等号：另一连接仅改大小写/尾部空格时不得覆盖。
        executorCasRestores.push({
          label: 'stored_file.original_filename',
          targetId: fileId,
          sql:
            'UPDATE stored_file SET original_filename = ? ' +
            'WHERE file_id = ? ' +
            `AND ${byteExactTextMatchCondition('file_id')} ` +
            `AND ${byteExactTextMatchCondition('original_filename')}`,
          parameters: [originalFilename, fileId, fileId, driftedFilename],
        });

        const before = await readWithControlledFault('R02', 'stored-file-snapshot', () =>
          snapshotRows('stored_file', 'file_id', [fileId]),
        );
        expect(before[0].original_filename).toBe(driftedFilename);

        await rejectWithoutDestructiveCalls(caseLedger, 'S4-E/R02', '本轮登记事实漂移');

        expect(await snapshotRows('stored_file', 'file_id', [fileId])).toEqual(before);
      }),
    );

    if (!faultArmedFor('R02')) {
      if (failure !== undefined) {
        throw failure instanceof Error ? failure : new Error(messageOf(failure));
      }
      return;
    }

    expect(messageOf(failure)).toContain('INJECTED_READ_FAILURE:R02');
    expect(await snapshotRows('stored_file', 'file_id', [fileId])).toEqual([]);
    await assertSeedBaselineUnchanged();
  });

  // =========================================================================
  // R02-CONFLICT：另一受控连接在登记后只改大小写
  // =========================================================================

  (SECOND_CONNECTION_INTERFERENCE && faultArmedFor('R02-CONFLICT') ? it : it.skip)(
    'R02-CONFLICT 另一连接仅改大小写：字节精确恢复拒绝，冲突行按设计保留',
    async () => {
      const originalFilename = `s4e-r02-conflict-${runTag}.txt`;
      const writtenFilename = `s4e-r02-written-${runTag}.txt`;
      // 另一受控连接只改变字母大小写，模拟排序规则等价改写。
      const caseChangedFilename = writtenFilename.toUpperCase();
      // 受控修改前登记本轮预期字节值；删除只允许使用该预期值。
      // 回读仅用于比较与定位，绝不替换这里的预期事实。
      const expectedFilename = writtenFilename;
      let fileId = '';
      let controlledWriteCommitted = false;
      let recoveryError: Error | undefined;

      try {
        const failure = await captureFailure(async () =>
          runCase('S4-E/R02-CONFLICT', async () => {
            fileId = await insertStoredFile(caseLedger, {
              uploaderAccountId: external.accountId,
              ownerOrganizationId: external.organizationId,
              tag: 'r02-conflict',
              originalFilename,
            });
            // 第一条受控写入由第二连接提交；写入前 expectedFilename 已登记。
            const second = dataSource.createQueryRunner();
            try {
              await second.connect();
              await second.startTransaction();
              await second.query('UPDATE stored_file SET original_filename = ? WHERE file_id = ?', [
                expectedFilename,
                fileId,
              ]);
              await second.commitTransaction();
              controlledWriteCommitted = true;
            } finally {
              await second.release();
            }
            // 登记 CAS 恢复条件（写入值）。
            executorCasRestores.push({
              label: 'stored_file.original_filename',
              targetId: fileId,
              sql:
                'UPDATE stored_file SET original_filename = ? ' +
                'WHERE file_id = ? ' +
                `AND ${byteExactTextMatchCondition('file_id')} ` +
                `AND ${byteExactTextMatchCondition('original_filename')}`,
              parameters: [originalFilename, fileId, fileId, expectedFilename],
            });
            // 另一连接再次提交“仅大小写”变化，CAS 的写入值条件不再字节命中。
            const third = dataSource.createQueryRunner();
            try {
              await third.connect();
              await third.startTransaction();
              await third.query('UPDATE stored_file SET original_filename = ? WHERE file_id = ?', [
                caseChangedFilename,
                fileId,
              ]);
              await third.commitTransaction();
            } finally {
              await third.release();
            }

            await readWithControlledFault('R02-CONFLICT', 'stored-file-snapshot', () =>
              snapshotRows('stored_file', 'file_id', [fileId]),
            );
          }),
        );

        // 主读取错误与恢复冲突都必须保留，且报告可定位的行 ID。
        expect(messageOf(failure)).toContain('INJECTED_READ_FAILURE:R02-CONFLICT');
        expect(messageOf(failure)).toContain('恢复冲突');
        expect(messageOf(failure)).toContain(`targetId=${fileId}`);
        expect(messageOf(failure)).toContain('已跳过后续通用清理');

        // 直接证据：冲突行未被覆盖、未被通用清理删除。
        const retained = await snapshotRows('stored_file', 'file_id', [fileId]);
        expect(retained).toHaveLength(1);
        expect(String(retained[0].original_filename)).toBe(caseChangedFilename);
        // 只输出脱敏行标识与字节事实，不落盘、不输出连接信息。
        console.info(
          `[S4-E/R02-CONFLICT] retained file_id=${fileId} ` +
            `original_filename_bytes=${Buffer.from(caseChangedFilename, 'utf8').toString('hex')}`,
        );
      } finally {
        // 独立测试执行者收尾：与被测清理器分离，删除条件只使用受控修改前登记的
        // expectedFilename；当前值仅用于比较与定位，绝不反填为预期事实。
        if (fileId !== '' && controlledWriteCommitted) {
          try {
            const outcome = await reclaimConflictFileByExpectedBytes(fileId, expectedFilename);
            if (outcome.kind === 'retained') {
              // P3：冲突行、外部写入值及必要父资源进入套件级保留集合，
              // 后续用例收尾、通用清理与 afterAll 均不得再次认领删除。
              retainConflictFile(fileId);
              console.warn(
                `[S4-E/R02-CONFLICT] 第三方值保留：file_id=${fileId} ` +
                  `expected_bytes=${Buffer.from(expectedFilename, 'utf8').toString('hex')} ` +
                  `current_bytes=${Buffer.from(outcome.currentFilename, 'utf8').toString('hex')} ` +
                  'DELETE affectedRows=0；未继续通用删除',
              );
            } else if (outcome.kind === 'mismatch') {
              recoveryError = new Error(
                `R02-CONFLICT 独立回收未命中：file_id=${fileId} ` +
                  `expected_bytes=${Buffer.from(expectedFilename, 'utf8').toString('hex')} ` +
                  `current_rows=${outcome.currentRows} DELETE affectedRows=0；` +
                  '零匹配不视为回收成功',
              );
            } else if (outcome.kind === 'absent') {
              console.info(
                `[S4-E/R02-CONFLICT] 冲突行已由用例台账回收：file_id=${fileId}，` +
                  '独立收尾未发起 DELETE',
              );
            }
          } catch (error) {
            recoveryError =
              error instanceof Error
                ? error
                : new Error(`R02-CONFLICT 独立回收异常：${String(error)}`);
          }
        }
      }
      if (recoveryError !== undefined) {
        throw recoveryError;
      }
    },
  );

  // =========================================================================
  // R03：集合外记录引用本轮目标
  // =========================================================================

  it('R03 集合外工单引用本轮 intake：拒绝且零删除零解环', async () => {
    let intakeId = 0;
    let externalRequestId = 0;
    const failure = await captureFailure(async () =>
      runCase('S4-E/R03', async () => {
        intakeId = await insertIntake(caseLedger, {
          customerAccountId: external.accountId,
          customerOrganizationId: external.organizationId,
          serviceOrganizationId: external.organizationId,
          equipmentModelId: external.equipmentModelId,
          tag: 'r03',
        });

        const externalRequestNo = `S4E-EXTREQ-r03-${runTag}`;
        const externalRequestResult = await dataSource.query(
          `INSERT INTO repair_request
             (request_no, customer_account_id, equipment_model_id, error_code, fault_description,
              content_md, intake_id, customer_organization_id, service_organization_id,
              owner_organization_id)
           VALUES (?, ?, ?, 'E001', 'S4-E 外部工单', 'S4-E 外部内容', ?, ?, ?, ?)`,
          [
            externalRequestNo,
            external.accountId,
            external.equipmentModelId,
            intakeId,
            external.organizationId,
            external.organizationId,
            external.organizationId,
          ],
        );
        externalRequestId = insertIdOf(externalRequestResult);
        // INSERT 成功立即登记收尾事实；该行只属于测试执行者，不重新塞回被测台账，
        // 保留“集合外记录”语义。回收条件同时限定真实 ID 与创建事实，且在用例台账
        // 之前执行，先解除 intake_id 外键引用；不能放进测试执行者台账，
        // 因为该台账的归属核验要求客户账号/机型也在本轮删除范围内。
        caseDirectCleanups.push(async () => {
          await guardedDirect(
            'DELETE FROM repair_request WHERE id = ? AND request_no = ? ' +
              'AND customer_account_id = ? AND equipment_model_id = ? AND intake_id = ?',
            [
              externalRequestId,
              externalRequestNo,
              external.accountId,
              external.equipmentModelId,
              intakeId,
            ],
          );
        });

        const before = {
          intake: await readWithControlledFault('R03', 'intake-snapshot', () =>
            snapshotRows('repair_request_intake', 'id', [intakeId]),
          ),
          externalRequest: await readWithControlledFault('R03', 'external-request-snapshot', () =>
            snapshotRows('repair_request', 'id', [externalRequestId]),
          ),
        };

        await rejectWithoutDestructiveCalls(
          caseLedger,
          'S4-E/R03',
          '工单经 intake_id 引用本轮报修输入但未登记归属证据',
        );

        expect({
          intake: await snapshotRows('repair_request_intake', 'id', [intakeId]),
          externalRequest: await snapshotRows('repair_request', 'id', [externalRequestId]),
        }).toEqual(before);
      }),
    );

    if (!faultArmedFor('R03')) {
      if (failure !== undefined) {
        throw failure instanceof Error ? failure : new Error(messageOf(failure));
      }
      return;
    }

    expect(messageOf(failure)).toContain('INJECTED_READ_FAILURE:R03');
    expect(await snapshotRows('repair_request', 'id', [externalRequestId])).toEqual([]);
    expect(await snapshotRows('repair_request_intake', 'id', [intakeId])).toEqual([]);
    await assertSeedBaselineUnchanged();
  });

  /**
   * P3：套件级保留的冲突文件仍按事实存在，不计为“未登记残留”。
   * 仅 `stored_file` 使用保留集合；其他表仍要求精确零行。
   */
  const expectResidueMatchesRetention = async (table: string): Promise<void> => {
    const retainedIds = table === 'stored_file' ? [...retainedResources.storedFileIds] : [];
    if (retainedIds.length === 0) {
      expect(await countOf(table)).toBe(0);
      return;
    }
    expect(await snapshotRows('stored_file', 'file_id', retainedIds)).toHaveLength(
      retainedIds.length,
    );
    expect(await countOf(table)).toBe(retainedIds.length);
  };

  // =========================================================================
  // R04：合法精确清理（17 表全量 + 字符串/整数主键）
  // =========================================================================

  it('R04 合法精确清理：17 表全量、依赖顺序、字符串与整数主键', async () => {
    let recorder: ReturnType<typeof createDestructiveRecorder> | undefined;
    let requestId = 0;
    let documentId = 0;
    await runCase('S4-E/R04', async () => {
      const parents = await createCaseParents(caseLedger, 'r04');

      const fileId = await insertStoredFile(caseLedger, {
        uploaderAccountId: parents.accountId,
        ownerOrganizationId: parents.organizationId,
        tag: 'r04',
      });
      requestId = await insertRepairRequest(caseLedger, {
        customerAccountId: parents.accountId,
        equipmentModelId: parents.equipmentModelId,
        organizationId: parents.organizationId,
        tag: 'r04',
      });
      const intakeId = await insertIntake(caseLedger, {
        customerAccountId: parents.accountId,
        customerOrganizationId: parents.organizationId,
        serviceOrganizationId: parents.organizationId,
        equipmentModelId: parents.equipmentModelId,
        tag: 'r04',
        fileId,
        convertedRequestId: requestId,
      });
      // 建立 intake ↔ repair_request 双向引用，验证合法解环。
      await dataSource.query('UPDATE repair_request SET intake_id = ? WHERE id = ?', [
        intakeId,
        requestId,
      ]);
      await insertAttempt(caseLedger, intakeId);
      await insertProcessEntry(caseLedger, {
        requestId,
        authorAccountId: parents.accountId,
        fileId,
        tag: 'r04',
      });
      await insertAiMessageAnalysis(caseLedger);
      await insertMaintenanceReportFault(caseLedger, 'r04');
      await insertRepairRequestRevision(caseLedger, {
        requestId,
        actorAccountId: parents.accountId,
        tag: 'r04',
      });
      documentId = await insertReferenceDocument(caseLedger, {
        ownerOrganizationId: parents.organizationId,
        createdByAccountId: parents.accountId,
        tag: 'r04',
      });
      await insertReferenceDocumentRevision(caseLedger, {
        documentId,
        actorAccountId: parents.accountId,
        tag: 'r04',
      });
      await insertLocalAccountAuthorization(caseLedger, {
        organizationId: parents.organizationId,
        accountId: parents.accountId,
      });
      await insertLocalCompanySetting(caseLedger, parents.organizationId);
      const receiptId = await insertSyncReceipt(caseLedger, {
        organizationId: parents.organizationId,
        tag: 'r04',
      });
      await insertSyncConflict(caseLedger, {
        organizationId: parents.organizationId,
        tag: 'r04',
      });
      const packageId = await insertRecordPackage(caseLedger, {
        organizationId: parents.organizationId,
        importedByAccountId: parents.accountId,
        tag: 'r04',
      });
      await insertRecordPackageItem(caseLedger, { packageId, receiptId, tag: 'r04' });
      const backupId = await insertBackupAsset(caseLedger, {
        organizationId: parents.organizationId,
        tag: 'r04-main',
      });
      const protectionBackupId = await insertBackupAsset(caseLedger, {
        organizationId: parents.organizationId,
        tag: 'r04-protection',
      });
      await insertBackupRestoreRun(caseLedger, {
        backupId,
        protectionBackupId,
        organizationId: parents.organizationId,
        startedByAccountId: parents.accountId,
      });
      await insertManagementAuditEvent(caseLedger, {
        actorAccountId: parents.accountId,
        organizationId: parents.organizationId,
        tag: 'r04',
      });

      recorder = createDestructiveRecorder(dataSource);
      await runGuardedSpecCleanup({
        dataSource: recorder.dataSource,
        helper: 'S4-E/R04',
        owned: caseLedger,
        expectedDatabase: EXPECTED_DB,
      });
      resetCase();
      await assertNoActiveTransactions();

      const calls = recorder.calls;
      expect(calls[0]).toEqual(
        expect.objectContaining({ kind: 'UPDATE', table: 'repair_request', affectedRows: 1 }),
      );

      const expectedDeletes: Record<string, number> = {
        intake_analysis_attempt: 1,
        record_package_item: 1,
        backup_restore_run: 1,
        repair_process_entry: 1,
        ai_message_analysis: 1,
        repair_request_revision: 1,
        reference_document_revision: 1,
        repair_request_intake: 1,
        local_account_authorization: 1,
        local_company_setting: 1,
        sync_conflict: 1,
        sync_receipt: 1,
        record_package_import: 1,
        backup_asset: 2,
        management_audit_event: 1,
        maintenance_report_fault: 1,
        stored_file: 1,
        repair_request: 1,
        reference_document: 1,
        organization: 1,
        base_user_info: 1,
        base_user_account: 1,
        equipment_model: 1,
      };
      for (const [table, affectedRows] of Object.entries(expectedDeletes)) {
        expect(calls.filter((call) => call.kind === 'DELETE' && call.table === table)).toHaveLength(
          1,
        );
        expect(
          calls.find((call) => call.kind === 'DELETE' && call.table === table)?.affectedRows,
        ).toBe(affectedRows);
      }

      const deleteOrder = calls.filter((call) => call.kind === 'DELETE').map((call) => call.table);
      expect(deleteOrder.indexOf('intake_analysis_attempt')).toBeLessThan(
        deleteOrder.indexOf('repair_request_intake'),
      );
      expect(deleteOrder.indexOf('record_package_item')).toBeLessThan(
        deleteOrder.indexOf('record_package_import'),
      );
      expect(deleteOrder.indexOf('backup_restore_run')).toBeLessThan(
        deleteOrder.indexOf('backup_asset'),
      );
      expect(deleteOrder.indexOf('maintenance_report_fault')).toBeLessThan(
        deleteOrder.indexOf('stored_file'),
      );
      expect(deleteOrder.indexOf('stored_file')).toBeLessThan(
        deleteOrder.indexOf('repair_request'),
      );
      expect(deleteOrder.indexOf('reference_document')).toBeLessThan(
        deleteOrder.indexOf('organization'),
      );

      for (const table of [
        'stored_file',
        'repair_request_intake',
        'intake_analysis_attempt',
        'repair_process_entry',
        'ai_message_analysis',
        'maintenance_report_fault',
        'repair_request_revision',
        'reference_document_revision',
        'local_account_authorization',
        'local_company_setting',
        'sync_receipt',
        'sync_conflict',
        'record_package_import',
        'record_package_item',
        'backup_asset',
        'backup_restore_run',
        'management_audit_event',
      ]) {
        await expectResidueMatchesRetention(table);
      }
      expect(await countOf('repair_request')).toBe(0);
      expect(await countOf('reference_document')).toBe(0);
    });

    // 用例级单行断言：即使上面提前失败，也保持可定位的独立证据。
    if (requestId > 0) {
      expect(await snapshotRows('repair_request', 'id', [requestId])).toEqual([]);
    }
    if (documentId > 0) {
      expect(await snapshotRows('reference_document', 'id', [documentId])).toEqual([]);
    }
  });

  // =========================================================================
  // R05：后序删除失败，前序 DELETE 与解环 UPDATE 全回滚
  // =========================================================================

  it('R05 后序删除失败：前序 DELETE 与解环 UPDATE 全部回滚', async () => {
    let requestId = 0;
    let intakeId = 0;
    let attemptId = 0;
    let entryId = 0;
    let fileId = '';
    await runCase('S4-E/R05', async () => {
      const parents = await createCaseParents(caseLedger, 'r05');
      fileId = await insertStoredFile(caseLedger, {
        uploaderAccountId: parents.accountId,
        ownerOrganizationId: parents.organizationId,
        tag: 'r05',
      });
      requestId = await insertRepairRequest(caseLedger, {
        customerAccountId: parents.accountId,
        equipmentModelId: parents.equipmentModelId,
        organizationId: parents.organizationId,
        tag: 'r05',
      });
      intakeId = await insertIntake(caseLedger, {
        customerAccountId: parents.accountId,
        customerOrganizationId: parents.organizationId,
        serviceOrganizationId: parents.organizationId,
        equipmentModelId: parents.equipmentModelId,
        tag: 'r05',
        fileId,
        convertedRequestId: requestId,
      });
      await dataSource.query('UPDATE repair_request SET intake_id = ? WHERE id = ?', [
        intakeId,
        requestId,
      ]);
      attemptId = await insertAttempt(caseLedger, intakeId);
      entryId = await insertProcessEntry(caseLedger, {
        requestId,
        authorAccountId: parents.accountId,
        fileId,
        tag: 'r05',
      });

      const tables = [
        { table: 'stored_file', key: 'file_id', id: fileId },
        { table: 'repair_request_intake', key: 'id', id: intakeId },
        { table: 'intake_analysis_attempt', key: 'id', id: attemptId },
        { table: 'repair_process_entry', key: 'id', id: entryId },
        { table: 'repair_request', key: 'id', id: requestId },
      ] as const;
      const before = {
        stored_file: await snapshotRows('stored_file', 'file_id', [fileId]),
        repair_request_intake: await snapshotRows('repair_request_intake', 'id', [intakeId]),
        intake_analysis_attempt: await snapshotRows('intake_analysis_attempt', 'id', [attemptId]),
        repair_process_entry: await snapshotRows('repair_process_entry', 'id', [entryId]),
        repair_request: await snapshotRows('repair_request', 'id', [requestId]),
      };
      expect(before.repair_request[0].intake_id).toBe(intakeId);

      const recorder = createDestructiveRecorder(dataSource, { failOnDeleteTable: 'stored_file' });
      let caught: unknown;
      try {
        await runGuardedSpecCleanup({
          dataSource: recorder.dataSource,
          helper: 'S4-E/R05',
          owned: caseLedger,
          expectedDatabase: EXPECTED_DB,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(messageOf(caught)).toContain('INJECTED_DELETE_FAILURE:stored_file');
      await assertNoActiveTransactions();

      // 破坏性调用确实发生过，但全部随事务回滚。
      expect(recorder.calls[0]).toEqual(
        expect.objectContaining({ kind: 'UPDATE', table: 'repair_request', affectedRows: 1 }),
      );
      expect(
        recorder.calls.filter((call) => call.kind === 'DELETE').map((call) => call.table),
      ).toEqual(['intake_analysis_attempt', 'repair_process_entry', 'repair_request_intake']);

      expect({
        stored_file: await snapshotRows('stored_file', 'file_id', [fileId]),
        repair_request_intake: await snapshotRows('repair_request_intake', 'id', [intakeId]),
        intake_analysis_attempt: await snapshotRows('intake_analysis_attempt', 'id', [attemptId]),
        repair_process_entry: await snapshotRows('repair_process_entry', 'id', [entryId]),
        repair_request: await snapshotRows('repair_request', 'id', [requestId]),
      }).toEqual(before);
      expect((await snapshotRows('repair_request', 'id', [requestId]))[0].intake_id).toBe(intakeId);
      expect(tables.length).toBe(5);

      // 回滚后走正常清理：证明保留的是完整可回收现场。
      await runGuardedSpecCleanup({
        dataSource,
        helper: 'S4-E/R05/恢复回收',
        owned: caseLedger,
        expectedDatabase: EXPECTED_DB,
      });
      resetCase();
      expect(await snapshotRows('repair_request', 'id', [requestId])).toEqual([]);
      expect(await snapshotRows('repair_request_intake', 'id', [intakeId])).toEqual([]);
      expect(await snapshotRows('stored_file', 'file_id', [fileId])).toEqual([]);
    });
  });

  // =========================================================================
  // R06：清理完成后重复执行
  // =========================================================================

  it('R06 清理完成后重复执行：安全、零新增删除、非目标不变', async () => {
    await runCase('S4-E/R06', async () => {
      const parents = await createCaseParents(caseLedger, 'r06');
      const fileId = await insertStoredFile(caseLedger, {
        uploaderAccountId: parents.accountId,
        ownerOrganizationId: parents.organizationId,
        tag: 'r06',
      });
      const receiptId = await insertSyncReceipt(caseLedger, {
        organizationId: parents.organizationId,
        tag: 'r06',
      });
      const organizationBefore = await snapshotRows('organization', 'id', [parents.organizationId]);
      const receiptBefore = await snapshotRows('sync_receipt', 'receipt_id', [receiptId]);
      expect(organizationBefore).toHaveLength(1);
      expect(receiptBefore).toHaveLength(1);

      const first = createDestructiveRecorder(dataSource);
      await runGuardedSpecCleanup({
        dataSource: first.dataSource,
        helper: 'S4-E/R06/第一次',
        owned: caseLedger,
        expectedDatabase: EXPECTED_DB,
      });
      await assertNoActiveTransactions();
      expect(await snapshotRows('stored_file', 'file_id', [fileId])).toEqual([]);
      expect(await snapshotRows('sync_receipt', 'receipt_id', [receiptId])).toEqual([]);

      // 重复执行同一个已清空台账：只允许 0 行影响的 DELETE，不允许任何 UPDATE。
      const second = createDestructiveRecorder(dataSource);
      await runGuardedSpecCleanup({
        dataSource: second.dataSource,
        helper: 'S4-E/R06/第二次',
        owned: caseLedger,
        expectedDatabase: EXPECTED_DB,
      });
      resetCase();
      await assertNoActiveTransactions();

      expect(second.calls.length).toBeGreaterThan(0);
      expect(second.calls.every((call) => call.kind === 'DELETE')).toBe(true);
      expect(second.calls.every((call) => call.affectedRows === 0)).toBe(true);

      expect(await snapshotRows('organization', 'id', [1])).toEqual(baseline.seedOrganization);
      expect(await snapshotRows('local_installation', 'id', [1])).toEqual(
        baseline.seedInstallation,
      );
      expect(await plainRows('SELECT id, name, timestamp FROM migrations ORDER BY id')).toEqual(
        baseline.migrations,
      );
      expect(
        Number(
          (
            await rowsOf(
              `SELECT COUNT(*) AS count FROM information_schema.triggers WHERE trigger_schema = ?`,
              [EXPECTED_DB],
            )
          )[0].count,
        ),
      ).toBe(baseline.triggerCount);
      await expectResidueMatchesRetention('stored_file');
      expect(await countOf('sync_receipt')).toBe(0);
    });
  });

  // =========================================================================
  // R07a：合法循环引用
  // =========================================================================

  it('R07a intake 与 repair_request 合法循环引用：解环后可回收', async () => {
    await runCase('S4-E/R07a', async () => {
      const parents = await createCaseParents(caseLedger, 'r07a');
      const requestId = await insertRepairRequest(caseLedger, {
        customerAccountId: parents.accountId,
        equipmentModelId: parents.equipmentModelId,
        organizationId: parents.organizationId,
        tag: 'r07a',
      });
      const intakeId = await insertIntake(caseLedger, {
        customerAccountId: parents.accountId,
        customerOrganizationId: parents.organizationId,
        serviceOrganizationId: parents.organizationId,
        equipmentModelId: parents.equipmentModelId,
        tag: 'r07a',
        convertedRequestId: requestId,
      });
      await dataSource.query('UPDATE repair_request SET intake_id = ? WHERE id = ?', [
        intakeId,
        requestId,
      ]);

      const before = {
        request: await snapshotRows('repair_request', 'id', [requestId]),
        intake: await snapshotRows('repair_request_intake', 'id', [intakeId]),
      };
      expect(before.request[0].intake_id).toBe(intakeId);
      expect(before.intake[0].converted_request_id).toBe(requestId);

      const recorder = createDestructiveRecorder(dataSource);
      await runGuardedSpecCleanup({
        dataSource: recorder.dataSource,
        helper: 'S4-E/R07a',
        owned: caseLedger,
        expectedDatabase: EXPECTED_DB,
      });
      resetCase();
      await assertNoActiveTransactions();

      expect(recorder.calls[0]).toEqual(
        expect.objectContaining({ kind: 'UPDATE', table: 'repair_request', affectedRows: 1 }),
      );
      expect(recorder.calls.filter((call) => call.kind === 'UPDATE')).toHaveLength(1);
      expect(await snapshotRows('repair_request', 'id', [requestId])).toEqual([]);
      expect(await snapshotRows('repair_request_intake', 'id', [intakeId])).toEqual([]);
    });
  });

  // =========================================================================
  // R07b：额外引用时不得先解环
  // =========================================================================

  it('R07b 循环引用存在集合外记录时：零解环、零删除、逐字段不变', async () => {
    await runCase('S4-E/R07b', async () => {
      const parents = await createCaseParents(caseLedger, 'r07b');
      const requestId = await insertRepairRequest(caseLedger, {
        customerAccountId: parents.accountId,
        equipmentModelId: parents.equipmentModelId,
        organizationId: parents.organizationId,
        tag: 'r07b',
      });
      const intakeId = await insertIntake(caseLedger, {
        customerAccountId: parents.accountId,
        customerOrganizationId: parents.organizationId,
        serviceOrganizationId: parents.organizationId,
        equipmentModelId: parents.equipmentModelId,
        tag: 'r07b',
        convertedRequestId: requestId,
      });
      const originalRequestRow = (await snapshotRows('repair_request', 'id', [requestId]))[0];
      const originalIntakeId = originalRequestRow.intake_id ?? null;
      await dataSource.query('UPDATE repair_request SET intake_id = ? WHERE id = ?', [
        intakeId,
        requestId,
      ]);
      // RQ6：UPDATE 成功后立即登记原值与恢复条件，之后才执行可能失败的查询/断言。
      caseDirectCleanups.push(async () => {
        await guardedDirect(
          'UPDATE repair_request SET intake_id = ? WHERE id = ? AND intake_id = ?',
          [originalIntakeId, requestId, intakeId],
        );
      });

      // 额外引用：集合外处理记录通过 request_id 指向本轮登记的 request。
      // uk_repair_request_intake_converted 只允许一个 intake 指向同一 request，
      // 因此这里用另一张有 request_id 外键的表制造集合外引用。
      const externalEntryResult = await dataSource.query(
        `INSERT INTO repair_process_entry
           (entry_uuid, request_id, author_account_id, operation_text, time_source,
            file_id, version_no)
         VALUES (?, ?, ?, 'S4-E 外部处理记录', 'AUTO', NULL, 1)`,
        [randomUUID(), requestId, external.accountId],
      );
      const externalEntryId = insertIdOf(externalEntryResult);
      // RQ6：INSERT 成功后立即登记真实 ID，之后才执行可能失败的查询/断言。
      caseDirectCleanups.push(async () => {
        await guardedDirect('DELETE FROM repair_process_entry WHERE id = ?', [externalEntryId]);
      });

      const before = {
        request: await snapshotRows('repair_request', 'id', [requestId]),
        intake: await snapshotRows('repair_request_intake', 'id', [intakeId]),
        externalEntry: await snapshotRows('repair_process_entry', 'id', [externalEntryId]),
      };
      expect(before.request[0].intake_id).toBe(intakeId);

      await rejectWithoutDestructiveCalls(caseLedger, 'S4-E/R07b', '该子行未登记归属证据');

      expect((await snapshotRows('repair_request', 'id', [requestId]))[0].intake_id).toBe(intakeId);
    });
  });

  // =========================================================================
  // R08：多态 stored_file 引用
  // =========================================================================

  it('R08 多态 stored_file 被集合外业务引用：按事实核验，不自动认领', async () => {
    await runCase('S4-E/R08', async () => {
      const fileId = await insertStoredFile(caseLedger, {
        uploaderAccountId: external.accountId,
        ownerOrganizationId: external.organizationId,
        tag: 'r08',
      });

      // 多态绑定：stored_file 无 FK 到 intake，只有业务列 file_id 引用。
      const externalIntakeResult = await dataSource.query(
        `INSERT INTO repair_request_intake
           (record_uuid, customer_account_id, customer_organization_id, service_organization_id,
            equipment_model_id, error_code, fault_description, file_id, analysis_status,
            analysis_generation)
         VALUES (?, ?, ?, ?, ?, 'E001', 'S4-E 多态引用', ?, 'WAITING', 0)`,
        [
          randomUUID(),
          external.accountId,
          external.organizationId,
          external.organizationId,
          external.equipmentModelId,
          fileId,
        ],
      );
      const externalIntakeId = insertIdOf(externalIntakeResult);
      // RQ6：INSERT 成功后立即登记真实 ID，之后才执行可能失败的查询/断言。
      caseDirectCleanups.push(async () => {
        await guardedDirect('DELETE FROM repair_request_intake WHERE id = ?', [externalIntakeId]);
      });

      const before = {
        file: await snapshotRows('stored_file', 'file_id', [fileId]),
        externalIntake: await snapshotRows('repair_request_intake', 'id', [externalIntakeId]),
      };

      await rejectWithoutDestructiveCalls(caseLedger, 'S4-E/R08', '该子行未登记归属证据');

      expect({
        file: await snapshotRows('stored_file', 'file_id', [fileId]),
        externalIntake: await snapshotRows('repair_request_intake', 'id', [externalIntakeId]),
      }).toEqual(before);
    });
  });

  // =========================================================================
  // R09：非目标基线与迁移种子不变
  // =========================================================================

  it('R09 非目标基线、迁移与触发器不变，除套件保留外 17 表零残留', async () => {
    expect(await snapshotRows('organization', 'id', [1])).toEqual(baseline.seedOrganization);
    expect(await snapshotRows('local_installation', 'installation_id', [installationId])).toEqual(
      baseline.seedInstallation,
    );
    expect(await plainRows('SELECT id, name, timestamp FROM migrations ORDER BY id')).toEqual(
      baseline.migrations,
    );
    expect(baseline.migrations).toHaveLength(44);
    expect(
      Number(
        (
          await rowsOf(
            `SELECT COUNT(*) AS count FROM information_schema.triggers WHERE trigger_schema = ?`,
            [EXPECTED_DB],
          )
        )[0].count,
      ),
    ).toBe(0);

    for (const table of [
      'stored_file',
      'repair_request_intake',
      'intake_analysis_attempt',
      'repair_process_entry',
      'ai_message_analysis',
      'maintenance_report_fault',
      'repair_request_revision',
      'reference_document_revision',
      'local_account_authorization',
      'local_company_setting',
      'sync_receipt',
      'sync_conflict',
      'record_package_import',
      'record_package_item',
      'backup_asset',
      'backup_restore_run',
      'management_audit_event',
    ]) {
      const retainedIds = table === 'stored_file' ? [...retainedResources.storedFileIds] : [];
      if (retainedIds.length > 0) {
        // P3：套件级保留的冲突文件仍按事实存在，不计为“未登记残留”；
        // 但除这些已登记 ID 外，本表不得有任何其他行。
        const retainedRows = await snapshotRows('stored_file', 'file_id', retainedIds);
        expect(retainedRows).toHaveLength(retainedIds.length);
        expect(await countOf(table)).toBe(retainedIds.length);
      } else {
        expect(await countOf(table)).toBe(0);
      }
    }

    // 冲突备份行同样按套件级保留集合核验仍在，而不是被 afterAll 删除制造零残留。
    for (const backupRunId of retainedResources.backupRunIds) {
      expect(await snapshotRows('local_backup_run', 'id', [backupRunId])).toHaveLength(1);
    }

    await assertNoActiveTransactions();
  });

  // =========================================================================
  // RQ6：受控实库故障注入（默认关闭，需 E2E_V13_CONTROLLED_FAULT=1）
  // =========================================================================

  (CONTROLLED_FAULT ? it : it.skip)(
    'FAULT-CREATE 创建干扰行后真实断言失败，仍精确回收且事务已回滚',
    async () => {
      let entryId = 0;
      await expect(
        runCase('S4-E/FAULT-CREATE', async () => {
          const parents = await createCaseParents(caseLedger, 'faultc');
          const requestId = await insertRepairRequest(caseLedger, {
            customerAccountId: parents.accountId,
            equipmentModelId: parents.equipmentModelId,
            organizationId: parents.organizationId,
            tag: 'fault-create',
          });
          const result = await dataSource.query(
            `INSERT INTO repair_process_entry
               (entry_uuid, request_id, author_account_id, operation_text, time_source,
                file_id, version_no)
             VALUES (?, ?, ?, 'S4-E 受控故障行', 'AUTO', NULL, 1)`,
            [randomUUID(), requestId, parents.accountId],
          );
          entryId = insertIdOf(result);
          // 成功即登记真实 ID，随后再抛断言失败。
          caseDirectCleanups.push(async () => {
            await guardedDirect('DELETE FROM repair_process_entry WHERE id = ?', [entryId]);
          });
          throw new Error('__CONTROLLED_ASSERTION_FAILURE__');
        }),
      ).rejects.toThrow(/__CONTROLLED_ASSERTION_FAILURE__/);

      expect(await snapshotRows('repair_process_entry', 'id', [entryId])).toEqual([]);
      await assertNoActiveTransactions();
    },
  );

  const readBackupFinishedAt = async (): Promise<string | null> => {
    const rows = await dataSource.query(
      "SELECT DATE_FORMAT(finished_at, '%Y-%m-%d %H:%i:%s.%f') AS finished_at " +
        'FROM local_backup_run WHERE id = ?',
      [external.backupRunId],
    );
    return (rows[0]?.finished_at as string | null | undefined) ?? null;
  };

  /**
   * FAULT-UPDATE 公共执行体：写入前由数据库确定本轮 finished_at，
   * UPDATE 成功后立即登记原值、写入值与字节精确 CAS 条件。
   * `withConflict` 为 true 时由受控外部连接改写 finished_at，制造真实恢复冲突；
   * 套件级保留只在恢复阶段实际冲突时登记，不依赖故障注入开关。
   */
  const runFaultUpdateWrite = async (
    helper: string,
    withConflict: boolean,
  ): Promise<{
    readonly failure: unknown;
    readonly originalStatus: unknown;
    readonly originalFinishedAt: string | null;
    readonly changedStatus: string;
    readonly externalFinishedAt: string | null;
  }> => {
    const original = (await snapshotRows('local_backup_run', 'id', [external.backupRunId]))[0];
    const changedStatus = original.status === 'SUCCEEDED' ? 'FAILED' : 'SUCCEEDED';
    const originalFinishedAt = await readBackupFinishedAt();
    // 外部改写只落 finished_at：status 仍为本轮写入值，可单独验证 CAS 的字节精确条件。
    const externalFinishedAt = '2001-02-03 04:05:06.007';
    let writtenFinishedAt = '';

    const failure = await captureFailure(async () =>
      runCase(helper, async () => {
        // 写入前从数据库取本轮 finished_at，并规范化为 timestamp(3) 毫秒精度。
        // 登记与恢复只使用该值；任何写入后回读都不能成为登记前置。
        const writtenRows = await dataSource.query(
          "SELECT DATE_FORMAT(NOW(3), '%Y-%m-%d %H:%i:%s.%f') AS finished_at",
        );
        writtenFinishedAt = normalizeDbMillisecondTimestamp(
          String(writtenRows[0]?.finished_at ?? ''),
        );
        if (writtenFinishedAt === '') {
          throw new Error('FAULT-UPDATE 未能确定本轮 finished_at');
        }
        // 同时写入完成时间，满足 chk_local_backup_run_finish（非 RUNNING 必须有 finished_at）。
        await dataSource.query(
          'UPDATE local_backup_run SET status = ?, finished_at = ? WHERE id = ?',
          [changedStatus, writtenFinishedAt, external.backupRunId],
        );
        // UPDATE 成功后立即登记原值、本轮写入值与字节精确 CAS 条件。
        caseDirectCleanups.push(async () => {
          try {
            // 按写入值条件恢复：status 字节精确且 finished_at 一致才回滚，
            // 避免另一连接仅改大小写/尾部空格时被普通等号误判并覆盖。
            await guardedCasRestore({
              label: 'local_backup_run.status+finished_at',
              targetId: external.backupRunId,
              sql:
                'UPDATE local_backup_run SET status = ?, finished_at = ? WHERE id = ? AND ' +
                `${byteExactTextMatchCondition('status')} AND finished_at = ?`,
              parameters: [
                original.status,
                originalFinishedAt,
                external.backupRunId,
                changedStatus,
                writtenFinishedAt,
              ],
            });
          } catch (error) {
            // P2：在实际恢复冲突发生的位置立即登记套件级保留；
            // 即使后续断言失败，用例收尾、通用清理与 afterAll 也不得删除该行。
            retainConflictBackupRun(external.backupRunId);
            throw error;
          }
        });
        if (withConflict) {
          // 受控外部连接改写 finished_at：CAS 必须拒绝覆盖并保留异主值。
          const second = dataSource.createQueryRunner();
          try {
            await second.connect();
            await second.startTransaction();
            await second.query('UPDATE local_backup_run SET finished_at = ? WHERE id = ?', [
              externalFinishedAt,
              external.backupRunId,
            ]);
            await second.commitTransaction();
          } finally {
            await second.release();
          }
        }
        // 回读只做核验；受控故障在此注入失败，登记已在此之前完成。
        const observed = await readWithControlledFault('FAULT-UPDATE', 'finished-at-verify', () =>
          readBackupFinishedAt(),
        );
        expect(observed === null ? null : normalizeDbMillisecondTimestamp(observed)).toBe(
          writtenFinishedAt,
        );
        throw new Error('__CONTROLLED_ASSERTION_FAILURE__');
      }),
    );

    return {
      failure,
      originalStatus: original.status,
      originalFinishedAt,
      changedStatus,
      externalFinishedAt: withConflict ? externalFinishedAt : null,
    };
  };

  (CONTROLLED_FAULT ? it : it.skip)(
    'FAULT-UPDATE 修改成功后断言失败：无并发冲突时按写入值精确恢复原值',
    async () => {
      const result = await runFaultUpdateWrite('S4-E/FAULT-UPDATE', false);
      if (result.failure === undefined) {
        throw new Error('FAULT-UPDATE 未按预期失败');
      }
      expect(messageOf(result.failure)).toContain(
        faultArmedFor('FAULT-UPDATE')
          ? 'INJECTED_READ_FAILURE:FAULT-UPDATE'
          : '__CONTROLLED_ASSERTION_FAILURE__',
      );
      expect(retainedResources.backupRunIds.has(external.backupRunId)).toBe(false);
      expect((await snapshotRows('local_backup_run', 'id', [external.backupRunId]))[0].status).toBe(
        result.originalStatus,
      );
      // 原 finished_at 也必须恢复（RUNNING 种子的原值为 NULL）。
      const restoredFinishedAt = await readBackupFinishedAt();
      expect(
        restoredFinishedAt === null ? null : normalizeDbMillisecondTimestamp(restoredFinishedAt),
      ).toBe(
        result.originalFinishedAt === null
          ? null
          : normalizeDbMillisecondTimestamp(result.originalFinishedAt),
      );
      await assertNoActiveTransactions();
    },
  );

  // 实际冲突只在受控故障用例被选中时执行（公开 normal 档不得留下保留行），
  // 但冲突本身由受控外部连接制造，不再依赖 E2E_V13_SECOND_CONNECTION 开关。
  (faultArmedFor('FAULT-UPDATE') ? it : it.skip)(
    'FAULT-UPDATE 实际恢复冲突：拒绝覆盖异主值并立即登记套件保留',
    async () => {
      const result = await runFaultUpdateWrite('S4-E/FAULT-UPDATE-CONFLICT', true);
      // 主错误可为注入读取失败或受控断言失败，但恢复冲突必须发生。
      expect(messageOf(result.failure)).toMatch(
        /INJECTED_READ_FAILURE:FAULT-UPDATE|__CONTROLLED_ASSERTION_FAILURE__/,
      );
      expect(messageOf(result.failure)).toContain('恢复冲突');
      expect(messageOf(result.failure)).toContain(`targetId=${external.backupRunId}`);
      // 保留登记来自恢复阶段的实际冲突，而不是用例在断言后补写。
      expect(retainedResources.backupRunIds.has(external.backupRunId)).toBe(true);
      if (result.externalFinishedAt === null) {
        throw new Error('FAULT-UPDATE 冲突用例未产生外部改写值');
      }
      const retained = await snapshotRows('local_backup_run', 'id', [external.backupRunId]);
      expect(retained).toHaveLength(1);
      expect(retained[0].status).toBe(result.changedStatus);
      const retainedFinishedAt = await readBackupFinishedAt();
      expect(
        retainedFinishedAt === null ? null : normalizeDbMillisecondTimestamp(retainedFinishedAt),
      ).toBe(normalizeDbMillisecondTimestamp(result.externalFinishedAt));
      console.info(
        `[S4-E/FAULT-UPDATE-CONFLICT] 外部改写保留 backup_run_id=${external.backupRunId} ` +
          `status=${result.changedStatus} finished_at=${result.externalFinishedAt}`,
      );
      await assertNoActiveTransactions();
    },
  );

  // =========================================================================
  // 默认关闭的真实反例：事务采集能力（需要独立授权）
  // =========================================================================

  (INSTRUMENT_INJECTION ? it : it.skip)(
    'INSTRUMENT 正常活动事务被实际观测，回滚后归零',
    async () => {
      const transactionRunner = dataSource.createQueryRunner();
      try {
        await transactionRunner.connect();
        await transactionRunner.startTransaction();
        // 真实活动事务：在事务内执行语句，使 events_transactions_current 出现 ACTIVE 行。
        await transactionRunner.query('SELECT 1 AS inside_transaction');
        await expect(
          countActiveOwnTransactions((sql) => observationRunner.query(sql)),
        ).resolves.toBe(1);
        await transactionRunner.rollbackTransaction();
      } finally {
        if (transactionRunner.isTransactionActive) {
          await transactionRunner.rollbackTransaction();
        }
        await transactionRunner.release();
      }
      // 回滚后才允许得到 0；此前 0 不能作为“无活动事务”的证据。
      await expect(countActiveOwnTransactions((sql) => observationRunner.query(sql))).resolves.toBe(
        0,
      );
      await assertNoActiveTransactions();
    },
  );

  (UPSTREAM_CONSUMER_INJECTION ? it : it.skip)(
    'INSTRUMENT 上游 consumer 分别关闭时拒绝且不返回零事务，恢复后事务可见、回滚归零',
    async () => {
      const requiredConsumers = ['global_instrumentation', 'thread_instrumentation'] as const;
      const readEnabled = async (name: string): Promise<string> => {
        const rows: unknown = await dataSource.query(
          `SELECT ENABLED AS enabled
             FROM performance_schema.setup_consumers
            WHERE NAME = ?
            LIMIT 1`,
          [name],
        );
        if (!Array.isArray(rows) || rows.length === 0) {
          return '';
        }
        const row = rows[0] as Record<string, unknown>;
        return typeof row.enabled === 'string' ? row.enabled : '';
      };
      const setEnabled = async (name: string, from: string, enabled: string): Promise<unknown> => {
        const result: unknown = await dataSource.query(
          `UPDATE performance_schema.setup_consumers SET ENABLED = ? WHERE NAME = ? AND ENABLED = ?`,
          [enabled, name, from],
        );
        return result;
      };

      for (const name of requiredConsumers) {
        const original = await readEnabled(name);
        // 专用隔离实例前提：两个上游 consumer 必须原本为 YES；
        // 否则本用例的“关闭后拒绝”不是可归因的本轮注入，直接拒绝制造不可信现场。
        expect(original).toBe('YES');
        const transactionRunner = dataSource.createQueryRunner();
        let restoreConsumer: (() => Promise<void>) | undefined;
        let primaryError: unknown;
        const cleanupErrors: unknown[] = [];
        try {
          await transactionRunner.connect();
          await transactionRunner.startTransaction();
          await transactionRunner.query('SELECT 1 AS inside_transaction');
          try {
            restoreConsumer = await disableConsumerWithRecovery({
              serverUuid: EXPECTED_SERVER_UUID,
              consumer: name,
              original,
              write: (from, to) => setEnabled(name, from, to),
              read: () => readEnabled(name),
            });
          } catch (error) {
            consumerInjectionBlocked = true;
            throw error;
          }
          // 上游关闭时预检与计数都必须明确拒绝；
          // 尤其是计数不能因为 events_transactions_current 为空而返回 0。
          await expect(
            assertTransactionObservationCapability((sql) => observationRunner.query(sql)),
          ).rejects.toThrow(new RegExp(`${name} consumer 未启用`));
          await expect(
            countActiveOwnTransactions((sql) => observationRunner.query(sql)),
          ).rejects.toThrow(new RegExp(`${name} consumer 未启用`));
        } catch (error) {
          primaryError = error;
        } finally {
          try {
            if (restoreConsumer) {
              // 可靠恢复：无论断言是否失败，都恢复原值并逐项确认。
              await restoreConsumer();
            }
          } catch (error) {
            consumerInjectionBlocked = true;
            cleanupErrors.push(error);
          }
          try {
            if (transactionRunner.isTransactionActive) {
              await transactionRunner.rollbackTransaction();
            }
          } catch (error) {
            cleanupErrors.push(error);
          }
          try {
            await transactionRunner.release();
          } catch (error) {
            cleanupErrors.push(error);
          }
        }
        if (cleanupErrors.length > 0) {
          consumerInjectionBlocked = true;
          throw new AggregateError(
            primaryError === undefined ? cleanupErrors : [primaryError, ...cleanupErrors],
            `consumer 注入或收尾失败：server_uuid=${EXPECTED_SERVER_UUID} consumer=${name}`,
          );
        }
        if (primaryError !== undefined) {
          throw primaryError instanceof Error
            ? primaryError
            : new Error('consumer 注入失败', { cause: primaryError });
        }

        // 恢复后：正常事务可见，回滚后归零。
        const verifyRunner = dataSource.createQueryRunner();
        try {
          await verifyRunner.connect();
          await verifyRunner.startTransaction();
          await verifyRunner.query('SELECT 1 AS inside_transaction');
          await expect(
            countActiveOwnTransactions((sql) => observationRunner.query(sql)),
          ).resolves.toBe(1);
          await verifyRunner.rollbackTransaction();
        } finally {
          if (verifyRunner.isTransactionActive) {
            await verifyRunner.rollbackTransaction();
          }
          await verifyRunner.release();
        }
        await expect(
          countActiveOwnTransactions((sql) => observationRunner.query(sql)),
        ).resolves.toBe(0);
      }
      await assertNoActiveTransactions();
    },
  );

  (INSTRUMENT_INJECTION ? it : it.skip)(
    'INSTRUMENT 仅停采测试连接：造数前拒绝且零业务写入，finally 恢复原状态',
    async () => {
      const trackedTables = [
        'intake_analysis_attempt',
        'record_package_item',
        'backup_restore_run',
        'repair_process_entry',
        'ai_message_analysis',
        'repair_request_revision',
        'reference_document_revision',
        'repair_request_intake',
        'local_account_authorization',
        'local_company_setting',
        'sync_conflict',
        'sync_receipt',
        'record_package_import',
        'backup_asset',
        'management_audit_event',
        'maintenance_report_fault',
        'stored_file',
        'repair_request',
        'reference_document',
        'organization',
        'base_user_info',
        'base_user_account',
        'equipment_model',
      ] as const;
      const snapshotCounts = async (): Promise<Record<string, number>> => {
        const entries = await Promise.all(
          trackedTables.map(async (table) => [table, await countOf(table)] as const),
        );
        return Object.fromEntries(entries);
      };

      const stoppedRunner = dataSource.createQueryRunner();
      let threadId = 0;
      let connectionId: number | undefined;
      let processlistUser = '';
      let originalInstrumented = '';
      let restoreError: Error | undefined;
      /**
       * P2：只有本轮条件 UPDATE 明确命中 1 行时，才在 finally 登记并执行恢复。
       * 0 行表示另一连接已改写/条件不匹配，本轮没有成功写入，必须保持现状；
       * 结果未知时保留现场并诊断，不得按猜测恢复。
       */
      let injectionOutcome: 'not-attempted' | 'applied' | 'not-applied' | 'unknown' =
        'not-attempted';
      try {
        await stoppedRunner.connect();
        const original = await readObservationThreadState(stoppedRunner);
        threadId = original.threadId;
        connectionId = original.connectionId;
        processlistUser = original.processlistUser;
        originalInstrumented = original.instrumented;
        // UPDATE 前核验本轮连接的全部事实；任一不符即拒绝，不进入任何业务造数。
        const expectedUser = original.currentUser.split('@')[0] ?? '';
        expect(originalInstrumented).toBe('YES');
        expect(original.threadType).toBe('FOREGROUND');
        expect(original.processlistUser).not.toBe('');
        expect(original.processlistUser).toBe(expectedUser);
        expect(connectionId).toBeGreaterThan(0);

        // 只改这一条明确授权的测试连接线程；条件同时锁定连接、线程、用户、类型与原状态，
        // 任一事实变化或未精确命中 1 行都拒绝，避免按用户名批量更新或误改其他线程。
        let stopped: unknown;
        try {
          stopped = await dataSource.query(
            `UPDATE performance_schema.threads
                SET INSTRUMENTED = ?
              WHERE THREAD_ID = ?
                AND PROCESSLIST_ID = ?
                AND PROCESSLIST_USER = ?
                AND TYPE = 'FOREGROUND'
                AND UPPER(INSTRUMENTED) = 'YES'`,
            ['NO', threadId, connectionId, processlistUser],
          );
        } catch (error) {
          injectionOutcome = 'unknown';
          throw new Error(
            '线程停采条件 UPDATE 执行失败；结果未知，保留现场并诊断，不执行自动恢复：' +
              (error instanceof Error ? error.message : String(error)),
            { cause: error },
          );
        }
        const decision = classifyThreadInstrumentationWrite(stopped);
        injectionOutcome = decision.outcome;
        if (decision.outcome === 'unknown') {
          throw new Error(
            `线程停采结果未知：thread_id=${threadId} connection_id=${String(connectionId)} ` +
              `user=${processlistUser}；${decision.diagnostic ?? '缺少有效 affectedRows'}；` +
              '保留现场并诊断，不执行自动恢复',
          );
        }
        if (decision.outcome === 'not-applied') {
          // 典型反例：另一连接已先把该线程设为 NO，本轮条件 UPDATE 必然 0 行。
          // 本轮没有成功写入，因此不登记恢复责任，保持 NO，绝不反向恢复成 YES。
          throw new Error(
            `线程停采拒绝：事实不匹配或未精确命中 thread_id=${threadId} ` +
              `connection_id=${String(connectionId)} user=${processlistUser} ` +
              `affectedRows=${String(decision.affectedRows)}；${decision.diagnostic ?? ''}`,
          );
        }
        const injected = await readObservationThreadState(stoppedRunner);
        expect(injected.instrumented).toBe('NO');
        console.info(
          `[S4-E/INSTRUMENT] thread_id=${threadId} connection_id=${String(connectionId)} ` +
            `original=YES injected=NO`,
        );

        const countsBefore = await snapshotCounts();
        // 实际目标线程停采：即使全局 consumer/instrument/权限不变也必须拒绝。
        await expect(
          assertTransactionObservationCapability((sql) => stoppedRunner.query(sql)),
        ).rejects.toThrow(/INSTRUMENTED=NO/);
        // 覆盖实际池连接：预检即使落到另一条仍采集的连接，池内停采线程也必须被识别。
        await expect(
          assertTransactionObservationCapability((sql) => dataSource.query(sql)),
        ).rejects.toThrow(/INSTRUMENTED<>YES/);
        // 首次造数前拒绝：业务表行数完全不变，证明零业务写入。
        expect(await snapshotCounts()).toEqual(countsBefore);
      } finally {
        try {
          if (injectionOutcome === 'applied' && threadId > 0) {
            // 仅本轮明确命中 1 行后登记的恢复责任，才执行精确恢复。
            await restoreObservationThread(stoppedRunner, {
              threadId,
              connectionId: connectionId ?? 0,
              processlistUser,
              originalInstrumented,
            });
          } else if (injectionOutcome === 'not-applied') {
            console.warn(
              '[S4-E/INSTRUMENT] 停采条件 UPDATE 命中 0 行：本轮未成功写入，' +
                '不登记恢复责任，保持当前线程状态',
            );
          } else if (injectionOutcome === 'unknown') {
            console.error('[S4-E/INSTRUMENT] 停采结果未知：保留现场并诊断，不执行自动恢复');
          }
        } catch (error) {
          restoreError =
            error instanceof Error
              ? error
              : new Error(`线程停采恢复异常：${String(error)}；停止后续写入`);
        } finally {
          await stoppedRunner.release();
        }
      }
      if (restoreError !== undefined) {
        throw restoreError;
      }
      await assertNoActiveTransactions();
    },
  );

  (INSTRUMENT_INJECTION ? it : it.skip)(
    'INSTRUMENT 另一连接先停采：本轮零命中保持 NO，不反向恢复',
    async () => {
      const targetRunner = dataSource.createQueryRunner();
      const otherRunner = dataSource.createQueryRunner();
      let threadId = 0;
      let connectionId = 0;
      let processlistUser = '';
      let originalInstrumented = '';
      /**
       * P1：恢复责任只由首次条件 UPDATE 的分类结果决定，并在任何断言之前登记。
       * 0 行或结果未知时保持现状，不认领其他执行方写入的状态；后续断言失败也不改变已登记事实。
       */
      let stopDecision: ThreadInstrumentationWriteDecision | null = null;
      const conditionalStopSql = `UPDATE performance_schema.threads
          SET INSTRUMENTED = 'NO'
        WHERE THREAD_ID = ?
          AND PROCESSLIST_ID = ?
          AND PROCESSLIST_USER = ?
          AND TYPE = 'FOREGROUND'
          AND UPPER(INSTRUMENTED) = 'YES'`;
      try {
        await targetRunner.connect();
        await otherRunner.connect();
        const original = await readObservationThreadState(targetRunner);
        expect(original.instrumented).toBe('YES');
        originalInstrumented = original.instrumented;
        threadId = original.threadId;
        connectionId = original.connectionId ?? 0;
        processlistUser = original.processlistUser;
        expect(connectionId).toBeGreaterThan(0);

        // 受控第三连接先成功停采目标线程；这是前置事实，不是本轮被测路径的恢复责任。
        const precondition = classifyThreadInstrumentationWrite(
          await otherRunner.query(conditionalStopSql, [threadId, connectionId, processlistUser]),
        );
        expect(precondition.outcome).toBe('applied');
        expect(precondition.shouldRestore).toBe(true);

        // 被测路径的首次条件 UPDATE：目标已被第三连接置 NO，因此必须 0 行。
        // 分类结果在任何断言之前登记；0 行 => 本轮不认领恢复责任。
        stopDecision = classifyThreadInstrumentationWrite(
          await dataSource.query(conditionalStopSql, [threadId, connectionId, processlistUser]),
        );
        if (stopDecision.outcome === 'unknown') {
          throw new Error(
            `首次停采结果未知：thread_id=${threadId} connection_id=${connectionId} ` +
              `user=${processlistUser}；${stopDecision.diagnostic ?? '缺少有效 affectedRows'}；` +
              '保留现场，不执行自动恢复',
          );
        }
        expect(stopDecision.outcome).toBe('not-applied');
        expect(stopDecision.shouldRestore).toBe(false);

        // 被测路径未成功写入，目标线程必须保持第三连接设置的 NO，不能被反向恢复为 YES。
        expect((await readObservationThreadState(targetRunner)).instrumented).toBe('NO');
      } finally {
        try {
          const recovery = planThreadInstrumentationRecovery({
            stopDecision,
            threadFactsKnown: threadId > 0 && connectionId > 0 && processlistUser !== '',
          });
          expect(recovery.action).toBe('keep');
          console.warn(`[S4-E/INSTRUMENT] 未登记恢复责任：${recovery.reason}`);

          // 直接证据（先于任何收尾）：被测 finally 结束后，第三连接设置的 NO 仍保留。
          const retained = await readObservationThreadState(targetRunner);
          expect(retained.instrumented).toBe('NO');
          console.warn(
            `[S4-E/INSTRUMENT] 保留第三连接停采状态：thread_id=${threadId} ` +
              `connection_id=${connectionId} instrumented=${retained.instrumented}`,
          );

          // 独立执行者收尾：按已核验事实恢复原值，避免停采连接回流连接池影响后续观测。
          // 这是测试执行者在保存证据后的精确收尾，不是被测路径 finally 的恢复写入。
          await restoreObservationThread(targetRunner, {
            threadId,
            connectionId,
            processlistUser,
            originalInstrumented,
          });
          expect((await readObservationThreadState(targetRunner)).instrumented).toBe('YES');
        } finally {
          await targetRunner.release();
          await otherRunner.release();
        }
      }
      await assertNoActiveTransactions();
    },
  );

  (INSTRUMENT_INJECTION && INSTRUMENT_FAULT_CASE === 'UNKNOWN' ? it : it.skip)(
    'INSTRUMENT 首次停采结果未知：保留 NO 现场且 finally 不恢复，由独立执行者收尾',
    async () => {
      const targetRunner = dataSource.createQueryRunner();
      let threadId: number;
      let connectionId: number;
      let processlistUser: string;
      let originalInstrumented: string;
      let stopDecision: ThreadInstrumentationWriteDecision | null = null;
      let testedPathRestored = false;
      let observedAfterKeep: string;
      const conditionalStopSql = `UPDATE performance_schema.threads
          SET INSTRUMENTED = 'NO'
        WHERE THREAD_ID = ?
          AND PROCESSLIST_ID = ?
          AND PROCESSLIST_USER = ?
          AND TYPE = 'FOREGROUND'
          AND UPPER(INSTRUMENTED) = 'YES'`;
      await targetRunner.connect();
      try {
        const original = await readObservationThreadState(targetRunner);
        expect(original.instrumented).toBe('YES');
        originalInstrumented = original.instrumented;
        threadId = original.threadId;
        connectionId = original.connectionId ?? 0;
        processlistUser = original.processlistUser;
        expect(connectionId).toBeGreaterThan(0);

        // 默认关闭的受控故障：真实写入命中 1 行，但主动丢弃返回值，模拟“结果无法确认”。
        const rawWrite = await dataSource.query(conditionalStopSql, [
          threadId,
          connectionId,
          processlistUser,
        ]);
        expect(Number(rawWrite.affectedRows)).toBe(1);
        try {
          stopDecision = classifyThreadInstrumentationWrite({ affectedRows: undefined });
          if (stopDecision.outcome !== 'unknown') {
            throw new Error(`受控未知故障未生效：outcome=${stopDecision.outcome}`);
          }
          throw new Error(
            `首次停采结果未知：thread_id=${threadId} connection_id=${connectionId} ` +
              `user=${processlistUser}；${stopDecision.diagnostic ?? '缺少诊断'}；` +
              '保留现场，不执行自动恢复',
          );
        } catch (error) {
          const failureMessage = messageOf(error);
          expect(failureMessage).toContain('结果未知');
          expect(failureMessage).toContain(`thread_id=${threadId}`);
          expect(failureMessage).toContain(`connection_id=${connectionId}`);
          expect(failureMessage).toContain(`user=${processlistUser}`);
          console.warn(`[S4-E/INSTRUMENT] 受控未知结果：${failureMessage}`);
        } finally {
          const recovery = planThreadInstrumentationRecovery({
            stopDecision,
            threadFactsKnown: threadId > 0 && connectionId > 0 && processlistUser !== '',
          });
          if (recovery.action === 'restore') {
            testedPathRestored = true;
            await restoreObservationThread(targetRunner, {
              threadId,
              connectionId,
              processlistUser,
              originalInstrumented,
            });
          }
          observedAfterKeep = (await readObservationThreadState(targetRunner)).instrumented;
          console.warn(
            `[S4-E/INSTRUMENT] 未知结果保留现场：${recovery.reason}；` +
              `instrumented=${observedAfterKeep}`,
          );
        }

        // 直接证据：被测 finally 没有恢复，未知结果下的 NO 仍保留。
        expect(testedPathRestored).toBe(false);
        expect(observedAfterKeep).toBe('NO');

        // 独立执行者依据“本轮确实命中 1 行”的注入事实精确收尾，避免停采连接回流连接池。
        await restoreObservationThread(targetRunner, {
          threadId,
          connectionId,
          processlistUser,
          originalInstrumented,
        });
        expect((await readObservationThreadState(targetRunner)).instrumented).toBe('YES');
      } finally {
        await targetRunner.release();
      }
      await assertNoActiveTransactions();
    },
  );

  (INSTRUMENT_INJECTION && INSTRUMENT_FAULT_CASE === 'ASSERT-AFTER' ? it : it.skip)(
    'INSTRUMENT 首次停采成功后受控断言失败：仍按登记事实精确恢复',
    async () => {
      const targetRunner = dataSource.createQueryRunner();
      let threadId = 0;
      let connectionId = 0;
      let processlistUser = '';
      let originalInstrumented = '';
      let stopDecision: ThreadInstrumentationWriteDecision | null = null;
      let restoredInFinally = false;
      const conditionalStopSql = `UPDATE performance_schema.threads
          SET INSTRUMENTED = 'NO'
        WHERE THREAD_ID = ?
          AND PROCESSLIST_ID = ?
          AND PROCESSLIST_USER = ?
          AND TYPE = 'FOREGROUND'
          AND UPPER(INSTRUMENTED) = 'YES'`;
      try {
        await targetRunner.connect();
        const original = await readObservationThreadState(targetRunner);
        expect(original.instrumented).toBe('YES');
        originalInstrumented = original.instrumented;
        threadId = original.threadId;
        connectionId = original.connectionId ?? 0;
        processlistUser = original.processlistUser;
        expect(connectionId).toBeGreaterThan(0);

        const failure = await captureFailure(async () => {
          try {
            const written = await dataSource.query(conditionalStopSql, [
              threadId,
              connectionId,
              processlistUser,
            ]);
            stopDecision = classifyThreadInstrumentationWrite(written);
            // 先登记恢复责任，再执行任何断言；受控断言失败发生在登记之后。
            expect(stopDecision.outcome).toBe('applied');
            expect(stopDecision.shouldRestore).toBe(true);
            expect((await readObservationThreadState(targetRunner)).instrumented).toBe('NO');
            throw new Error('__CONTROLLED_ASSERTION_FAILURE__:INSTRUMENT');
          } finally {
            const recovery = planThreadInstrumentationRecovery({
              stopDecision,
              threadFactsKnown: threadId > 0 && connectionId > 0 && processlistUser !== '',
            });
            if (recovery.action === 'restore') {
              restoredInFinally = true;
              await restoreObservationThread(targetRunner, {
                threadId,
                connectionId,
                processlistUser,
                originalInstrumented,
              });
            }
            console.warn(`[S4-E/INSTRUMENT] 断言失败后恢复计划：${recovery.reason}`);
          }
        });

        expect(messageOf(failure)).toContain('__CONTROLLED_ASSERTION_FAILURE__:INSTRUMENT');
        expect(restoredInFinally).toBe(true);
        expect((await readObservationThreadState(targetRunner)).instrumented).toBe('YES');
      } finally {
        await targetRunner.release();
      }
      await assertNoActiveTransactions();
    },
  );
});

// ---------------------------------------------------------------------------
// 离线目标校验回归（无需数据库 / 不依赖 E2E_REAL_DB_SPECS）
// ---------------------------------------------------------------------------

describe('S4-E 目标参数与种子基线校验（离线）', () => {
  const baseEnv = (): NodeJS.ProcessEnv => ({
    E2E_REAL_DB_SPECS: '1',
    E2E_ALLOW_PHYSICAL_CLEANUP: '1',
    E2E_REAL_DB_NAME: 'lithography_v13_delivery_dev43',
    E2E_ALLOWED_DB_NAMES: 'lithography_v13_delivery_dev43',
    E2E_EXPECTED_SERVER_UUID: '909f9587-9fce-11f1-a353-00e0709ef3a9',
  });

  it('合法显式配置解析为单一目标', () => {
    expect(resolveV13CleanupTarget(baseEnv())).toEqual({
      database: 'lithography_v13_delivery_dev43',
      serverUuid: '909f9587-9fce-11f1-a353-00e0709ef3a9',
    });
  });

  it('缺少显式许可、清理许可、目标库、白名单或实例 UUID 时拒绝', () => {
    const cases: Array<[keyof NodeJS.ProcessEnv, RegExp]> = [
      ['E2E_REAL_DB_SPECS', /缺少 E2E_REAL_DB_SPECS=1/],
      ['E2E_ALLOW_PHYSICAL_CLEANUP', /缺少 E2E_ALLOW_PHYSICAL_CLEANUP=1/],
      ['E2E_REAL_DB_NAME', /缺少 E2E_REAL_DB_NAME/],
      ['E2E_ALLOWED_DB_NAMES', /缺少 E2E_ALLOWED_DB_NAMES/],
      ['E2E_EXPECTED_SERVER_UUID', /缺少 E2E_EXPECTED_SERVER_UUID/],
    ];
    for (const [key, message] of cases) {
      const env = baseEnv();
      delete env[key];
      expect(() => resolveV13CleanupTarget(env)).toThrow(message);
    }
  });

  it('多目标白名单或白名单与目标不一致时拒绝', () => {
    const multi = baseEnv();
    multi.E2E_ALLOWED_DB_NAMES = 'lithography_v13_delivery_dev43,lithography_e2e';
    expect(() => resolveV13CleanupTarget(multi)).toThrow(/单一目标库/);

    const mismatch = baseEnv();
    mismatch.E2E_ALLOWED_DB_NAMES = 'lithography_e2e';
    expect(() => resolveV13CleanupTarget(mismatch)).toThrow(/不一致/);
  });

  it('local_installation 种子按唯一性/事实核验，缺失或重复时拒绝', () => {
    const seed = {
      id: 1,
      installation_id: '6f1f5b5e-2a5b-4c2b-9f6e-3a2d1c0b9a8f',
      auto_upload_enabled: 0,
      backup_interval_days: 3,
    };
    expect(assertSeedInstallation([seed])).toBe(seed.installation_id);
    expect(() => assertSeedInstallation([])).toThrow(/数量/);
    expect(() => assertSeedInstallation([seed, seed])).toThrow(/数量/);
    expect(() => assertSeedInstallation([{ ...seed, installation_id: ' ' }])).toThrow(
      /installation_id 为空/,
    );
    expect(() => assertSeedInstallation([{ ...seed, backup_interval_days: 0 }])).toThrow(
      /backup_interval_days/,
    );
  });
});
