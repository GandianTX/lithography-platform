// scripts/task09-sync-conflict-readonly-view-check.ts
/**
 * 任务 09 · 「已结单冲突采用云端」的**来源页只读投影**取证脚本（P1-4）。
 *
 * 目的：把"已结单工单在冲突页选完『使用云端』后，**来源页读回云端内容**"
 * 从**结构性推断**变成**真实入口实测结论**。
 *
 * 真实链路（不 mock、不只断言"不调用写入器"）：
 *   GraphQL 查询 → resolver → usecase → 查询服务 → 真实库 → **只读投影**。
 *
 * | 断言 | 期望 |
 * | --- | --- |
 * | V1 来源页（真实 GraphQL）读回**云端正文** | contentMd = 云端内容 |
 * | V2 来源页的处理事实也来自云端 | handlingResult / handlingStatus = 云端值 |
 * | V3 **业务行没被改写**（只读采用不写业务记录） | repair_request.content_md 仍是本地内容 |
 * | V4 **历史没被改写** | repair_request_revision 行数不变 |
 * | V5 **云端原记录与原本地副本都没被改写** | 两份快照原文不变 |
 * | V6 无权用户读不到该工单 | 越权读取被拒 |
 *
 * 纪律：复用恢复自检同一套安全约束（一次性库、预期实例身份、一次性库标识、
 * 受控文件根、安装／公司标识、测试授权）；只改**本轮选定的一条**工单并在收尾时
 * **精确恢复原值**，只删**本轮创建**的冲突行；非目标工单不得被改动。
 */

import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import type { UsecaseSession } from '@app-types/auth/session.types';

import { AppConfigModule } from '@src/infrastructure/config/config.module';
import { loadExplicitEnvConfig } from '@src/infrastructure/database/incremental-migration';
import { TypeOrmTransactionModule } from '@src/infrastructure/database/transaction/typeorm-transaction.module';
import { LocalRuntimeStorageModule } from '@src/infrastructure/file-storage/local-runtime-storage.module';
import { LoggerModule } from '@src/infrastructure/logger/logger.module';
import { EngineerResponseEntity } from '@src/modules/lithography/entities/engineer-response.entity';
import { EquipmentModelEntity } from '@src/modules/lithography/entities/equipment-model.entity';
import { IntakeAnalysisAttemptEntity } from '@src/modules/lithography/entities/intake-analysis-attempt.entity';
import { OrganizationEntity } from '@src/modules/lithography/entities/organization.entity';
import { RepairProcessEntryEntity } from '@src/modules/lithography/entities/repair-process-entry.entity';
import { RepairRequestDiagnosticStepEntity } from '@src/modules/lithography/entities/repair-request-diagnostic-step.entity';
import { RepairRequestEntity } from '@src/modules/lithography/entities/repair-request.entity';
import { RepairRequestFaultPanelEntity } from '@src/modules/lithography/entities/repair-request-fault-panel.entity';
import { RepairRequestIntakeEntity } from '@src/modules/lithography/entities/repair-request-intake.entity';
import { StoredFileEntity } from '@src/modules/lithography/entities/stored-file.entity';
import { SyncConflictEntity } from '@src/modules/lithography/entities/sync-conflict.entity';
import { RepairProcessEntryQueryService } from '@src/modules/lithography/queries/repair-process-entry.query.service';
import { RepairRequestMaintenanceQueryService } from '@src/modules/lithography/queries/repair-request-maintenance.query.service';
import { RepairRequestQueryService } from '@src/modules/lithography/queries/repair-request.query.service';
import { SyncConflictQueryService } from '@src/modules/lithography/queries/sync-conflict.query.service';
import { ResolveSyncConflictUsecase } from '@src/usecases/local-runtime/resolve-sync-conflict.usecase';
import { LocalRuntimeUsecasesModule } from '@src/usecases/local-runtime/local-runtime-usecases.module';

import {
  assertDisposableMarker,
  assertServerIdentity,
  readSelfcheckAuthorization,
} from './task09-restore-selfcheck.safety';
import { createAssertionCollector, loadEnvFile, text } from './task09-script-utils';

const { assertions, check } = createAssertionCollector();

const LOCAL_CONTENT = '## 本地正文 A\n这是本地版本内容。';
const CLOUD_CONTENT = '## 云端正文 B\n这是云端版本内容。';

async function main(): Promise<void> {
  // eslint-disable-next-line local-architecture/no-runtime-config-outside-wiring
  const auth = readSelfcheckAuthorization(process.env);
  loadEnvFile(auth.envFile);
  const config = loadExplicitEnvConfig(auth.envFile, auth.database);

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
    providers: [
      {
        // `TypeOrmModule.forRoot` 的 entities 用 glob 时，**Nest 不会注册仓储 token**
        // （TypeORM 自己解析 glob）⇒ `@InjectRepository` 注入不到。
        // 这里直接用 `dataSource.getRepository(...)` **手工构造**真实查询服务：
        // 读权限判定、字段装配与只读投影都走生产代码，未被 mock。
        provide: RepairRequestQueryService,
        useFactory: (ds: DataSource) =>
          new RepairRequestQueryService(
            ds.getRepository(RepairRequestEntity),
            ds.getRepository(EngineerResponseEntity),
            ds.getRepository(EquipmentModelEntity),
            ds.getRepository(RepairRequestIntakeEntity),
            ds.getRepository(IntakeAnalysisAttemptEntity),
            ds.getRepository(StoredFileEntity),
            ds.getRepository(OrganizationEntity),
            new RepairProcessEntryQueryService(ds.getRepository(RepairProcessEntryEntity)),
            new RepairRequestMaintenanceQueryService(
              ds.getRepository(RepairRequestEntity),
              ds.getRepository(RepairRequestDiagnosticStepEntity),
              ds.getRepository(RepairRequestFaultPanelEntity),
            ),
            new SyncConflictQueryService(ds.getRepository(SyncConflictEntity)),
          ),
        inject: [DataSource],
      },
    ],
  }).compile();

  const dataSource = moduleRef.get(DataSource);
  const resolveUsecase = moduleRef.get(ResolveSyncConflictUsecase);

  const ownedConflictIds: string[] = [];
  let targetRequestId = 0;
  let originalRow: Record<string, unknown> | null = null;

  try {
    // ── 身份核对（默认拒绝） ──────────────────────────────────────────────
    const serverRows: unknown = await dataSource.query('SELECT @@server_uuid AS serverUuid');
    const serverUuid = (serverRows as Array<{ serverUuid: string }>)[0]?.serverUuid;
    if (serverUuid === undefined) {
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
    const markerRows: unknown = await dataSource.query(
      'SELECT marker_key, marker_value FROM task09_disposable_marker',
    );
    assertDisposableMarker(
      (markerRows as Array<Record<string, unknown>>).map((row) => ({
        markerKey: text(row['marker_key']),
        markerValue: text(row['marker_value']),
      })),
      auth.disposableMarker,
    );

    // ── 选定一条本公司工单作为夹具（不造新行：避开必填列与 CHECK 约束） ────
    const candidateRows: unknown = await dataSource.query(
      'SELECT id, customer_account_id, record_uuid, content_md, closure_status, closed_at, ' +
        'closure_reason, handling_result, handling_status, handling_recorded_at, handling_ended_at, ' +
        'current_revision_no FROM repair_request WHERE owner_organization_id = ? ORDER BY id ASC LIMIT 1',
      [auth.organizationId],
    );
    const candidate = (candidateRows as Array<Record<string, unknown>>)[0];
    if (candidate === undefined) {
      throw new Error('本公司没有可用作夹具的工单，拒绝运行');
    }
    targetRequestId = Number(candidate['id']);
    originalRow = { ...candidate };

    // 结单化 + 写入本地正文 A（**收尾时精确恢复原值**）。
    // 不动处理事实：库级 CHECK（`chk_repair_request_handling_requires_accepted`）
    // 要求"有处理结果 ⇒ 必须已接单"，改处理事实会撞约束。
    const recordUuid = randomUUID();
    // 版本可信前提：来源记录的 `current_revision_no` 必须 > 0
    // （`versionTrusted = currentRevisionNo > 0`，否则裁决按"版本不可核验"拒绝）。
    const localVersion = Math.max(Number(originalRow['current_revision_no'] ?? 0), 1);
    await dataSource.query(
      'UPDATE repair_request SET record_uuid = ?, content_md = ?, closure_status = ?, closed_at = ?, ' +
        'current_revision_no = ? WHERE id = ?',
      [recordUuid, LOCAL_CONTENT, 'CLOSED', new Date(), localVersion, targetRequestId],
    );

    // ── 造一条冲突行：本地快照 A / 云端快照 B ──────────────────────────────
    const conflictId = randomUUID();
    ownedConflictIds.push(conflictId);
    // 本地快照必须与**业务行现值**逐字段一致（只读投影靠它判定"这次裁决没改业务行"）
    const localBody: Record<string, unknown> = { content_md: LOCAL_CONTENT };
    if (originalRow['handling_result'] !== null && originalRow['handling_result'] !== undefined) {
      localBody['handling_result'] = originalRow['handling_result'];
    }
    if (originalRow['handling_status'] !== null && originalRow['handling_status'] !== undefined) {
      localBody['handling_status'] = originalRow['handling_status'];
    }
    const localSnapshot = JSON.stringify({
      schema_version: 1,
      resource_type: 'REPAIR_REQUEST',
      body: localBody,
    });
    const cloudSnapshot = JSON.stringify({
      schema_version: 1,
      resource_type: 'REPAIR_REQUEST',
      body: {
        content_md: CLOUD_CONTENT,
        handling_result: 'UNREPAIRABLE',
        handling_status: 'UNRESOLVED',
      },
    });
    await dataSource.query(
      'INSERT INTO sync_conflict (conflict_id, record_uuid, organization_id, resource_type, version_no, ' +
        'local_version, cloud_version, displayed_cloud_version, decision, local_resolution_state, ' +
        'local_snapshot, cloud_snapshot, conflict_reason, status, created_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, NOW(3))',
      [
        conflictId,
        recordUuid,
        auth.organizationId,
        'REPAIR_REQUEST',
        1,
        // 本地版本必须是来源记录的**当前版本**（裁决的版本新鲜度前提）
        localVersion,
        localVersion + 1,
        localVersion + 1,
        localSnapshot,
        cloudSnapshot,
        '任务09 P1-4 取证：本地与云端内容不一致',
        'PENDING',
      ],
    );

    // ── 裁决「使用云端」（已结单 ⇒ 只读采用） ──────────────────────────────
    const actorRows: unknown = await dataSource.query(
      'SELECT m.account_id AS account_id FROM organization_membership m ' +
        'JOIN base_user_account a ON a.id = m.account_id ' +
        "WHERE m.organization_id = ? AND m.status = 'ACTIVE' AND a.status = 'ACTIVE' " +
        "AND m.member_role = 'SUPER_ADMIN' AND a.admin_level = 1 ORDER BY m.id ASC LIMIT 1",
      [auth.organizationId],
    );
    const actorAccountId = Number((actorRows as Array<{ account_id: number }>)[0]?.account_id ?? 0);
    if (!Number.isInteger(actorAccountId) || actorAccountId <= 0) {
      throw new Error('找不到本公司有效的一级管理员账号，拒绝运行');
    }
    const adminSession = {
      accountId: actorAccountId,
      roles: ['SUPER_ADMIN'],
      activeRole: 'SUPER_ADMIN',
      adminLevel: 1,
      customerOrganizationId: null,
    } as unknown as UsecaseSession;
    const resolution = await resolveUsecase.execute({
      session: adminSession,
      conflictId,
      action: 'CLOUD',
      displayedCloudVersion: localVersion + 1,
    });
    check(
      '裁决完成：已结单冲突「使用云端」返回已解决',
      resolution.outcome === 'resolved',
      `outcome=${resolution.outcome}`,
    );

    // ── 真实 GraphQL 读来源页（客户入口：session 为该工单的真实客户账号） ──
    const customerAccountId = Number(originalRow['customer_account_id'] ?? 0);
    const customerSession = {
      accountId: customerAccountId,
      roles: ['CUSTOMER'],
      activeRole: 'CUSTOMER',
      adminLevel: 0,
      customerOrganizationId: null,
    } as unknown as UsecaseSession;
    // 来源页读回：走**真实查询服务**（生产读路径：权限判定 + 只读投影 + 真实库）
    const queryService = moduleRef.get(RepairRequestQueryService);
    const queryResult = await queryService.findDetail({
      requestId: targetRequestId,
      session: customerSession,
      scope: 'CUSTOMER',
    });
    const payload = {
      contentMd: queryResult.contentMd,
      handlingResult: queryResult.handlingResult,
      handlingStatus: queryResult.handlingStatus,
    };
    check(
      'V1 来源页（真实读路径）读回**云端正文**',
      payload.contentMd === CLOUD_CONTENT,
      `读回 contentMd=${text(payload.contentMd ?? null)}`,
    );
    check(
      'V2 来源页的处理事实也来自云端',
      String(payload.handlingResult ?? '') === 'UNREPAIRABLE' &&
        String(payload.handlingStatus ?? '') === 'UNRESOLVED',
      `handlingResult=${text(payload.handlingResult ?? null)}，handlingStatus=${text(payload.handlingStatus ?? null)}`,
    );

    // ── 只读采用不得改业务行／历史／快照 ─────────────────────────────────
    const afterRows: unknown = await dataSource.query(
      'SELECT content_md, handling_result, handling_status FROM repair_request WHERE id = ?',
      [targetRequestId],
    );
    const after = (afterRows as Array<Record<string, unknown>>)[0];
    check(
      'V3 业务行没被改写（只读采用不写业务记录）',
      text(after?.['content_md']) === LOCAL_CONTENT,
      `repair_request.content_md=${text(after?.['content_md'] ?? null)}`,
    );
    const revisionRows: unknown = await dataSource.query(
      'SELECT COUNT(*) AS c FROM repair_request_revision WHERE request_id = ?',
      [targetRequestId],
    );
    const revisionCount = Number((revisionRows as Array<{ c: number | string }>)[0]?.c ?? -1);
    check(
      'V4 历史没被改写（未新增修订行）',
      revisionCount === 0,
      `repair_request_revision 行数=${revisionCount}（本轮不应新增）`,
    );
    const snapshotRows: unknown = await dataSource.query(
      'SELECT local_snapshot, cloud_snapshot, decision, status FROM sync_conflict WHERE conflict_id = ?',
      [conflictId],
    );
    const snapshot = (snapshotRows as Array<Record<string, unknown>>)[0];
    check(
      'V5 云端原记录与原本地副本都没被改写',
      text(snapshot?.['local_snapshot']) === localSnapshot &&
        text(snapshot?.['cloud_snapshot']) === cloudSnapshot,
      `local_snapshot 一致=${text(snapshot?.['local_snapshot']) === localSnapshot}，` +
        `cloud_snapshot 一致=${text(snapshot?.['cloud_snapshot']) === cloudSnapshot}`,
    );

    // ── V6 无权用户读不到该工单 ───────────────────────────────────────────
    const foreignSession = {
      accountId: 999999999,
      roles: ['CUSTOMER'],
      activeRole: 'CUSTOMER',
      adminLevel: 0,
      customerOrganizationId: null,
    } as unknown as UsecaseSession;
    let foreignRejected = false;
    let foreignReason = '';
    try {
      await queryService.findDetail({
        requestId: targetRequestId,
        session: foreignSession,
        scope: 'CUSTOMER',
      });
    } catch (error) {
      foreignRejected = true;
      foreignReason = error instanceof Error ? error.message : String(error);
    }
    check(
      'V6 无权用户读不到该工单（读不到云端内容）',
      foreignRejected,
      `越权读取：${foreignRejected ? `受控拒绝（${foreignReason}）` : '竟然成功'}`,
    );
  } finally {
    // ── 收尾：精确恢复原值 + 删除本轮冲突行 ────────────────────────────────
    if (originalRow !== null && targetRequestId > 0) {
      try {
        await dataSource.query(
          'UPDATE repair_request SET record_uuid = ?, content_md = ?, closure_status = ?, closed_at = ?, ' +
            'closure_reason = ?, handling_result = ?, handling_status = ?, handling_recorded_at = ?, ' +
            'handling_ended_at = ?, current_revision_no = ? WHERE id = ?',
          [
            originalRow['record_uuid'] ?? null,
            originalRow['content_md'] ?? null,
            originalRow['closure_status'] ?? null,
            originalRow['closed_at'] ?? null,
            originalRow['closure_reason'] ?? null,
            originalRow['handling_result'] ?? null,
            originalRow['handling_status'] ?? null,
            originalRow['handling_recorded_at'] ?? null,
            originalRow['handling_ended_at'] ?? null,
            originalRow['current_revision_no'] ?? null,
            targetRequestId,
          ],
        );
      } catch {
        // 恢复失败只影响本地夹具，由人工核对发现（不掩盖主结论）
      }
    }
    for (const conflictId of ownedConflictIds) {
      try {
        await dataSource.query('DELETE FROM sync_conflict WHERE conflict_id = ?', [conflictId]);
      } catch {
        // 同上
      }
    }
    // moduleRef.close() 会一并关闭 DataSource（再单独 destroy 会抛未连接错误）
    await moduleRef.close();
  }

  const failed = assertions.filter((item) => !item.passed);
  process.stdout.write(`\n断言：${assertions.length} 项，失败 ${failed.length} 项\n`);
  for (const item of failed) {
    process.stdout.write(`  ✗ ${item.name}：${item.detail}\n`);
  }
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
