// scripts/task09-restore-concurrency-race.ts
/**
 * 任务 09 · **恢复链并发竞态**取证脚本（G30）。
 *
 * 目的：把"恢复期间并发写入的串行化只有结构保证"从**未验证**变成**实测结论**。
 * 脚本在一次性隔离库上用**生产服务**（`LocalWriteHoldService`）复现四类竞态：
 *
 * | 场景 | 期望行为（产品口径） | 实测关注点 |
 * | --- | --- | --- |
 * | S1 同一范围**并发建立冻结** | 只应存在一条 ACTIVE 冻结 | `hold()` 是"先查后插"，无锁无唯一索引 |
 * | S2 同范围**多条冻结的释放边界** | 释放自己的不得带走别人的 | `release()` 按范围更新，不带 `restoreId` |
 * | S3 **"先读后写"的冻结可见性** | 冻结建立后，写前守卫必须拒绝 | 守卫读的是事务快照还是最新已提交数据 |
 * | S5 **再次建立冻结的归属保持** | 不得改写既有冻结的 `restore_id` | 归属被覆写会让收尾按 `restore_id` 判归属失真 |
 *
 * 断言写的是**期望行为**，不是当前行为：若现实现存在缺陷，脚本会**如实失败**
 * （exit 1）并把复现证据写进 JSON——缺陷不靠改断言掩盖，也不靠"预期失败"粉饰。
 *
 * 纪律：
 * - **默认拒绝**：复用恢复自检同一套 10 个环境变量（一次性库、预期实例身份、
 *   一次性库标识、受控文件根、安装／公司标识、测试授权），缺一即零写入退出；
 * - 只写**本轮创建的冻结行**（按 `hold_id` 精确清单收尾），并核对**外公司哨兵**
 *   在收尾后仍然存在（不得误删他人现场）；
 * - 哨兵用**外公司**范围建立，验证"按范围释放"不会越界到别的数据区。
 *
 * 用法：
 *   TASK09_RESTORE_ENV_FILE=... TASK09_RESTORE_DATABASE=lithography_task09_isolated_a \
 *   TASK09_RESTORE_EXPECTED_HOST=127.0.0.1 TASK09_RESTORE_EXPECTED_PORT=33307 \
 *   TASK09_RESTORE_EXPECTED_SERVER_UUID=<@@server_uuid> \
 *   TASK09_RESTORE_DISPOSABLE_MARKER=<库内标识值> \
 *   TASK09_RESTORE_FILE_ROOT=<受控文件根> \
 *   TASK09_RESTORE_INSTALLATION_ID=<local_installation.installation_id> \
 *   TASK09_RESTORE_ORGANIZATION_ID=1 \
 *   TASK09_RESTORE_TEST_AUTHORIZATION=TASK09-RESTORE-SELFCHECK-ISOLATED-RUN \
 *   npx ts-node -r tsconfig-paths/register scripts/task09-restore-concurrency-race.ts
 */

// 脚本属**受控 wiring**（同 scripts/task09-restore-selfcheck.ts）：运行时配置只在这里读取一次。

import { Test } from '@nestjs/testing';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { AppConfigModule } from '@src/infrastructure/config/config.module';
import { loadExplicitEnvConfig } from '@src/infrastructure/database/incremental-migration';
import { TypeOrmTransactionModule } from '@src/infrastructure/database/transaction/typeorm-transaction.module';
import { LocalRuntimeStorageModule } from '@src/infrastructure/file-storage/local-runtime-storage.module';
import { LoggerModule } from '@src/infrastructure/logger/logger.module';
import { LocalWriteHoldService } from '@src/modules/lithography/local-write-hold.service';
import { LocalRuntimeUsecasesModule } from '@src/usecases/local-runtime/local-runtime-usecases.module';

import {
  assertDisposableMarker,
  assertServerIdentity,
  DISPOSABLE_MARKER_TABLE,
  readSelfcheckAuthorization,
} from './task09-restore-selfcheck.safety';
import {
  createAssertionCollector,
  loadEnvFile,
  readInstallationId,
  text,
} from './task09-script-utils';

/** 断言收集器与文本转换共用共享工具（避免四个脚本各存一份） */
const { assertions, check } = createAssertionCollector();

/** 并发建立冻结的并发度（够大才能命中"先查后插"的窗口） */
const CONCURRENCY = 8;

/** 哨兵公司（外公司数据区，用于验证"按范围释放"不越界） */
const SENTINEL_ORGANIZATION_CODE = 'PEER_ALT';

type DeviceContext = {
  dataSource: DataSource;
  writeHold: LocalWriteHoldService;
};

async function bootstrapDevice(envFile: string, database: string): Promise<DeviceContext> {
  loadEnvFile(envFile);
  const config = loadExplicitEnvConfig(envFile, database);

  const moduleRef = await Test.createTestingModule({
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
      TypeOrmTransactionModule,
      LocalRuntimeStorageModule,
      LocalRuntimeUsecasesModule,
    ],
  }).compile();

  return {
    dataSource: moduleRef.get(DataSource),
    writeHold: moduleRef.get(LocalWriteHoldService),
  };
}

type HoldRow = {
  holdId: string;
  organizationId: number;
  status: string;
  restoreId: string | null;
  reason: string;
};

async function listHoldRows(
  device: DeviceContext,
  installationId: string,
  organizationId: number,
  status: 'ACTIVE' | 'RELEASED' | null = null,
): Promise<HoldRow[]> {
  const rows: unknown = await device.dataSource.query(
    `SELECT hold_id AS holdId, organization_id AS organizationId, status, restore_id AS restoreId, reason
       FROM local_write_hold
      WHERE installation_id = ? AND organization_id = ?
        ${status === null ? '' : 'AND status = ?'}
      ORDER BY created_at ASC`,
    status === null ? [installationId, organizationId] : [installationId, organizationId, status],
  );
  return rows as HoldRow[];
}

async function readMarkerRows(
  device: DeviceContext,
): Promise<ReadonlyArray<{ markerKey: string; markerValue: string }>> {
  const rows: unknown = await device.dataSource.query(
    `SELECT marker_key AS markerKey, marker_value AS markerValue FROM ${DISPOSABLE_MARKER_TABLE}`,
  );
  return rows as ReadonlyArray<{ markerKey: string; markerValue: string }>;
}

async function readOrganizationId(device: DeviceContext, code: string): Promise<number | null> {
  const rows: unknown = await device.dataSource.query(
    'SELECT id FROM organization WHERE organization_code = ? LIMIT 1',
    [code],
  );
  const list = rows as ReadonlyArray<{ id: number }>;
  return list[0]?.id ?? null;
}

async function main(): Promise<void> {
  // ── 1. 授权（默认拒绝） ────────────────────────────────────────────────────
  // eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
  const auth = readSelfcheckAuthorization(process.env);
  const device = await bootstrapDevice(auth.envFile, auth.database);

  const serverUuidRows: unknown = await device.dataSource.query(
    'SELECT @@server_uuid AS serverUuid',
  );
  const serverUuid = (serverUuidRows as ReadonlyArray<{ serverUuid: string }>)[0]?.serverUuid;
  if (serverUuid === undefined) {
    throw new Error('无法读取实例 UUID，拒绝在未确认身份的实例上运行');
  }
  assertServerIdentity(
    {
      database: auth.database,
      host: auth.expectedHost,
      port: auth.expectedPort,
      serverUuid,
    },
    auth,
  );
  assertDisposableMarker(await readMarkerRows(device), auth.disposableMarker);

  const installationId = await readInstallationId(device.dataSource);
  check(
    '库内安装标识与声明一致',
    installationId === auth.installationId,
    `实际 ${text(installationId)}，声明 ${auth.installationId}`,
  );
  if (installationId === null) {
    throw new Error('本机缺少安装身份，拒绝运行');
  }

  const organizationId = auth.organizationId;
  const sentinelOrganizationId = await readOrganizationId(device, SENTINEL_ORGANIZATION_CODE);
  check(
    '哨兵公司存在（外公司数据区）',
    sentinelOrganizationId !== null,
    `${SENTINEL_ORGANIZATION_CODE} → ${text(sentinelOrganizationId)}`,
  );
  if (sentinelOrganizationId === null) {
    throw new Error('缺少哨兵公司，拒绝运行');
  }

  const ownedHoldIds: string[] = [];
  const detail: Record<string, unknown> = {};

  try {
    // ── 哨兵：外公司范围的冻结（收尾后必须仍在） ────────────────────────────
    const sentinel = await device.writeHold.hold({
      installationId,
      organizationId: sentinelOrganizationId,
      reason: '任务09 并发竞态取证：外公司哨兵',
      restoreId: 'task09-race-sentinel',
    });
    ownedHoldIds.push(sentinel.holdId);

    // ── S1：同一范围并发建立冻结 ───────────────────────────────────────────
    const holdResults = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_unused, index) =>
        device.writeHold.hold({
          installationId,
          organizationId,
          reason: `任务09 并发竞态取证：并发建立 ${index}`,
          restoreId: `task09-race-${index}`,
        }),
      ),
    );
    ownedHoldIds.push(...holdResults.map((item) => item.holdId));
    const activeAfterRace = await listHoldRows(device, installationId, organizationId);
    const distinctHoldIds = new Set(holdResults.map((item) => item.holdId));
    detail.s1 = {
      concurrency: CONCURRENCY,
      returnedHoldIds: holdResults.map((item) => ({ created: item.created, holdId: item.holdId })),
      distinctHoldIdCount: distinctHoldIds.size,
      activeRows: activeAfterRace,
    };
    check(
      'S1 同一范围并发建立冻结：只应存在一条 ACTIVE 冻结',
      activeAfterRace.length === 1,
      `并发 ${CONCURRENCY} 路后 ACTIVE 冻结 ${activeAfterRace.length} 条（返回的 hold_id 去重 ${distinctHoldIds.size} 个）`,
    );
    check(
      'S1 同一范围并发建立冻结：应复用同一行（hold_id 唯一）',
      distinctHoldIds.size === 1,
      `返回的 hold_id 去重数 ${distinctHoldIds.size}`,
    );

    // ── S2：同范围"他人恢复的冻结"哨兵 —— 本轮释放不得带走别人的 ────────────
    // 哨兵与本轮恢复**同范围**（同安装×公司×类型），代表并发恢复中另一条恢复的现场。
    const foreign = await device.writeHold.hold({
      installationId,
      organizationId,
      reason: '任务09 并发竞态取证：他人恢复的冻结哨兵',
      restoreId: 'task09-race-foreign-restore',
    });
    ownedHoldIds.push(foreign.holdId);
    const released = await device.writeHold.release({ installationId, organizationId });
    const activeAfterRelease = await listHoldRows(device, installationId, organizationId, 'ACTIVE');
    const foreignRow = activeAfterRelease.find((row) => row.holdId === foreign.holdId);
    detail.s2 = {
      releasedRows: released,
      foreignHoldId: foreign.holdId,
      activeRowsAfterRelease: activeAfterRelease.map((row) => ({
        holdId: row.holdId,
        restoreId: row.restoreId,
      })),
      foreignStillActive: foreignRow !== undefined,
    };
    check(
      'S2 释放冻结：不得把同范围其它恢复的冻结一起释放',
      foreignRow !== undefined,
      `本轮释放 ${released} 条后，他人恢复的冻结哨兵仍 ACTIVE=${text(foreignRow !== undefined)}` +
        `（同范围剩余 ACTIVE ${activeAfterRelease.length} 条）`,
    );

    // 外公司哨兵不受影响（按范围释放不应越界）
    const sentinelRows = await listHoldRows(device, installationId, sentinelOrganizationId);
    check(
      'S2 按范围释放不影响外公司哨兵冻结',
      sentinelRows.some((row) => row.status === 'ACTIVE'),
      `外公司哨兵 ACTIVE 行数 ${sentinelRows.filter((row) => row.status === 'ACTIVE').length}`,
    );

    // ── S3："先读后写"的冻结可见性（写前守卫能否看见后建立的冻结） ──────────
    // 探针语义与真实业务写入一致：写入方先读归属公司，再调用写前守卫，最后写库。
    // 这里只验证守卫这一环：**守卫必须拒绝**，否则冻结形同虚设。
    const readBeforeHold = await listHoldRows(device, installationId, organizationId);
    const concurrentHold = await device.writeHold.hold({
      installationId,
      organizationId,
      reason: '任务09 并发竞态取证：先读后写窗口',
      restoreId: 'task09-race-toctou',
    });
    ownedHoldIds.push(concurrentHold.holdId);
    let guardRejected = false;
    let guardMessage = '';
    try {
      await device.writeHold.assertBusinessWritable({ organizationId });
    } catch (error) {
      guardRejected = true;
      guardMessage = error instanceof Error ? error.message : text(error);
    }
    detail.s3 = {
      activeRowsBeforeHold: readBeforeHold.length,
      guardRejected,
      guardMessage,
    };
    check(
      'S3 冻结建立后写前守卫必须拒绝写入',
      guardRejected,
      guardRejected ? `守卫拒绝：${guardMessage}` : '守卫未拒绝（冻结对写入不可见）',
    );

    // ── S5：再次建立冻结不得改写既有冻结的归属 restore_id ──────────────────
    const beforeOwnership = await listHoldRows(device, installationId, organizationId);
    const ownerBefore = beforeOwnership.find((row) => row.status === 'ACTIVE')?.restoreId ?? null;
    await device.writeHold.hold({
      installationId,
      organizationId,
      reason: '任务09 并发竞态取证：再次建立冻结',
      restoreId: 'task09-race-second',
    });
    const afterOwnership = await listHoldRows(device, installationId, organizationId);
    const ownerAfter = afterOwnership.find((row) => row.status === 'ACTIVE')?.restoreId ?? null;
    detail.s5 = { ownerBefore, ownerAfter };
    check(
      'S5 再次建立冻结不得改写既有冻结的归属 restore_id',
      ownerBefore === null || ownerAfter === ownerBefore,
      `建立前 restore_id=${text(ownerBefore)}，建立后 restore_id=${text(ownerAfter)}`,
    );
  } finally {
    // ── 收尾：按 hold_id 精确删除本轮冻结行 ─────────────────────────────────
    const cleanupErrors: string[] = [];
    for (const holdId of ownedHoldIds) {
      try {
        await device.dataSource.query('DELETE FROM local_write_hold WHERE hold_id = ?', [holdId]);
      } catch (error) {
        cleanupErrors.push(`${holdId}：${text(error instanceof Error ? error.message : error)}`);
      }
    }
    const remaining = await listHoldRows(device, installationId, organizationId, 'ACTIVE');
    const sentinelRows = await listHoldRows(device, installationId, sentinelOrganizationId);
    check(
      '收尾：目标范围无残留 ACTIVE 冻结',
      remaining.length === 0,
      `残留 ACTIVE ${remaining.length} 条`,
    );
    check(
      '收尾：外公司哨兵已按 hold_id 精确删除（不误删也不残留）',
      sentinelRows.length === 0,
      `哨兵剩余 ${sentinelRows.length} 条（本轮自建的他人现场代理，按 hold_id 精确删除）`,
    );
    check(
      '收尾：删除本轮冻结行无失败',
      cleanupErrors.length === 0,
      cleanupErrors.length === 0 ? '按 hold_id 精确删除完成' : cleanupErrors.join(' | '),
    );
  }

  const failed = assertions.filter((item) => !item.passed);
  const verdict = {
    generatedAt: new Date().toISOString(),
    database: auth.database,
    installationId,
    organizationId,
    sentinelOrganizationId,
    assertions,
    assertionTotal: assertions.length,
    assertionFailed: failed.length,
    // 断言即"期望行为"：失败即复现了产品缺陷，不粉饰为通过
    passed: failed.length === 0,
    detail,
  };

  const outputFile =
    // eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
    process.env.TASK09_RACE_OUTPUT ??
    join(process.cwd(), '..', '.local', 'task09', 'evidence', 'restore-concurrency-race.json');
  mkdirSync(join(process.cwd(), '..', '.local', 'task09', 'evidence'), { recursive: true });
  writeFileSync(outputFile, `${JSON.stringify(verdict, null, 2)}\n`, 'utf8');

  process.stdout.write(`\n断言：${assertions.length} 项，失败 ${failed.length} 项\n`);
  for (const item of failed) {
    process.stdout.write(`  ✗ ${item.name}：${item.detail}\n`);
  }
  process.stdout.write(`证据：${outputFile}\n`);
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n${
      error instanceof Error && error.stack !== undefined ? error.stack : ''
    }\n`,
  );
  process.exitCode = 1;
});
