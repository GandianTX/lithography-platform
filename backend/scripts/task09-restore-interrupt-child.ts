// scripts/task09-restore-interrupt-child.ts

/**
 * 恢复**进程中断**取证子进程（任务 09 新计划第 05 项 · G22）。
 *
 * 用途：让父进程在恢复执行途中 `SIGKILL` 本进程，制造**真实的进程中断**，
 * 观察本机留下的事实：
 *
 * - 业务写入在**单一事务**内 ⇒ 进程被杀 ⇒ 事务由数据库回滚 ⇒ **不留半截数据**；
 * - 冻结事实**先于写入**落库 ⇒ 进程被杀 ⇒ 冻结仍在 ⇒ 设备继续停写停传；
 * - 恢复运行行停在 `RUNNING` ⇒ **结果未知**，但可由运维重新执行收口。
 *
 * 本子进程只做"真实动作"，**断言全部在父进程**（`task09-restore-selfcheck.ts`）。
 *
 * ── 安全边界（独立验收 P1-3）──
 * 子进程**独立复核**与父进程完全相同的约束：一次性库、预期实例身份、
 * 一次性库标识、受控文件根、安装／公司标识、测试授权。
 * 不信任父进程"已经检查过"的结论：父进程只透传**声明值**，
 * 子进程自己连库、读标识、核对真实路径后才动手。
 *
 * 约定的标准输出（父进程按行解析）：
 *   `READY <restoreId>` —— 预检与受理已完成、冻结已建立，**即将**进入写入；
 *   `DONE`                —— 写入已完成（父进程若此时才杀掉，则属"写完才中断"）。
 */

import { Test } from '@nestjs/testing';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { UsecaseSession } from '@app-types/auth/session.types';

import { TypeOrmModule } from '@nestjs/typeorm';
import { parse as parseDotenv } from 'dotenv';
import { DataSource } from 'typeorm';

import { AppConfigModule } from '@src/infrastructure/config/config.module';
import { loadExplicitEnvConfig } from '@src/infrastructure/database/incremental-migration';
import { TypeOrmTransactionModule } from '@src/infrastructure/database/transaction/typeorm-transaction.module';
import { LocalRuntimeStorageModule } from '@src/infrastructure/file-storage/local-runtime-storage.module';
import { LoggerModule } from '@src/infrastructure/logger/logger.module';
import { LocalInstallationEntity } from '@src/modules/lithography/entities/local-installation.entity';
import { LocalWriteHoldService } from '@src/modules/lithography/local-write-hold.service';
import { AcceptLocalRestoreUsecase } from '@src/usecases/local-runtime/accept-local-restore.usecase';
import { ExecuteLocalRestoreUsecase } from '@src/usecases/local-runtime/execute-local-restore.usecase';
import { LocalRuntimeUsecasesModule } from '@src/usecases/local-runtime/local-runtime-usecases.module';
import { PrecheckLocalRestoreUsecase } from '@src/usecases/local-runtime/precheck-local-restore.usecase';
import { StartManualLocalBackupUsecase } from '@src/usecases/local-runtime/start-manual-local-backup.usecase';

import {
  assertControlledFileRoot,
  assertDisposableMarker,
  assertPathWithinRoot,
  assertServerIdentity,
  readSelfcheckAuthorization,
  type DisposableMarkerRow,
} from './task09-restore-selfcheck.safety';

async function main(): Promise<void> {
  // ── 子进程独立复核安全约束（不信任父进程结论）──
  const authorization = readSelfcheckAuthorization(process.env);
  const fileRoot = assertControlledFileRoot(authorization.fileRoot);
  const runId = process.env['TASK09_RESTORE_RUN_ID'] ?? '';
  if (!/^[0-9a-f-]{36}$/u.test(runId)) {
    throw new Error('子进程缺少有效的本轮运行 ID，拒绝运行');
  }
  const runRoot = join(fileRoot, runId, 'child');
  const backupRoot = join(runRoot, 'backups');
  mkdirSync(backupRoot, { recursive: true });

  const parsed = parseDotenv(readFileSync(authorization.envFile, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    // eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
    process.env[key] = value;
  }
  // eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
  process.env.LOCAL_BACKUP_PROTECTION_KEY =
    '9f2c7a1d4e6b8035c7d9e1f4a2b6c8d0e3f5a7b9c1d3e5f7a9b1c3d5e7f9a1b3';
  // eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
  process.env.LOCAL_BACKUP_STORAGE_DIR = backupRoot;
  // 业务原件存储目录沿用 env 文件（受控文件根内）：原件是**跨轮次既有数据**，
  // 子进程必须与父进程看到同一批原件，否则备份出来的包缺原件、预检必然拒绝。
  const configuredOriginalsDir = process.env['REFERENCE_DOCUMENT_STORAGE_DIR'];
  const originalsDir =
    configuredOriginalsDir === undefined || configuredOriginalsDir.trim().length === 0
      ? join(fileRoot, 'originals')
      : resolve(configuredOriginalsDir);
  assertPathWithinRoot(fileRoot, originalsDir);
  // eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
  process.env.REFERENCE_DOCUMENT_STORAGE_DIR = originalsDir;
  mkdirSync(originalsDir, { recursive: true });

  const config = loadExplicitEnvConfig(authorization.envFile, authorization.database);
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

  const dataSource = moduleRef.get(DataSource);
  const startManualBackup = moduleRef.get(StartManualLocalBackupUsecase);
  const precheck = moduleRef.get(PrecheckLocalRestoreUsecase);
  const accept = moduleRef.get(AcceptLocalRestoreUsecase);
  const execute = moduleRef.get(ExecuteLocalRestoreUsecase);
  const writeHold = moduleRef.get(LocalWriteHoldService);

  try {
    // ── 子进程自己核对：实例身份 / 一次性库标识 / 安装与公司 ──
    const actualRows: unknown = await dataSource.query(
      'SELECT DATABASE() AS current_database, @@server_uuid AS server_uuid',
    );
    const actual = (actualRows as Array<Record<string, unknown>>)[0] ?? {};
    const options = dataSource.options as { host?: string; port?: number };
    assertServerIdentity(
      {
        database: String(actual['current_database'] ?? ''),
        serverUuid: String(actual['server_uuid'] ?? ''),
        host: String(options.host ?? ''),
        port: Number(options.port ?? 0),
      },
      authorization,
    );
    let markerRows: DisposableMarkerRow[];
    try {
      const rows: unknown = await dataSource.query(
        'SELECT marker_key, marker_value FROM task09_disposable_marker',
      );
      markerRows = (rows as Array<Record<string, unknown>>).map((row) => ({
        markerKey: String(row['marker_key'] ?? ''),
        markerValue: String(row['marker_value'] ?? ''),
      }));
    } catch {
      throw new Error('子进程读取一次性库标识失败：标识表不存在');
    }
    assertDisposableMarker(markerRows, authorization.disposableMarker);

    const installation = await dataSource
      .getRepository(LocalInstallationEntity)
      .findOne({ where: {} });
    if (installation === null) {
      throw new Error('本机安装身份未初始化');
    }
    if (installation.installationId.toLowerCase() !== authorization.installationId) {
      throw new Error('子进程安装标识与声明不一致，拒绝运行');
    }
    if (installation.organizationId !== authorization.organizationId) {
      throw new Error('子进程公司数据区与声明不一致，拒绝运行');
    }
    const organizationId = installation.organizationId ?? authorization.organizationId;

    // 会话：使用本轮真实的一级管理员账号（不写死 id）
    // 管理员等级由请求期数据库复核（`findAdminLevelByAccountId`）⇒ 必须**同时**
    // 具备组织管理员成员关系与 `admin_level = 1`，否则会话会被判"等级不合法"。
    const actorRows: unknown = await dataSource.query(
      'SELECT m.account_id AS account_id FROM organization_membership m ' +
        'JOIN base_user_account a ON a.id = m.account_id ' +
        "WHERE m.organization_id = ? AND m.status = ? AND a.status = 'ACTIVE' " +
        "AND m.member_role = 'SUPER_ADMIN' AND a.admin_level = 1 ORDER BY m.id ASC LIMIT 1",
      [organizationId, 'ACTIVE'],
    );
    const actorAccountId = Number(
      (actorRows as Array<{ account_id: number }>)[0]?.account_id ?? 0,
    );
    if (!Number.isInteger(actorAccountId) || actorAccountId <= 0) {
      throw new Error('子进程找不到本公司有效的一级管理员账号，拒绝运行');
    }
    const session: UsecaseSession = {
      accountId: actorAccountId,
      roles: ['SUPER_ADMIN'],
      activeRole: 'SUPER_ADMIN',
      adminLevel: 1,
      customerOrganizationId: null,
    } as unknown as UsecaseSession;

    const backup = await startManualBackup.execute({ session });
    if (backup.status !== 'SUCCEEDED' || backup.backupId === null) {
      throw new Error(`准备恢复用的备份失败：status=${backup.status}`);
    }
    const precheckResult = await precheck.execute({ session, backupId: backup.backupId });
    if (precheckResult.outcome !== 'PASSED') {
      throw new Error(`预检未通过：${precheckResult.outcome}`);
    }
    const accepted = await accept.execute({ session, restoreId: precheckResult.restoreId });
    if (!accepted.accepted) {
      throw new Error('受理失败');
    }

    // 冻结事实先落库（与恢复执行内部同口径）——进程被杀后它必须仍在
    await writeHold.hold({
      installationId: installation.installationId,
      organizationId,
      restoreId: precheckResult.restoreId,
      reason: `恢复执行中（${precheckResult.restoreId}）`,
    });

    // 备份之后改动一条业务数据：恢复若提交成功，该行会回到备份时刻的值；
    // 进程被杀则事务回滚 ⇒ 仍是改后的值。二者都成立，但**绝不能是半截**。
    // 把**本公司全部**工单都改成标记值（不只一条）：
    // 这样"未提交"＝全部仍是标记值、"整批提交"＝全部不是标记值、
    // "半截"＝有的改有的没改 ⇒ 原子性可判定。
    await dataSource.query(
      "UPDATE repair_request SET fault_description = 'MUTATED-AFTER-BACKUP' " +
        "WHERE owner_organization_id = ? AND fault_description <> 'MUTATED-AFTER-BACKUP'",
      [organizationId],
    );

    // **确定性中断**：先在**独立连接**上锁住本公司一条工单（FOR UPDATE），
    // 恢复写入会在这条行锁上**阻塞** ⇒ 父进程此刻 SIGKILL，
    // 杀掉的瞬间"业务写入正在途中"（而不是"还没开始"）。
    //
    // 锁与写入都在本进程内 ⇒ 进程被杀 ⇒ 行锁释放、写入事务由数据库回滚。
    await dataSource.transaction(async (manager) => {
      await manager.query(
        'SELECT id FROM repair_request WHERE owner_organization_id = ? ORDER BY id LIMIT 1 FOR UPDATE',
        [organizationId],
      );
      process.stdout.write(`READY ${precheckResult.restoreId}\n`);
      const outcome = await execute.execute({
        session,
        restoreId: precheckResult.restoreId,
      });
      process.stdout.write(`DONE ${outcome.status}\n`);
    });
  } finally {
    await dataSource.destroy();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
