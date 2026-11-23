// scripts/task09-sync-conflict-cloud-chain.ts
/**
 * 任务 09 · 「使用云端」**隔离实库整链**取证脚本（R066–R068）。
 *
 * 目的：把"原内容 → 冲突 → 采用云端 → 本地视图读回 → 历史／云端不变"这条链
 * 从**单元测试**推进到**一次性隔离库上的真实副作用**：
 * - 冲突登记走**生产服务**（`BusinessSyncReceiptService.recordConflict`）；
 * - 裁决走**生产用例**（`ResolveSyncConflictUsecase`，含受控本地视图对齐）；
 * - 对齐写入走**来源域受控入口**（中立端口 `SYNC_CONFLICT_LOCAL_VIEW_WRITER`）；
 * - 断言全部落在**真实副作用**上：工单当前视图、修订历史行数与内容、
 *   冲突行终态、两份快照原文。
 *
 * 纪律：
 * - **默认拒绝**：复用恢复自检同一套安全边界（一次性库、预期实例身份、
 *   一次性库标识、受控文件根、安装／公司标识、测试授权），缺一即零写入退出；
 * - 只写**本轮创建的夹具**（确定性 ID 段 979201／冲突 UUID 段 f001…），
 *   收尾按精确清单删除，并核对非目标哨兵（外公司工单）不变；
 * - 反例同样取证：版本不匹配／版本过期必须**拒绝且不标 resolved**；
 *   已结单来源只允许**只读采用**（不写业务记录、不改历史）。
 *
 * 用法（与恢复自检同一组环境变量）：
 *   TASK09_RESTORE_ENV_FILE=... TASK09_RESTORE_DATABASE=lithography_task09_isolated_a \
 *   TASK09_RESTORE_EXPECTED_HOST=127.0.0.1 TASK09_RESTORE_EXPECTED_PORT=33307 \
 *   TASK09_RESTORE_EXPECTED_SERVER_UUID=<@@server_uuid> \
 *   TASK09_RESTORE_DISPOSABLE_MARKER=<库内标识值> \
 *   TASK09_RESTORE_FILE_ROOT=<受控文件根> \
 *   TASK09_RESTORE_INSTALLATION_ID=<local_installation.installation_id> \
 *   TASK09_RESTORE_ORGANIZATION_ID=<local_installation.organization_id> \
 *   TASK09_RESTORE_TEST_AUTHORIZATION=TASK09-RESTORE-SELFCHECK-ISOLATED-RUN \
 *   npx ts-node -r tsconfig-paths/register scripts/task09-sync-conflict-cloud-chain.ts
 */

// 脚本属**受控 wiring**（同 scripts/task09-restore-selfcheck.ts）：运行时配置只在这里读取一次。

import { Test } from '@nestjs/testing';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { UsecaseSession } from '@app-types/auth/session.types';

import { TypeOrmModule } from '@nestjs/typeorm';
import { parse as parseDotenv } from 'dotenv';
import { DataSource } from 'typeorm';

import { AppConfigModule } from '@src/infrastructure/config/config.module';
import { loadExplicitEnvConfig } from '@src/infrastructure/database/incremental-migration';
import { TypeOrmTransactionModule } from '@src/infrastructure/database/transaction/typeorm-transaction.module';
import { LocalRuntimeStorageModule } from '@src/infrastructure/file-storage/local-runtime-storage.module';
import { LoggerModule } from '@src/infrastructure/logger/logger.module';
import { BusinessSyncReceiptService } from '@src/modules/lithography/business-sync-receipt.service';
import { LocalInstallationEntity } from '@src/modules/lithography/entities/local-installation.entity';
import { LocalRuntimeUsecasesModule } from '@src/usecases/local-runtime/local-runtime-usecases.module';
import { ResolveSyncConflictUsecase } from '@src/usecases/local-runtime/resolve-sync-conflict.usecase';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';

import {
  assertControlledFileRoot,
  assertDisposableMarker,
  assertServerIdentity,
  readSelfcheckAuthorization,
} from './task09-restore-selfcheck.safety';

/** 断言条目 */
type Assertion = { name: string; passed: boolean; detail: string };

const assertions: Assertion[] = [];

function check(name: string, passed: boolean, detail: string): void {
  assertions.push({ name, passed, detail });
}

/** 本轮夹具的确定性标识（便于幂等与精确清理） */
const FIXTURE_REQUEST_ID = 979_201;
const FIXTURE_REQUEST_UUID = '00000000-0000-4000-8000-00000000f001';
const FIXTURE_REQUEST_NO = 'TASK09-CLOUD-RR-0001';
const LOCAL_CONTENT = '## 任务09 本地正文\n这是本地既有内容。';
const CLOUD_CONTENT = '## 任务09 云端正文\n这是云端版本内容。';

/** 一级管理员会话（等级由服务端查库复核） */
function superAdminSession(accountId: number): UsecaseSession {
  return {
    accountId,
    roles: ['SUPER_ADMIN'],
    activeRole: 'SUPER_ADMIN',
    adminLevel: 1,
    customerOrganizationId: null,
  } as unknown as UsecaseSession;
}

/** 数据库行取值统一转文本（不用 String(unknown)：那会退化成默认字符串化） */
function text(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value);
  }
  if (value === null || value === undefined) {
    return '';
  }
  return JSON.stringify(value) ?? '';
}

type RequestRow = {
  id: number;
  content_md: string;
  current_revision_no: number;
  handling_result: string | null;
  handling_status: string | null;
  closure_status: string | null;
};

type ConflictRow = {
  conflict_id: string;
  status: string;
  decision: string;
  local_version: number | null;
  cloud_version: number | null;
  displayed_cloud_version: number | null;
  local_snapshot: string;
  cloud_snapshot: string;
  confirmed_by_account_id: number | null;
};

async function main(): Promise<void> {
  // ── 0. 安全入口：默认拒绝（缺任何一项授权即零写入退出）──
  // eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
  const authorization = readSelfcheckAuthorization(process.env);
  assertControlledFileRoot(authorization.fileRoot);

  const parsed = parseDotenv(readFileSync(authorization.envFile, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    // eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
    process.env[key] = value;
  }
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
  const transactionRunner = moduleRef.get<TransactionRunner>(TRANSACTION_RUNNER);
  const receiptService = moduleRef.get(BusinessSyncReceiptService);
  const resolveUsecase = moduleRef.get(ResolveSyncConflictUsecase);

  const createdConflictIds: string[] = [];

  try {
    // ── 1. 实例身份 / 一次性库标识 / 安装与公司核对 ──
    const actualRows: unknown = await dataSource.query(
      'SELECT DATABASE() AS current_database, @@server_uuid AS server_uuid',
    );
    const actual = (actualRows as Array<Record<string, unknown>>)[0] ?? {};
    const options = dataSource.options as { host?: string; port?: number };
    assertServerIdentity(
      {
        database: text(actual['current_database']),
        serverUuid: text(actual['server_uuid']),
        host: String(options.host ?? ''),
        port: Number(options.port ?? 0),
      },
      authorization,
    );
    const markerRows: unknown = await dataSource.query(
      'SELECT marker_key, marker_value FROM task09_disposable_marker',
    );
    assertDisposableMarker(
      (markerRows as Array<Record<string, unknown>>).map((row) => ({
        markerKey: text(row['marker_key']),
        markerValue: text(row['marker_value']),
      })),
      authorization.disposableMarker,
    );
    const installation = await dataSource
      .getRepository(LocalInstallationEntity)
      .findOne({ where: {} });
    if (installation === null) {
      throw new Error('隔离库缺少本机安装身份');
    }
    if (installation.installationId.toLowerCase() !== authorization.installationId) {
      throw new Error('安装标识与声明不一致');
    }
    const organizationId = authorization.organizationId;

    // ── 2. 夹具：本公司可写工单（稳定编号已持久化、版本可核验、非冻结非结单）──
    const accountRows: unknown = await dataSource.query(
      'SELECT id FROM base_user_account WHERE login_name = ? LIMIT 1',
      ['mock_customer_alpha'],
    );
    const customerAccountId = Number((accountRows as Array<{ id: number }>)[0]?.id ?? 0);
    if (customerAccountId <= 0) {
      throw new Error('隔离库缺少客户账号');
    }
    const modelRows: unknown = await dataSource.query(
      'SELECT id FROM equipment_model ORDER BY id LIMIT 1',
    );
    const equipmentModelId = Number((modelRows as Array<{ id: number }>)[0]?.id ?? 0);
    if (equipmentModelId <= 0) {
      throw new Error('隔离库缺少机型');
    }

    await dataSource.query('DELETE FROM repair_request WHERE id = ? AND record_uuid = ?', [
      FIXTURE_REQUEST_ID,
      FIXTURE_REQUEST_UUID,
    ]);
    await dataSource.query(
      'INSERT INTO repair_request ' +
        '(id, request_no, customer_account_id, equipment_model_id, error_code, fault_description, ' +
        'content_md, is_accepted, accepted_by_engineer_account_id, accepted_at, owner_organization_id, ' +
        'customer_organization_id, service_organization_id, current_revision_no, maintenance_version_no, ' +
        'deprecated, deleted_at, is_historical, record_uuid, handling_status, handling_result, closure_status) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, NOW(3), ?, ?, ?, 1, 0, 0, NULL, 0, ?, NULL, NULL, NULL)',
      [
        FIXTURE_REQUEST_ID,
        FIXTURE_REQUEST_NO,
        customerAccountId,
        equipmentModelId,
        'E-TASK09-CLOUD',
        '任务09 采用云端夹具',
        LOCAL_CONTENT,
        900_101,
        organizationId,
        organizationId,
        organizationId,
        FIXTURE_REQUEST_UUID,
      ],
    );
    // 修订历史第 1 版（"历史只追加"的基线；previous_version 列非空，首版取 0）
    await dataSource.query(
      'INSERT INTO repair_request_revision ' +
        '(request_id, revision_no, previous_version, before_snapshot, after_snapshot, schema_version, ' +
        'actor_account_id, reason) ' +
        'VALUES (?, 1, 0, ?, ?, 1, ?, ?)',
      [
        FIXTURE_REQUEST_ID,
        JSON.stringify({ schema_version: 1, content_md: LOCAL_CONTENT }),
        JSON.stringify({ schema_version: 1, content_md: LOCAL_CONTENT }),
        900_101,
        '任务09 隔离库夹具初始版本',
      ],
    );

    // ── 3. 外公司哨兵（收尾核对"非目标数据不变"）──
    const foreignBefore = await fingerprintForeignRequests(dataSource, organizationId);

    const readRequest = async (): Promise<RequestRow> => {
      const rows: unknown = await dataSource.query(
        'SELECT id, content_md, current_revision_no, handling_result, handling_status, closure_status ' +
          'FROM repair_request WHERE id = ?',
        [FIXTURE_REQUEST_ID],
      );
      const row = (rows as Array<Record<string, unknown>>)[0];
      if (row === undefined) {
        throw new Error('夹具工单不存在');
      }
      return {
        id: Number(row['id']),
        content_md: text(row['content_md']),
        current_revision_no: Number(row['current_revision_no']),
        handling_result: row['handling_result'] === null ? null : text(row['handling_result']),
        handling_status: row['handling_status'] === null ? null : text(row['handling_status']),
        closure_status: row['closure_status'] === null ? null : text(row['closure_status']),
      };
    };
    const readRevisions = async (): Promise<Array<{ revision_no: number; reason: string }>> => {
      const rows: unknown = await dataSource.query(
        'SELECT revision_no, reason FROM repair_request_revision WHERE request_id = ? ORDER BY revision_no ASC',
        [FIXTURE_REQUEST_ID],
      );
      return (rows as Array<Record<string, unknown>>).map((row) => ({
        revision_no: Number(row['revision_no']),
        reason: String(row['reason']),
      }));
    };
    const readConflict = async (conflictId: string): Promise<ConflictRow> => {
      const rows: unknown = await dataSource.query(
        'SELECT conflict_id, status, decision, local_version, cloud_version, displayed_cloud_version, ' +
          'local_snapshot, cloud_snapshot, confirmed_by_account_id FROM sync_conflict WHERE conflict_id = ?',
        [conflictId],
      );
      const row = (rows as Array<Record<string, unknown>>)[0];
      if (row === undefined) {
        throw new Error(`冲突行不存在：${conflictId}`);
      }
      return {
        conflict_id: text(row['conflict_id']),
        status: text(row['status']),
        decision: text(row['decision']),
        local_version: row['local_version'] === null ? null : Number(row['local_version']),
        cloud_version: row['cloud_version'] === null ? null : Number(row['cloud_version']),
        displayed_cloud_version:
          row['displayed_cloud_version'] === null ? null : Number(row['displayed_cloud_version']),
        local_snapshot: text(row['local_snapshot']),
        cloud_snapshot: text(row['cloud_snapshot']),
        confirmed_by_account_id:
          row['confirmed_by_account_id'] === null ? null : Number(row['confirmed_by_account_id']),
      };
    };

    /** 登记一条冲突（生产服务：冲突登记链的真实写法） */
    const registerConflict = async (input: {
      versionNo: number;
      localVersion: number;
      cloudVersion: number;
      cloudBody: Record<string, unknown>;
    }): Promise<string> => {
      const envelope = (
        versionNo: number,
        body: Record<string, unknown>,
      ): Record<string, unknown> => ({
        schema_version: 1,
        resource_type: 'REPAIR_REQUEST',
        record_uuid: FIXTURE_REQUEST_UUID,
        version_no: versionNo,
        manifest_checksum: 'a'.repeat(64),
        body,
      });
      await transactionRunner.run(async (transactionContext) => {
        await receiptService.recordConflict(
          {
            organizationId,
            resourceType: 'REPAIR_REQUEST',
            recordUuid: FIXTURE_REQUEST_UUID,
            versionNo: input.versionNo,
            localVersion: input.localVersion,
            cloudVersion: input.cloudVersion,
            localSnapshot: envelope(input.localVersion, { content_md: LOCAL_CONTENT }),
            cloudSnapshot: envelope(input.cloudVersion, input.cloudBody),
            conflictReason: '任务09 隔离库：本地与云端内容不一致',
          },
          transactionContext,
        );
      });
      const rows: unknown = await dataSource.query(
        'SELECT conflict_id FROM sync_conflict WHERE record_uuid = ? AND version_no = ?',
        [FIXTURE_REQUEST_UUID, input.versionNo],
      );
      const conflictId = text((rows as Array<Record<string, unknown>>)[0]?.['conflict_id']);
      createdConflictIds.push(conflictId);
      return conflictId;
    };

    const admin = superAdminSession(979_101);

    // ── 4. 正例：原内容 → 冲突 → 采用云端 → 本地视图读回 ──
    const conflictId = await registerConflict({
      versionNo: 1,
      localVersion: 1,
      cloudVersion: 2,
      cloudBody: { content_md: CLOUD_CONTENT, handling_result: 'FIXED' },
    });
    const before = await readRequest();
    const beforeRevisions = await readRevisions();
    const beforeConflict = await readConflict(conflictId);

    const resolved = await resolveUsecase.execute({
      session: admin,
      conflictId,
      action: 'CLOUD',
      displayedCloudVersion: 2,
    });
    const after = await readRequest();
    const afterRevisions = await readRevisions();
    const afterConflict = await readConflict(conflictId);

    check(
      '采用云端：裁决返回已解决',
      resolved.outcome === 'resolved',
      `outcome=${resolved.outcome}`,
    );
    check(
      '采用云端：本地当前有权视图已对齐到云端正文',
      after.content_md === CLOUD_CONTENT,
      `before=${before.content_md.slice(0, 24)} after=${after.content_md.slice(0, 24)}`,
    );
    check(
      '采用云端：本地版本按版本条件推进一版',
      after.current_revision_no === before.current_revision_no + 1,
      `before=${before.current_revision_no} after=${after.current_revision_no}`,
    );
    check(
      '采用云端：处理事实已按云端受控字段落到本地视图',
      after.handling_result === 'FIXED' && after.handling_status === 'COMPLETED',
      `result=${String(after.handling_result)} status=${String(after.handling_status)}`,
    );
    check(
      '采用云端：修订历史只追加（原有第 1 版未被覆盖）',
      afterRevisions.length === beforeRevisions.length + 1 &&
        afterRevisions[0]?.revision_no === beforeRevisions[0]?.revision_no &&
        afterRevisions[0]?.reason === beforeRevisions[0]?.reason,
      `before=${JSON.stringify(beforeRevisions)} after=${JSON.stringify(afterRevisions)}`,
    );
    check(
      '采用云端：冲突行落裁决事实（RESOLVED／CLOUD／确认人）',
      afterConflict.status === 'RESOLVED' &&
        afterConflict.decision === 'CLOUD' &&
        afterConflict.confirmed_by_account_id === 979_101,
      `status=${afterConflict.status} decision=${afterConflict.decision} confirmedBy=${String(afterConflict.confirmed_by_account_id)}`,
    );
    check(
      '采用云端：两份快照原文未被改写（云端原记录与原本地副本保持不变）',
      afterConflict.cloud_snapshot === beforeConflict.cloud_snapshot &&
        afterConflict.local_snapshot === beforeConflict.local_snapshot,
      `cloudSnapshotUnchanged=${afterConflict.cloud_snapshot === beforeConflict.cloud_snapshot} localSnapshotUnchanged=${afterConflict.local_snapshot === beforeConflict.local_snapshot}`,
    );
    check(
      '采用云端：冲突登记的云端版本未被本次裁决改写',
      afterConflict.cloud_version === beforeConflict.cloud_version,
      `before=${String(beforeConflict.cloud_version)} after=${String(afterConflict.cloud_version)}`,
    );

    // ── 5. 幂等：重复确认不产生新业务版本 ──
    const repeated = await resolveUsecase.execute({
      session: admin,
      conflictId,
      action: 'CLOUD',
      displayedCloudVersion: 2,
    });
    const afterRepeat = await readRequest();
    const afterRepeatRevisions = await readRevisions();
    check(
      '重复确认：返回既有事实且不产生多余业务版本',
      repeated.outcome === 'existing' &&
        afterRepeat.current_revision_no === after.current_revision_no &&
        afterRepeatRevisions.length === afterRevisions.length,
      `outcome=${repeated.outcome} version=${afterRepeat.current_revision_no} revisions=${afterRepeatRevisions.length}`,
    );

    // ── 6. 反例：展示的云端版本不匹配 ⇒ 拒绝且不标 resolved ──
    const staleConflictId = await registerConflict({
      versionNo: 2,
      localVersion: after.current_revision_no,
      cloudVersion: 3,
      cloudBody: { content_md: '## 云端第三版', handling_result: 'FIXED' },
    });
    const staleBefore = await readRequest();
    let staleError = '';
    try {
      await resolveUsecase.execute({
        session: admin,
        conflictId: staleConflictId,
        action: 'CLOUD',
        displayedCloudVersion: 99,
      });
    } catch (error: unknown) {
      staleError = error instanceof Error ? error.message : String(error);
    }
    const staleAfter = await readRequest();
    const staleConflict = await readConflict(staleConflictId);
    check(
      '反例：云端版本与实际看到的不一致 ⇒ 拒绝执行',
      staleError.includes('云端版本已变化'),
      `error=${staleError}`,
    );
    check(
      '反例：拒绝后不标 resolved 且本地视图不变',
      staleConflict.status === 'PENDING' &&
        staleConflict.decision === 'PENDING' &&
        staleAfter.content_md === staleBefore.content_md &&
        staleAfter.current_revision_no === staleBefore.current_revision_no,
      `status=${staleConflict.status} decision=${staleConflict.decision} version=${staleAfter.current_revision_no}`,
    );

    // ── 7. 反例：本地版本已过期 ⇒ 拒绝且不标 resolved ──
    const expiredConflictId = await registerConflict({
      versionNo: 3,
      localVersion: staleBefore.current_revision_no,
      cloudVersion: 4,
      cloudBody: { content_md: '## 云端第四版' },
    });
    // 把工单推进一版，使冲突登记的本地版本过期
    await dataSource.query(
      'UPDATE repair_request SET current_revision_no = current_revision_no + 1 WHERE id = ?',
      [FIXTURE_REQUEST_ID],
    );
    const expiredBefore = await readRequest();
    let expiredError = '';
    try {
      await resolveUsecase.execute({
        session: admin,
        conflictId: expiredConflictId,
        action: 'CLOUD',
        displayedCloudVersion: 4,
      });
    } catch (error: unknown) {
      expiredError = error instanceof Error ? error.message : String(error);
    }
    const expiredAfter = await readRequest();
    const expiredConflict = await readConflict(expiredConflictId);
    check(
      '反例：本地版本已被别处推进 ⇒ 拒绝执行',
      expiredError.includes('已不是来源记录的当前版本') || expiredError.includes('已被别处推进'),
      `error=${expiredError}`,
    );
    check(
      '反例：拒绝后不标 resolved 且本地视图不变',
      expiredConflict.status === 'PENDING' &&
        expiredAfter.content_md === expiredBefore.content_md &&
        expiredAfter.current_revision_no === expiredBefore.current_revision_no,
      `status=${expiredConflict.status} version=${expiredAfter.current_revision_no}`,
    );

    // ── 8. 只读来源（已结单）：只读采用，不写业务记录、不改历史 ──
    await dataSource.query(
      'UPDATE repair_request SET closure_status = ?, closed_at = NOW(3) WHERE id = ?',
      ['CLOSED', FIXTURE_REQUEST_ID],
    );
    const readOnlyConflictId = await registerConflict({
      versionNo: 4,
      localVersion: expiredAfter.current_revision_no,
      cloudVersion: 5,
      cloudBody: { content_md: '## 云端结单视图' },
    });
    const readOnlyBefore = await readRequest();
    const readOnlyBeforeRevisions = await readRevisions();
    const readOnlyResolved = await resolveUsecase.execute({
      session: admin,
      conflictId: readOnlyConflictId,
      action: 'CLOUD',
      displayedCloudVersion: 5,
    });
    const readOnlyAfter = await readRequest();
    const readOnlyAfterRevisions = await readRevisions();
    const readOnlyConflict = await readConflict(readOnlyConflictId);
    check(
      '已结单只读采用：裁决完成（冲突有终态）',
      readOnlyResolved.outcome === 'resolved' && readOnlyConflict.status === 'RESOLVED',
      `outcome=${readOnlyResolved.outcome} status=${readOnlyConflict.status}`,
    );
    check(
      '已结单只读采用：不写业务记录、不改历史（R066）',
      readOnlyAfter.content_md === readOnlyBefore.content_md &&
        readOnlyAfter.current_revision_no === readOnlyBefore.current_revision_no &&
        readOnlyAfterRevisions.length === readOnlyBeforeRevisions.length,
      `contentUnchanged=${readOnlyAfter.content_md === readOnlyBefore.content_md} version=${readOnlyAfter.current_revision_no} revisions=${readOnlyAfterRevisions.length}`,
    );

    // ── 9. 收尾：只删本轮对象，并核对非目标哨兵不变 ──
    for (const createdConflictId of createdConflictIds) {
      await dataSource.query('DELETE FROM sync_conflict WHERE conflict_id = ?', [
        createdConflictId,
      ]);
    }
    await dataSource.query('DELETE FROM repair_request_revision WHERE request_id = ?', [
      FIXTURE_REQUEST_ID,
    ]);
    await dataSource.query('DELETE FROM repair_request WHERE id = ? AND record_uuid = ?', [
      FIXTURE_REQUEST_ID,
      FIXTURE_REQUEST_UUID,
    ]);
    const foreignAfter = await fingerprintForeignRequests(dataSource, organizationId);
    check(
      '收尾：非目标（外公司）工单指纹未变',
      foreignAfter === foreignBefore,
      `before=${foreignBefore} after=${foreignAfter}`,
    );
    const leftoverConflicts: unknown = await dataSource.query(
      'SELECT COUNT(*) AS total FROM sync_conflict WHERE record_uuid = ?',
      [FIXTURE_REQUEST_UUID],
    );
    const leftoverRequests: unknown = await dataSource.query(
      'SELECT COUNT(*) AS total FROM repair_request WHERE id = ?',
      [FIXTURE_REQUEST_ID],
    );
    check(
      '收尾：本轮对象零残留',
      Number((leftoverConflicts as Array<Record<string, unknown>>)[0]?.['total'] ?? -1) === 0 &&
        Number((leftoverRequests as Array<Record<string, unknown>>)[0]?.['total'] ?? -1) === 0,
      `conflicts=${String((leftoverConflicts as Array<Record<string, unknown>>)[0]?.['total'])} requests=${String((leftoverRequests as Array<Record<string, unknown>>)[0]?.['total'])}`,
    );
  } finally {
    await dataSource.destroy();
  }

  const failedCount = assertions.filter((item) => !item.passed).length;
  process.stdout.write(
    `TASK09_SYNC_CONFLICT_CHAIN_RESULT ${JSON.stringify({
      database: authorization.database,
      installationId: authorization.installationId,
      organizationId: authorization.organizationId,
      assertions,
      passed: failedCount === 0,
      total: assertions.length,
      failedCount,
    })}\n`,
  );
  if (failedCount > 0) {
    process.exitCode = 1;
  }
}

/** 外公司工单指纹（行数 ＋ 内容摘要）：用于核对"非目标数据不变" */
async function fingerprintForeignRequests(
  dataSource: DataSource,
  organizationId: number,
): Promise<string> {
  const rows: unknown = await dataSource.query(
    'SELECT COUNT(*) AS total, COALESCE(SUM(CRC32(CONCAT_WS("|", id, request_no, content_md))), 0) AS digest ' +
      'FROM repair_request WHERE owner_organization_id <> ?',
    [organizationId],
  );
  const row = (rows as Array<Record<string, unknown>>)[0] ?? {};
  return `${text(row['total'])}:${text(row['digest'])}`;
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
