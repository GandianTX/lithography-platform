// scripts/task09-restore-write-mutex-check.ts
/**
 * 任务 09 · 独立验收 **P1-1：恢复期冻结与业务写入的原子互斥**取证脚本。
 *
 * 目的：把"业务写入与恢复建立冻结**互斥**"从**结构性推断**变成**真实库并发实测结论**。
 *
 * | 场景 | 期望行为（产品口径） | 实测关注点 |
 * | --- | --- | --- |
 * | C1 在途业务事务（已过冻结检查）未提交时恢复建立冻结 | 恢复**必须等待**（或受控拒绝），**不得**在业务事务收口前把冻结立起来 | 范围排他锁与业务共享锁互斥 |
 * | C2 冻结已生效后的业务写入 | **受控拒绝**（不放行） | 冻结事实的当前读 |
 * | C3 同一范围的两个并发业务写入 | **互不阻塞**（共享锁） | 不因并发协议把业务写入串行化 |
 * | C4 另一公司数据区的业务写入 | **不受**本公司冻结影响 | 范围按"安装×公司"隔离 |
 * | C5 冻结解除后的业务写入 | **恢复放行** | 解冻后不留"永远冻结" |
 *
 * 断言写的是**期望行为**，不是当前行为：若实现存在缺陷，脚本会**如实失败**（exit 1）
 * 并把复现证据写进 JSON——缺陷不靠改断言掩盖。
 *
 * 纪律：
 * - **默认拒绝**：复用恢复自检同一套环境变量（一次性库、预期实例身份、一次性库标识、
 *   受控文件根、安装／公司标识、测试授权），缺一即零写入退出；
 * - 只写**本轮创建**的对象（冻结事实），收尾精确回收。
 *
 * 用法：见 `.local/task09/run-restore-write-mutex.sh` 的同款环境变量。
 */

// 脚本属**受控 wiring**（同 scripts/task09-restore-selfcheck.ts）：运行时配置只在这里读取一次。

import { Test } from '@nestjs/testing';

import { join } from 'node:path';

import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { AppConfigModule } from '@src/infrastructure/config/config.module';
import { loadExplicitEnvConfig } from '@src/infrastructure/database/incremental-migration';
import { TypeOrmTransactionModule } from '@src/infrastructure/database/transaction/typeorm-transaction.module';
import { LoggerModule } from '@src/infrastructure/logger/logger.module';
import { LithographyModule } from '@src/modules/lithography/lithography.module';
import { LocalWriteHoldService } from '@src/modules/lithography/local-write-hold.service';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@usecases/common/ports/transaction-runner.contract';

import {
  assertDisposableMarker,
  assertNoForeignActiveHold,
  assertServerIdentity,
  readSelfcheckAuthorization,
} from './task09-restore-selfcheck.safety';
import {
  createAssertionCollector,
  loadEnvFile,
  readInstallationId,
  readServerUuid,
  text,
} from './task09-script-utils';

const { assertions, check } = createAssertionCollector();

type AppContext = {
  dataSource: DataSource;
  writeHold: LocalWriteHoldService;
  transactionRunner: TransactionRunner;
};

async function bootstrap(envFile: string, database: string): Promise<AppContext> {
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
      LithographyModule,
    ],
  }).compile();

  return {
    dataSource: moduleRef.get(DataSource),
    writeHold: moduleRef.get(LocalWriteHoldService),
    transactionRunner: moduleRef.get<TransactionRunner>(TRANSACTION_RUNNER),
  };
}

/** 读某范围的 ACTIVE 冻结行数 */
async function activeHoldCount(
  dataSource: DataSource,
  installationId: string,
  organizationId: number,
): Promise<number> {
  const rows: unknown = await dataSource.query(
    'SELECT COUNT(*) AS c FROM local_write_hold ' +
      'WHERE installation_id = ? AND organization_id = ? AND status = ?',
    [installationId, organizationId, 'ACTIVE'],
  );
  return Number((rows as Array<{ c: number | string }>)[0]?.c ?? 0);
}

/** 找同库内的另一个公司数据区（用于范围隔离实测） */
async function findPeerOrganization(
  dataSource: DataSource,
  organizationId: number,
): Promise<number | null> {
  const rows: unknown = await dataSource.query(
    "SELECT id FROM organization WHERE id <> ? AND status = 'ACTIVE' ORDER BY id ASC LIMIT 1",
    [organizationId],
  );
  const id = Number((rows as Array<{ id: number | string }>)[0]?.id ?? 0);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** 业务事务：过冻结检查（取范围共享锁）→ 等闸门 → 提交 */
async function businessWrite(
  app: AppContext,
  organizationId: number,
  gate: { open: boolean; released: Promise<void> },
  onGuarded?: () => void,
): Promise<{ ok: boolean; reason: string }> {
  try {
    await app.transactionRunner.run(async (transactionContext) => {
      await app.writeHold.assertBusinessWritableInTransaction({
        organizationId,
        transactionContext,
      });
      // 守卫已通过（范围共享锁已取得）⇒ 通知调用方
      onGuarded?.();
      // 事务仍未提交 ⇒ 范围共享锁仍被本事务持有
      if (!gate.open) {
        await gate.released;
      }
    });
    return { ok: true, reason: '放行' };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, reason };
  }
}

/** 已放行的闸门（业务写入不需要等待） */
function openGate(): { open: boolean; released: Promise<void>; open2: () => void } {
  const gate = createGate();
  gate.open = true;
  gate.open2();
  return gate;
}

function createGate(): { open: boolean; released: Promise<void>; open2: () => void } {
  const gate: { open: boolean; released: Promise<void>; open2: () => void } = {
    open: false,
    released: Promise.resolve(),
    open2: (): void => {},
  };
  gate.released = new Promise<void>((resolve) => {
    gate.open2 = resolve;
  });
  return gate;
}

async function main(): Promise<void> {
  // eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
  const auth = readSelfcheckAuthorization(process.env);
  const app = await bootstrap(auth.envFile, auth.database);

  const installationId = await readInstallationId(app.dataSource);
  if (installationId === null) {
    throw new Error('隔离库缺少本机安装记录，无法核对安装标识');
  }
  if (installationId.toLowerCase() !== auth.installationId) {
    throw new Error(
      `安装标识不一致：库内 ${installationId}，声明 ${auth.installationId}，拒绝运行`,
    );
  }

  // ── 身份核对（默认拒绝） ────────────────────────────────────────────────
  const serverUuid = await readServerUuid(app.dataSource);
  if (serverUuid === null) {
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
  const markerRows: unknown = await app.dataSource.query(
    'SELECT marker_key, marker_value FROM task09_disposable_marker',
  );
  assertDisposableMarker(
    (markerRows as Array<Record<string, unknown>>).map((row) => ({
      markerKey: text(row['marker_key']),
      markerValue: text(row['marker_value']),
    })),
    auth.disposableMarker,
  );

  const scope = { installationId, organizationId: auth.organizationId };
  const restoreId = `p1-mutex-${Date.now()}`;
  const createdHoldIds: string[] = [];

  // ── 范围预检：目标范围不得存在**非本轮**的 ACTIVE 冻结 ──────────────────
  // 冻结是"别人的现场"：上一轮中断留下的冻结不属于本轮，不得被本轮复用或释放，
  // 更不得让本轮的断言建立在别人的冻结之上 ⇒ 直接拒绝运行。
  const existingHoldRows: unknown = await app.dataSource.query(
    'SELECT hold_id, installation_id, organization_id, status, restore_id ' +
      'FROM local_write_hold WHERE installation_id = ? AND organization_id = ? AND status = ?',
    [scope.installationId, scope.organizationId, 'ACTIVE'],
  );
  assertNoForeignActiveHold(
    (existingHoldRows as Array<Record<string, unknown>>).map((row) => ({
      holdId: text(row['hold_id']),
      installationId: text(row['installation_id']),
      organizationId: Number(row['organization_id'] ?? 0),
      status: text(row['status']),
      restoreId:
        row['restore_id'] === null || row['restore_id'] === undefined
          ? null
          : text(row['restore_id']),
    })),
    scope.installationId,
    scope.organizationId,
  );

  const phase = (label: string): void => {
    process.stdout.write(`[${new Date().toISOString()}] ${label}\n`);
  };

  try {
    phase('C1 开始：在途业务事务持共享锁，恢复尝试建立冻结');
    // ══ C1：在途业务事务未提交时，恢复建立冻结必须等待 ══════════════════════
    const gate = createGate();
    const businessTask = businessWrite(app, scope.organizationId, gate);
    // 等业务事务真正拿到共享锁（守卫执行完即持锁）
    await new Promise((resolve) => setTimeout(resolve, 800));

    const holdState = { settled: false };
    const holdTask = app.writeHold
      .hold({
        ...scope,
        restoreId,
        reason: 'P1-1 并发互斥取证',
      })
      .then(
        (value) => {
          holdState.settled = true;
          return value;
        },
        (error: unknown) => {
          holdState.settled = true;
          throw error;
        },
      );
    holdTask.catch(() => undefined);

    await new Promise((resolve) => setTimeout(resolve, 1500));
    const holdsDuringBusiness = await activeHoldCount(
      app.dataSource,
      scope.installationId,
      scope.organizationId,
    );
    check(
      'C1 在途业务事务未提交时，恢复不得建立冻结',
      holdsDuringBusiness === 0,
      `业务事务持有范围共享锁期间 ACTIVE 冻结行数 = ${holdsDuringBusiness}（期望 0）`,
    );
    check(
      'C1 恢复建立冻结在业务事务收口前处于等待态',
      holdState.settled === false,
      `等待窗口结束时 hold() 是否已完成 = ${String(holdState.settled)}（期望 false）`,
    );

    // 业务事务收口 ⇒ 恢复才被允许建立冻结
    gate.open = true;
    gate.open2();
    const businessResult = await businessTask;
    check(
      'C1 业务写入在无冻结时正常放行',
      businessResult.ok,
      `业务写入结果 = ${businessResult.reason}`,
    );
    const holdResult = await holdTask;
    if (holdResult !== undefined && holdResult !== null) {
      createdHoldIds.push(holdResult.holdId);
    }
    const holdsAfterBusiness = await activeHoldCount(
      app.dataSource,
      scope.installationId,
      scope.organizationId,
    );
    check(
      'C1 业务事务提交后恢复才建立冻结',
      holdsAfterBusiness === 1,
      `业务事务提交后 ACTIVE 冻结行数 = ${holdsAfterBusiness}（期望 1）`,
    );

    phase('C2 开始：冻结生效后的业务写入');
    // ══ C2：冻结已生效后的业务写入必须受控拒绝 ════════════════════════════
    const rejected = await businessWrite(app, scope.organizationId, openGate());
    check(
      'C2 冻结生效期间的业务写入被受控拒绝',
      rejected.ok === false && /恢复期冻结/.test(rejected.reason),
      `业务写入结果 = ${rejected.ok ? '放行' : `拒绝（${rejected.reason}）`}`,
    );

    phase('C5 开始：解除冻结');
    // ══ C5：解除冻结后不再拦截 ════════════════════════════════════════════
    const holdCountBefore = await activeHoldCount(
      app.dataSource,
      scope.installationId,
      scope.organizationId,
    );
    await app.writeHold.release({ ...scope, restoreId });
    const holdCountAfter = await activeHoldCount(
      app.dataSource,
      scope.installationId,
      scope.organizationId,
    );
    check(
      'C5 解除冻结后不再拦截',
      holdCountBefore === 1 && holdCountAfter === 0,
      `解除前 ACTIVE 冻结行数 = ${holdCountBefore}，解除后 = ${holdCountAfter}`,
    );

    phase('C3 开始：同范围并发业务写入');
    // ══ C3：同一范围的两个并发业务写入互不阻塞 ════════════════════════════
    const gateA = createGate();
    const gateB = createGate();
    const taskA = businessWrite(app, scope.organizationId, gateA);
    await new Promise((resolve) => setTimeout(resolve, 600));
    const bState = { guarded: false };
    const taskB = businessWrite(app, scope.organizationId, gateB, () => {
      bState.guarded = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    check(
      'C3 同一范围的并发业务写入互不阻塞',
      bState.guarded === true,
      `第二个业务写入是否在等待窗口内取得范围共享锁 = ${String(bState.guarded)}（期望 true：共享锁不互斥）`,
    );
    gateA.open = true;
    gateB.open = true;
    gateA.open2();
    gateB.open2();
    const [resultA, resultB] = await Promise.all([taskA, taskB]);
    check(
      'C3 两个并发业务写入都放行',
      resultA.ok && resultB.ok,
      `结果 = ${resultA.reason} / ${resultB.reason}`,
    );

    phase('C4 开始：另一公司数据区');
    // ══ C4：另一公司数据区不受影响 ════════════════════════════════════════
    const otherOrg = await findPeerOrganization(app.dataSource, scope.organizationId);
    if (otherOrg === null) {
      check('C4 另一公司数据区的业务写入不受影响', false, '隔离库缺少第二个公司，无法实测');
    } else {
      const holdOther = await app.writeHold.hold({
        ...scope,
        restoreId: `${restoreId}-other`,
        reason: 'P1-1 范围隔离取证',
      });
      createdHoldIds.push(holdOther.holdId);
      const peerResult = await businessWrite(app, otherOrg, openGate());
      check(
        'C4 另一公司数据区的业务写入不受本公司冻结影响',
        peerResult.ok,
        `另一公司业务写入结果 = ${peerResult.ok ? '放行' : `拒绝（${peerResult.reason}）`}`,
      );
      await app.writeHold.release({ ...scope, restoreId: `${restoreId}-other` });
    }
  } finally {
    // ── 收尾：只回收本轮创建的对象 ────────────────────────────────────────
    for (const restoreIdToRelease of [restoreId, `${restoreId}-other`]) {
      try {
        await app.writeHold.release({ ...scope, restoreId: restoreIdToRelease });
      } catch {
        // 释放失败不掩盖主因
      }
    }
    for (const holdId of createdHoldIds) {
      try {
        await app.dataSource.query(
          'DELETE FROM local_write_hold WHERE hold_id = ? AND installation_id = ? AND organization_id = ?',
          [holdId, scope.installationId, scope.organizationId],
        );
      } catch {
        // 忽略
      }
    }
    const leftover: unknown = await app.dataSource.query(
      'SELECT hold_id, restore_id, status FROM local_write_hold ' +
        'WHERE installation_id = ? AND organization_id = ? AND status = ?',
      [scope.installationId, scope.organizationId, 'ACTIVE'],
    );
    if (Array.isArray(leftover) && leftover.length > 0) {
      process.stderr.write(`\n⚠️ 收尾后仍有 ACTIVE 冻结残留：${JSON.stringify(leftover)}\n`);
    }
  }

  await app.dataSource.destroy();

  const failed = assertions.filter((item) => !item.passed);
  process.stdout.write(`${JSON.stringify({ assertions }, null, 2)}\n`);
  if (failed.length > 0) {
    process.stderr.write(`\n❌ P1-1 并发互斥取证失败：${failed.length} 项断言未通过\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write('\n✅ P1-1 并发互斥取证通过\n');
}

main().catch((error: unknown) => {
  process.stderr.write(`\n❌ P1-1 并发互斥取证异常：${String(error)}\n`);
  if (error instanceof Error && typeof error.stack === 'string') {
    process.stderr.write(`${error.stack}\n`);
  }
  process.exitCode = 1;
});
