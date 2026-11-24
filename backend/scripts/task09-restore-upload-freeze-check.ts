// scripts/task09-restore-upload-freeze-check.ts
/**
 * 任务 09 · 最小修复 01 的真实链反例取证：**原件上传与恢复冻结的互斥**。
 *
 * 目的：把"上传（写盘 ＋ 登记）与恢复建立冻结互斥"从**结构性推断**变成
 * **一次性隔离库 ＋ 隔离文件根**上的实测结论。
 *
 * | 用例 | 期望行为（产品口径） | 实测关注点 |
 * | --- | --- | --- |
 * | U1 冻结已生效时上传 | **被拒**：不写盘（不落字节）、不登记元数据 | 事务内守卫**先于**写盘 |
 * | U2 在途上传（持锁后暂停）时建立冻结 | 冻结**必须等待**上传事务收口 | 排他范围锁 vs 业务共享锁 |
 * | U3 写盘失败 | 事务回滚（无登记）、**锁释放**（后续上传可成功） | 失败路径不残留锁 |
 * | U5 非目标哨兵 | 其它公司数据区的冻结与文件**不变** | 范围隔离与清理纪律 |
 *
 * 断言写的是**期望行为**，不是当前行为：若实现存在缺陷，脚本会**如实失败**（exit 1）
 * 并把复现证据写进 JSON——缺陷不靠改断言掩盖。
 *
 * 失败注入说明（诚实标注）：
 * - U3 的失败是**进程内注入**（写盘实现抛错），不是实际断连；
 *   事务、范围锁、数据库与文件根都是**真实**的。
 * - "提交回执丢失（终局未知）"分支由单元测试覆盖（`upload-stored-file.usecase.spec.ts`），
 *   本脚本**未做 kill／断连**，不声称已验证该分支的实库行为。
 *
 * 纪律（与恢复链取证脚本同款）：
 * - **默认拒绝**：复用恢复自检同一套环境变量（一次性库、预期实例身份、一次性库标识、
 *   受控文件根、安装／公司标识），缺一即零写入退出；
 * - 只写**本轮创建**的对象（暂存原件与冻结事实），收尾精确回收；
 * - 非目标哨兵（外公司冻结、外公司暂存原件）逐项核对未被触碰。
 *
 * 用法：见 `.local/task09/run-restore-upload-freeze.sh` 的同款环境变量。
 */

// 脚本属**受控 wiring**（同 scripts/task09-restore-selfcheck.ts）：运行时配置只在这里读取一次。

import { Test } from '@nestjs/testing';

import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { IdentityTypeEnum } from '@app-types/models/account.types';

import { AppConfigModule } from '@src/infrastructure/config/config.module';
import { loadExplicitEnvConfig } from '@src/infrastructure/database/incremental-migration';
import { TypeOrmTransactionModule } from '@src/infrastructure/database/transaction/typeorm-transaction.module';
import { LocalReferenceDocumentStorageModule } from '@src/infrastructure/file-storage/local-reference-document-storage.module';
import { LocalStoredFileStorage } from '@src/infrastructure/file-storage/local-stored-file-storage';
import { LoggerModule } from '@src/infrastructure/logger/logger.module';
import { LocalWriteHoldService } from '@src/modules/lithography/local-write-hold.service';
import { StoredFileUsecasesModule } from '@src/usecases/stored-file/stored-file-usecases.module';
import { UploadStoredFileUsecase } from '@src/usecases/stored-file/upload-stored-file.usecase';
import {
  STORED_FILE_STORAGE,
  type StoredFileStorage,
} from '@src/usecases/common/ports/stored-file-storage.contract';
import type { UsecaseSession } from '@app-types/auth/session.types';

import {
  assertControlledFileRoot,
  assertDisposableMarker,
  assertNoForeignActiveHold,
  assertServerIdentity,
  deleteFilesByList,
  fileContentFingerprint,
  holdSentinelFingerprint,
  readSelfcheckAuthorization,
  type SentinelSnapshot,
} from './task09-restore-selfcheck.safety';
import {
  CleanupIssueLog,
  collectResidue,
  compareSentinelEntries,
  decideForensicsFileCleanup,
  planForensicsCleanupSteps,
  runAtomicForensicsCleanup,
  type ForensicsCleanupStep,
} from './task09-forensics-cleanup.safety';
import {
  createAssertionCollector,
  loadEnvFile,
  readInstallationId,
  readServerUuid,
  text,
} from './task09-script-utils';

import { makeMinimalPdf } from '../test/fixtures/stored-file-samples';

const { assertions, check } = createAssertionCollector();

/** 上传闸门：暂停/放行写盘、统计写盘次数、注入写盘失败 */
type UploadGate = {
  paused: boolean;
  saveCalls: number;
  failNextSave: boolean;
  savedReferences: string[];
};

type AppContext = {
  dataSource: DataSource;
  writeHold: LocalWriteHoldService;
  upload: UploadStoredFileUsecase;
  storageDir: string;
  gate: UploadGate;
  /** 本轮写盘产生的存储引用（收尾精确回收） */
  createdReferences: string[];
  /** 删除隔离文件根里的对象（收尾用；只删本轮引用） */
  deleteStorage: (storageReference: string) => Promise<void>;
};

function createGate(): UploadGate {
  return {
    paused: false,
    saveCalls: 0,
    failNextSave: false,
    savedReferences: [],
  };
}

/** 等待闸门放行（写盘入口处的可控屏障） */
async function waitGate(gate: UploadGate): Promise<void> {
  while (gate.paused) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
}

async function bootstrap(envFile: string, database: string): Promise<AppContext> {
  loadEnvFile(envFile);
  const config = loadExplicitEnvConfig(envFile, database);
  const gate = createGate();
  const createdReferences: string[] = [];
  let realStorage: StoredFileStorage | null = null;

  // 闸门存储：委托**真实**本地存储（真实写盘到隔离文件根），只在写盘入口加屏障与计数
  const gatedStorage: StoredFileStorage = {
    save: async (content: Buffer, fileExtension: string): Promise<string> => {
      gate.saveCalls += 1;
      await waitGate(gate);
      if (gate.failNextSave) {
        gate.failNextSave = false;
        throw new Error('注入的写盘失败');
      }
      if (realStorage === null) {
        throw new Error('真实存储未就绪');
      }
      const reference = await realStorage.save(content, fileExtension);
      gate.savedReferences.push(reference);
      createdReferences.push(reference);
      return reference;
    },
    open: (storageReference: string) => {
      if (realStorage === null) {
        throw new Error('真实存储未就绪');
      }
      return realStorage.open(storageReference);
    },
    delete: (storageReference: string) => {
      if (realStorage === null) {
        throw new Error('真实存储未就绪');
      }
      return realStorage.delete(storageReference);
    },
    verifyIntegrity: (
      storageReference: string,
      expectedChecksumSha256: string,
      expectedByteSize: number,
    ) => {
      if (realStorage === null) {
        throw new Error('真实存储未就绪');
      }
      return realStorage.verifyIntegrity(
        storageReference,
        expectedChecksumSha256,
        expectedByteSize,
      );
    },
  };

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
      LocalReferenceDocumentStorageModule,
      StoredFileUsecasesModule,
    ],
  })
    .overrideProvider(STORED_FILE_STORAGE)
    .useValue(gatedStorage)
    .compile();

  realStorage = moduleRef.get<StoredFileStorage>(LocalStoredFileStorage);

  return {
    dataSource: moduleRef.get(DataSource),
    writeHold: moduleRef.get(LocalWriteHoldService),
    upload: moduleRef.get(UploadStoredFileUsecase),
    storageDir: resolveStorageDir(moduleRef.get(ConfigService)),
    gate,
    createdReferences,
    deleteStorage: async (storageReference: string): Promise<void> => {
      if (realStorage === null) {
        return;
      }
      await realStorage.delete(storageReference);
    },
  };
}

/** 读取实际装配的业务原件存储根（与 LocalReferenceDocumentStorage 同一配置键与默认值） */
function resolveStorageDir(configService: ConfigService): string {
  const configured = configService.get<string>(
    'referenceDocumentStorage.dir',
    'var/reference-documents',
  );
  return resolve(process.cwd(), configured);
}

/** 错误对象的安全字符串化（不把对象默认成 [object Object]） */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return '未知错误';
}

/** 隔离文件根下的文件清单（用于"字节是否落盘"的判定） */
async function listStorageFiles(storageDir: string): Promise<string[]> {
  const entries = await readdir(storageDir, { recursive: true, withFileTypes: true })
    .then((items) =>
      items.filter((item) => item.isFile()).map((item) => join(item.parentPath, item.name)),
    )
    .catch(() => [] as string[]);
  return entries.sort();
}

/** 存储引用格式白名单（与真实存储实现一致：32 位 hex ＋ 1~8 位小写扩展名） */
const STORAGE_REFERENCE_PATTERN = /^[0-9a-f]{32}\.[a-z0-9]{1,8}$/u;

/**
 * 非目标哨兵快照之一：**其它公司数据区**的冻结行逐行字段指纹。
 *
 * 为什么不用"数量"：数量不变但内容被改写（状态／归属／原因被篡改）时，
 * 数量检查照样通过 ⇒ 证明不了"没碰到别人的东西"。
 */
async function snapshotForeignHoldSentinel(
  dataSource: DataSource,
  organizationId: number,
): Promise<SentinelSnapshot[]> {
  const rows: unknown = await dataSource.query(
    'SELECT hold_id, installation_id, organization_id, hold_type, status, restore_id, ' +
      'reason, created_at, released_at FROM local_write_hold WHERE organization_id <> ?',
    [organizationId],
  );
  return (rows as Array<Record<string, unknown>>).map((row) => ({
    label: `外公司冻结#${text(row['hold_id'])}`,
    fingerprint: holdSentinelFingerprint(row),
  }));
}

/**
 * 非目标哨兵快照之二：隔离文件根内**既有文件**的真实字节摘要。
 *
 * 用 `fileContentFingerprint`（SHA-256 ＋ 字节数）而不是文件大小或数量：
 * 内容被替换而大小不变时，只有字节摘要能发现。
 */
async function snapshotFileSentinel(root: string, storageDir: string): Promise<SentinelSnapshot[]> {
  const files = await listStorageFiles(storageDir);
  return files.map((file) => ({
    label: `文件#${file}`,
    fingerprint: fileContentFingerprint(root, file),
  }));
}

/** 该公司数据区当前的 ACTIVE 冻结行数 */
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

/** 暂存原件行数（按上传人过滤） */
async function stagedFileCount(dataSource: DataSource, accountId: number): Promise<number> {
  const rows: unknown = await dataSource.query(
    'SELECT COUNT(*) AS c FROM stored_file WHERE uploaded_by_account_id = ?',
    [accountId],
  );
  return Number((rows as Array<{ c: number | string }>)[0]?.c ?? 0);
}

/** 找目标公司里"只有一个 ACTIVE 成员关系"的工程师账号（可信公司归属要求唯一） */
async function resolveEngineerAccount(
  dataSource: DataSource,
  organizationId: number,
): Promise<number> {
  const rows: unknown = await dataSource.query(
    'SELECT m.account_id AS account_id FROM organization_membership m ' +
      "WHERE m.organization_id = ? AND m.status = 'ACTIVE' AND m.member_role = 'ENGINEER'",
    [organizationId],
  );
  const candidates = (rows as Array<{ account_id: number | string }>).map((row) =>
    Number(row.account_id),
  );
  for (const accountId of candidates) {
    const membershipRows: unknown = await dataSource.query(
      "SELECT COUNT(*) AS c FROM organization_membership WHERE account_id = ? AND status = 'ACTIVE'",
      [accountId],
    );
    const count = Number((membershipRows as Array<{ c: number | string }>)[0]?.c ?? 0);
    if (count === 1) {
      return accountId;
    }
  }
  throw new Error('隔离库缺少"只有一个 ACTIVE 成员关系"的工程师账号，无法取真实可信公司归属');
}

/** 构造可信会话（工程师；公司范围由服务端按成员关系复核，不接受会话自报） */
function buildSession(accountId: number): UsecaseSession {
  return {
    accountId,
    roles: [IdentityTypeEnum.ENGINEER],
    activeRole: IdentityTypeEnum.ENGINEER,
    adminLevel: null,
    customerOrganizationId: null,
  };
}

async function main(): Promise<void> {
  // eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
  const auth = readSelfcheckAuthorization(process.env);
  // 受控文件根必须真实存在且不是符号链接（删除与字节摘要都以它为边界）
  assertControlledFileRoot(auth.fileRoot);
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

  const organizationId = auth.organizationId;
  const scope = { installationId, organizationId };
  const engineerAccountId = await resolveEngineerAccount(app.dataSource, organizationId);
  const session = buildSession(engineerAccountId);
  const restoreId = `p1-upload-freeze-${Date.now()}`;

  // ── 范围预检：目标范围不得存在**非本轮**的 ACTIVE 冻结 ──────────────────
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

  // ── 哨兵快照：非目标对象不得被触碰（**逐行字段指纹 ＋ 逐文件字节摘要**）────
  const foreignHoldSentinelBefore = await snapshotForeignHoldSentinel(
    app.dataSource,
    organizationId,
  );
  const fileSentinelBefore = await snapshotFileSentinel(auth.fileRoot, app.storageDir);

  const createdHoldIds: string[] = [];
  const createdFileIds: string[] = [];
  const phase = (label: string): void => {
    process.stdout.write(`[${new Date().toISOString()}] ${label}\n`);
  };
  // 收尾问题清单（**不被吞掉**）：主因与收尾错误都会进断言 ⇒ runner 非零退出
  const issues = new CleanupIssueLog();
  let mainError: unknown = null;

  try {
    // ══ U1：冻结已生效 ⇒ 上传被拒，且**不写盘、不登记** ══════════════════════
    phase('U1 开始：冻结已生效时的上传');
    const u1Hold = await app.writeHold.hold({
      ...scope,
      restoreId: `${restoreId}-u1`,
      reason: 'P1 上传互斥取证（U1）',
    });
    createdHoldIds.push(u1Hold.holdId);
    const filesBeforeU1 = await listStorageFiles(app.storageDir);
    const stagedBeforeU1 = await stagedFileCount(app.dataSource, engineerAccountId);
    let u1Error: unknown = null;
    try {
      await app.upload.execute({
        session,
        businessType: 'MAINTENANCE_REPORT',
        file: { buffer: makeMinimalPdf(), originalFilename: 'u1-report.pdf' },
      });
    } catch (error: unknown) {
      u1Error = error;
    }
    const filesAfterU1 = await listStorageFiles(app.storageDir);
    const stagedAfterU1 = await stagedFileCount(app.dataSource, engineerAccountId);
    check(
      'U1 冻结生效期间的上传被受控拒绝',
      u1Error !== null && /冻结/.test(describeError(u1Error)),
      `上传结果 = ${u1Error === null ? '被放行（不应发生）' : `拒绝（${describeError(u1Error)}）`}`,
    );
    check(
      'U1 冻结生效期间**没有写下任何字节**（写盘未被调用）',
      app.gate.saveCalls === 0,
      `写盘调用次数 = ${app.gate.saveCalls}（期望 0）`,
    );
    check(
      'U1 冻结生效期间隔离文件根没有新增文件',
      filesAfterU1.length === filesBeforeU1.length,
      `隔离文件根文件数 = ${filesBeforeU1.length} → ${filesAfterU1.length}`,
    );
    check(
      'U1 冻结生效期间**没有登记任何元数据**',
      stagedAfterU1 === stagedBeforeU1,
      `暂存原件行数 = ${stagedBeforeU1} → ${stagedAfterU1}`,
    );
    await app.writeHold.release({ ...scope, restoreId: `${restoreId}-u1` });

    // ══ U2：在途上传（持锁后暂停）⇒ 恢复建立冻结必须等待 ════════════════════
    phase('U2 开始：在途上传持锁时恢复尝试建立冻结');
    app.gate.paused = true;
    const uploadTask = app.upload.execute({
      session,
      businessType: 'MAINTENANCE_REPORT',
      file: { buffer: makeMinimalPdf(), originalFilename: 'u2-report.pdf' },
    });
    uploadTask.catch(() => undefined);
    // 等上传真的进入写盘入口（此时事务未提交、范围共享锁仍被持有）
    let waited = 0;
    while (app.gate.saveCalls === 0 && waited < 100) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      waited += 1;
    }
    check(
      'U2 上传已进入写盘入口（持锁未提交）',
      app.gate.saveCalls === 1,
      `写盘调用次数 = ${app.gate.saveCalls}（期望 1）`,
    );
    const holdState = { settled: false };
    const holdTask = app.writeHold
      .hold({ ...scope, restoreId: `${restoreId}-u2`, reason: 'P1 上传互斥取证（U2）' })
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
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2000));
    const holdsDuringUpload = await activeHoldCount(
      app.dataSource,
      scope.installationId,
      scope.organizationId,
    );
    check(
      'U2 在途上传收口前不得建立冻结',
      holdsDuringUpload === 0,
      `上传持锁期间 ACTIVE 冻结行数 = ${holdsDuringUpload}（期望 0）`,
    );
    check(
      'U2 恢复建立冻结在上传事务收口前处于等待态',
      holdState.settled === false,
      `等待窗口结束时 hold() 是否已完成 = ${String(holdState.settled)}（期望 false）`,
    );
    // 放行上传 ⇒ 上传收口 ⇒ 冻结才被允许成立
    app.gate.paused = false;
    const uploadResult = await uploadTask;
    const u2FileId = uploadResult.fileId;
    createdFileIds.push(u2FileId);
    const holdResult = await holdTask;
    if (holdResult !== undefined && holdResult !== null) {
      createdHoldIds.push(holdResult.holdId);
    }
    const holdsAfterUpload = await activeHoldCount(
      app.dataSource,
      scope.installationId,
      scope.organizationId,
    );
    check(
      'U2 上传收口后恢复才建立冻结',
      holdsAfterUpload === 1,
      `上传收口后 ACTIVE 冻结行数 = ${holdsAfterUpload}（期望 1）`,
    );
    const u2Staged = await stagedFileCount(app.dataSource, engineerAccountId);
    check(
      'U2 上传成功：元数据已登记',
      u2Staged === stagedBeforeU1 + 1,
      `暂存原件行数 = ${stagedBeforeU1} → ${u2Staged}（期望 +1）`,
    );
    await app.writeHold.release({ ...scope, restoreId: `${restoreId}-u2` });

    // ══ U3：写盘失败 ⇒ 事务回滚、锁释放（后续上传可成功）═════════════════════
    phase('U3 开始：写盘失败（进程内注入）');
    const filesBeforeU3 = await listStorageFiles(app.storageDir);
    const stagedBeforeU3 = await stagedFileCount(app.dataSource, engineerAccountId);
    app.gate.failNextSave = true;
    let u3Error: unknown = null;
    try {
      await app.upload.execute({
        session,
        businessType: 'MAINTENANCE_REPORT',
        file: { buffer: makeMinimalPdf(), originalFilename: 'u3-report.pdf' },
      });
    } catch (error: unknown) {
      u3Error = error;
    }
    const filesAfterU3 = await listStorageFiles(app.storageDir);
    const stagedAfterU3 = await stagedFileCount(app.dataSource, engineerAccountId);
    check(
      'U3 写盘失败被受控拒绝',
      u3Error !== null,
      `上传结果 = ${u3Error === null ? '被放行（不应发生）' : '拒绝'}`,
    );
    check(
      'U3 写盘失败后没有登记元数据（事务已回滚）',
      stagedAfterU3 === stagedBeforeU3,
      `暂存原件行数 = ${stagedBeforeU3} → ${stagedAfterU3}`,
    );
    check(
      'U3 写盘失败后隔离文件根没有新增文件',
      filesAfterU3.length === filesBeforeU3.length,
      `隔离文件根文件数 = ${filesBeforeU3.length} → ${filesAfterU3.length}`,
    );
    // 锁必须已释放：后续上传可正常成功
    const u3Retry = await app.upload.execute({
      session,
      businessType: 'MAINTENANCE_REPORT',
      file: { buffer: makeMinimalPdf(), originalFilename: 'u3-retry-report.pdf' },
    });
    createdFileIds.push(u3Retry.fileId);
    check(
      'U3 写盘失败后范围锁已释放（后续上传可成功）',
      u3Retry.fileId.length > 0,
      `重试上传 fileId = ${u3Retry.fileId}`,
    );

    // ══ U5：非目标哨兵不得被触碰（**逐行字段指纹 ＋ 逐文件字节摘要**）══════
    const foreignHoldSentinelMid = await snapshotForeignHoldSentinel(
      app.dataSource,
      organizationId,
    );
    const fileSentinelMid = await snapshotFileSentinel(auth.fileRoot, app.storageDir);
    check(
      'U5 其它公司数据区的冻结行**逐行指纹**未变',
      sameSentinelsStrictly(foreignHoldSentinelBefore, foreignHoldSentinelMid),
      `外公司冻结哨兵 = ${JSON.stringify(foreignHoldSentinelBefore.map((item) => item.fingerprint))} → ${JSON.stringify(foreignHoldSentinelMid.map((item) => item.fingerprint))}`,
    );
    check(
      'U5 非目标文件**逐文件字节摘要**未变',
      sameSentinels(fileSentinelBefore, fileSentinelMid),
      `文件哨兵 = ${JSON.stringify(fileSentinelBefore.map((item) => item.fingerprint))} → ${JSON.stringify(fileSentinelMid.map((item) => item.fingerprint))}`,
    );
  } catch (error: unknown) {
    // 主因**不许被收尾吞掉**：记下来，最后统一以非零退出码回报
    mainError = error;
  } finally {
    // ── 收尾：只回收本轮创建的对象；**任何收尾问题都必须让 runner 非零退出** ──
    const cleanupOutcome = await runCleanup({
      app,
      scope,
      engineerAccountId,
      createdHoldIds,
      createdFileIds,
      fileRoot: auth.fileRoot,
      restoreId,
      issues,
    });
    const residueProblems = cleanupOutcome.residue;
    // 哨兵最终核对（收尾**之后**）：非目标对象必须原样存在
    const foreignHoldSentinelAfter = await snapshotForeignHoldSentinel(
      app.dataSource,
      organizationId,
    ).catch((error: unknown) => {
      issues.recordError('读取外公司冻结哨兵', error);
      return [] as SentinelSnapshot[];
    });
    const fileSentinelAfter = await snapshotFileSentinel(auth.fileRoot, app.storageDir).catch(
      (error: unknown) => {
        issues.recordError('读取文件哨兵', error);
        return [] as SentinelSnapshot[];
      },
    );
    check(
      '收尾后：其它公司数据区的冻结行**逐行指纹**未变',
      sameSentinelsStrictly(foreignHoldSentinelBefore, foreignHoldSentinelAfter),
      `外公司冻结哨兵 = ${JSON.stringify(foreignHoldSentinelBefore.map((item) => item.fingerprint))} → ${JSON.stringify(foreignHoldSentinelAfter.map((item) => item.fingerprint))}`,
    );
    check(
      '收尾后：非目标文件**逐文件字节摘要**未变（本轮写出的字节也必须已消失）',
      sameSentinelsStrictly(fileSentinelBefore, fileSentinelAfter),
      `文件哨兵 = ${JSON.stringify(fileSentinelBefore.map((item) => item.fingerprint))} → ${JSON.stringify(fileSentinelAfter.map((item) => item.fingerprint))}`,
    );
    check(
      '收尾：本轮零残留（无活动冻结、无暂存原件登记、无本轮写盘字节）',
      residueProblems.length === 0,
      residueProblems.length === 0 ? '本轮创建的对象已全部回收' : residueProblems.join('；'),
    );
    if (cleanupOutcome.probe !== null) {
      const probe = cleanupOutcome.probe;
      check(
        '收尾：数据库清理失败（事务回滚）⇒ 登记行与字节**都保留**，不做"行在、字节丢"的部分清理',
        probe.injectionFired && probe.rowRetained && probe.bytesRetained && probe.decisionKeptBytes,
        probe.detail,
      );
    }
    check(
      '收尾：无收尾错误（清理失败／残留／哨兵不一致一律不得静默通过）',
      issues.list.length === 0,
      issues.list.length === 0 ? '收尾无异常' : issues.list.join('；'),
    );
    check(
      '主流程：无未捕获异常',
      mainError === null,
      mainError === null ? '主流程正常结束' : describeError(mainError),
    );
  }

  await app.dataSource.destroy();

  const failed = assertions.filter((item) => !item.passed);
  process.stdout.write(`${JSON.stringify({ assertions }, null, 2)}\n`);
  if (failed.length > 0) {
    process.stderr.write(`\n❌ P1 上传×冻结互斥取证失败：${failed.length} 项断言未通过\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write('\n✅ P1 上传×冻结互斥取证通过\n');
}

/**
 * 两组哨兵比对（按**稳定标识**逐条比，不比数量）。
 *
 * `missing`／`changed` ⇒ 非目标对象被动过（一律失败）；
 * `added` ⇒ 新出现的对象：**外公司冻结**新出现是越界（失败），
 * 而**本轮自己写出的文件**在运行中出现是正常的（由"本轮零残留"单独核对）。
 */
function sameSentinels(
  before: ReadonlyArray<SentinelSnapshot>,
  after: ReadonlyArray<SentinelSnapshot>,
): boolean {
  const comparison = compareSentinelEntries(before, after);
  return comparison.missing.length === 0 && comparison.changed.length === 0;
}

/** 严格比对：连"新出现"也不允许（收尾后用于非目标范围） */
function sameSentinelsStrictly(
  before: ReadonlyArray<SentinelSnapshot>,
  after: ReadonlyArray<SentinelSnapshot>,
): boolean {
  const comparison = compareSentinelEntries(before, after);
  return (
    comparison.missing.length === 0 &&
    comparison.changed.length === 0 &&
    comparison.added.length === 0
  );
}

/**
 * 读出"数据库里仍有登记行"的存储引用。
 *
 * 用于文件清理前的裁决：**登记行还在 ⇒ 字节仍可能被引用 ⇒ 不删**。
 * 查询失败时**按"全部仍有登记行"处理**（失败关闭 ⇒ 一个字节都不删）。
 */
async function readLiveStorageReferences(
  app: AppContext,
  references: readonly string[],
): Promise<readonly string[]> {
  if (references.length === 0) {
    return [];
  }
  try {
    const rows: unknown = await app.dataSource.query(
      'SELECT storage_reference FROM stored_file WHERE storage_reference IN (?)',
      [[...references]],
    );
    return (rows as Array<Record<string, unknown>>).map((row) => String(row['storage_reference']));
  } catch {
    // 读不到登记行 ⇒ 无法证明"可以删字节" ⇒ 按全部仍有登记行处理（失败关闭）
    return [...references];
  }
}

/**
 * 失败分支自检的结果（**在真实隔离库上真跑**，不是替身）。
 *
 * 复核意见（任务 09 剩余问题 P2-1）：数据库删除失败并回滚后，
 * 脚本曾**无条件**继续删文件 ⇒ 可能留下"行在、字节丢"的部分清理。
 * 本探针用**真实事务 ＋ 真实注入**证明：回滚后登记行与字节**都保留**，
 * 且裁决在"数据库清理失败"时**保留字节**。
 */
type CleanupFailureProbe = {
  /** 登记行是否在回滚后仍在 */
  readonly rowRetained: boolean;
  /** 字节是否在回滚后仍在 */
  readonly bytesRetained: boolean;
  /** 裁决是否在"数据库清理失败"时保留字节 */
  readonly decisionKeptBytes: boolean;
  /** 注入是否真的生效（事务确实失败） */
  readonly injectionFired: boolean;
  readonly detail: string;
};

/**
 * 失败分支自检：对本轮登记的暂存原件行执行一次**注定失败**的清理事务。
 *
 * - 事务在删除之后、提交之前抛错 ⇒ **整体回滚**（真实事务，不是替身）；
 * - 随后核对：登记行仍在、字节仍在、且"数据库清理失败 ⇒ 保留字节"的裁决成立。
 * - 探针**不删除任何东西**（回滚了）；正常收尾随后照常精确回收这些对象。
 */
async function runCleanupFailureProbe(params: {
  app: AppContext;
  steps: readonly ForensicsCleanupStep[];
  createdFileIds: readonly string[];
}): Promise<CleanupFailureProbe | null> {
  const { app, steps, createdFileIds } = params;
  const storedFileSteps = steps.filter((step) => step.table === 'stored_file');
  if (storedFileSteps.length === 0) {
    // 本轮没有暂存原件行 ⇒ 没有可探针的对象（不制造假通过，直接不产出探针结论）
    return null;
  }

  // 取本轮登记的暂存原件行对应的存储引用（字节位置）
  const rows: unknown = await app.dataSource.query(
    'SELECT file_id, storage_reference FROM stored_file WHERE file_id IN (?)',
    [[...createdFileIds]],
  );
  const references = (rows as Array<Record<string, unknown>>).map((row) =>
    String(row['storage_reference']),
  );

  // 注入：删除照常执行，但**提交前抛错** ⇒ 事务整体回滚
  const probeResult = await runAtomicForensicsCleanup(storedFileSteps, {
    transaction: async <T>(
      run: (tx: {
        query: (sql: string, params?: readonly unknown[]) => Promise<unknown>;
      }) => Promise<T>,
    ): Promise<T> =>
      await app.dataSource.transaction(async (manager) => {
        await run({
          query: async (sql: string, params?: readonly unknown[]): Promise<unknown> =>
            await manager.query(sql, params as unknown[]),
        });
        throw new Error('注入的清理事务失败（提交前抛错 ⇒ 整体回滚）');
      }),
  });

  // 回滚后：登记行必须仍在
  const afterRows: unknown = await app.dataSource.query(
    'SELECT file_id FROM stored_file WHERE file_id IN (?)',
    [[...createdFileIds]],
  );
  const rowRetained = (afterRows as Array<Record<string, unknown>>).length > 0;

  // 回滚后：字节必须仍在
  const bytesRetained = references.every((reference) =>
    existsSync(join(app.storageDir, reference)),
  );

  // 裁决：数据库清理失败 ⇒ 必须保留字节
  const decision = decideForensicsFileCleanup({
    databaseCleanupOk: false,
    references,
  });
  const decisionKeptBytes = decision.deletable.length === 0 && decision.kept.length > 0;

  return {
    rowRetained,
    bytesRetained,
    decisionKeptBytes,
    injectionFired: !probeResult.ok,
    detail:
      `注入生效=${String(!probeResult.ok)} 登记行保留=${String(rowRetained)} ` +
      `字节保留=${String(bytesRetained)} 裁决保留字节=${String(decisionKeptBytes)} ` +
      `（本轮登记的暂存原件 ${String(createdFileIds.length)} 件）`,
  };
}

/**
 * 收尾：只回收**本轮创建**的对象，且**不吞掉任何异常**。
 *
 * 纪律（任务 09 剩余问题 02）：
 * 1. 先按本轮登记的真实 ID **一次性预检**（归属、外部引用）；
 * 2. 预检不通过 ⇒ **在首次删除前中止**（不删任何东西）；
 * 3. 数据库删除放在**同一个事务**里按"精确 ID ＋ 归属条件"执行 ⇒ 失败整体回滚；
 * 4. 文件只删**本轮产生**、位于**受控根**的明确引用，
 *    且**数据库清理失败或提交结果未知时一个字节都不删**（不做"行在、字节丢"的部分清理）；
 * 5. 收尾错误、残留、哨兵不一致 ⇒ 记为收尾问题 ⇒ runner **非零退出**。
 */
async function runCleanup(params: {
  app: AppContext;
  scope: { installationId: string; organizationId: number };
  engineerAccountId: number;
  createdHoldIds: readonly string[];
  createdFileIds: readonly string[];
  fileRoot: string;
  restoreId: string;
  issues: CleanupIssueLog;
}): Promise<{ residue: readonly string[]; probe: CleanupFailureProbe | null }> {
  const { app, scope, engineerAccountId, createdHoldIds, createdFileIds, fileRoot, issues } =
    params;
  const residueProblems: string[] = [];

  // ① 释放本轮建立的冻结（按**本轮登记的恢复 ID**，不碰别人的冻结）
  for (const restoreIdToRelease of [`${params.restoreId}-u1`, `${params.restoreId}-u2`]) {
    try {
      await app.writeHold.release({ ...scope, restoreId: restoreIdToRelease });
    } catch (error: unknown) {
      issues.recordError(`释放本轮冻结（${restoreIdToRelease}）`, error);
    }
  }

  // ② 删除前**一次性预检**：归属与外部引用
  const steps = await planCleanupSteps({
    app,
    scope,
    engineerAccountId,
    createdHoldIds,
    createdFileIds,
  }).catch((error: unknown) => {
    // 预检不通过 ⇒ **不进入删除路径**（保留现场，交人工判断）
    issues.recordError('删除前预检（已中止删除）', error);
    return null;
  });
  if (steps === null) {
    return { residue: residueProblems, probe: null };
  }

  // ③ 先跑**失败分支自检**（真实事务 ＋ 真实注入）：证明回滚后行与字节都保留
  const probe = await runCleanupFailureProbe({ app, steps, createdFileIds }).catch(
    (error: unknown) => {
      issues.recordError('失败分支自检', error);
      return null;
    },
  );

  // ④ 数据库删除：**同一事务**、精确 ID ＋ 归属条件；失败 ⇒ 整体回滚
  let databaseCleanupOk = true;
  if (steps.length > 0) {
    const result = await runAtomicForensicsCleanup(steps, {
      transaction: async <T>(
        run: (tx: {
          query: (sql: string, params?: readonly unknown[]) => Promise<unknown>;
        }) => Promise<T>,
      ): Promise<T> =>
        await app.dataSource.transaction(async (manager) => {
          return await run({
            query: async (sql: string, params?: readonly unknown[]): Promise<unknown> =>
              await manager.query(sql, params as unknown[]),
          });
        }),
    });
    if (!result.ok) {
      databaseCleanupOk = false;
      const where =
        result.failedStep === null
          ? '（事务本身失败）'
          : `${result.failedStep.table}#${result.failedStep.id}`;
      issues.recordError(`数据库清理（${where}）`, result.error);
    }
  }

  // ⑤ 文件清理：**先裁决能不能删字节**
  //    数据库清理失败或提交结果未知 ⇒ 登记行可能仍在 ⇒ **不删字节**；
  //    否则只删"数据库里已无登记行"的本轮引用。
  const references = [...new Set(app.gate.savedReferences)].filter((reference) => {
    if (!STORAGE_REFERENCE_PATTERN.test(reference)) {
      issues.record(`本轮写盘引用格式不合法，未删除：${reference}`);
      return false;
    }
    return true;
  });
  const liveReferences = await readLiveStorageReferences(app, references);
  const decision = decideForensicsFileCleanup({
    databaseCleanupOk,
    references,
    referencedByLiveRow: liveReferences,
  });
  if (decision.kept.length > 0) {
    issues.record(`保留本轮写盘字节（${String(decision.kept.length)} 项）：${decision.reason}`);
  }
  if (decision.deletable.length > 0) {
    try {
      const paths = decision.deletable.map((reference) => join(app.storageDir, reference));
      const deletion = deleteFilesByList(paths, fileRoot);
      for (const failure of deletion.failed) {
        issues.record(`文件删除失败：${failure.path}：${failure.reason}`);
      }
    } catch (error: unknown) {
      issues.recordError('文件清理', error);
    }
  }

  // ⑥ 残留核对：本轮对象必须**零残留**
  try {
    const leftoverHolds: unknown = await app.dataSource.query(
      'SELECT COUNT(*) AS c FROM local_write_hold ' +
        'WHERE installation_id = ? AND organization_id = ? AND status = ?',
      [scope.installationId, scope.organizationId, 'ACTIVE'],
    );
    const leftoverFiles: unknown = await app.dataSource.query(
      'SELECT COUNT(*) AS c FROM stored_file WHERE file_id IN (?)',
      [[...createdFileIds]],
    );
    const leftoverBytes = await countLeftoverBytes(app, references);
    residueProblems.push(
      ...collectResidue([
        {
          label: '本轮范围的活动冻结',
          rows: Number((leftoverHolds as Array<{ c: number }>)[0]?.c ?? 0),
        },
        {
          label: '本轮暂存原件登记',
          rows: Number((leftoverFiles as Array<{ c: number }>)[0]?.c ?? 0),
        },
        { label: '本轮写盘字节', rows: leftoverBytes },
      ]),
    );
  } catch (error: unknown) {
    issues.recordError('残留核对', error);
  }
  return { residue: residueProblems, probe };
}

/** 统计本轮写盘的字节是否仍留在磁盘上（只读核对，不做二次删除） */
async function countLeftoverBytes(app: AppContext, references: readonly string[]): Promise<number> {
  let remaining = 0;
  for (const reference of references) {
    const exists = await pathExists(join(app.storageDir, reference));
    if (exists) {
      remaining += 1;
    }
  }
  return remaining;
}

/** 路径是否存在（不跟随符号链接的判定交给受控根工具） */
async function pathExists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}

/**
 * 删除计划：先**一次性预检**归属与外部引用，再给出"精确 ID ＋ 归属条件"的删除步骤。
 *
 * 预检不通过（归属不符／已被外部引用）⇒ 抛错 ⇒ 调用方**在首次删除前中止**。
 */
async function planCleanupSteps(params: {
  app: AppContext;
  scope: { installationId: string; organizationId: number };
  engineerAccountId: number;
  createdHoldIds: readonly string[];
  createdFileIds: readonly string[];
}): Promise<readonly ForensicsCleanupStep[]> {
  const { app, scope, engineerAccountId, createdHoldIds, createdFileIds } = params;
  const steps: ForensicsCleanupStep[] = [];

  for (const holdId of createdHoldIds) {
    const rows: unknown = await app.dataSource.query(
      'SELECT hold_id, installation_id, organization_id FROM local_write_hold WHERE hold_id = ?',
      [holdId],
    );
    const row = (rows as Array<Record<string, unknown>>)[0];
    if (row === undefined) {
      continue;
    }
    if (
      text(row['installation_id']) !== scope.installationId ||
      Number(row['organization_id'] ?? 0) !== scope.organizationId
    ) {
      throw new Error(
        `冻结 ${holdId} 的归属与本轮登记不一致（安装 ${text(row['installation_id'])}／公司 ${String(row['organization_id'])}），拒绝删除`,
      );
    }
    steps.push({
      table: 'local_write_hold',
      idColumn: 'hold_id',
      id: holdId,
      ownership: `本轮创建的冻结（安装 ${scope.installationId}／公司 ${String(scope.organizationId)}）`,
      conditions: {
        installation_id: scope.installationId,
        organization_id: scope.organizationId,
      },
    });
  }

  for (const fileId of createdFileIds) {
    const rows: unknown = await app.dataSource.query(
      'SELECT file_id, uploaded_by_account_id, business_id, binding_status ' +
        'FROM stored_file WHERE file_id = ?',
      [fileId],
    );
    const row = (rows as Array<Record<string, unknown>>)[0];
    if (row === undefined) {
      continue;
    }
    if (Number(row['uploaded_by_account_id'] ?? 0) !== engineerAccountId) {
      throw new Error(`暂存原件 ${fileId} 的上传者与本轮登记不一致，拒绝删除`);
    }
    // 外部引用：已绑定业务单的原件不属于本轮可回收对象
    const businessId = row['business_id'];
    if (businessId !== null && businessId !== undefined && text(businessId) !== '') {
      throw new Error(`暂存原件 ${fileId} 已被业务单引用，拒绝删除`);
    }
    if (text(row['binding_status']) === 'BOUND') {
      throw new Error(`暂存原件 ${fileId} 处于已绑定状态，拒绝删除`);
    }
    steps.push({
      table: 'stored_file',
      idColumn: 'file_id',
      id: fileId,
      ownership: `本轮上传的暂存原件（上传者 ${String(engineerAccountId)}）`,
      conditions: { uploaded_by_account_id: engineerAccountId },
    });
  }

  return planForensicsCleanupSteps(steps);
}

main().catch((error: unknown) => {
  process.stderr.write(`\n❌ P1 上传×冻结互斥取证异常：${String(error)}\n`);
  if (error instanceof Error && typeof error.stack === 'string') {
    process.stderr.write(`${error.stack}\n`);
  }
  process.exitCode = 1;
});
