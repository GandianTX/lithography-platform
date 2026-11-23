/* eslint-disable @typescript-eslint/naming-convention -- HTTP 头名必须原样小写连字符，改名会破坏协议 */

/**
 * 任务 09 · 云备份真实链脚本（受控云替身）（S3／S4 验收）。
 *
 * 目的：在**缺生产云地址与凭据**的现实条件下（任务书允许"真实联调标未验证并记录提供方"），
 * 用一个**受控云替身**（本机真实 HTTP 服务）跑通"生成 → 上云 → 清理 → 云端清单 → 云端下载"
 * 的**真实链路**：真实 multipart 上传、真实 HTTP 响应、真实回执落库、真实本机包删除。
 *
 * 与"替身掩盖缺陷"的区别：
 * - 替身只负责**扮演云端协议对端**（收包、给回执、列包、给字节）；
 *   链路的其余部分（本机生成包、保护封包、凭据与用途判定、失败关闭、清理授权、
 *   本机包删除、云端清单与下载编排）全部走**生产代码路径**；
 * - 替身可切换故障模式（5xx／缺回执／凭据不符），用于验证**失败关闭**而非成功路径；
 * - 断言全部落在**真实副作用**上（DB 行状态、本机目录是否存在、云端收到的字节）。
 *
 * 用法（隔离库；两段不需要，本机单进程）：
 *   TASK09_CLOUD_ENV_FILE=env/.env.development \
 *   TASK09_CLOUD_DATABASE=lithography_task09_dev \
 *   npx ts-node -r tsconfig-paths/register scripts/task09-cloud-real-chain.ts
 */

// 脚本属**受控 wiring**（同 scripts/seed-mock.ts）：运行时配置只在这里读取一次。

import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { UsecaseSession } from '@app-types/auth/session.types';

import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { parse as parseDotenv } from 'dotenv';

import { AppConfigModule } from '@src/infrastructure/config/config.module';
import { loadExplicitEnvConfig } from '@src/infrastructure/database/incremental-migration';
import { LocalRuntimeStorageModule } from '@src/infrastructure/file-storage/local-runtime-storage.module';
import { LithographyModule } from '@src/modules/lithography/lithography.module';
import { LocalBackupCloudModule } from '@src/infrastructure/cloud/local-backup-cloud.module';
import { LoggerModule } from '@src/infrastructure/logger/logger.module';
import { LocalBackupUploadService } from '@src/modules/lithography/local-backup-upload.service';
import { BackupAssetEntity } from '@src/modules/lithography/entities/backup-asset.entity';
import { LocalCompanySettingEntity } from '@src/modules/lithography/entities/local-company-setting.entity';
import { LocalAccountAuthorizationEntity } from '@src/modules/lithography/entities/local-account-authorization.entity';
import { LocalInstallationEntity } from '@src/modules/lithography/entities/local-installation.entity';
import { LocalBackupRunEntity } from '@src/modules/lithography/entities/local-backup-run.entity';
import { TypeOrmTransactionModule } from '@src/infrastructure/database/transaction/typeorm-transaction.module';
import { CleanupLocalBackupPackagesUsecase } from '@src/usecases/local-runtime/cleanup-local-backup-packages.usecase';
import {
  DownloadLocalBackupCloudPackageUsecase,
  ListLocalBackupCloudPackagesUsecase,
} from '@src/usecases/local-runtime/local-backup-cloud-packages.usecase';
import { LocalRuntimeUsecasesModule } from '@src/usecases/local-runtime/local-runtime-usecases.module';
import { StartManualLocalBackupUsecase } from '@src/usecases/local-runtime/start-manual-local-backup.usecase';

/** 设备 env 文件与隔离库（必须是可丢弃的 task09 隔离库） */
// eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
const DEVICE_ENV_FILE = process.env.TASK09_CLOUD_ENV_FILE ?? 'env/.env.development';
// eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
const DEVICE_DATABASE = process.env.TASK09_CLOUD_DATABASE ?? 'lithography_task09_dev';

/** 目标公司与账号（seed 的确定性事实：CLIENT_DEFAULT / 工程师 900101） */
const TARGET_ORGANIZATION_ID = 1;
const ENGINEER_ACCOUNT_ID = 900_101;

/** 替身认可的凭据与用途（用途必须与生产常量一致，否则应被拒绝） */
const CLOUD_CREDENTIAL = 'task09-controlled-cloud-credential';
const CLOUD_PURPOSE = 'CLOUD_BACKUP';

/** 故障模式 */
type CloudMode = 'normal' | 'server-error' | 'missing-receipt' | 'unauthorized';

type CloudPackageRecord = {
  packageId: string;
  organizationId: number;
  byteSize: number;
  checksumSha256: string;
  createdAt: string;
  content: Buffer;
};

type MultipartPart = { name: string; filename?: string; data: Buffer };

/** 极简 multipart 解析：只取本链需要的字段与字节，不做通用解析器 */
function parseMultipart(body: Buffer, contentType: string): MultipartPart[] {
  const matched = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (matched === null) {
    return [];
  }
  const boundary = matched[1] ?? matched[2] ?? '';
  const delimiter = Buffer.from(`--${boundary}`);
  const parts: MultipartPart[] = [];
  let index = body.indexOf(delimiter);
  while (index !== -1) {
    let cursor = index + delimiter.length;
    if (body[cursor] === 0x2d && body[cursor + 1] === 0x2d) {
      break; // 结束分隔符
    }
    while (body[cursor] === 0x0d || body[cursor] === 0x0a) {
      cursor += 1;
    }
    const headerEnd = body.indexOf('\r\n\r\n', cursor);
    if (headerEnd === -1) {
      break;
    }
    const rawHeaders = body.subarray(cursor, headerEnd).toString('utf8');
    const next = body.indexOf(delimiter, headerEnd);
    if (next === -1) {
      break;
    }
    const nameMatch = /name="([^"]*)"/i.exec(rawHeaders);
    const filenameMatch = /filename="([^"]*)"/i.exec(rawHeaders);
    if (nameMatch !== null) {
      parts.push({
        name: nameMatch[1] ?? '',
        filename: filenameMatch?.[1],
        data: body.subarray(headerEnd + 4, next - 2),
      });
    }
    index = next;
  }
  return parts;
}

/**
 * 受控云替身：**真实的本机 HTTP 服务**，按生产协议扮演云端。
 *
 * 它不是"测试替身对象"，而是"云端对端"：本仓代码通过真实 socket 与它交互，
 * 因此鉴权头、用途头、multipart 形态、状态码语义都被真实校验。
 */
class ControlledCloud {
  mode: CloudMode = 'normal';
  readonly packages = new Map<string, CloudPackageRecord>();
  readonly receivedRequests: Array<{ method: string; path: string }> = [];
  private readonly server: Server;

  constructor(private credential: string) {
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        resolve();
      });
    });
    const address = this.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('受控云替身未能取得监听端口');
    }
    return `http://127.0.0.1:${address.port}`;
  }

  /** 切换替身认可的凭据（用于"凭据不符"负例：本机仍发原凭据，云端拒绝） */
  setCredential(credential: string): void {
    this.credential = credential;
  }

  /** 调试用：拼出内容下载路径 */
  baseUrlFor(packageId: string): string {
    const address = this.server.address();
    const port = address === null || typeof address === 'string' ? 0 : address.port;
    return `http://127.0.0.1:${port}/backup-packages/${encodeURIComponent(packageId)}/content`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
  }

  /** 收到的请求体大小（用于断言"确实把字节发上了云"） */
  lastUploadByteSize = 0;
  lastUploadFilePartCount = 0;

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    this.receivedRequests.push({ method: request.method ?? 'GET', path: url.pathname });
    const body = await readRequestBody(request);

    // 鉴权：凭据与用途都必须正确（与生产约定一致）
    const authorization = request.headers.authorization ?? '';
    const purpose = request.headers['x-cloud-purpose'] ?? '';
    if (authorization !== `Bearer ${this.credential}` || purpose !== CLOUD_PURPOSE) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    if (this.mode === 'unauthorized') {
      response.writeHead(403, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'forbidden' }));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/backup-packages') {
      this.handleUpload(body, request.headers['content-type'] ?? '', response);
      return;
    }

    if (request.method === 'GET' && url.pathname === '/backup-packages') {
      this.handleList(url.searchParams.get('organizationId'), response);
      return;
    }

    const contentMatch = /^\/backup-packages\/([^/]+)\/content$/u.exec(url.pathname);
    if (request.method === 'GET' && contentMatch !== null) {
      this.handleContent(decodeURIComponent(contentMatch[1] ?? ''), response);
      return;
    }

    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not_found' }));
  }

  private handleUpload(body: Buffer, contentType: string, response: ServerResponse): void {
    if (this.mode === 'server-error') {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'internal' }));
      return;
    }
    const parts = parseMultipart(body, contentType);
    const field = (name: string): string => {
      const found = parts.find((part) => part.name === name);
      return found === undefined ? '' : found.data.toString('utf8');
    };
    const packageId = field('backupId');
    const organizationId = Number(field('organizationId'));
    const byteSize = Number(field('byteSize'));
    const manifestChecksum = field('manifestChecksum');
    const payloadPart = parts.find((part) => part.name === 'payload');
    const fileParts = parts.filter((part) => part.name.startsWith('files/'));

    this.lastUploadByteSize = body.length;
    this.lastUploadFilePartCount = fileParts.length;

    if (
      packageId.length === 0 ||
      !Number.isInteger(organizationId) ||
      payloadPart === undefined ||
      manifestChecksum.length === 0
    ) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'bad_request' }));
      return;
    }

    const content = Buffer.concat(parts.map((part) => part.data));
    this.packages.set(packageId, {
      packageId,
      organizationId,
      byteSize,
      checksumSha256: createHash('sha256').update(content).digest('hex'),
      createdAt: new Date().toISOString(),
      content,
    });

    if (this.mode === 'missing-receipt') {
      // 形态非法：只给引用、不给完整回执 —— 本机侧必须按失败处理（不得当成成功）
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ cloudReference: `cloud://${packageId}` }));
      return;
    }
    // 回执必须是**可解析为 JSON 且带明确成功语义**的字符串（与生产判定同口径）：
    // 非 JSON 或无成功语义的回执会被本机判为"回执不完整"⇒ 零清理。
    const receipt = JSON.stringify({
      received: true,
      status: 'SUCCEEDED',
      packageId,
      byteSize,
      manifestChecksum,
    });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        cloudReference: `cloud://${packageId}`,
        receipt,
      }),
    );
  }

  private handleList(organizationId: string | null, response: ServerResponse): void {
    const target = Number(organizationId);
    const packages = [...this.packages.values()]
      .filter((item) => item.organizationId === target)
      .map((item) => ({
        packageId: item.packageId,
        organizationId: item.organizationId,
        backupId: item.packageId,
        createdAt: item.createdAt,
        byteSize: item.byteSize,
        checksumSha256: item.checksumSha256,
      }));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ packages }));
  }

  private handleContent(packageId: string, response: ServerResponse): void {
    const found = this.packages.get(packageId);
    if (found === undefined) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    response.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(found.content.length),
    });
    response.end(found.content);
  }
}

/** 读取请求体 */
function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    request.on('error', reject);
  });
}

type ChainContext = {
  dataSource: import('typeorm').DataSource;
  startManualBackup: StartManualLocalBackupUsecase;
  cleanupPackages: CleanupLocalBackupPackagesUsecase;
  listCloudPackages: ListLocalBackupCloudPackagesUsecase;
  downloadCloudPackage: DownloadLocalBackupCloudPackageUsecase;
  uploadService: LocalBackupUploadService;
};

/** 装配本机（隔离库 ＋ 本机文件根 ＋ 云替身地址） */
async function bootstrap(cloudBaseUrl: string): Promise<ChainContext> {
  // 设备 env 文件装载到 process.env：存储根、字段加密等运行时配置都从这里读
  const envContent = readFileSync(DEVICE_ENV_FILE, 'utf8');
  const parsed: Record<string, string> = parseDotenv(envContent);
  for (const [key, value] of Object.entries(parsed)) {
    // eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
    process.env[key] = value;
  }
  // 受保护封包密钥：本机 env 里的占位值不是合法 AES-256 密钥，
  // 脚本改用**固定的测试密钥**（仅用于隔离库的本地包封包，不进任何回执或日志）。
  // eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
  process.env.LOCAL_BACKUP_PROTECTION_KEY =
    '9f2c7a1d4e6b8035c7d9e1f4a2b6c8d0e3f5a7b9c1d3e5f7a9b1c3d5e7f9a1b3';
  // 云替身地址与凭据：**通过正式环境变量注入**（不绕过配置层）
  // eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
  process.env.LOCAL_BACKUP_CLOUD_BASE_URL = cloudBaseUrl;
  // eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
  process.env.LOCAL_BACKUP_CLOUD_CREDENTIAL = CLOUD_CREDENTIAL;

  const config = loadExplicitEnvConfig(DEVICE_ENV_FILE, DEVICE_DATABASE);

  process.stderr.write('[cloud] 装配中…\n');
  const moduleRef = await Test.createTestingModule({
    imports: [
      // 应用配置模块（与生产同一条装配：命名空间 ＋ 环境变量口径一致）
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
      TypeOrmModule.forFeature([
        BackupAssetEntity,
        LocalCompanySettingEntity,
        LocalAccountAuthorizationEntity,
      ]),
      TypeOrmTransactionModule,
      LocalRuntimeStorageModule,
      LithographyModule,
      // 云端口必须**直接**导入：上传服务注册在根测试模块，
      // 只有根作用域能注入 LOCAL_BACKUP_UPLOADER
      LocalBackupCloudModule,
      LocalRuntimeUsecasesModule,
    ],
    providers: [LocalBackupUploadService],
  }).compile();

  process.stderr.write('[cloud] 装配完成\n');
  return {
    dataSource: moduleRef.get(DataSource),
    startManualBackup: moduleRef.get(StartManualLocalBackupUsecase),
    cleanupPackages: moduleRef.get(CleanupLocalBackupPackagesUsecase),
    listCloudPackages: moduleRef.get(ListLocalBackupCloudPackagesUsecase),
    downloadCloudPackage: moduleRef.get(DownloadLocalBackupCloudPackageUsecase),
    uploadService: moduleRef.get(LocalBackupUploadService),
  };
}

/** 可信会话：工程师（本公司数据区由成员关系裁决） */
function buildSession(): UsecaseSession {
  return {
    accountId: ENGINEER_ACCOUNT_ID,
    roles: ['ENGINEER'],
    activeRole: 'ENGINEER',
    adminLevel: null,
    organizationId: TARGET_ORGANIZATION_ID,
  } as unknown as UsecaseSession;
}

/**
 * 残留运行补偿（与生产同口径：`BackupScheduleService.compensateInterruptedRuns`）。
 *
 * 事实：同一安装同时只允许一个 RUNNING 备份运行；上一轮中断留下的 RUNNING 行
 * 会挡住本轮的全部新运行。生产侧由 72h 计划扫描在**超过补偿时限（60 分钟）**后
 * 改判 INTERRUPTED；本脚本在开跑前按同一口径改判**本机安装**的残留行，
 * 只动「RUNNING 且超过补偿时限」的行，不碰任何已结束行与其他安装的行。
 */
async function compensateStaleRuns(
  dataSource: import('typeorm').DataSource,
  installationId: string,
  now: Date,
): Promise<number> {
  const cutoff = new Date(now.getTime() - 60 * 60_000);
  const stale = await dataSource
    .getRepository(LocalBackupRunEntity)
    .find({ where: { installationId, status: 'RUNNING' } });
  let compensated = 0;
  for (const run of stale) {
    if (run.startedAt.getTime() > cutoff.getTime()) {
      continue; // 仍在补偿时限内：可能是正在执行的备份，不动
    }
    await dataSource.getRepository(LocalBackupRunEntity).update(
      { id: run.id },
      {
        status: 'INTERRUPTED',
        finishedAt: now,
        errorCode: 'BACKUP_INTERRUPTED_BY_RESTART',
        errorMessage: '进程重启导致备份运行中断，计划将补一次',
      },
    );
    compensated += 1;
  }
  return compensated;
}

/**
 * 夹具：本公司设置（两个开关打开）＋ **云备份用途**的有效授权。
 *
 * 纪律：写入的是**可丢弃的隔离库**；行按 (installation, org) 唯一，可重复执行且不重复堆积；
 * 结束时按登记的主键精确删除（只删本轮自己写的行）。
 */
async function ensureFixtures(dataSource: import('typeorm').DataSource): Promise<{
  settingId: string;
  authorizationId: string;
  installationId: string;
}> {
  const installation = await dataSource
    .getRepository(LocalInstallationEntity)
    .findOne({ where: {} });
  if (installation === null) {
    throw new Error('隔离库缺少本机安装身份，无法执行云真实链');
  }

  const settingRepository = dataSource.getRepository(LocalCompanySettingEntity);
  let setting = await settingRepository.findOne({
    where: {
      installationId: installation.installationId,
      organizationId: TARGET_ORGANIZATION_ID,
    },
  });
  if (setting === null) {
    setting = await settingRepository.save(
      settingRepository.create({
        installationId: installation.installationId,
        organizationId: TARGET_ORGANIZATION_ID,
        settingSource: 'LOCAL_MANUAL',
        isCurrent: true,
        initializedAt: new Date(),
        backupIntervalHours: 72,
        backupEnabled: true,
        // 备份开启 ⇒ 必须给出下次计划时间（库级 CHECK 约束要求）
        nextBackupAt: new Date(Date.now() + 72 * 3600_000),
        lastAutoSuccessAt: null,
        lastAutoFailureAt: null,
        failureReason: null,
        autoUploadEnabled: true,
      }),
    );
  } else {
    await settingRepository.update(
      { id: setting.id },
      { backupEnabled: true, autoUploadEnabled: true },
    );
  }

  const authorizationRepository = dataSource.getRepository(LocalAccountAuthorizationEntity);
  let authorization = await authorizationRepository.findOne({
    where: {
      installationId: installation.installationId,
      accountId: ENGINEER_ACCOUNT_ID,
      organizationId: TARGET_ORGANIZATION_ID,
    },
  });
  // 与生产写入形态一致：签名声明是**对象**（`validateAuthorizationRenewalInput` 要求对象）
  const signedClaims = {
    purpose: ['CLOUD_BACKUP'],
    issuer: 'task09-controlled-cloud',
    subject: String(ENGINEER_ACCOUNT_ID),
  };
  if (authorization === null) {
    authorization = await authorizationRepository.save(
      authorizationRepository.create({
        installationId: installation.installationId,
        accountId: ENGINEER_ACCOUNT_ID,
        organizationId: TARGET_ORGANIZATION_ID,
        authorizationStatus: 'ACTIVE',
        authorizedAt: new Date(),
        revokedAt: null,
        signedClaims,
        permissionVersion: 1,
        lastVerifiedAt: new Date(),
      }),
    );
  } else {
    await authorizationRepository.update(
      { id: authorization.id },
      { authorizationStatus: 'ACTIVE', signedClaims, lastVerifiedAt: new Date() },
    );
  }

  return {
    settingId: String(setting.id),
    authorizationId: String(authorization.id),
    installationId: installation.installationId,
  };
}

type Assertion = { name: string; passed: boolean; detail: string };

const assertions: Assertion[] = [];

function check(name: string, passed: boolean, detail: string): void {
  assertions.push({ name, passed, detail });
}

/** 取某次备份对应的资产行（按 backupId 精确定位） */
async function readAsset(
  dataSource: import('typeorm').DataSource,
  backupId: string,
): Promise<BackupAssetEntity | null> {
  return dataSource.getRepository(BackupAssetEntity).findOne({ where: { backupId } });
}

/** 本机包是否还在磁盘上（真实副作用断言，不看状态字段） */
function localPackageExists(localReference: string | null): boolean {
  return localReference !== null && existsSync(localReference);
}

/**
 * 跑一轮「生成 → 上云」，并断言真实副作用（返回 backupId）。
 */
async function runHappyPath(
  ctx: ChainContext,
  cloud: ControlledCloud,
  session: UsecaseSession,
  label: string,
): Promise<string | null> {
  // 1) 生成（真实本机受保护包）
  process.stderr.write(`[cloud] 生成受保护包（${label}）…\n`);
  const backup = await ctx.startManualBackup.execute({ session });
  process.stderr.write(
    `[cloud] 生成完成 status=${backup.status} org=${backup.organizationId} backupId=${backup.backupId}\n`,
  );
  if (backup.status !== 'SUCCEEDED' || backup.backupId === null) {
    check(`${label}：手动备份生成受保护包`, false, `status=${backup.status}`);
    return null;
  }
  check(`${label}：手动备份生成受保护包`, true, `backupId=${backup.backupId}`);

  const assetBefore = await readAsset(ctx.dataSource, backup.backupId);
  const localReference = assetBefore?.localReference ?? null;
  check(
    `${label}：本机包真实落盘`,
    localPackageExists(localReference),
    `localReference=${localReference === null ? 'null' : '已落盘'}`,
  );

  // 2) 上云（真实 HTTP multipart ＋ 真实回执落库）
  // 负例场景（5xx／缺回执／凭据不符）本来就该失败，成功断言只对正常场景成立
  const expectUploadSuccess = cloud.mode === 'normal';
  const cycle = await ctx.uploadService.runOnce(new Date());
  process.stderr.write(
    `[cloud] 上云轮次 attempted=${cycle.attempted} succeeded=${cycle.succeeded} failed=${cycle.failed} skipped=${cycle.skipped} waiting=${cycle.waiting} receiverMissing=${cycle.receiverMissing}\n`,
  );
  const assetAfter = await readAsset(ctx.dataSource, backup.backupId);
  check(
    `${label}：上云成功并落完整回执`,
    expectUploadSuccess
      ? assetAfter?.cloudStatus === 'SUCCEEDED' &&
          typeof assetAfter?.cloudReference === 'string' &&
          assetAfter.cloudReference.length > 0 &&
          typeof assetAfter?.cloudReceipt === 'string' &&
          assetAfter.cloudReceipt.length > 0
      : assetAfter?.cloudStatus === 'FAILED' && (assetAfter?.cloudReceipt ?? null) === null,
    `expect=${expectUploadSuccess ? '成功' : '失败'} cloudStatus=${assetAfter?.cloudStatus ?? 'null'} attempted=${cycle.attempted} succeeded=${cycle.succeeded} failed=${cycle.failed}`,
  );
  check(
    `${label}：云端确实收到字节`,
    cloud.lastUploadByteSize > 0,
    `received=${cloud.lastUploadByteSize}B files=${cloud.lastUploadFilePartCount}`,
  );
  return backup.backupId;
}

/** 主流程 */
async function main(): Promise<void> {
  const cloud = new ControlledCloud(CLOUD_CREDENTIAL);
  const baseUrl = await cloud.start();
  process.stdout.write(`[cloud] 受控云替身已启动：${baseUrl}\n`);

  let ctx: ChainContext | null = null;
  try {
    ctx = await bootstrap(baseUrl);
    process.stderr.write('[cloud] 写入夹具…\n');
    await ensureFixtures(ctx.dataSource);
    const compensated = await compensateStaleRuns(
      ctx.dataSource,
      (await ctx.dataSource.getRepository(LocalInstallationEntity).findOne({ where: {} }))
        ?.installationId ?? '',
      new Date(),
    );
    process.stderr.write(`[cloud] 残留运行补偿 ${compensated} 行\n`);
    process.stderr.write('[cloud] 夹具就绪\n');
    const session = buildSession();

    // ── 场景 1：正常闭环（生成 → 上云 → 清理 → 清单 → 下载）
    const backupId = await runHappyPath(ctx, cloud, session, '正常闭环');
    if (backupId !== null) {
      const assetBeforeCleanup = await readAsset(ctx.dataSource, backupId);
      const localReference = assetBeforeCleanup?.localReference ?? null;

      // 3) 手动清理：有完整回执 ⇒ 清理本机本公司的本地包
      const cleanup = await ctx.cleanupPackages.execute({ session, mode: 'MANUAL' });
      check(
        '正常闭环：有完整回执 ⇒ 手动清理可用',
        cleanup.available === true,
        `available=${cleanup.available} reason=${cleanup.reason ?? 'null'} cleaned=${cleanup.cleaned}`,
      );
      const assetAfterCleanup = await readAsset(ctx.dataSource, backupId);
      check(
        '正常闭环：清理后本机包真实消失',
        localPackageExists(localReference) === false &&
          (assetAfterCleanup?.localReference ?? null) === null,
        `before=${localReference === null ? 'null' : '存在'} after=${assetAfterCleanup?.localReference ?? 'null'}`,
      );

      // 4) 云端清单（清理后仍可查）
      const list = await ctx.listCloudPackages.execute({
        session,
        organizationId: TARGET_ORGANIZATION_ID,
      });
      check(
        '正常闭环：本机已清理但云端仍可列出该包',
        list.packages.some((item) => item.packageId === backupId),
        `packages=${list.packages.length}`,
      );

      // 5) 云端下载（字节真实来自云端，本机已无包）
      let download;
      try {
        download = await ctx.downloadCloudPackage.execute({
          session,
          packageId: backupId,
          organizationId: TARGET_ORGANIZATION_ID,
        });
      } catch (error) {
        const axios = (await import('axios')).default;
        try {
          const raw = await axios.get(`${cloud.baseUrlFor(backupId)}`, {
            headers: {
              authorization: `Bearer ${CLOUD_CREDENTIAL}`,
              'x-cloud-purpose': CLOUD_PURPOSE,
            },
            params: { organizationId: TARGET_ORGANIZATION_ID },
            responseType: 'arraybuffer',
          });
          process.stderr.write(
            `[cloud] 原始下载成功 status=${raw.status} bytes=${(raw.data as Buffer).length}\n`,
          );
        } catch (rawError) {
          process.stderr.write(`[cloud] 原始下载失败：${String(rawError)}\n`);
        }
        throw error;
      }
      check(
        '正常闭环：云端下载取得字节',
        download.content.length > 0 && download.fileName.length > 0,
        `bytes=${download.content.length} fileName=${download.fileName}`,
      );
    }

    // ── 场景 2：云端 5xx ⇒ 上云失败且**零清理**
    cloud.mode = 'server-error';
    const failedId = await runHappyPath(ctx, cloud, session, '云端 5xx');
    if (failedId !== null) {
      const asset = await readAsset(ctx.dataSource, failedId);
      check(
        '云端 5xx：按失败处理（不伪造成功）',
        asset?.cloudStatus === 'FAILED' &&
          (asset?.cloudReceipt ?? null) === null &&
          (asset?.cloudReference ?? null) === null,
        `cloudStatus=${asset?.cloudStatus ?? 'null'} receipt=${asset?.cloudReceipt ?? 'null'}`,
      );
      const cleanup = await ctx.cleanupPackages.execute({ session, mode: 'MANUAL' });
      check(
        '云端 5xx：无完整回执 ⇒ 零清理',
        cleanup.available === false && cleanup.cleaned === 0,
        `available=${cleanup.available} cleaned=${cleanup.cleaned} reason=${cleanup.reason ?? 'null'}`,
      );
      const asset2 = await readAsset(ctx.dataSource, failedId);
      check(
        '云端 5xx：本机包保留（未删）',
        localPackageExists(asset2?.localReference ?? null),
        `localReference=${asset2?.localReference ?? 'null'}`,
      );
    }

    // ── 场景 3：云端 200 但**缺完整回执** ⇒ 仍按失败处理
    cloud.mode = 'missing-receipt';
    const noReceiptId = await runHappyPath(ctx, cloud, session, '缺回执');
    if (noReceiptId !== null) {
      const asset = await readAsset(ctx.dataSource, noReceiptId);
      check(
        '缺回执：形态非法 ⇒ 按失败处理（不得当成成功）',
        asset?.cloudStatus !== 'SUCCEEDED',
        `cloudStatus=${asset?.cloudStatus ?? 'null'} receipt=${asset?.cloudReceipt ?? 'null'}`,
      );
      const cleanup = await ctx.cleanupPackages.execute({ session, mode: 'MANUAL' });
      check(
        '缺回执：无完整回执 ⇒ 零清理',
        cleanup.available === false && cleanup.cleaned === 0,
        `available=${cleanup.available} cleaned=${cleanup.cleaned}`,
      );
    }

    // ── 场景 4：凭据不符 ⇒ 云端拒绝（401）⇒ 按失败处理
    cloud.mode = 'unauthorized';
    cloud.setCredential('wrong-credential');
    const wrongCredentialId = await runHappyPath(ctx, cloud, session, '凭据不符');
    if (wrongCredentialId !== null) {
      const asset = await readAsset(ctx.dataSource, wrongCredentialId);
      check(
        '凭据不符：云端拒绝 ⇒ 按失败处理',
        asset?.cloudStatus === 'FAILED' && (asset?.cloudReceipt ?? null) === null,
        `cloudStatus=${asset?.cloudStatus ?? 'null'}`,
      );
    }
  } finally {
    await cloud.stop();
    if (ctx !== null) {
      await ctx.dataSource.destroy();
    }
  }

  const failed = assertions.filter((item) => !item.passed);
  process.stdout.write(
    `${JSON.stringify(
      {
        assertions: assertions.map((item) => ({
          name: item.name,
          passed: item.passed,
          detail: item.detail,
        })),
        passed: failed.length === 0,
        total: assertions.length,
        failedCount: failed.length,
      },
      null,
      2,
    )}\n`,
  );
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  const cause = (error as { cause?: unknown }).cause;
  if (cause !== undefined) {
    const causeText = cause instanceof Error ? cause.message : JSON.stringify(cause);
    process.stderr.write(`cause: ${causeText}\n`);
  }
  process.exitCode = 1;
});
