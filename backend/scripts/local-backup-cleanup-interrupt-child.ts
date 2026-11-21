// scripts/local-backup-cleanup-interrupt-child.ts
//
// 真实进程中断注入的**子进程**（任务 09 R-08：删除中断的真实进程中断注入）。
//
// 用途：由 `local-backup-cleanup.interrupt.realdb.spec.ts` 起一个**真实进程**执行
// 真实的 `LocalBackupCleanupService`，父进程在观察到 CLEANING 已落库后用 SIGKILL
// 杀掉它，从而在真实数据库里留下"进程被中断"的残留现场。
//
// 与受控替身的区别（本文件存在的原因）：
// - 替身只替换底层删除失败；进程本身始终正常退出，无法证明"进程真的死在中间"；
// - 本子进程跑的是**真实清理服务 + 真实 MySQL + 真实文件系统**，
//   中断由父进程对子进程发 SIGKILL 造成，残留状态是真实落库的。
//
// 参数：<envFile> <database> <backupRoot> <organizationId> <installationId> <nowIso>
//   nowIso 允许父进程传入可控时钟（第二轮复现"超过中断可辨认时限"的判定）。
//
// 运行示例：
//   node -r ts-node/register -r tsconfig-paths/register \
//     scripts/local-backup-cleanup-interrupt-child.ts \
//     env/.env.development lithography_task09_dev /tmp/pkg-root 4 inst-xxx 2026-11-22T00:00:00.000Z
//
// 注意：这里用 `ts-node/register`（非 transpile-only）：transpile-only 会因本仓库 tsconfig 的
// rootDir 设定触发 TS5011（common source directory），子进程会在真正执行清理前就退出。

import * as nodePath from 'node:path';

import { DataSource } from 'typeorm';

import { loadExplicitEnvConfig } from '../src/infrastructure/database/incremental-migration';
import { BackupAssetEntity } from '../src/modules/lithography/entities/backup-asset.entity';
import { LocalBackupRunEntity } from '../src/modules/lithography/entities/local-backup-run.entity';
import { LocalInstallationEntity } from '../src/modules/lithography/entities/local-installation.entity';
import { LocalBackupCleanupService } from '../src/modules/lithography/local-backup-cleanup.service';

const readArg = (index: number, name: string): string => {
  const value = process.argv[index + 2];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`缺少参数：${name}`);
  }
  return value.trim();
};

const main = async (): Promise<void> => {
  const envFile = readArg(0, 'envFile');
  const database = readArg(1, 'database');
  const backupRoot = readArg(2, 'backupRoot');
  const organizationId = Number(readArg(3, 'organizationId'));
  const installationId = readArg(4, 'installationId');
  const nowIso = readArg(5, 'nowIso');

  const config = loadExplicitEnvConfig(envFile, database);
  const dataSource = new DataSource({
    type: 'mysql',
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password,
    database: config.database,
    timezone: config.timezone,
    charset: config.charset,
    logging: false,
    synchronize: false,
    dropSchema: false,
    migrationsRun: false,
    // 与仓库其它实库规格一致：用实体 glob 装配，保证关系元数据齐全
    entities: [nodePath.join(__dirname, '../src/modules/**/*.entity.ts')],
  });

  await dataSource.initialize();
  try {
    const service = new LocalBackupCleanupService(
      dataSource.getRepository(BackupAssetEntity),
      { baseDir: backupRoot },
      dataSource.getRepository(LocalBackupRunEntity),
      dataSource.getRepository(LocalInstallationEntity),
    );

    const result = await service.cleanupManualPackages({
      organizationId,
      installationId,
      // 完整云回执是手动清理的唯一授权来源
      cloudReceipt: '{"received":true}',
      now: new Date(nowIso),
    });

    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await dataSource.destroy();
  }
};

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
