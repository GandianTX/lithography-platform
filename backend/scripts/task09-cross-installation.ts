/**
 * 任务 09 · 跨安装（双设备）真实链脚本（P5-1）。
 *
 * 目的：在**两台"设备"**上跑通记录包的完整真实链路：
 *   设备 A：建夹具（真实原件字节）→ 导出含原件的包
 *   ［把包目录复制到设备 B 可见的路径 —— 这就是 U 盘介质］
 *   设备 B：安全预检（不写库）→ 确认导入 → 逐项结果 → 读回核对（含原件字节摘要）
 *
 * 两台"设备"＝**两套环境**（各自独立的库、安装身份、文件根）：
 *   设备 A：`NODE_ENV=development` → `lithography_task09_dev` ＋ `.local/storage/lithography_task09_dev`
 *   设备 B：`NODE_ENV=e2e`        → `lithography_task09_test_e2e` ＋ `.local/storage/e2e`
 * 两库用**同一份确定性 seed**（`scripts/seed-mock.ts`，固定 id）⇒ 同公司同账号 id 空间，
 * 这正是现实中"同公司两台设备各装一套系统"的情形。
 *
 * 用法（两段执行，中间用交接文件传递事实）：
 *   NODE_ENV=development npx ts-node -r tsconfig-paths/register \
 *     scripts/task09-cross-installation.ts source
 *   # 把 A 产出的包目录复制到 B 可见的路径，再执行：
 *   NODE_ENV=e2e npx ts-node -r tsconfig-paths/register \
 *     scripts/task09-cross-installation.ts target
 *
 * 交接文件默认落在 `/tmp/task09-cross-installation.json`（**不含口令或密钥**）。
 */

// 脚本属**受控 wiring**（同 scripts/seed-mock.ts）：运行时配置只在这里读取一次。
// eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataSource } from 'typeorm';

import type { UsecaseSession } from '@app-types/auth/session.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import {
  MaintenanceReportChangeKind,
  MaintenanceReportSourceType,
  MaintenanceReportStatus,
} from '@app-types/models/maintenance-report.types';

import { TypeOrmModule } from '@nestjs/typeorm';
import { parse as parseDotenv } from 'dotenv';

import { loadExplicitEnvConfig } from '@src/infrastructure/database/incremental-migration';
import { TypeOrmTransactionModule } from '@src/infrastructure/database/transaction/typeorm-transaction.module';
import { LocalReferenceDocumentStorageModule } from '@src/infrastructure/file-storage/local-reference-document-storage.module';
import { LocalRuntimeStorageModule } from '@src/infrastructure/file-storage/local-runtime-storage.module';
import { LoggerModule } from '@src/infrastructure/logger/logger.module';
import { MaintenanceReportAttachmentEntity } from '@src/modules/lithography/entities/maintenance-report-attachment.entity';
import { MaintenanceReportEntity } from '@src/modules/lithography/entities/maintenance-report.entity';
import { MaintenanceReportVersionEntity } from '@src/modules/lithography/entities/maintenance-report-version.entity';
import { OrganizationEntity } from '@src/modules/lithography/entities/organization.entity';
import { StoredFileEntity } from '@src/modules/lithography/entities/stored-file.entity';
import { MaintenanceReportQueryService } from '@src/modules/lithography/queries/maintenance-report.query.service';
import { MaintenanceReportService } from '@src/modules/lithography/maintenance-report.service';
import { StoredFileService } from '@src/modules/lithography/stored-file.service';
import { CheckRecordPackageUsecase } from '@src/usecases/local-runtime/check-record-package.usecase';
import { ExportRecordPackageUsecase } from '@src/usecases/local-runtime/export-record-package.usecase';
import { ImportRecordPackageUsecase } from '@src/usecases/local-runtime/import-record-package.usecase';
import { LocalRuntimeUsecasesModule } from '@src/usecases/local-runtime/local-runtime-usecases.module';
import { bindStagedAttachmentToReport } from '@src/usecases/maintenance-report/maintenance-report-attachment-binding.helpers';
import { MaintenanceReportUsecasesModule } from '@src/usecases/maintenance-report/maintenance-report-usecases.module';

import {
  STORED_FILE_STORAGE,
  type StoredFileStorage,
} from '@usecases/common/ports/stored-file-storage.contract';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@usecases/common/ports/transaction-runner.contract';

// eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
const HANDOFF_FILE = process.env.TASK09_CROSS_HANDOFF ?? '/tmp/task09-cross-installation.json';
/** 设备 env 文件与目标库（两台"设备"各一组；可用环境变量覆盖） */
// eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
const DEVICE_ENV_FILE = process.env.TASK09_CROSS_ENV_FILE ?? 'env/.env.development';
// eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
const DEVICE_DATABASE = process.env.TASK09_CROSS_DATABASE ?? 'lithography_task09_dev';

/** 目标公司（seed 的确定性组织编码）与工程师账号（确定性 id） */
const TARGET_ORGANIZATION_CODE = 'CLIENT_DEFAULT';
const ENGINEER_ACCOUNT_ID = 900_101;
const ENGINEER_NAME = '陈工';

/** 真实原件字节（PDF 头 + 随机正文）：跨安装后必须逐字节一致 */
function buildOriginalBytes(): Buffer {
  const head = Buffer.from('%PDF-1.7\n% task09 cross-installation original\n', 'utf8');
  return Buffer.concat([head, randomBytes(512)]);
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

type DeviceContext = {
  dataSource: DataSource;
  exportUsecase: ExportRecordPackageUsecase;
  checkUsecase: CheckRecordPackageUsecase;
  importUsecase: ImportRecordPackageUsecase;
  maintenanceReportService: MaintenanceReportService;
  maintenanceReportQueryService: MaintenanceReportQueryService;
  storedFileService: StoredFileService;
  storage: StoredFileStorage;
  transactionRunner: TransactionRunner;
};

/** 装配当前设备（按 NODE_ENV 取对应库／文件根／安装身份） */
async function bootstrap(): Promise<DeviceContext> {
  // 设备 env 文件装载到 process.env：存储根、字段加密等运行时配置都从这里读
  const envContent = readFileSync(DEVICE_ENV_FILE, 'utf8');
  const parsed: Record<string, string> = parseDotenv(envContent);
  for (const [key, value] of Object.entries(parsed)) {
    // eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
    process.env[key] = value;
  }
  // 同一公司的两台设备**共享同一组字段加密密钥**（现实中由公司配置下发）；
  // 本机两套 env 是各自独立的测试配置，跨安装验证时必须显式对齐，
  // 否则目标机无法解密来源机的加密列（payload_snapshot 等）。
  // eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
  const fieldKey = process.env.TASK09_CROSS_FIELD_KEY;
  // eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
  const fieldIv = process.env.TASK09_CROSS_FIELD_IV;
  if (fieldKey !== undefined) {
    // eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
    process.env.FIELD_ENCRYPTION_KEY = fieldKey;
  }
  if (fieldIv !== undefined) {
    // eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
    process.env.FIELD_ENCRYPTION_IV = fieldIv;
  }

  // 目标库必须与 env 文件声明一致（复用迁移入口的同一套校验，不猜库名）
  const config = loadExplicitEnvConfig(DEVICE_ENV_FILE, DEVICE_DATABASE);

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
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
      LocalRuntimeStorageModule,
      LocalRuntimeUsecasesModule,
      MaintenanceReportUsecasesModule,
    ],
  }).compile();

  return {
    dataSource: moduleRef.get(DataSource),
    exportUsecase: moduleRef.get(ExportRecordPackageUsecase),
    checkUsecase: moduleRef.get(CheckRecordPackageUsecase),
    importUsecase: moduleRef.get(ImportRecordPackageUsecase),
    maintenanceReportService: moduleRef.get(MaintenanceReportService),
    maintenanceReportQueryService: moduleRef.get(MaintenanceReportQueryService),
    storedFileService: moduleRef.get(StoredFileService),
    storage: moduleRef.get<StoredFileStorage>(STORED_FILE_STORAGE),
    transactionRunner: moduleRef.get<TransactionRunner>(TRANSACTION_RUNNER),
  };
}

/**
 * 构造可信会话（工程师；公司范围由来源域按成员关系裁决）。
 *
 * 字段与 `mapJwtToUsecaseSession` 的产物一致：`roles` ＋ `activeRole` 决定身份，
 * `adminLevel` 为 null（非管理员）。公司范围**不**由会话自报，
 * 由查看者范围策略按本机成员关系复核。
 */
function buildSession(): UsecaseSession {
  return {
    accountId: ENGINEER_ACCOUNT_ID,
    roles: [IdentityTypeEnum.ENGINEER],
    activeRole: IdentityTypeEnum.ENGINEER,
    adminLevel: null,
    customerOrganizationId: null,
  };
}

/** 按确定性组织编码读取目标公司 id（**不猜 id**；两库各自查自己的真实行） */
async function resolveTargetOrganizationId(device: DeviceContext): Promise<number> {
  const organization = await device.dataSource
    .getRepository(OrganizationEntity)
    .findOne({ where: { organizationCode: TARGET_ORGANIZATION_CODE } });
  if (organization === null) {
    throw new Error(
      `本机缺少组织编码 ${TARGET_ORGANIZATION_CODE}（请先在本机库执行 seed:mock 以建立同构夹具）`,
    );
  }
  return organization.id;
}

/** 设备 A：建夹具（报告 ＋ 真实原件）→ 导出含原件的记录包 */
async function runSourceRole(device: DeviceContext): Promise<void> {
  const organizationId = await resolveTargetOrganizationId(device);
  const session = buildSession();
  const originalBytes = buildOriginalBytes();
  const originalChecksum = sha256(originalBytes);
  const exportRoot = join('/tmp', 'task09-cross-export');
  mkdirSync(exportRoot, { recursive: true });
  const targetPath = join(exportRoot, `package-${Date.now()}`);

  // 1) 真实原件：写入本机存储根 → 登记任务 11 暂存行
  const storageReference = await device.storage.save(originalBytes, 'pdf');
  const fileId = randomUUID();
  const uploadContextId = randomUUID();
  await device.storedFileService.insertStagedFile({
    fileId,
    uploadedByAccountId: ENGINEER_ACCOUNT_ID,
    ownerOrganizationId: organizationId,
    storageReference,
    originalFilename: 'cross-installation-original.pdf',
    mimeType: 'application/pdf',
    byteSize: originalBytes.byteLength,
    checksumSha256: originalChecksum,
    businessType: 'MAINTENANCE_REPORT',
    uploadContextId,
  });

  // 2) 报告夹具：报告根 ＋ 冻结版本行 ＋ 绑定真实原件（与导入写入同一代码路径）
  const recordUuid = randomUUID();
  const payload = {
    sourceType: MaintenanceReportSourceType.HISTORICAL_CASE,
    repairRequestId: null,
    title: '跨安装真实链验证报告',
    customerFactoryName: '某客户工厂',
    equipmentModelId: null,
    equipmentModelText: '某机型',
    maintenanceDate: '2026-11-23',
    maintenanceEngineerAccountId: ENGINEER_ACCOUNT_ID,
    maintenanceEngineerName: ENGINEER_NAME,
    phaseFlowVersion: 1,
    alarms: [],
    steps: [],
    faults: [],
  };
  const { reportId } = await device.transactionRunner.run(async (transactionContext) => {
    const report = await device.maintenanceReportService.insertReport(
      {
        ownerOrganizationId: organizationId,
        sourceType: MaintenanceReportSourceType.HISTORICAL_CASE,
        repairRequestId: null,
        title: '跨安装真实链验证报告',
        customerFactoryName: '某客户工厂',
        equipmentModelId: null,
        equipmentModelText: '某机型',
        maintenanceDate: '2026-11-23',
        maintenanceEngineerAccountId: ENGINEER_ACCOUNT_ID,
        maintenanceEngineerNameSnapshot: ENGINEER_NAME,
        phaseFlowVersion: 1,
        createdByAccountId: ENGINEER_ACCOUNT_ID,
        updatedByAccountId: ENGINEER_ACCOUNT_ID,
        recordUuid,
        status: MaintenanceReportStatus.SUBMITTED,
        currentVersionNo: 1,
        lastSubmittedAt: new Date('2026-11-23T00:00:00.000Z'),
      },
      transactionContext,
    );
    await device.maintenanceReportService.insertVersion(
      {
        reportId: report.id,
        versionNo: 1,
        changeKind: MaintenanceReportChangeKind.SUBMIT,
        changeReason: '跨安装真实链夹具',
        payloadSnapshot: payload,
        submittedByAccountId: ENGINEER_ACCOUNT_ID,
        submittedAt: new Date('2026-11-23T00:00:00.000Z'),
      },
      transactionContext,
    );
    await bindStagedAttachmentToReport({
      storedFileService: device.storedFileService,
      maintenanceReportService: device.maintenanceReportService,
      maintenanceReportQueryService: device.maintenanceReportQueryService,
      reportId: report.id,
      ownerOrganizationId: organizationId,
      accountId: ENGINEER_ACCOUNT_ID,
      attachment: { fileId, uploadContextId, description: '跨安装真实链原件' },
      transactionContext,
    });
    return { reportId: report.id };
  });

  // 3) 导出（含真实原件字节）
  const exported = await device.exportUsecase.execute({
    session,
    targetPath,
    resourceType: 'MAINTENANCE_REPORT',
    recordIds: [reportId],
  });

  const handoff = {
    packageId: exported.packageId,
    packagePath: exported.packagePath,
    manifestChecksum: exported.manifestChecksum,
    recordUuid,
    reportId,
    organizationId,
    originalChecksum,
    originalByteSize: originalBytes.byteLength,
    itemTotal: exported.itemTotal,
    itemExported: exported.itemExported,
    items: exported.items.map((item) => ({
      recordId: item.recordId,
      outcome: item.outcome,
      message: item.message,
    })),
  };
  writeFileSync(HANDOFF_FILE, JSON.stringify(handoff, null, 2), 'utf8');
  process.stdout.write(`[source] 交接事实已写入 ${HANDOFF_FILE}\n`);
  process.stdout.write(`${JSON.stringify(handoff, null, 2)}\n`);
}

/** 读取存储对象字节（跨安装后必须与源机逐字节一致） */
async function readStorageBytes(
  storage: StoredFileStorage,
  storageReference: string,
): Promise<Buffer | null> {
  try {
    const stream = await storage.open(storageReference);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    }
    return Buffer.concat(chunks);
  } catch {
    return null;
  }
}

/** 设备 B：检查（预检不写库）→ 确认导入 → 逐项结果 → 读回核对（含原件字节） */
async function runTargetRole(device: DeviceContext): Promise<void> {
  if (!existsSync(HANDOFF_FILE)) {
    throw new Error(`缺少交接文件 ${HANDOFF_FILE}（请先在设备 A 执行 source 角色）`);
  }
  const handoff = JSON.parse(readFileSync(HANDOFF_FILE, 'utf8')) as {
    packageId: string;
    packagePath: string;
    manifestChecksum: string;
    recordUuid: string;
    reportId: number;
    organizationId: number;
    originalChecksum: string;
    originalByteSize: number;
  };
  const session = buildSession();

  // 1) 检查：只落检查事实，不写正式业务
  const checked = await device.checkUsecase.execute({
    session,
    packagePath: handoff.packagePath,
  });
  const checkItems = checked.items.map((item) => ({
    recordUuid: item.recordUuid,
    checkResult: item.checkResult,
    errorMessage: item.errorMessage,
  }));

  // 2) 确认导入：逐项结果
  const imported = await device.importUsecase.execute({
    session,
    packageId: checked.import.packageId,
    packagePath: handoff.packagePath,
    manifestChecksum: checked.import.manifestChecksum,
  });
  const importItems = imported.items.map((item) => ({
    recordUuid: item.recordUuid,
    result: item.result,
    errorMessage: item.errorMessage,
  }));

  // 3) 读回核对：作者、公司、UUID、版本、状态、正文、原件字节
  const reportRepository = device.dataSource.getRepository(MaintenanceReportEntity);
  const versionRepository = device.dataSource.getRepository(MaintenanceReportVersionEntity);
  const attachmentRepository = device.dataSource.getRepository(MaintenanceReportAttachmentEntity);
  const storedFileRepository = device.dataSource.getRepository(StoredFileEntity);

  const report = await reportRepository.findOne({
    where: { recordUuid: handoff.recordUuid },
  });
  const versionRows =
    report === null
      ? []
      : await versionRepository.find({
          where: { reportId: report.id },
          order: { versionNo: 'ASC' },
        });
  const attachmentRows =
    report === null
      ? []
      : await attachmentRepository.find({
          where: { reportId: report.id, status: 'CURRENT' },
        });
  const attachmentFileId = attachmentRows[0]?.fileId ?? null;
  const storedFile =
    attachmentFileId === null
      ? null
      : await storedFileRepository.findOne({ where: { fileId: attachmentFileId } });
  const originalBytes =
    storedFile === null
      ? null
      : await readStorageBytes(device.storage, storedFile.storageReference);
  const originalChecksum = originalBytes === null ? null : sha256(originalBytes);
  const payloadTitle =
    versionRows[0] === undefined
      ? null
      : (((versionRows[0].payloadSnapshot ?? null) as unknown as { title?: string } | null)
          ?.title ?? null);

  const assertions = {
    imported: importItems.length > 0 && importItems.every((item) => item.result === 'SUCCEEDED'),
    recordUuidPreserved: report !== null && report.recordUuid === handoff.recordUuid,
    authorPreserved:
      report !== null &&
      report.createdByAccountId === ENGINEER_ACCOUNT_ID &&
      report.maintenanceEngineerAccountId === ENGINEER_ACCOUNT_ID,
    companyPreserved: report !== null && report.ownerOrganizationId === handoff.organizationId,
    versionPreserved: report !== null && report.currentVersionNo === 1,
    statusPreserved: report !== null && report.status === String(MaintenanceReportStatus.SUBMITTED),
    payloadPreserved: payloadTitle === '跨安装真实链验证报告',
    attachmentBound: attachmentRows.length === 1,
    originalBytesIdentical:
      originalChecksum !== null && originalChecksum === handoff.originalChecksum,
    originalByteSizeMatch:
      originalBytes !== null && originalBytes.byteLength === handoff.originalByteSize,
  };
  const passed = Object.values(assertions).every((value) => value);

  const verdict = {
    packageId: handoff.packageId,
    checkItems,
    importItems,
    importedReport:
      report === null
        ? null
        : {
            recordUuid: report.recordUuid,
            ownerOrganizationId: report.ownerOrganizationId,
            createdByAccountId: report.createdByAccountId,
            maintenanceEngineerAccountId: report.maintenanceEngineerAccountId,
            currentVersionNo: report.currentVersionNo,
            status: report.status,
          },
    versionCount: versionRows.length,
    payloadTitle,
    attachmentCount: attachmentRows.length,
    originalChecksum,
    originalByteSize: originalBytes?.byteLength ?? null,
    assertions,
    passed,
  };

  writeFileSync(HANDOFF_FILE, JSON.stringify({ ...handoff, verdict }, null, 2), 'utf8');
  process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
  if (!passed) {
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const role = process.argv[2];
  const device = await bootstrap();
  if (role === 'source') {
    await runSourceRole(device);
    return;
  }
  if (role === 'target') {
    await runTargetRole(device);
    return;
  }
  throw new Error('用法：task09-cross-installation.ts <source|target>');
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n${
      error instanceof Error && error.stack !== undefined ? error.stack : ''
    }\n`,
  );
  process.exitCode = 1;
});
