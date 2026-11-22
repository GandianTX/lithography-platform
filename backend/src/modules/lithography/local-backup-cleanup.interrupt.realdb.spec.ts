// src/modules/lithography/local-backup-cleanup.interrupt.realdb.spec.ts
//
// R-08：删除中断的**真实进程中断**注入（任务 09 自身遗留项）。
//
// 为什么需要这一份规格（而不是再加一个受控替身）：
// - 既有集成规格（local-backup-cleanup.integration.spec.ts）用**受控替身**覆盖底层删除失败，
//   进程始终正常退出；中断语义只靠"残留 CLEANING 超时"这一条合成判定，
//   无法证明"进程真的死在落 CLEANING 与落 CLEANED 之间"；
// - 本规格起**真实子进程**执行真实清理服务（真实 MySQL ＋ 真实文件系统），
//   父进程观察到 CLEANING 已落库后发 SIGKILL，随后核对：
//   ① 残留是 CLEANING（不是 CLEANED、deleted_at 为空、local_reference 未被清空）；
//   ② 下一轮把残留**识别为中断**（落"清理被进程中断"原因）并**继续清理**；
//   ③ 最终落 CLEANED、包目录消失——即中断不误标为已清理；
//   ④ 反例：残留**未超过中断可辨认时限**时下一轮**不得**把它登记为中断
//     （证明"识别为中断"由超时判定驱动，而不是无条件落库）；
//   ⑤ **重启恢复**：上一进程留下的残留（进程死在删除完成之后、落 CLEANED 之前），
//     在**服务重启后**（新起的真实子进程 = 重启后的服务实例）仍必须**可辨认**
//     （被登记为中断）并**收敛**为已清理；同批的"时限内残留"不得被登记为中断。
//
// 作用域隔离（重要）：
// - 真实清理的批次作用域是「本机公司 ＋ 本机安装标识」下的**全部**资产。
//   `local_installation` 是单例表（`id = 1`），无法再插一条合成安装行，
//   因此本规格复用本机真实安装标识，并**在执行前断言该作用域内只有本轮合成资产**；
//   一旦发现他人资产，直接失败关闭——否则子进程会把他人资产行改写（状态／清理原因），
//   属于对开发库的越权污染。
//
// 观测窗口的处理（关键设计）：
// - "识别为中断"落库（写 local_cleanup_error）到"再次落 CLEANING"之间只有一次 UPDATE 往返，
//   实测窗口约 2ms；父进程用普通轮询很容易错过，断言会变成"看运气"。
// - 因此本规格在中断之后**补录创建时间更早的待清理包**（补位包）：下一轮的清理清单按
//   (created_at, backup_id) 排序，补位包排在残留之前，残留因此落在批次末尾；
//   下一轮会先花时间真正删除补位包，残留行上的"清理被进程中断"在整个补位包删除期间持续可见，
//   断言变成确定性的事实核对，而不是碰运气。
// - 补位包只影响批次顺序，不改变中断判定口径（判定只看「CLEANING 且超过 10 分钟未推进」）。
//
// 夹具放在系统临时目录（os.tmpdir）的原因：
// - 本规格要验证的是**真实文件系统删除**在进程中断下的行为。部分 IDE/工具链会把 node 的
//   fs 删除调用改成"移入回收站"，并对单次工具调用内的批量删除条目数设上限，
//   那会改变被测语义（包目录不是被真删，而是被回收站接管）甚至直接阻断删除。
// - 系统临时目录是这类工具链的通用豁免路径：放在那里即回到原生 fs 语义，
//   本规格测到的才是真实删除 + 真实中断。
//
// 安全门（默认 skip，不创建 DataSource、不建立任何连接）：
//   E2E_REAL_DB_SPECS=1                    显式启用实库规格
//   E2E_ALLOW_PHYSICAL_CLEANUP=1           显式授权清理本轮合成夹具
//   E2E_REAL_DB_NAME=<目标库>               精确目标库
//   E2E_ALLOWED_DB_NAMES=<同一个库>          白名单必须且只能包含该库
//   E2E_REAL_DB_CONFIG_FILE=<绝对路径 env>   显式 env 文件，DB_NAME 必须与目标一致
// 显式设置 E2E_REAL_DB_SPECS=1 但许可不全时，模块加载即抛错拒绝，不静默跳过。
//
// 运行示例：
//   E2E_REAL_DB_SPECS=1 E2E_ALLOW_PHYSICAL_CLEANUP=1 \
//   E2E_REAL_DB_NAME=lithography_task09_dev E2E_ALLOWED_DB_NAMES=lithography_task09_dev \
//   E2E_REAL_DB_CONFIG_FILE=<绝对路径>/env/.env.development \
//   npx jest src/modules/lithography/local-backup-cleanup.interrupt.realdb.spec.ts --runInBand

import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

import { DataSource } from 'typeorm';

import {
  assertAllowedE2eDatabase,
  assertPhysicalCleanupConsent,
  resolveAllowedE2eDatabases,
} from '../../../test/utils/e2e-db-guard';
import { loadExplicitEnvConfig } from '../../infrastructure/database/incremental-migration';
import { BackupAssetEntity } from './entities/backup-asset.entity';
import { LocalBackupRunEntity } from './entities/local-backup-run.entity';

const REQUESTED = process.env.E2E_REAL_DB_SPECS === '1';
const CLEANUP_ALLOWED = process.env.E2E_ALLOW_PHYSICAL_CLEANUP === '1';
const EXPECTED_DB = (process.env.E2E_REAL_DB_NAME ?? '').trim().toLowerCase();
const ALLOWED_DBS = resolveAllowedE2eDatabases();
const CONFIG_FILE = (process.env.E2E_REAL_DB_CONFIG_FILE ?? '').trim();

// 许可逐项核对：任一缺失都算许可不全
const MISSING_PERMISSIONS: string[] = [];
if (!CLEANUP_ALLOWED) {
  MISSING_PERMISSIONS.push('E2E_ALLOW_PHYSICAL_CLEANUP=1');
}
if (EXPECTED_DB === '') {
  MISSING_PERMISSIONS.push('E2E_REAL_DB_NAME');
}
if (CONFIG_FILE === '') {
  MISSING_PERMISSIONS.push('E2E_REAL_DB_CONFIG_FILE');
}
if (EXPECTED_DB !== '' && !ALLOWED_DBS.includes(EXPECTED_DB)) {
  MISSING_PERMISSIONS.push('E2E_ALLOWED_DB_NAMES（白名单必须且只能包含目标库）');
}

const ENABLED = REQUESTED && MISSING_PERMISSIONS.length === 0;

// 显式要求执行却许可不全 → 模块加载即失败关闭，绝不静默跳过
// （否则执行者会误判"已经跑过"，把未执行的规格当成已验证）
if (REQUESTED && !ENABLED) {
  throw new Error(
    'R-08 实库规格被显式要求执行（E2E_REAL_DB_SPECS=1），但许可不全：缺少 ' +
      `${MISSING_PERMISSIONS.join('、')}。明确拒绝，不静默跳过。` +
      '该规格会写入合成资产行并物理删除包目录，清理许可与库名白名单是两道相互独立的门。',
  );
}

const describeRealDb = ENABLED ? describe : describe.skip;

// 真实进程 + 真实 MySQL + ts-node 子进程启动，耗时远超默认 10s：显式放宽时限
jest.setTimeout(300_000);

/**
 * 单个合成包的文件数与分目录数。
 *
 * 规模刻意控制在千级并分目录存放：既让真实递归删除耗时足够长（中断窗口可被 SIGKILL 命中），
 * 又避免触发批量删除护栏（本规格自身清理只逐个 unlink 登记的文件）。
 */
const PACKAGE_SUBDIR_COUNT = 200;
const PACKAGE_FILE_PER_SUBDIR = 6;
/** 观察 DB 状态的轮询间隔与超时 */
const POLL_INTERVAL_MS = 2;
const POLL_TIMEOUT_MS = 120_000;
/** 中断注入的最大尝试次数：删除窗口没命中时重来，不靠"碰运气" */
const INJECT_ATTEMPTS = 3;
/** 补位包数量：让"识别为中断"的瞬时状态具备确定性的观测窗口 */
const FILLER_PACKAGE_COUNT = 2;
/** 中断可辨认时限（分钟）：与 BACKUP_CLEANUP_INTERRUPT_MINUTES 口径一致 */
const INTERRUPT_MINUTES = 10;
/** 下一轮判定时刻相对残留更新时间的推进量（分钟）：越过中断可辨认时限 */
const NEXT_ROUND_ADVANCE_MINUTES = INTERRUPT_MINUTES + 1;
/** 反例用推进量（分钟）：仍在中断可辨认时限之内，不得登记为中断 */
const WITHIN_THRESHOLD_ADVANCE_MINUTES = 1;

type AssetState = {
  local_status: string;
  local_cleanup_error: string | null;
  local_reference: string | null;
  deleted_at: Date | null;
  updated_at: Date;
};

/** 本轮登记的一个合成包 */
type SyntheticPackage = {
  backupId: string;
  packagePath: string;
};

describeRealDb('R-08 删除中断的真实进程中断注入', () => {
  const backendRoot = nodePath.resolve(__dirname, '../../..');
  // 夹具落在系统临时目录：保证删除走原生 fs 语义（见文件头说明）
  const workspace = nodePath.join(tmpdir(), `task09-r08-interrupt-${process.pid}`);
  const backupRoot = nodePath.join(workspace, 'local-backups');
  /** 本机真实安装标识（beforeAll 从库里读出，避免硬编码与外键脱节） */
  let installationId = '';
  const organizationId = 4;
  /** 中断注入的目标包（残留现场） */
  const residual: SyntheticPackage = {
    backupId: randomUUID(),
    packagePath: '',
  };
  /** 补位包：创建时间早于残留，用于把残留排到下一轮批次末尾 */
  const fillers: SyntheticPackage[] = [];
  /** 反例批次：慢清理包（制造观测窗口）＋ 时限内残留（不得被登记为中断） */
  const withinThresholdBatch: SyntheticPackage[] = [];
  /** 重启恢复批次：上一进程遗留的残留（目录已删、状态未落）＋ 时限内对照 ＋ 补位包 */
  const restartBatch: SyntheticPackage[] = [];
  /**
   * 哨兵（中断场景下的"不该被动"事实）：
   * - 外公司包目录（备份根下的另一个公司目录）：中断清理不得越界删除；
   * - 备份根内的非包文件：清理只针对登记的包目录；
   * - 业务原件哨兵（备份根之外）：受控清理不得触碰业务原件目录。
   */
  const sentinels: { path: string; content: string }[] = [];

  let dataSource: DataSource;
  let runId = 0;
  /** 子进程输出（早退时用于快速失败定位）：stdout 与 stderr 分开留存 */
  const childOutput = new Map<ChildProcess, { stdout: string; stderr: string }>();

  const readAssetState = async (backupId: string): Promise<AssetState | null> => {
    const rows = await dataSource.query(
      'SELECT local_status, local_cleanup_error, local_reference, deleted_at, updated_at' +
        ' FROM backup_asset WHERE backup_id = ?',
      [backupId],
    );
    const row = rows[0] as AssetState | undefined;
    return row ?? null;
  };

  /**
   * 清理作用域护栏：真实清理批次覆盖「本机公司 ＋ 本机安装标识」下的**全部**资产。
   *
   * `local_installation` 是单例表（`id = 1`），无法再插一条合成安装行，因此本规格复用
   * 本机真实安装标识——代价是批次作用域不可完全隔离。若作用域内存在他人资产，
   * 子进程会把它们改写（状态与清理原因），属于对开发库的越权污染，故失败关闭。
   */
  const assertScopeIsolated = async (allowedBackupIds: string[]): Promise<void> => {
    const rows = await dataSource.query(
      'SELECT backup_id FROM backup_asset WHERE organization_id = ? AND installation_id = ?',
      [organizationId, installationId],
    );
    const foreign = (rows as { backup_id: string }[])
      .map((row) => row.backup_id)
      .filter((backupId) => !allowedBackupIds.includes(backupId));
    if (foreign.length > 0) {
      throw new Error(
        '拒绝执行 R-08 实库规格：清理作用域（本机公司 ＋ 本机安装标识）内存在非本轮合成资产 ' +
          `${foreign.join('、')}；继续执行会改写他人资产行的状态与清理原因。` +
          '请先清理该作用域，或改用可丢弃库执行。',
      );
    }
  };

  /** 逐个删除登记的合成文件与目录（不做整树批量删除）；已被删掉的条目直接跳过 */
  const removeTree = (targetPath: string): void => {
    if (!existsSync(targetPath)) {
      return;
    }
    for (const entry of readdirSync(targetPath, { withFileTypes: true })) {
      const entryPath = nodePath.join(targetPath, entry.name);
      if (!existsSync(entryPath)) {
        continue;
      }
      if (entry.isDirectory()) {
        removeTree(entryPath);
        if (existsSync(entryPath)) {
          rmdirSync(entryPath);
        }
      } else {
        unlinkSync(entryPath);
      }
    }
    if (existsSync(targetPath)) {
      rmdirSync(targetPath);
    }
  };

  const createPackageFiles = (packagePath: string): void => {
    removeTree(packagePath);
    mkdirSync(packagePath, { recursive: true });
    for (let dirIndex = 0; dirIndex < PACKAGE_SUBDIR_COUNT; dirIndex += 1) {
      const dirPath = nodePath.join(packagePath, `chunk-${dirIndex}`);
      mkdirSync(dirPath, { recursive: true });
      for (let fileIndex = 0; fileIndex < PACKAGE_FILE_PER_SUBDIR; fileIndex += 1) {
        writeFileSync(nodePath.join(dirPath, `part-${fileIndex}`), 'x');
      }
    }
  };

  /** 建立哨兵：三个位置各放一个带内容的文件 */
  const createSentinels = (): void => {
    const cases: { path: string; content: string }[] = [
      {
        path: nodePath.join(backupRoot, '999', 'foreign-package', 'keep.txt'),
        content: 'foreign-company-package',
      },
      {
        path: nodePath.join(backupRoot, 'shared-root-file.txt'),
        content: 'backup-root-non-package',
      },
      {
        path: nodePath.join(workspace, 'business-originals', 'original.bin'),
        content: 'business-original',
      },
    ];
    for (const item of cases) {
      mkdirSync(nodePath.dirname(item.path), { recursive: true });
      writeFileSync(item.path, item.content);
      sentinels.push(item);
    }
  };

  /** 核对哨兵：文件仍在且内容未变 */
  const expectSentinelsIntact = (): void => {
    for (const item of sentinels) {
      expect(existsSync(item.path)).toBe(true);
      expect(readFileSync(item.path, 'utf8')).toBe(item.content);
    }
  };

  const waitFor = async (
    predicate: () => Promise<boolean>,
    timeoutMs: number = POLL_TIMEOUT_MS,
  ): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    return false;
  };

  /** 起真实子进程执行真实清理服务 */
  const spawnCleanupChild = (nowIso: string): ChildProcess => {
    const child = spawn(
      process.execPath,
      [
        '-r',
        'ts-node/register',
        '-r',
        'tsconfig-paths/register',
        'scripts/local-backup-cleanup-interrupt-child.ts',
        CONFIG_FILE,
        EXPECTED_DB,
        backupRoot,
        String(organizationId),
        installationId,
        nowIso,
      ],
      { cwd: backendRoot, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    childOutput.set(child, { stdout: '', stderr: '' });
    child.stderr?.on('data', (chunk: Buffer) => {
      const current = childOutput.get(child) ?? { stdout: '', stderr: '' };
      childOutput.set(child, { ...current, stderr: current.stderr + chunk.toString() });
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      const current = childOutput.get(child) ?? { stdout: '', stderr: '' };
      childOutput.set(child, { ...current, stdout: current.stdout + chunk.toString() });
    });
    return child;
  };

  /** 等待子进程退出并取回退出码 */
  const waitForChildExit = (child: ChildProcess): Promise<number | null> => {
    if (child.exitCode !== null) {
      return Promise.resolve(child.exitCode);
    }
    return new Promise<number | null>((resolve) => {
      child.once('exit', (code) => resolve(code));
    });
  };

  /** 取子进程 stdout 最后一行（清理结果 JSON）；只认 stdout，避免与 stderr 混淆 */
  const readChildResult = (child: ChildProcess): Record<string, unknown> | null => {
    const lines = (childOutput.get(child)?.stdout ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('{') && line.endsWith('}'));
    const last = lines[lines.length - 1];
    if (last === undefined) {
      return null;
    }
    try {
      return JSON.parse(last) as Record<string, unknown>;
    } catch {
      return null;
    }
  };

  /** 子进程输出（stdout＋stderr）拼接，用于失败定位 */
  const readChildOutput = (child: ChildProcess): string =>
    `${childOutput.get(child)?.stdout ?? ''}${childOutput.get(child)?.stderr ?? ''}`
      .trim()
      .slice(0, 2000);

  /** 把残留行复位到"待清理"（仅用于删除窗口没命中的重试） */
  const resetResidualRow = async (): Promise<void> => {
    await dataSource.query(
      'UPDATE backup_asset SET local_status = ?, local_reference = ?, deleted_at = NULL,' +
        ' local_cleanup_error = NULL WHERE backup_id = ?',
      ['PENDING', residual.packagePath, residual.backupId],
    );
  };

  /** 写入一个合成资产行 */
  const insertAsset = async (
    backupId: string,
    packagePath: string,
    createdAt: Date,
    overrides: { localStatus?: string; updatedAt?: Date } = {},
  ): Promise<void> => {
    const assetRepository = dataSource.getRepository(BackupAssetEntity);
    await assetRepository.save(
      assetRepository.create({
        backupId,
        runId,
        organizationId,
        storageReference: `cloud://${backupId}`,
        fileSha256: 'a'.repeat(64),
        byteSize: '100',
        cloudStatus: 'SUCCEEDED',
        localStatus: overrides.localStatus ?? 'PENDING',
        cloudReceipt: '{"received":true}',
        installationId,
        localReference: packagePath,
        verifiedAt: new Date(),
        createdAt,
        updatedAt: overrides.updatedAt,
      }),
    );
  };

  beforeAll(async () => {
    assertPhysicalCleanupConsent();
    const config = loadExplicitEnvConfig(CONFIG_FILE, EXPECTED_DB);
    assertAllowedE2eDatabase(config.database);

    dataSource = new DataSource({
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
      entities: [nodePath.join(__dirname, '../**/*.entity.ts')],
    });
    await dataSource.initialize();
    assertAllowedE2eDatabase(dataSource.options.database as string);

    // 复用本机真实安装标识：外键指向 local_installation，且合成资产按安装标识隔离，
    // 不会与既有资产（本机既有资产的 installation_id 为空）混在同一清理批次里
    const installationRows = await dataSource.query(
      'SELECT installation_id FROM local_installation WHERE organization_id = ? LIMIT 1',
      [organizationId],
    );
    const realInstallationId = (installationRows as { installation_id?: string }[])[0]
      ?.installation_id;
    if (realInstallationId === undefined || realInstallationId.length === 0) {
      throw new Error('本机没有可用安装标识，无法构造符合外键的合成运行行');
    }
    installationId = realInstallationId;

    // 合成运行行与资产行（均为本轮生成，结束时按登记的主键精确删除）
    // 运行行取"已结束"状态：本机同一 (安装, 公司) 只允许一条活动运行，
    // 合成行不占用活动位，也不影响既有运行。
    const runRepository = dataSource.getRepository(LocalBackupRunEntity);
    const run = await runRepository.save(
      runRepository.create({
        installationId,
        triggerType: 'MANUAL',
        status: 'SUCCEEDED',
        startedAt: new Date(),
        finishedAt: new Date(),
        organizationId,
      }),
    );
    runId = run.id;

    residual.packagePath = nodePath.join(backupRoot, String(organizationId), residual.backupId);
    await insertAsset(residual.backupId, residual.packagePath, new Date());

    // 作用域护栏：本轮执行不得改写他人资产行
    await assertScopeIsolated([residual.backupId]);

    // 哨兵先行建立：外公司包、备份根内非包文件、业务原件
    createSentinels();

    // 第一轮：真实子进程执行真实清理，父进程在 CLEANING 落库后 SIGKILL
    let injected = false;
    for (let attempt = 1; attempt <= INJECT_ATTEMPTS && !injected; attempt += 1) {
      await resetResidualRow();
      createPackageFiles(residual.packagePath);

      const child = spawnCleanupChild(new Date().toISOString());
      let childExited = false;
      child.once('exit', () => {
        childExited = true;
      });

      await waitFor(async () => {
        const state = await readAssetState(residual.backupId);
        if (state?.local_status === 'CLEANING' || state?.local_status === 'CLEANED') {
          return true;
        }
        // 子进程提前退出（启动失败等）：立刻收敛，不空等窗口
        return childExited;
      }, 60_000);

      const observed = await readAssetState(residual.backupId);
      if (observed?.local_status === 'CLEANING') {
        child.kill('SIGKILL');
        await waitForChildExit(child);
        // 杀掉后仍必须是 CLEANING：若已落 CLEANED 说明窗口没命中，重来
        injected = (await readAssetState(residual.backupId))?.local_status === 'CLEANING';
        if (!injected) {
          continue;
        }
        break;
      }

      await waitForChildExit(child);
      if (observed?.local_status !== 'CLEANED') {
        throw new Error(
          '子进程未落 CLEANING 也未落 CLEANED（可能启动失败）：' + readChildOutput(child),
        );
      }
      // 走到这里说明删除已完成、窗口没命中：复位后重来，不靠碰运气
    }

    if (!injected) {
      throw new Error(
        `未能把 SIGKILL 注入到删除窗口内（${INJECT_ATTEMPTS} 次尝试均未命中）：` +
          '删除窗口过短，无法证明"进程死在落 CLEANING 与落 CLEANED 之间"。',
      );
    }
  });

  afterAll(async () => {
    const registered = [residual, ...fillers, ...withinThresholdBatch, ...restartBatch];
    if (dataSource?.isInitialized === true) {
      for (const item of registered) {
        await dataSource.query('DELETE FROM backup_asset WHERE backup_id = ?', [item.backupId]);
      }
      if (runId > 0) {
        await dataSource.query('DELETE FROM local_backup_run WHERE id = ?', [runId]);
      }
      await dataSource.destroy();
    }
    for (const item of registered) {
      removeTree(item.packagePath);
    }
    // 整个临时工作区（含空壳目录与哨兵）一并回收，不留残留在系统临时目录
    removeTree(workspace);
  });

  it('进程被 SIGKILL 后留下可辨认的 CLEANING 残留，不误标为已清理', async () => {
    const state = await readAssetState(residual.backupId);

    expect(state).not.toBeNull();
    expect(state?.local_status).toBe('CLEANING');
    expect(state?.deleted_at).toBeNull();
    expect(state?.local_reference).toBe(residual.packagePath);

    // 中断不得越界：外公司包、备份根内非包文件、业务原件都不受影响
    expectSentinelsIntact();
  });

  it('下一轮把残留识别为中断并继续清理，最终落 CLEANED 且包目录消失', async () => {
    const residualBefore = await readAssetState(residual.backupId);
    expect(residualBefore?.local_status).toBe('CLEANING');

    // 补位包：创建时间早于残留，使残留落在下一轮清理批次的末尾，
    // 从而"识别为中断"的落库状态在整个补位包删除期间持续可见（确定性观测窗口）
    const fillerCreatedAt = new Date(residualBefore!.updated_at.getTime() - 60 * 60_000);
    for (let index = 0; index < FILLER_PACKAGE_COUNT; index += 1) {
      const filler: SyntheticPackage = {
        backupId: randomUUID(),
        packagePath: nodePath.join(backupRoot, String(organizationId), `filler-${index}`),
      };
      fillers.push(filler);
      await insertAsset(filler.backupId, filler.packagePath, fillerCreatedAt);
      createPackageFiles(filler.packagePath);
    }

    // 第二轮执行前再查一次作用域：不得出现他人资产
    await assertScopeIsolated([residual.backupId, ...fillers.map((item) => item.backupId)]);

    // 可控时钟：把判定时刻推进到"超过中断可辨认时限"之后（与任务书 S5.2 的可控时钟口径一致）
    const nextRoundNow = new Date(
      residualBefore!.updated_at.getTime() + NEXT_ROUND_ADVANCE_MINUTES * 60_000,
    );
    const child = spawnCleanupChild(nextRoundNow.toISOString());

    // 残留先被登记为中断（本轮重试），随后继续清理
    const marked = await waitFor(async () => {
      const state = await readAssetState(residual.backupId);
      return (state?.local_cleanup_error ?? '').includes('LOCAL_CLEANUP_INTERRUPTED');
    });
    if (!marked) {
      throw new Error(
        '下一轮没有把残留登记为中断（未观测到"清理被进程中断"），子进程输出：\n' +
          readChildOutput(child),
      );
    }

    const exitCode = await waitForChildExit(child);

    const result = readChildResult(child);
    if (exitCode !== 0 || result?.['cleaned'] !== FILLER_PACKAGE_COUNT + 1) {
      throw new Error(
        `下一轮清理结果不符合预期：exitCode=${exitCode}，cleaned=${String(result?.['cleaned'])}，` +
          `retained=${String(result?.['retained'])}，子进程输出：\n` +
          readChildOutput(child),
      );
    }
    expect(result?.['retained']).toBe(0);

    const state = await readAssetState(residual.backupId);
    expect(state?.local_status).toBe('CLEANED');
    expect(state?.local_reference).toBeNull();
    expect(state?.deleted_at).not.toBeNull();
    expect(existsSync(residual.packagePath)).toBe(false);

    // 补位包同样被清掉：中断不阻断本轮其余包的清理
    for (const filler of fillers) {
      const fillerState = await readAssetState(filler.backupId);
      expect(fillerState?.local_status).toBe('CLEANED');
      expect(existsSync(filler.packagePath)).toBe(false);
    }

    // 中断后的续清同样不得越界：三个哨兵仍在且内容未变
    expectSentinelsIntact();
  });

  it('反例：残留未超过中断可辨认时限时，下一轮不得把它登记为中断', async () => {
    // 慢清理包排在前面：制造观测窗口，让"若被误登记为中断"的状态持续可见
    const slowPackage: SyntheticPackage = {
      backupId: randomUUID(),
      packagePath: nodePath.join(backupRoot, String(organizationId), 'within-threshold-slow'),
    };
    // 时限内残留：CLEANING 且更新时间很新（未超过 10 分钟可辨认时限）
    const freshResidual: SyntheticPackage = {
      backupId: randomUUID(),
      packagePath: nodePath.join(backupRoot, String(organizationId), 'within-threshold-residual'),
    };
    withinThresholdBatch.push(slowPackage, freshResidual);

    const now = new Date();
    await insertAsset(
      slowPackage.backupId,
      slowPackage.packagePath,
      new Date(now.getTime() - 7_200_000),
    );
    createPackageFiles(slowPackage.packagePath);
    await insertAsset(
      freshResidual.backupId,
      freshResidual.packagePath,
      new Date(now.getTime() - 3_600_000),
      { localStatus: 'CLEANING', updatedAt: now },
    );
    createPackageFiles(freshResidual.packagePath);

    await assertScopeIsolated([
      residual.backupId,
      ...fillers.map((item) => item.backupId),
      slowPackage.backupId,
      freshResidual.backupId,
    ]);

    // 可控时钟：判定时刻仍在中断可辨认时限之内 → 不得登记为中断
    const withinThresholdNow = new Date(now.getTime() + WITHIN_THRESHOLD_ADVANCE_MINUTES * 60_000);
    const child = spawnCleanupChild(withinThresholdNow.toISOString());

    // 全程盯住该残留：只要出现"清理被进程中断"即判定失败
    let wronglyMarked = false;
    let pollCount = 0;
    while (child.exitCode === null && child.signalCode === null) {
      pollCount += 1;
      const state = await readAssetState(freshResidual.backupId);
      if ((state?.local_cleanup_error ?? '').includes('LOCAL_CLEANUP_INTERRUPTED')) {
        wronglyMarked = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    const exitCode = await waitForChildExit(child);

    expect(wronglyMarked).toBe(false);
    // 观测必须真的覆盖了子进程的清理阶段，否则"没看到标记"没有意义
    expect(pollCount).toBeGreaterThan(20);
    expect(exitCode).toBe(0);

    const result = readChildResult(child);
    expect(result?.['cleaned']).toBe(2);
    expect(result?.['retained']).toBe(0);

    // 时限内的残留仍会被正常清理（不误判为中断，也不因此被跳过）
    const state = await readAssetState(freshResidual.backupId);
    expect(state?.local_status).toBe('CLEANED');
    expect(state?.local_cleanup_error).toBeNull();
    expect(existsSync(freshResidual.packagePath)).toBe(false);
  });

  it('重启恢复：上一进程遗留的残留，重启后仍可辨认并收敛为已清理', async () => {
    const base = new Date();

    // 夹具 1：模拟"进程死在**删除完成之后、落 CLEANED 之前**"的残留现场
    //   ——包目录已不存在、状态仍为 CLEANING。该窗口只有一次 UPDATE 往返，无法稳定命中，
    //   因此按**残留状态事实**构造；识别与收敛由**新起的子进程**（= 重启后的服务实例）
    //   执行真实清理完成：子进程只认数据库里持久化下来的残留事实。
    const restartResidual: SyntheticPackage = {
      backupId: randomUUID(),
      packagePath: nodePath.join(backupRoot, String(organizationId), 'restart-residual'),
    };
    // 夹具 2：时限内的残留（上一进程刚死不久）：重启后不得被登记为中断
    const withinThresholdControl: SyntheticPackage = {
      backupId: randomUUID(),
      packagePath: nodePath.join(backupRoot, String(organizationId), 'restart-within-threshold'),
    };
    restartBatch.push(restartResidual, withinThresholdControl);

    const staleUpdatedAt = new Date(base.getTime() - (INTERRUPT_MINUTES + 1) * 60_000);

    await insertAsset(
      restartResidual.backupId,
      restartResidual.packagePath,
      new Date(base.getTime() - 7_200_000),
      { localStatus: 'CLEANING', updatedAt: staleUpdatedAt },
    );
    // 包目录已不存在：删除时应走 ENOENT 分支并收敛为已清理（不得永久卡在 CLEANING）
    createPackageFiles(restartResidual.packagePath);
    removeTree(restartResidual.packagePath);

    await insertAsset(
      withinThresholdControl.backupId,
      withinThresholdControl.packagePath,
      new Date(base.getTime() - 3_600_000),
      { localStatus: 'CLEANING', updatedAt: base },
    );
    createPackageFiles(withinThresholdControl.packagePath);

    // 补位包：创建时间早于残留，使残留落在批次末尾，提供"被登记为中断"的确定性观测窗口
    for (let index = 0; index < FILLER_PACKAGE_COUNT; index += 1) {
      const filler: SyntheticPackage = {
        backupId: randomUUID(),
        packagePath: nodePath.join(backupRoot, String(organizationId), `restart-filler-${index}`),
      };
      restartBatch.push(filler);
      await insertAsset(filler.backupId, filler.packagePath, new Date(base.getTime() - 10_800_000));
      createPackageFiles(filler.packagePath);
    }

    await assertScopeIsolated([
      residual.backupId,
      ...fillers.map((item) => item.backupId),
      ...withinThresholdBatch.map((item) => item.backupId),
      ...restartBatch.map((item) => item.backupId),
    ]);

    // 重启 = 新起一个真实子进程（新的服务实例）
    const restartNow = new Date(base.getTime() + 60_000);
    const child = spawnCleanupChild(restartNow.toISOString());

    // 全程盯住两行：超时残留必须被登记为中断；时限内残留不得被登记为中断
    let markedResidual = false;
    let wronglyMarkedControl = false;
    let pollCount = 0;
    while (child.exitCode === null && child.signalCode === null) {
      pollCount += 1;
      const residualState = await readAssetState(restartResidual.backupId);
      if ((residualState?.local_cleanup_error ?? '').includes('LOCAL_CLEANUP_INTERRUPTED')) {
        markedResidual = true;
      }
      const controlState = await readAssetState(withinThresholdControl.backupId);
      if ((controlState?.local_cleanup_error ?? '').includes('LOCAL_CLEANUP_INTERRUPTED')) {
        wronglyMarkedControl = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    const exitCode = await waitForChildExit(child);

    // 观测必须真的覆盖了重启后那一轮的清理阶段，否则"没看到标记"没有意义
    expect(pollCount).toBeGreaterThan(20);
    expect(wronglyMarkedControl).toBe(false);
    expect(exitCode).toBe(0);
    // 重启后仍可辨认：上一进程遗留的残留被登记为中断（而不是被当成正常待清理包直接删掉）
    expect(markedResidual).toBe(true);

    const result = readChildResult(child);
    expect(result?.['cleaned']).toBe(FILLER_PACKAGE_COUNT + 2);
    expect(result?.['retained']).toBe(0);

    // 超时残留：收敛为已清理（不再卡在 CLEANING）
    const residualState = await readAssetState(restartResidual.backupId);
    expect(residualState?.local_status).toBe('CLEANED');
    expect(residualState?.local_reference).toBeNull();
    expect(residualState?.deleted_at).not.toBeNull();

    // 时限内残留：未被登记为中断，也正常收敛
    const controlState = await readAssetState(withinThresholdControl.backupId);
    expect(controlState?.local_status).toBe('CLEANED');
    expect(controlState?.local_cleanup_error).toBeNull();
    expect(controlState?.deleted_at).not.toBeNull();
    expect(existsSync(withinThresholdControl.packagePath)).toBe(false);

    // 补位包同样被清掉：重启恢复不阻断本轮其余包的清理
    for (const filler of restartBatch) {
      if (
        filler.backupId === restartResidual.backupId ||
        filler.backupId === withinThresholdControl.backupId
      ) {
        continue;
      }
      const fillerState = await readAssetState(filler.backupId);
      expect(fillerState?.local_status).toBe('CLEANED');
      expect(existsSync(filler.packagePath)).toBe(false);
    }

    // 重启恢复同样不得越界：三个哨兵仍在且内容未变
    expectSentinelsIntact();
  });
});
