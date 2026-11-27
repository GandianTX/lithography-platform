// scripts/task12-write-hold-active-conflict-check.ts
/**
 * 任务 09 第 12 项 · **历史 ACTIVE 冻结冲突**的合成隔离实库取证。
 *
 * 目的（计划第 12 项第 2 点）：
 * 「若需要历史 ACTIVE 冲突样例，用合成隔离数据验证修复／失败关闭，不能操作真实旧库。」
 *
 * 事实基础：`local_write_hold` 的范围索引 `idx_local_write_hold_scope`
 * **不是唯一索引** ⇒ 同（本机安装 × 公司）可以并存多条 ACTIVE 冻结。
 * 这正是"历史库遗留"的可能形态（旧实现先查后写，并发下会堆叠）。
 * `core/local-runtime/policy/local-write-hold.policy.ts` 的既定口径是：
 * 同范围多条 ACTIVE ⇒ **无法判定归属 ⇒ 失败关闭，不静默挑一条**。
 *
 * 本脚本只写**本轮创建的合成冻结**，按精确 `hold_id` 回收；
 * 不碰真实旧库、不碰真实业务数据、不改既有冻结。
 *
 * 断言写的是**期望行为**，不是当前行为：若实现有缺陷，脚本会**如实失败**（exit 1）。
 *
 * 用法（backend 目录）：
 *   TASK12_ACTIVE_CONFLICT_ALLOW=1 \
 *   TASK12_ACTIVE_CONFLICT_ENV=env/.env.e2e \
 *   TASK12_ACTIVE_CONFLICT_DATABASE=lithography_task09_test_e2e \
 *   npx ts-node -r tsconfig-paths/register scripts/task12-write-hold-active-conflict-check.ts
 */

// 脚本属**受控 wiring**：运行时配置只在这里读取一次。
import { Test } from '@nestjs/testing';

import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { join } from 'node:path';

import { AppConfigModule } from '@src/infrastructure/config/config.module';
import { loadExplicitEnvConfig } from '@src/infrastructure/database/incremental-migration';
import { TypeOrmTransactionModule } from '@src/infrastructure/database/transaction/typeorm-transaction.module';
import { LocalRuntimeStorageModule } from '@src/infrastructure/file-storage/local-runtime-storage.module';
import { LoggerModule } from '@src/infrastructure/logger/logger.module';
import { LocalWriteHoldEntity } from '@src/modules/lithography/entities/local-write-hold.entity';
import { LocalWriteHoldService } from '@src/modules/lithography/local-write-hold.service';
import { LocalRuntimeUsecasesModule } from '@src/usecases/local-runtime/local-runtime-usecases.module';

import {
  createAssertionCollector,
  loadEnvFile,
  readInstallationId,
  text,
} from './task09-script-utils';

const { assertions, check } = createAssertionCollector();

/** 受控原因码（与服务层同一口径，不另立字典） */
const SCOPE_OCCUPIED = 'WRITE_HELD_FOR_RESTORE_SCOPE_OCCUPIED';
const NOT_OWNER = 'RELEASE_NOT_PERMITTED_NOT_OWNER';
const WRITE_HELD = 'WRITE_HELD_FOR_RESTORE';

/** 合成恢复标识（固定值，便于复跑与核对；不指向任何真实恢复运行） */
const RESTORE_MINE = '97a10000-0000-4000-8000-00000000aa01';
const RESTORE_OTHER = '97a10000-0000-4000-8000-00000000bb02';
/** 该范围内**没有任何**冻结持有者：用于验证"不得按范围一刀切" */
const RESTORE_THIRD = '97a10000-0000-4000-8000-00000000cc03';

/**
 * 合成冻结 ID：刻意设计**主键排序**与"谁先被读到"的关系，
 * 以便验证"归属判定不得依赖行序"。
 */
const HOLD_IDS = {
  /** 本人持有、排序在前 */
  mineFirst: '97a10000-0000-4000-8000-000000000001',
  /** 他人持有、排序在后 */
  otherLast: '97a10000-0000-4000-8000-0000000000ff',
  /** 他人持有、排序在前 */
  otherFirst: '97a10000-0000-4000-8000-0000000000aa',
  /** 本人持有、排序在后 */
  mineLast: '97a10000-0000-4000-8000-0000000000ee',
} as const;

type HoldRow = { holdId: string; restoreId: string | null; status: string };

type Ctx = {
  dataSource: DataSource;
  writeHold: LocalWriteHoldService;
  repository: Repository<LocalWriteHoldEntity>;
  installationId: string;
  organizationId: number;
};

async function bootstrap(
  envFile: string,
  database: string,
): Promise<{
  dataSource: DataSource;
  writeHold: LocalWriteHoldService;
}> {
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

/** 读取范围内全部冻结（ACTIVE 与 RELEASED 都看，用于核对释放结果） */
async function readHolds(
  repository: Repository<LocalWriteHoldEntity>,
  installationId: string,
  organizationId: number,
): Promise<HoldRow[]> {
  const rows = await repository.find({
    where: { installationId, organizationId },
    order: { holdId: 'ASC' },
  });
  return rows.map((row) => ({
    holdId: row.holdId,
    restoreId: row.restoreId,
    status: row.status,
  }));
}

/** 从受控错误里取出错误码与原因码 */
function readErrorShape(error: unknown): { code: string; reasonCode: string; message: string } {
  const domain = error as { code?: unknown; details?: unknown; message?: unknown };
  const details = domain.details as { reasonCode?: unknown } | undefined;
  return {
    code: text(domain.code),
    reasonCode: text(details?.reasonCode),
    message: text(domain.message),
  };
}

/** 写入一条合成 ACTIVE 冻结 */
async function seedHold(
  ctx: Ctx,
  holdId: string,
  restoreId: string,
  reason: string,
): Promise<void> {
  await ctx.repository.save(
    ctx.repository.create({
      holdId,
      installationId: ctx.installationId,
      organizationId: ctx.organizationId,
      holdType: 'RESTORE',
      status: 'ACTIVE',
      restoreId,
      reason,
      releasedAt: null,
    }),
  );
}

/** 清空本轮在该范围内创建的合成行（按精确 hold_id，逐条可核对） */
async function resetScope(ctx: Ctx, ownedHoldIds: string[]): Promise<void> {
  if (ownedHoldIds.length > 0) {
    await ctx.repository.delete({ holdId: In(ownedHoldIds) });
    ownedHoldIds.length = 0;
  }
}

/** 调用"现场强制解冻"，返回释放条数与受控拒绝信息 */
async function callForceRelease(
  ctx: Ctx,
  incidentRestoreId: string,
): Promise<{ released: number; reasonCode: string; message: string }> {
  try {
    const released = await ctx.writeHold.forceReleaseForRecoveryIncident({
      installationId: ctx.installationId,
      organizationId: ctx.organizationId,
      incidentRestoreId,
    });
    return { released, reasonCode: '', message: '' };
  } catch (error) {
    const shape = readErrorShape(error);
    return { released: 0, reasonCode: shape.reasonCode, message: shape.message };
  }
}

/**
 * 单次探针：范围冲突态（两条 ACTIVE，不同持有者）下的一次"现场强制解冻"。
 *
 * 期望口径（与 `local-write-hold.policy.ts` 的既定原则一致）：
 * - **归属判定不得依赖行序**：本人持有者无论排在第几位，都必须能解冻自己那条；
 * - **不得按范围一刀切**：声明一个并不持有该范围冻结的恢复 ID ⇒ 必须被拒且零释放。
 */
async function runForceReleaseProbe(
  ctx: Ctx,
  label: string,
  mineHoldId: string,
  otherHoldId: string,
  ownedHoldIds: string[],
  declareRestoreId: string,
  expectAllowed: boolean,
  expectRemainingRestoreId: string | null,
): Promise<void> {
  await resetScope(ctx, ownedHoldIds);
  await seedHold(ctx, mineHoldId, RESTORE_MINE, `T12 合成 ${label} 本人持有`);
  await seedHold(ctx, otherHoldId, RESTORE_OTHER, `T12 合成 ${label} 他人持有`);
  ownedHoldIds.push(mineHoldId, otherHoldId);

  const probe = await callForceRelease(ctx, declareRestoreId);
  const after = await readHolds(ctx.repository, ctx.installationId, ctx.organizationId);
  const activeAfter = after.filter((row) => row.status === 'ACTIVE');
  const detail =
    `released=${probe.released} reasonCode=${probe.reasonCode} active=${activeAfter.length} ` +
    `remaining=${text(activeAfter[0]?.restoreId)} message=${probe.message}`;

  if (!expectAllowed) {
    check(
      `${label}：不得按范围一刀切（被拒、零释放、两条 ACTIVE 保持）`,
      probe.reasonCode === NOT_OWNER && probe.released === 0 && activeAfter.length === 2,
      detail,
    );
    return;
  }
  check(
    `${label}：持有者能解冻自己那条（归属判定不得因行序被误拒）`,
    probe.released === 1 &&
      probe.reasonCode === '' &&
      activeAfter.length === 1 &&
      activeAfter[0]?.restoreId === expectRemainingRestoreId,
    detail,
  );
}

async function main(): Promise<void> {
  // eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
  const envFile = process.env.TASK12_ACTIVE_CONFLICT_ENV ?? 'env/.env.e2e';
  // eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
  const database = process.env.TASK12_ACTIVE_CONFLICT_DATABASE ?? '';
  // 默认拒绝：必须显式授权，且目标必须是本机测试库（名称含 test/drill/ci）。
  // eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
  if (process.env.TASK12_ACTIVE_CONFLICT_ALLOW !== '1') {
    throw new Error('默认拒绝：请显式设置 TASK12_ACTIVE_CONFLICT_ALLOW=1');
  }
  if (database.length === 0 || !/(test|drill|ci)/.test(database.toLowerCase())) {
    throw new Error(`拒绝非隔离目标：${database}`);
  }

  const bootstrapped = await bootstrap(envFile, database);
  const installationId = await readInstallationId(bootstrapped.dataSource);
  if (installationId === null) {
    throw new Error('未找到本机安装标识，拒绝运行');
  }
  const orgRows: unknown = await bootstrapped.dataSource.query(
    "SELECT id FROM organization WHERE organization_code = 'PEER_ALT' LIMIT 1",
  );
  const organizationId = Number(text((orgRows as Array<{ id: unknown }>)[0]?.id));
  if (!Number.isInteger(organizationId) || organizationId <= 0) {
    throw new Error('未找到隔离测试组织 PEER_ALT，拒绝运行');
  }
  const ctx: Ctx = {
    ...bootstrapped,
    repository: bootstrapped.dataSource.getRepository(LocalWriteHoldEntity),
    installationId,
    organizationId,
  };
  const ownedHoldIds: string[] = [];

  try {
    const preExisting = await readHolds(ctx.repository, ctx.installationId, ctx.organizationId);
    check(
      '前置：隔离范围内无既有冻结（合成数据不与真实现场混叠）',
      preExisting.length === 0,
      `existing=${preExisting.length}`,
    );

    await seedHold(ctx, HOLD_IDS.mineFirst, RESTORE_MINE, 'T12 合成冲突样例 A');
    await seedHold(ctx, HOLD_IDS.otherLast, RESTORE_OTHER, 'T12 合成冲突样例 B');
    ownedHoldIds.push(HOLD_IDS.mineFirst, HOLD_IDS.otherLast);
    const afterSeed = await readHolds(ctx.repository, ctx.installationId, ctx.organizationId);
    check(
      'S1：同范围并存两条 ACTIVE 冻结在库层被接受（历史冲突可被结构表达）',
      afterSeed.filter((row) => row.status === 'ACTIVE').length === 2,
      `rows=${afterSeed.length}`,
    );

    let guardCode = '';
    let guardMessage = '';
    try {
      await ctx.writeHold.assertWritable({
        installationId: ctx.installationId,
        organizationId: ctx.organizationId,
      });
    } catch (error) {
      const shape = readErrorShape(error);
      guardCode = shape.reasonCode;
      guardMessage = shape.message;
    }
    check(
      'S2：冻结期写入准入被拒（受控原因码）',
      guardCode === WRITE_HELD,
      `reasonCode=${guardCode} message=${guardMessage}`,
    );

    let holdCode = '';
    let holdMessage = '';
    try {
      await ctx.writeHold.hold({
        installationId: ctx.installationId,
        organizationId: ctx.organizationId,
        restoreId: RESTORE_MINE,
        reason: 'T12 合成：历史冲突下的建立尝试',
      });
    } catch (error) {
      const shape = readErrorShape(error);
      holdCode = shape.reasonCode;
      holdMessage = shape.message;
    }
    const afterHoldAttempt = await readHolds(
      ctx.repository,
      ctx.installationId,
      ctx.organizationId,
    );
    check(
      'S3：历史冲突下建立冻结失败关闭（不静默挑一条、不新增行）',
      holdCode === SCOPE_OCCUPIED &&
        afterHoldAttempt.filter((row) => row.status === 'ACTIVE').length === 2,
      `reasonCode=${holdCode} message=${holdMessage}`,
    );

    const releasedByOwner = await ctx.writeHold.release({
      installationId: ctx.installationId,
      organizationId: ctx.organizationId,
      restoreId: RESTORE_MINE,
    });
    const afterRelease = await readHolds(ctx.repository, ctx.installationId, ctx.organizationId);
    const activeAfterRelease = afterRelease.filter((row) => row.status === 'ACTIVE');
    check(
      'S4：按归属释放只解自己那一条（同范围其它 ACTIVE 保持）',
      releasedByOwner === 1 &&
        activeAfterRelease.length === 1 &&
        activeAfterRelease[0]?.restoreId === RESTORE_OTHER,
      `released=${releasedByOwner} active=${activeAfterRelease.length} ` +
        `remaining=${text(activeAfterRelease[0]?.restoreId)}`,
    );

    await runForceReleaseProbe(
      ctx,
      'S5(本人持有且排序在前)',
      '97a10000-0000-4000-8000-000000000101',
      '97a10000-0000-4000-8000-0000000001ff',
      ownedHoldIds,
      RESTORE_MINE,
      true,
      RESTORE_OTHER,
    );
    await runForceReleaseProbe(
      ctx,
      'S6(声明不持有该范围的恢复)',
      '97a10000-0000-4000-8000-000000000101',
      '97a10000-0000-4000-8000-0000000001ff',
      ownedHoldIds,
      RESTORE_THIRD,
      false,
      null,
    );
    await runForceReleaseProbe(
      ctx,
      'S7(本人持有但排序在后)',
      '97a10000-0000-4000-8000-0000000002ee',
      '97a10000-0000-4000-8000-0000000002aa',
      ownedHoldIds,
      RESTORE_MINE,
      true,
      RESTORE_OTHER,
    );
  } finally {
    if (ownedHoldIds.length > 0) {
      await ctx.repository.delete({ holdId: In(ownedHoldIds) });
    }
    const leftover = await readHolds(ctx.repository, ctx.installationId, ctx.organizationId);
    check(
      '收尾：本轮合成冻结已按精确 hold_id 全部回收',
      leftover.length === 0,
      `leftover=${leftover.length}`,
    );
    await ctx.dataSource.destroy();
  }

  process.stdout.write('\n');
  for (const item of assertions) {
    process.stdout.write(`${item.passed ? 'PASS' : 'FAIL'} · ${item.name} · ${item.detail}\n`);
  }
  const failed = assertions.filter((item) => !item.passed);
  process.stdout.write(`\n总断言 ${assertions.length}，失败 ${failed.length}\n`);
  process.stdout.write(
    failed.length === 0 ? '✅ 历史 ACTIVE 冲突验证通过\n' : '❌ 历史 ACTIVE 冲突验证未通过\n',
  );
  process.exitCode = failed.length === 0 ? 0 : 1;
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : text(error);
  process.stdout.write(`❌ 脚本失败：${message}\n`);
  process.exitCode = 1;
});
