/* eslint-disable @typescript-eslint/naming-convention -- HTTP 头名必须原样小写连字符，改名会破坏协议 */

/**
 * 任务 09 · 业务同步**真实链**脚本（受控云替身）（第 10 项 · 第 2 点）。
 *
 * 目的：在**缺生产云地址与凭据**的现实条件下（任务书允许“真实联调标未验证并记录提供方”），
 * 用一个**受控云替身**（本机真实 HTTP 服务）跑通“来源记录 → 待传任务 → 真实 multipart 送出
 * → 接收端**重新计算摘要** → 完整回执 → 本机落回执”这条链，
 * 并把计划要求的故障面在**真实 HTTP** 上逐条复验。
 *
 * 与“替身掩盖缺陷”的区别：
 * - 替身只负责**扮演云端协议对端**（收包、重算摘要、给回包）；
 *   链路的其余部分（来源读取、身份复核、用途凭据、失败分类、回执落库）
 *   全部走**生产代码路径**；
 * - 替身可切换故障模式（丢响应／部分原件／旧版本／5xx），用于验证**失败关闭**；
 * - 断言全部落在**真实副作用**上（任务行状态、回执行、接收端实收字节与重算摘要）。
 *
 * 用法（隔离库；本机单进程）：
 *   TASK09_SYNC_ENV_FILE=env/.env.development \
 *   TASK09_SYNC_DATABASE=lithography_task09_dev \
 *   npx ts-node -r tsconfig-paths/register scripts/task09-business-sync-real-chain.ts
 */

// 脚本属**受控 wiring**（同 scripts/seed-mock.ts）：运行时配置只在这里读取一次。

import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { parse as parseDotenv } from 'dotenv';

import { createAssertionCollector } from './task09-script-utils';

import { AppConfigModule } from '@src/infrastructure/config/config.module';
import { LocalRuntimeStorageModule } from '@src/infrastructure/file-storage/local-runtime-storage.module';
import { LoggerModule } from '@src/infrastructure/logger/logger.module';
import { LocalBackupCloudModule } from '@src/infrastructure/cloud/local-backup-cloud.module';
import { LithographyModule } from '@src/modules/lithography/lithography.module';
import { LocalAccountAuthorizationEntity } from '@src/modules/lithography/entities/local-account-authorization.entity';
import { LocalInstallationEntity } from '@src/modules/lithography/entities/local-installation.entity';
import { TypeOrmTransactionModule } from '@src/infrastructure/database/transaction/typeorm-transaction.module';
import { DispatchBusinessSyncTasksUsecase } from '@src/usecases/local-runtime/dispatch-business-sync-tasks.usecase';
import { EnqueueSourceRecordSyncUsecase } from '@src/usecases/local-runtime/enqueue-source-record-sync.usecase';
import { LocalRuntimeUsecasesModule } from '@src/usecases/local-runtime/local-runtime-usecases.module';
import { loadExplicitEnvConfig } from '@src/infrastructure/database/incremental-migration';

/** 设备 env 文件与隔离库（必须是可丢弃的 task09 隔离库） */
// eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
const DEVICE_ENV_FILE = process.env.TASK09_SYNC_ENV_FILE ?? 'env/.env.development';
// eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
const DEVICE_DATABASE = process.env.TASK09_SYNC_DATABASE ?? 'lithography_task09_dev';

/** 受控云替身地址与凭据（脚本启动后注入，不进任何日志或回执） */
const SYNC_CREDENTIAL = 'task09-controlled-sync-credential';
const SYNC_PURPOSE = 'BUSINESS_SYNC';

/** 夹具的确定性标识（可重复执行、收尾精确删除） */
const FIXTURE_DOCUMENT_ID = 979_401;
const FIXTURE_DOCUMENT_UUID = '00000000-0000-4000-8000-00000000b401';
const FIXTURE_ORIGINAL_FILENAME = 'task09-原件.txt';
const FIXTURE_ORIGINAL_BYTES = Buffer.from('任务09 业务同步原件字节（真实文件内容）', 'utf8');
const FIXTURE_STORAGE_REFERENCE = '979401aa979401aa979401aa979401aa.txt';

/** 故障模式（受控云替身可切换） */
type SyncMode = 'normal' | 'drop-response' | 'partial-originals' | 'older-version' | 'server-error';

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

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** 取请求头文本（Node 的头值可能是 string[]，统一取首个） */
function headerText(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}

/** 从不可信元数据里读文本（不是字符串就用默认值，绝不把对象直接字符串化） */
function readText(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * 受控云替身：**真实的本机 HTTP 服务**，按生产协议扮演业务同步接收端。
 *
 * 它不是“测试替身对象”，而是“云端对端”：本仓代码通过真实 socket 与它交互，
 * 因此鉴权头、用途头、multipart 形态、状态码语义都被真实校验；
 * 并且它**自己重新计算**原件摘要（本机据此逐项复核，而不是采信本机自报）。
 */
class ControlledSyncCloud {
  mode: SyncMode = 'normal';
  /** 收到的请求（真实副作用证据） */
  readonly requests: Array<{
    path: string;
    purpose: string;
    authorization: string;
    metadata: Record<string, unknown> | null;
    originalParts: Array<{ name: string; byteSize: number; sha256: string }>;
  }> = [];
  private readonly server: Server;
  private port = 0;

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
    this.port = address.port;
    return `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
  }

  /** 暂停监听（保持端口）：模拟"云端不可达"，本机地址不变 */
  async pause(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
  }

  /** 恢复监听（同一端口）：模拟"云端恢复" */
  async resume(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.listen(this.port, '127.0.0.1', () => {
        resolve();
      });
    });
  }

  /** 收到的幂等键序列（重复/并发/重试的事实证据） */
  get idempotencyKeys(): string[] {
    return this.requests
      .map((item) => item.metadata?.['idempotency_key'])
      .filter((value): value is string => typeof value === 'string');
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const authorization = headerText(request.headers.authorization);
    const purpose = headerText(request.headers['x-cloud-purpose']);
    const body = await readRequestBody(request);
    const parts = parseMultipart(body, request.headers['content-type'] ?? '');
    const metadataPart = parts.find((part) => part.name === 'metadata');
    let metadata: Record<string, unknown> | null = null;
    if (metadataPart !== undefined) {
      try {
        metadata = JSON.parse(metadataPart.data.toString('utf8')) as Record<string, unknown>;
      } catch {
        metadata = null;
      }
    }
    const originalParts = parts
      .filter((part) => part.name.startsWith('originals/'))
      .map((part) => ({
        name: part.name,
        byteSize: part.data.byteLength,
        // **接收端自己算摘要**：本机拿回包逐项复核，而不是采信本机自报
        sha256: sha256(part.data),
      }));

    this.requests.push({ path: url.pathname, purpose, authorization, metadata, originalParts });

    if (request.method === 'POST' && url.pathname === '/backup-packages') {
      // 云备份端点：只认**云备份用途**凭据（业务同步凭据打这里 ⇒ 401）
      const backupPurpose = headerText(request.headers['x-cloud-purpose']);
      if (backupPurpose !== 'CLOUD_BACKUP') {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          cloudReference: 'cloud://probe',
          receipt: JSON.stringify({ received: true }),
        }),
      );
      return;
    }
    // 鉴权：凭据与用途都必须正确（与生产约定一致；两种用途凭据互不混用）
    if (authorization !== `Bearer ${this.credential}` || purpose !== SYNC_PURPOSE) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (request.method !== 'POST' || url.pathname !== '/business-sync/records') {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    if (this.mode === 'server-error') {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'internal' }));
      return;
    }
    if (this.mode === 'drop-response') {
      // 丢响应：云端已收下，但**不回包**（连接直接断开）⇒ 本机不得判成功
      request.socket.destroy();
      return;
    }

    const sentVersion = Number(metadata?.['version_no'] ?? 0);
    // 「部分原件」：云端**少收**最后一件（实收数少于清单数）⇒ 本机必须判原件不全
    const received =
      this.mode === 'partial-originals'
        ? originalParts.slice(0, Math.max(0, originalParts.length - 1))
        : originalParts;
    const versionNo = this.mode === 'older-version' ? Math.max(0, sentVersion - 1) : sentVersion;
    const responseBody = {
      status: 'ACCEPTED',
      reason: 'ACCEPTED',
      organization_id: metadata?.['organization_id'] ?? null,
      record_uuid: metadata?.['record_uuid'] ?? null,
      version_no: versionNo,
      manifest_checksum: metadata?.['manifest_checksum'] ?? null,
      // 回包里的原件清单用**接收端重算的摘要**（本机据此逐项复核）
      received_originals: received.map((item) => ({
        relative_path: item.name,
        sha256: item.sha256,
        byte_size: item.byteSize,
      })),
      remote_resource_id: `remote://${readText(metadata?.['record_uuid'], 'unknown')}`,
      snapshot: null,
      received_at: new Date().toISOString(),
    };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(responseBody));
  }
}

type ChainContext = {
  dataSource: DataSource;
  dispatch: DispatchBusinessSyncTasksUsecase;
  enqueue: EnqueueSourceRecordSyncUsecase;
};

/** 装配本机（隔离库 ＋ 本机文件根 ＋ 受控云地址与凭据） */
async function bootstrap(cloudBaseUrl: string): Promise<ChainContext> {
  const envContent = readFileSync(DEVICE_ENV_FILE, 'utf8');
  const parsed: Record<string, string> = parseDotenv(envContent);
  for (const [key, value] of Object.entries(parsed)) {
    // eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
    process.env[key] = value;
  }
  // 受控云替身地址与凭据：**通过正式环境变量注入**（不绕过配置层）
  // eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
  process.env.BUSINESS_SYNC_CLOUD_BASE_URL = cloudBaseUrl;
  // eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
  process.env.BUSINESS_SYNC_CLOUD_CREDENTIAL = SYNC_CREDENTIAL;

  const config = loadExplicitEnvConfig(DEVICE_ENV_FILE, DEVICE_DATABASE);

  process.stderr.write('[sync] 装配中…\n');
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
      LithographyModule,
      // 云端口必须**直接**导入：接收端注册在根测试模块，只有根作用域能注入
      LocalBackupCloudModule,
      LocalRuntimeUsecasesModule,
    ],
  }).compile();

  process.stderr.write('[sync] 装配完成\n');
  return {
    dataSource: moduleRef.get(DataSource),
    dispatch: moduleRef.get(DispatchBusinessSyncTasksUsecase),
    enqueue: moduleRef.get(EnqueueSourceRecordSyncUsecase),
  };
}

/**
 * 夹具：本公司可写资料（含**真实原件文件**）＋ **业务同步用途**的有效授权。
 *
 * 纪律：写入的是**可丢弃的隔离库**；按确定性 ID 精确删除，可重复执行；
 * 原件文件写在受控存储目录内（与生产存储同路径口径）。
 */
async function ensureFixtures(dataSource: DataSource): Promise<{
  installationId: string;
  organizationId: number;
}> {
  const installation = await dataSource
    .getRepository(LocalInstallationEntity)
    .findOne({ where: {} });
  if (installation === null) {
    throw new Error('隔离库缺少本机安装身份，无法执行业务同步真实链');
  }
  const organizationId = installation.organizationId ?? 1;

  // 原件文件：真实落在受控存储目录（存储引用的格式须满足 32 位 hex ＋ 扩展名）
  // eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
  const storageDir = process.env['REFERENCE_DOCUMENT_STORAGE_DIR'] ?? '';
  if (storageDir.length === 0) {
    throw new Error('隔离库 env 缺少 REFERENCE_DOCUMENT_STORAGE_DIR，无法造真实原件');
  }
  mkdirSync(storageDir, { recursive: true });
  const originalPath = join(storageDir, FIXTURE_STORAGE_REFERENCE);
  if (!existsSync(originalPath)) {
    writeFileSync(originalPath, FIXTURE_ORIGINAL_BYTES);
  }

  await dataSource.query('DELETE FROM reference_document_revision WHERE document_id = ?', [
    FIXTURE_DOCUMENT_ID,
  ]);
  await dataSource.query('DELETE FROM reference_document WHERE id = ? AND record_uuid = ?', [
    FIXTURE_DOCUMENT_ID,
    FIXTURE_DOCUMENT_UUID,
  ]);
  await dataSource.query(
    'INSERT INTO reference_document ' +
      '(id, title, document_type, description, content_text, created_by_account_id, ' +
      'owner_organization_id, ingest_method, updated_by_account_id, schema_version, deprecated, ' +
      'publication_status, ownership_status, current_revision_no, source_kind, record_uuid, ' +
      'equipment_model_text, original_filename, mime_type, storage_backend, storage_reference) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)',
    [
      FIXTURE_DOCUMENT_ID,
      '任务09 业务同步真实链资料',
      'MANUAL',
      '受控夹具资料',
      '任务09 业务同步真实链正文',
      900_101,
      organizationId,
      'ADMIN_DIRECT',
      900_101,
      'ONLINE',
      'CONFIRMED',
      'MATERIAL',
      FIXTURE_DOCUMENT_UUID,
      '某机型',
      FIXTURE_ORIGINAL_FILENAME,
      'text/plain',
      'LOCAL',
      FIXTURE_STORAGE_REFERENCE,
    ],
  );
  await dataSource.query(
    'INSERT INTO reference_document_revision ' +
      '(document_id, revision_no, before_snapshot, after_snapshot, actor_account_id, reason) ' +
      'VALUES (?, 1, ?, ?, ?, ?)',
    [
      FIXTURE_DOCUMENT_ID,
      JSON.stringify({ schema_version: 1, content_text: '任务09 业务同步真实链正文' }),
      JSON.stringify({ schema_version: 1, content_text: '任务09 业务同步真实链正文' }),
      900_101,
      '任务09 业务同步真实链夹具初始版本',
    ],
  );

  // 授权：**业务同步用途**（与云备份用途互不混用）
  const authorizationRepository = dataSource.getRepository(LocalAccountAuthorizationEntity);
  const signedClaims = {
    purpose: ['BUSINESS_SYNC'],
    issuer: 'task09-controlled-sync',
    subject: '900101',
  };
  const existing = await authorizationRepository.findOne({
    where: {
      installationId: installation.installationId,
      accountId: 900_101,
      organizationId,
    },
  });
  if (existing === null) {
    await authorizationRepository.save(
      authorizationRepository.create({
        installationId: installation.installationId,
        accountId: 900_101,
        organizationId,
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
      { id: existing.id },
      { authorizationStatus: 'ACTIVE', signedClaims, lastVerifiedAt: new Date() },
    );
  }

  return { installationId: installation.installationId, organizationId };
}

/** 断言收集器与文本转换共用共享工具（避免各脚本各存一份） */
const { assertions, check } = createAssertionCollector();

type TaskRow = {
  id: number;
  status: string;
  attempt_count: number;
  error_code: string | null;
  error_message: string | null;
  remote_id: string | null;
  remote_receipt: string | null;
  idempotency_key: string;
  organization_id: number | null;
  task_kind: string | null;
};

/** 读取本轮夹具对应的待传任务行（真实副作用断言） */
async function readTask(dataSource: DataSource): Promise<TaskRow | null> {
  const rows = (await dataSource.query(
    'SELECT id, status, attempt_count, error_code, error_message, remote_id, remote_receipt, ' +
      'idempotency_key, organization_id, task_kind FROM local_upload_task WHERE record_uuid = ? ' +
      'ORDER BY id DESC',
    [FIXTURE_DOCUMENT_UUID],
  )) as unknown as TaskRow[];
  return rows[0] ?? null;
}

/** 把待传任务复位为 PENDING（用于逐个场景重跑同一夹具） */
async function resetTask(dataSource: DataSource): Promise<void> {
  await dataSource.query(
    "UPDATE local_upload_task SET status = 'PENDING', attempt_count = 0, error_code = NULL, " +
      'error_message = NULL, remote_id = NULL, remote_receipt = NULL WHERE record_uuid = ?',
    [FIXTURE_DOCUMENT_UUID],
  );
}

/** 登记一次待传任务（走生产登记用例） */
async function enqueueTask(ctx: ChainContext): Promise<void> {
  await ctx.enqueue.execute({
    resourceType: 'REFERENCE_DOCUMENT',
    recordUuid: FIXTURE_DOCUMENT_UUID,
  });
}

/** 让替身收下但不回包（丢响应） */
function dropResponse(cloud: ControlledSyncCloud): void {
  cloud.mode = 'drop-response';
}

/** 主流程 */
async function main(): Promise<void> {
  const cloud = new ControlledSyncCloud(SYNC_CREDENTIAL);
  const baseUrl = await cloud.start();
  process.stdout.write(`[sync] 受控云替身已启动：${baseUrl}\n`);

  let ctx: ChainContext | null = null;
  try {
    ctx = await bootstrap(baseUrl);
    process.stderr.write('[sync] 写入夹具…\n');
    const fixture = await ensureFixtures(ctx.dataSource);
    process.stderr.write(
      `[sync] 夹具就绪 installation=${fixture.installationId} org=${fixture.organizationId}\n`,
    );

    // ── 场景 1：正常闭环（真实字节 ＋ 接收端重算摘要 ＋ 完整回执 ＋ 幂等键）
    // 上一次运行可能把任务留在终态：先复位再登记（登记本身是幂等的）
    await resetTask(ctx.dataSource);
    await enqueueTask(ctx);
    const first = await ctx.dispatch.execute();
    const taskAfterSuccess = await readTask(ctx.dataSource);
    const received = cloud.requests[cloud.requests.length - 1];
    check('正常闭环：派发成功', first.succeeded === 1, `succeeded=${first.succeeded}`);
    check(
      '正常闭环：接收端实收原件字节（非只发清单）',
      received?.originalParts.length === 1 &&
        received.originalParts[0]?.byteSize === FIXTURE_ORIGINAL_BYTES.byteLength,
      `parts=${received?.originalParts.length ?? 0} bytes=${received?.originalParts[0]?.byteSize ?? 0}`,
    );
    check(
      '正常闭环：接收端重算摘要与本机原件一致',
      received?.originalParts[0]?.sha256 === sha256(FIXTURE_ORIGINAL_BYTES),
      `cloud=${received?.originalParts[0]?.sha256 ?? 'null'} local=${sha256(FIXTURE_ORIGINAL_BYTES)}`,
    );
    check(
      '正常闭环：用途头为业务同步（凭据用途不混用）',
      received?.purpose === SYNC_PURPOSE && received?.authorization === `Bearer ${SYNC_CREDENTIAL}`,
      `purpose=${received?.purpose ?? 'null'}`,
    );
    check(
      '正常闭环：落成功回执并完成任务',
      taskAfterSuccess?.status === 'SUCCEEDED' &&
        (taskAfterSuccess?.remote_receipt ?? '').length > 0 &&
        (taskAfterSuccess?.remote_id ?? '').length > 0,
      `status=${taskAfterSuccess?.status ?? 'null'} receipt=${(taskAfterSuccess?.remote_receipt ?? '').length}B`,
    );
    check(
      '正常闭环：幂等键按（稳定键, 版本）稳定',
      received?.metadata?.['idempotency_key'] === `business-sync:${FIXTURE_DOCUMENT_UUID}:1`,
      `key=${readText(received?.metadata?.['idempotency_key'], 'null')}`,
    );

    // ── 场景 2：丢响应（云端收下但不回包）⇒ 退回待传，重试仍用同一幂等键
    await resetTask(ctx.dataSource);
    dropResponse(cloud);
    const dropped = await ctx.dispatch.execute();
    const taskAfterDrop = await readTask(ctx.dataSource);
    check(
      '丢响应：退回待传，不伪造成功',
      dropped.retryable === 1,
      `retryable=${dropped.retryable}`,
    );
    check(
      '丢响应：任务仍在待传且无成功回执',
      taskAfterDrop?.status === 'PENDING' && (taskAfterDrop?.remote_receipt ?? null) === null,
      `status=${taskAfterDrop?.status ?? 'null'} receipt=${taskAfterDrop?.remote_receipt ?? 'null'}`,
    );
    cloud.mode = 'normal';
    await ctx.dispatch.execute();
    const keysAfterRetry = cloud.idempotencyKeys;
    check(
      '丢响应：重试沿用同一幂等键（不产生第二条记录）',
      keysAfterRetry.length >= 2 && keysAfterRetry[0] === keysAfterRetry[keysAfterRetry.length - 1],
      `keys=${keysAfterRetry.join(',')}`,
    );
    const taskAfterRetry = await readTask(ctx.dataSource);
    check(
      '丢响应：重试成功后落回执',
      taskAfterRetry?.status === 'SUCCEEDED',
      `status=${taskAfterRetry?.status ?? 'null'}`,
    );

    // ── 场景 3：并发（两个派发者同时抢同一条任务）⇒ 只发一次，另一方不回退在途状态
    await resetTask(ctx.dataSource);
    const requestsBefore = cloud.requests.length;
    const [firstRunner, secondRunner] = await Promise.all([
      ctx.dispatch.execute(),
      ctx.dispatch.execute(),
    ]);
    const sentTimes = cloud.requests.length - requestsBefore;
    check('并发：两个派发者同时抢 ⇒ 只发一次', sentTimes === 1, `sent=${sentTimes}`);
    check(
      '并发：一方成功、另一方跳过（不重复发送、不伪造成功）',
      firstRunner.succeeded + secondRunner.succeeded === 1 &&
        firstRunner.skipped + secondRunner.skipped === 1,
      `a=${firstRunner.succeeded}/${firstRunner.skipped} b=${secondRunner.succeeded}/${secondRunner.skipped}`,
    );
    const taskAfterConcurrent = await readTask(ctx.dataSource);
    check(
      '并发：任务落到成功且只落一份回执',
      taskAfterConcurrent?.status === 'SUCCEEDED' &&
        (taskAfterConcurrent?.remote_receipt ?? '').length > 0,
      `status=${taskAfterConcurrent?.status ?? 'null'}`,
    );
    // 在途（UPLOADING）任务不进入下一轮派发清单 ⇒ 不会被重复发送
    await ctx.dataSource.query(
      "UPDATE local_upload_task SET status = 'UPLOADING' WHERE record_uuid = ?",
      [FIXTURE_DOCUMENT_UUID],
    );
    const requestsBeforeUploading = cloud.requests.length;
    const uploading = await ctx.dispatch.execute();
    check(
      '并发：在途任务不被重复发送',
      uploading.scanned === 0 && cloud.requests.length === requestsBeforeUploading,
      `scanned=${uploading.scanned} sent=${cloud.requests.length - requestsBeforeUploading}`,
    );
    await resetTask(ctx.dataSource);

    // ── 场景 4：断网（云端不可达）⇒ 退回待传，不伪造成功
    await cloud.pause();
    const offline = await ctx.dispatch.execute();
    const taskAfterOffline = await readTask(ctx.dataSource);
    check('断网：云端不可达 ⇒ 退回待传', offline.retryable === 1, `retryable=${offline.retryable}`);
    check(
      '断网：无成功回执',
      (taskAfterOffline?.remote_receipt ?? null) === null,
      `receipt=${taskAfterOffline?.remote_receipt ?? 'null'}`,
    );
    await cloud.resume();

    // ── 场景 5：部分原件（云端只回报部分原件）⇒ 拒绝，不落成功回执
    await resetTask(ctx.dataSource);
    cloud.mode = 'partial-originals';
    const partial = await ctx.dispatch.execute();
    const taskAfterPartial = await readTask(ctx.dataSource);
    check(
      '部分原件：按拒绝处理',
      partial.rejected === 1,
      `rejected=${partial.rejected} scanned=${partial.scanned} status=${taskAfterPartial?.status ?? 'null'}`,
    );
    check(
      '部分原件：受控原因码为原件不全且无成功回执',
      taskAfterPartial?.error_code === 'ORIGINALS_INCOMPLETE' &&
        (taskAfterPartial?.remote_receipt ?? null) === null,
      `error=${taskAfterPartial?.error_code ?? 'null'} status=${taskAfterPartial?.status ?? 'null'}`,
    );

    // ── 场景 6：伪造旧回执（云端回更旧版本）⇒ 拒绝，不判成功
    cloud.mode = 'older-version';
    await resetTask(ctx.dataSource);
    const stale = await ctx.dispatch.execute();
    const taskAfterStale = await readTask(ctx.dataSource);
    check('旧回执：按拒绝处理', stale.rejected === 1, `rejected=${stale.rejected}`);
    check(
      '旧回执：受控原因码为版本不匹配且无成功回执',
      taskAfterStale?.error_code === 'VERSION_MISMATCH' &&
        (taskAfterStale?.remote_receipt ?? null) === null,
      `error=${taskAfterStale?.error_code ?? 'null'}`,
    );
    cloud.mode = 'normal';

    // ── 场景 7：撤权 ⇒ 取消任务，不派发
    await ctx.dataSource.query(
      "UPDATE local_account_authorization SET authorization_status = 'REVOKED', " +
        'revoked_at = NOW() WHERE installation_id = ? AND account_id = ? AND organization_id = ?',
      [fixture.installationId, 900_101, fixture.organizationId],
    );
    await resetTask(ctx.dataSource);
    const requestsBeforeRevoke = cloud.requests.length;
    const revoked = await ctx.dispatch.execute();
    const taskAfterRevoke = await readTask(ctx.dataSource);
    check(
      '撤权：取消任务且不派发',
      revoked.skipped === 1 && cloud.requests.length === requestsBeforeRevoke,
      `skipped=${revoked.skipped} sent=${cloud.requests.length - requestsBeforeRevoke}`,
    );
    check(
      '撤权：任务被取消',
      taskAfterRevoke?.status === 'CANCELLED',
      `status=${taskAfterRevoke?.status ?? 'null'}`,
    );
    await ctx.dataSource.query(
      "UPDATE local_account_authorization SET authorization_status = 'ACTIVE', " +
        'revoked_at = NULL WHERE installation_id = ? AND account_id = ? AND organization_id = ?',
      [fixture.installationId, 900_101, fixture.organizationId],
    );

    // ── 场景 8：换公司（任务绑定的公司不是本机公司）⇒ 取消任务，不派发
    // 公司标识必须取**库内真实存在**的外公司：organization_id 有外键约束，
    // 用"当前公司 + 1"这种算出来的标识在未播种该 id 的库里会直接违反外键，
    // 证据就只能在特定种子库复现。找不到外公司时如实判失败，不伪造。
    const peerRows: unknown = await ctx.dataSource.query(
      'SELECT `id` FROM `organization` WHERE `id` <> ? ORDER BY `id` ASC LIMIT 1',
      [fixture.organizationId],
    );
    const peerOrganizationId = Number(
      (peerRows as ReadonlyArray<Record<string, unknown>>)[0]?.['id'] ?? Number.NaN,
    );
    if (!Number.isInteger(peerOrganizationId) || peerOrganizationId <= 0) {
      check('换公司：库内存在可用的外公司数据区', false, '未找到外公司');
      return;
    }
    check('换公司：库内存在可用的外公司数据区', true, `peer=${peerOrganizationId}`);
    await resetTask(ctx.dataSource);
    await ctx.dataSource.query(
      'UPDATE local_upload_task SET organization_id = ? WHERE record_uuid = ?',
      [peerOrganizationId, FIXTURE_DOCUMENT_UUID],
    );
    const requestsBeforeCompany = cloud.requests.length;
    const switched = await ctx.dispatch.execute();
    const taskAfterCompany = await readTask(ctx.dataSource);
    check(
      '换公司：取消任务且不派发',
      switched.skipped === 1 && cloud.requests.length === requestsBeforeCompany,
      `skipped=${switched.skipped} sent=${cloud.requests.length - requestsBeforeCompany}`,
    );
    check(
      '换公司：任务被取消',
      taskAfterCompany?.status === 'CANCELLED',
      `status=${taskAfterCompany?.status ?? 'null'}`,
    );
    await ctx.dataSource.query(
      'UPDATE local_upload_task SET organization_id = ? WHERE record_uuid = ?',
      [fixture.organizationId, FIXTURE_DOCUMENT_UUID],
    );

    // ── 场景 9：两种用途的凭据互不混用（真实 HTTP 401）
    const axios = (await import('axios')).default;
    const backupCredential = 'task09-controlled-backup-credential';
    const withBackupCredential = await axios
      .post(`${baseUrl}/business-sync/records`, new FormData(), {
        headers: { authorization: `Bearer ${backupCredential}`, 'x-cloud-purpose': 'CLOUD_BACKUP' },
        validateStatus: () => true,
      })
      .catch(() => null);
    check(
      '用途互不混用：云备份凭据打业务同步端点 ⇒ 401',
      withBackupCredential?.status === 401,
      `status=${withBackupCredential?.status ?? 'null'}`,
    );
    const withSyncCredential = await axios
      .post(`${baseUrl}/backup-packages`, new FormData(), {
        headers: {
          authorization: `Bearer ${SYNC_CREDENTIAL}`,
          'x-cloud-purpose': SYNC_PURPOSE,
        },
        validateStatus: () => true,
      })
      .catch(() => null);
    check(
      '用途互不混用：业务同步凭据打云备份端点 ⇒ 401',
      withSyncCredential?.status === 401,
      `status=${withSyncCredential?.status ?? 'null'}`,
    );
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
