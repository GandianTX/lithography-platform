// scripts/task09-local-resolution-document-check.ts
/**
 * 任务 09 · 「保留本地」**资料分支**取证脚本（第 05 项 · P1-5／G10）。
 *
 * 目的：把"需求内可写资源（资料）不因缺实现直接拒绝，且无权与只读仍安全"
 * 从**结构性推断**变成**真实入口实测结论**。
 *
 * 真实链路（不 mock、不只断言"不调用写入器"）：
 *   裁决入口 → `ApplyLocalSyncConflictResolutionUsecase` → 中立契约 →
 *   资料域受控写入（行锁 → 只读守卫 → 版本条件 → 修订历史）→ **真实库**。
 *
 * | 断言 | 期望 |
 * | --- | --- |
 * | V1 裁决完成 | outcome=resolved |
 * | V2 资料行版本推进 ＋1（受控修订落库） | current_revision_no = 原值 + 1 |
 * | V3 资料正文／标题／说明未被改写（保留本地） | 与原值逐项一致 |
 * | V4 修订历史**只追加**一行且带裁决留痕 | 新增 1 行（修改人＋原因含"保留本地"） |
 * | V5 冲突事实落 LOCAL | decision=LOCAL／status=RESOLVED／WRITTEN／确认人=裁决人 |
 * | V6 两份快照原文未被改写 | local_snapshot／cloud_snapshot 不变 |
 * | V7 记录人／工程师无写权 → 受控拒绝 | 不改资料行、不新增修订行 |
 * | V8 二级管理员无资料正文写权 → 受控拒绝 | 同上（库中无该账号时如实标注跳过） |
 * | V9 报告（只读资源）仍显式拒绝 | LOCAL_RESOLUTION_RESOURCE_UNSUPPORTED |
 *
 * 纪律：复用恢复自检同一套安全约束（一次性库、预期实例身份、一次性库标识、
 * 受控文件根、安装／公司标识、测试授权）；只改**本轮选定的一条**资料并在收尾时
 * **精确恢复原值**，只删**本轮创建**的冲突行与本轮新增的修订行。
 */

import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import type { UsecaseSession } from '@app-types/auth/session.types';

import { PERMISSION_ERROR, SYNC_ERROR } from '@core/common/errors/domain-error';

import { AppConfigModule } from '@src/infrastructure/config/config.module';
import { loadExplicitEnvConfig } from '@src/infrastructure/database/incremental-migration';
import { TypeOrmTransactionModule } from '@src/infrastructure/database/transaction/typeorm-transaction.module';
import { LocalRuntimeStorageModule } from '@src/infrastructure/file-storage/local-runtime-storage.module';
import { LoggerModule } from '@src/infrastructure/logger/logger.module';
import { AdminDocumentDatabaseUsecasesModule } from '@src/usecases/admin-document-database/admin-document-database-usecases.module';
import { ApplyLocalSyncConflictResolutionUsecase } from '@src/usecases/admin-document-database/apply-local-sync-conflict-resolution.usecase';

import {
  assertDisposableMarker,
  assertServerIdentity,
  readSelfcheckAuthorization,
} from './task09-restore-selfcheck.safety';
import { createAssertionCollector, loadEnvFile, text } from './task09-script-utils';

const { assertions, check } = createAssertionCollector();

const CLOUD_TITLE = '云端资料标题';
const CLOUD_DESCRIPTION = '云端说明';
const CLOUD_CONTENT = '云端正文（本地快照之外的版本）';

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
      AdminDocumentDatabaseUsecasesModule,
    ],
  }).compile();

  const dataSource = moduleRef.get(DataSource);
  const applyLocalUsecase = moduleRef.get(ApplyLocalSyncConflictResolutionUsecase);

  const ownedConflictIds: string[] = [];
  let targetDocumentId = 0;
  let originalRow: Record<string, unknown> | null = null;
  let originalRevisionNo = 0;

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

    // ── 选定一条本公司资料作为夹具（不造新行：避开必填列与 CHECK 约束） ────
    // 优先选**已有管理修订行**的资料：生效正文按「管理修订 > 冻结报告 > 自身正文」解析，
    // 修订行缺失属数据定式破坏（来源域失败关闭），夹具不能制造这种定式破坏。
    const selectCandidateSql =
      'SELECT d.id, d.record_uuid, d.title, d.description, d.content_text, d.document_type, d.schema_version, ' +
      'd.publication_status, d.ownership_status, d.deprecated, d.deleted_at, d.current_revision_no, ' +
      'd.source_kind, d.source_report_id, d.source_report_version_id, d.owner_organization_id, d.created_by_account_id ' +
      'FROM reference_document d WHERE d.owner_organization_id = ? AND d.deprecated = 0 AND d.deleted_at IS NULL ';
    const candidateRows: unknown = await dataSource.query(
      selectCandidateSql +
        'AND EXISTS (SELECT 1 FROM reference_document_revision r WHERE r.document_id = d.id AND r.revision_no = d.current_revision_no) ' +
        "ORDER BY (d.source_kind = 'MANUAL') DESC, d.id ASC LIMIT 1",
      [auth.organizationId],
    );
    let candidate = (candidateRows as Array<Record<string, unknown>>)[0];
    let needsFixtureRevisionRow = false;
    if (candidate === undefined) {
      const fallbackRows: unknown = await dataSource.query(
        selectCandidateSql + "ORDER BY (d.source_kind = 'MANUAL') DESC, d.id ASC LIMIT 1",
        [auth.organizationId],
      );
      candidate = (fallbackRows as Array<Record<string, unknown>>)[0];
      needsFixtureRevisionRow = candidate !== undefined;
    }
    if (candidate === undefined) {
      throw new Error('本公司没有可用作夹具的资料，拒绝运行');
    }
    targetDocumentId = Number(candidate['id']);
    originalRow = { ...candidate };
    originalRevisionNo = Number(originalRow['current_revision_no'] ?? 0);

    // 夹具改造成"可写且版本可核验"的资料（**收尾时精确恢复原值**）：
    // - 版本可信前提：`current_revision_no > 0`（否则裁决按"版本不可核验"拒绝）；
    // - 只读守卫前提：ONLINE ＋ CONFIRMED ＋ 未软删。
    const recordUuid = randomUUID();
    const localVersion = Math.max(originalRevisionNo, 1);
    await dataSource.query(
      'UPDATE reference_document SET record_uuid = ?, publication_status = ?, ownership_status = ?, ' +
        'current_revision_no = ? WHERE id = ?',
      [recordUuid, 'ONLINE', 'CONFIRMED', localVersion, targetDocumentId],
    );

    const localBody: Record<string, unknown> = {
      schema_version: originalRow['schema_version'] ?? 1,
      title: originalRow['title'] ?? null,
      description: originalRow['description'] ?? null,
      content_text: originalRow['content_text'] ?? null,
      current_revision_no: localVersion,
    };
    const localSnapshot = JSON.stringify({
      schema_version: 1,
      resource_type: 'REFERENCE_DOCUMENT',
      record_uuid: recordUuid,
      version_no: localVersion,
      body: localBody,
    });
    const cloudSnapshot = JSON.stringify({
      schema_version: 1,
      resource_type: 'REFERENCE_DOCUMENT',
      record_uuid: recordUuid,
      version_no: localVersion + 1,
      body: {
        schema_version: 1,
        title: CLOUD_TITLE,
        description: CLOUD_DESCRIPTION,
        content_text: CLOUD_CONTENT,
        current_revision_no: localVersion + 1,
      },
    });

    // ── 裁决人：本公司有效的一级管理员（资料正文修订只对一级管理员开放） ────
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
      adminOrganizationId: null,
      customerOrganizationId: null,
    } as unknown as UsecaseSession;

    // 夹具资料没有管理修订行时补一条（生效正文按「管理修订优先」解析，
    // 缺修订行会被来源域失败关闭）；收尾时随本轮新增修订行一并删除。
    if (needsFixtureRevisionRow) {
      const fixtureSnapshot = JSON.stringify({
        schema_version: originalRow['schema_version'] ?? 1,
        title: originalRow['title'] ?? null,
        documentType: originalRow['document_type'] ?? null,
        description: originalRow['description'] ?? null,
        contentText: originalRow['content_text'] ?? null,
        publicationStatus: 'ONLINE',
        ownershipStatus: 'CONFIRMED',
        createdByAccountId: originalRow['created_by_account_id'] ?? null,
        ownerOrganizationId: auth.organizationId,
      });
      await dataSource.query(
        'INSERT INTO reference_document_revision (document_id, revision_no, before_snapshot, after_snapshot, ' +
          'actor_account_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, NOW(3))',
        [
          targetDocumentId,
          localVersion,
          fixtureSnapshot,
          fixtureSnapshot,
          actorAccountId,
          '任务09 P1-5 取证：夹具管理修订（收尾删除）',
        ],
      );
    }

    // ── 冲突行：一条（库级唯一键 uk_sync_conflict_scope 限制同一来源只能有一条） ──
    // 各条断言**复用**这一条：裁决前把它重置回 PENDING（我们自己的行，可控）。
    const conflictId = randomUUID();
    ownedConflictIds.push(conflictId);
    const resetConflict = async (options: { resourceType?: string } = {}): Promise<void> => {
      await dataSource.query(
        'UPDATE sync_conflict SET resource_type = ?, status = ?, decision = NULL, local_resolution_state = NULL, ' +
          'confirmed_by_account_id = NULL, confirmed_at = NULL, local_version = ?, cloud_version = ?, ' +
          'displayed_cloud_version = ?, local_snapshot = ?, cloud_snapshot = ? WHERE conflict_id = ?',
        [
          options.resourceType ?? 'REFERENCE_DOCUMENT',
          'PENDING',
          localVersion,
          localVersion + 1,
          localVersion + 1,
          localSnapshot,
          cloudSnapshot,
          conflictId,
        ],
      );
    };
    await dataSource.query(
      'INSERT INTO sync_conflict (conflict_id, record_uuid, organization_id, resource_type, version_no, ' +
        'local_version, cloud_version, displayed_cloud_version, decision, local_resolution_state, ' +
        'local_snapshot, cloud_snapshot, conflict_reason, status, created_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, NOW(3))',
      [
        conflictId,
        recordUuid,
        auth.organizationId,
        'REFERENCE_DOCUMENT',
        localVersion,
        localVersion,
        localVersion + 1,
        localVersion + 1,
        localSnapshot,
        cloudSnapshot,
        '任务09 P1-5 取证：本地与云端资料内容不一致',
        'PENDING',
      ],
    );
    await resetConflict();

    const readDocumentRow = async (): Promise<Record<string, unknown>> => {
      const rows: unknown = await dataSource.query(
        'SELECT title, description, content_text, current_revision_no, publication_status, ownership_status ' +
          'FROM reference_document WHERE id = ?',
        [targetDocumentId],
      );
      return (rows as Array<Record<string, unknown>>)[0] ?? {};
    };
    const countRevisions = async (): Promise<number> => {
      const rows: unknown = await dataSource.query(
        'SELECT COUNT(*) AS c FROM reference_document_revision WHERE document_id = ?',
        [targetDocumentId],
      );
      return Number((rows as Array<{ c: number | string }>)[0]?.c ?? -1);
    };
    /** 执行一次裁决并捕获受控拒绝（返回错误码） */
    const captureRejection = async (
      session: UsecaseSession,
      conflictId: string,
    ): Promise<{ rejected: boolean; code: string }> => {
      try {
        await applyLocalUsecase.execute({ session, conflictId });
        return { rejected: false, code: 'NONE' };
      } catch (error) {
        const code =
          typeof error === 'object' && error !== null && 'code' in error
            ? String(error.code)
            : 'UNKNOWN';
        return { rejected: true, code };
      }
    };

    // ── V1～V6：一级管理员「保留本地」资料冲突 ────────────────────────────
    const revisionsBefore = await countRevisions();
    const resolution = await applyLocalUsecase.execute({
      session: adminSession,
      conflictId,
    });
    check(
      'V1 裁决完成：资料冲突「保留本地」返回已解决',
      resolution.outcome === 'resolved',
      `outcome=${resolution.outcome}`,
    );

    const afterRow = await readDocumentRow();
    check(
      'V2 资料行版本推进 ＋1（受控修订落库）',
      Number(afterRow['current_revision_no']) === localVersion + 1,
      `current_revision_no=${text(afterRow['current_revision_no'] ?? null)}（期望 ${localVersion + 1}）`,
    );
    check(
      'V3 资料正文／标题／说明未被改写（保留本地＝保留本地内容）',
      text(afterRow['title']) === text(originalRow['title'] ?? null) &&
        text(afterRow['description']) === text(originalRow['description'] ?? null) &&
        text(afterRow['content_text']) === text(originalRow['content_text'] ?? null),
      `title 一致=${text(afterRow['title'] ?? null) === text(originalRow['title'] ?? null)}，` +
        `description 一致=${text(afterRow['description'] ?? null) === text(originalRow['description'] ?? null)}，` +
        `content_text 一致=${text(afterRow['content_text'] ?? null) === text(originalRow['content_text'] ?? null)}`,
    );

    const revisionsAfter = await countRevisions();
    check(
      'V4 修订历史只追加一行且带裁决留痕',
      revisionsAfter === revisionsBefore + 1,
      `reference_document_revision 行数 ${revisionsBefore} → ${revisionsAfter}`,
    );
    const revisionRows: unknown = await dataSource.query(
      'SELECT revision_no, actor_account_id, reason FROM reference_document_revision ' +
        'WHERE document_id = ? ORDER BY revision_no DESC LIMIT 1',
      [targetDocumentId],
    );
    const latestRevision = (revisionRows as Array<Record<string, unknown>>)[0];
    check(
      'V4b 修订行记录了裁决人与「保留本地」原因',
      Number(latestRevision?.['actor_account_id']) === actorAccountId &&
        text(latestRevision?.['reason']).includes('保留本地') &&
        Number(latestRevision?.['revision_no']) === localVersion + 1,
      `actor=${text(latestRevision?.['actor_account_id'] ?? null)}，` +
        `reason=${text(latestRevision?.['reason'] ?? null)}，` +
        `revision_no=${text(latestRevision?.['revision_no'] ?? null)}`,
    );

    const conflictRows: unknown = await dataSource.query(
      'SELECT decision, status, local_resolution_state, confirmed_by_account_id, local_snapshot, cloud_snapshot ' +
        'FROM sync_conflict WHERE conflict_id = ?',
      [conflictId],
    );
    const conflictRow = (conflictRows as Array<Record<string, unknown>>)[0];
    check(
      'V5 冲突事实落 LOCAL（决策、状态、幂等标记、确认人）',
      text(conflictRow?.['decision']) === 'LOCAL' &&
        text(conflictRow?.['status']) === 'RESOLVED' &&
        text(conflictRow?.['local_resolution_state']) === 'WRITTEN' &&
        Number(conflictRow?.['confirmed_by_account_id']) === actorAccountId,
      `decision=${text(conflictRow?.['decision'] ?? null)}，status=${text(conflictRow?.['status'] ?? null)}，` +
        `state=${text(conflictRow?.['local_resolution_state'] ?? null)}，` +
        `confirmed_by=${text(conflictRow?.['confirmed_by_account_id'] ?? null)}`,
    );
    check(
      'V6 两份快照原文未被改写',
      text(conflictRow?.['local_snapshot']) === localSnapshot &&
        text(conflictRow?.['cloud_snapshot']) === cloudSnapshot,
      `local_snapshot 一致=${text(conflictRow?.['local_snapshot'] ?? null) === localSnapshot}，` +
        `cloud_snapshot 一致=${text(conflictRow?.['cloud_snapshot'] ?? null) === cloudSnapshot}`,
    );

    // ── V7：记录人／工程师没有资料正文修订权 → 受控拒绝 ──────────────────
    const engineerRows: unknown = await dataSource.query(
      'SELECT m.account_id AS account_id FROM organization_membership m ' +
        'JOIN base_user_account a ON a.id = m.account_id ' +
        "WHERE m.organization_id = ? AND m.status = 'ACTIVE' AND a.status = 'ACTIVE' " +
        "AND m.member_role = 'ENGINEER' ORDER BY m.id ASC LIMIT 1",
      [auth.organizationId],
    );
    const engineerAccountId = Number(
      (engineerRows as Array<{ account_id: number }>)[0]?.account_id ?? 0,
    );
    if (Number.isInteger(engineerAccountId) && engineerAccountId > 0) {
      const engineerSession = {
        accountId: engineerAccountId,
        roles: ['ENGINEER'],
        activeRole: 'ENGINEER',
        adminLevel: null,
        adminOrganizationId: null,
        customerOrganizationId: null,
      } as unknown as UsecaseSession;
      const engineerConflictId = conflictId;
      await resetConflict();
      const revisionCountBefore = await countRevisions();
      const engineerRejected = await captureRejection(engineerSession, engineerConflictId);
      const revisionCountAfter = await countRevisions();
      check(
        'V7 记录人／工程师无资料写权 → 受控拒绝（不改资料行、不新增修订行）',
        engineerRejected.rejected &&
          engineerRejected.code === PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS &&
          Number((await readDocumentRow())['current_revision_no']) === localVersion + 1 &&
          revisionCountAfter === revisionCountBefore,
        `拒绝=${engineerRejected.rejected}，code=${engineerRejected.code}，` +
          `修订行数=${revisionCountAfter}（期望 ${revisionCountBefore}）`,
      );
    } else {
      process.stdout.write('  · V7 跳过：隔离库中没有本公司有效工程师账号（如实标注，不计断言）\n');
    }

    // ── V8：二级管理员没有资料正文修订权 → 受控拒绝 ───────────────────────
    const secondLevelRows: unknown = await dataSource.query(
      'SELECT m.account_id AS account_id FROM organization_membership m ' +
        'JOIN base_user_account a ON a.id = m.account_id ' +
        "WHERE m.organization_id = ? AND m.status = 'ACTIVE' AND a.status = 'ACTIVE' " +
        "AND m.member_role = 'SUPER_ADMIN' AND a.admin_level = 2 ORDER BY m.id ASC LIMIT 1",
      [auth.organizationId],
    );
    const secondLevelAccountId = Number(
      (secondLevelRows as Array<{ account_id: number }>)[0]?.account_id ?? 0,
    );
    if (Number.isInteger(secondLevelAccountId) && secondLevelAccountId > 0) {
      const secondLevelSession = {
        accountId: secondLevelAccountId,
        roles: ['SUPER_ADMIN'],
        activeRole: 'SUPER_ADMIN',
        adminLevel: 2,
        adminOrganizationId: auth.organizationId,
        customerOrganizationId: null,
      } as unknown as UsecaseSession;
      const secondLevelConflictId = conflictId;
      await resetConflict();
      const revisionCountBefore = await countRevisions();
      const secondLevelRejected = await captureRejection(secondLevelSession, secondLevelConflictId);
      const revisionCountAfter = await countRevisions();
      check(
        'V8 二级管理员无资料正文写权 → 受控拒绝（不改资料行、不新增修订行）',
        secondLevelRejected.rejected &&
          secondLevelRejected.code === PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS &&
          Number((await readDocumentRow())['current_revision_no']) === localVersion + 1 &&
          revisionCountAfter === revisionCountBefore,
        `拒绝=${secondLevelRejected.rejected}，code=${secondLevelRejected.code}，` +
          `修订行数=${revisionCountAfter}（期望 ${revisionCountBefore}）`,
      );
    } else {
      process.stdout.write(
        '  · V8 跳过：隔离库中没有本公司有效二级管理员账号（如实标注，不计断言）\n',
      );
    }

    // ── V9：报告（只读资源）仍显式拒绝 ───────────────────────────────────
    const reportConflictId = conflictId;
    await resetConflict({ resourceType: 'MAINTENANCE_REPORT' });
    const revisionCountBefore = await countRevisions();
    const reportRejected = await captureRejection(adminSession, reportConflictId);
    const revisionCountAfter = await countRevisions();
    check(
      'V9 报告（只读资源）仍显式拒绝，不写任何事实',
      reportRejected.rejected &&
        reportRejected.code === SYNC_ERROR.LOCAL_RESOLUTION_RESOURCE_UNSUPPORTED &&
        Number((await readDocumentRow())['current_revision_no']) === localVersion + 1 &&
        revisionCountAfter === revisionCountBefore,
      `拒绝=${reportRejected.rejected}，code=${reportRejected.code}，` +
        `修订行数=${revisionCountAfter}（期望 ${revisionCountBefore}）`,
    );
    // ── V10～V12：工单既有入口回归（「保留本地」在真实链上不再被"无变化"拒绝） ──
    const requestRows: unknown = await dataSource.query(
      'SELECT id, record_uuid, content_md, closure_status, closed_at, closure_reason, handling_result, ' +
        'handling_status, handling_recorded_at, handling_ended_at, current_revision_no ' +
        'FROM repair_request WHERE owner_organization_id = ? ORDER BY id ASC LIMIT 1',
      [auth.organizationId],
    );
    const requestCandidate = (requestRows as Array<Record<string, unknown>>)[0];
    if (requestCandidate === undefined) {
      process.stdout.write('  · V10～V12 跳过：本公司没有可用作夹具的工单（如实标注，不计断言）\n');
    } else {
      const targetRequestId = Number(requestCandidate['id']);
      const originalRequestRow = { ...requestCandidate };
      const originalRequestRevisionNo = Number(originalRequestRow['current_revision_no'] ?? 0);
      const requestLocalVersion = Math.max(originalRequestRevisionNo, 1);
      const requestRecordUuid = randomUUID();
      const requestLocalContent = '## 本地工单正文 A\n任务09 P1-5 取证用的本地版本。';
      await dataSource.query(
        'UPDATE repair_request SET record_uuid = ?, content_md = ?, current_revision_no = ? WHERE id = ?',
        [requestRecordUuid, requestLocalContent, requestLocalVersion, targetRequestId],
      );
      const requestConflictId = randomUUID();
      ownedConflictIds.push(requestConflictId);
      await dataSource.query(
        'INSERT INTO sync_conflict (conflict_id, record_uuid, organization_id, resource_type, version_no, ' +
          'local_version, cloud_version, displayed_cloud_version, decision, local_resolution_state, ' +
          'local_snapshot, cloud_snapshot, conflict_reason, status, created_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, NOW(3))',
        [
          requestConflictId,
          requestRecordUuid,
          auth.organizationId,
          'REPAIR_REQUEST',
          requestLocalVersion,
          requestLocalVersion,
          requestLocalVersion + 1,
          requestLocalVersion + 1,
          JSON.stringify({
            schema_version: 1,
            resource_type: 'REPAIR_REQUEST',
            record_uuid: requestRecordUuid,
            version_no: requestLocalVersion,
            body: { schema_version: 1, content_md: requestLocalContent },
          }),
          JSON.stringify({
            schema_version: 1,
            resource_type: 'REPAIR_REQUEST',
            record_uuid: requestRecordUuid,
            version_no: requestLocalVersion + 1,
            body: { schema_version: 1, content_md: '云端工单正文 B' },
          }),
          '任务09 P1-5 取证：本地与云端工单内容不一致',
          'PENDING',
        ],
      );
      const requestRevisionsBefore: unknown = await dataSource.query(
        'SELECT COUNT(*) AS c FROM repair_request_revision WHERE request_id = ?',
        [targetRequestId],
      );
      const requestRevisionsBeforeCount = Number(
        (requestRevisionsBefore as Array<{ c: number | string }>)[0]?.c ?? -1,
      );
      const requestResolution = await applyLocalUsecase.execute({
        session: adminSession,
        conflictId: requestConflictId,
      });
      check(
        'V10 工单既有入口回归：「保留本地」裁决完成（不再被"未检测到需要修订的字段"拒绝）',
        requestResolution.outcome === 'resolved',
        `outcome=${requestResolution.outcome}`,
      );
      const requestAfterRows: unknown = await dataSource.query(
        'SELECT content_md, current_revision_no FROM repair_request WHERE id = ?',
        [targetRequestId],
      );
      const requestAfter = (requestAfterRows as Array<Record<string, unknown>>)[0];
      const requestRevisionsAfter: unknown = await dataSource.query(
        'SELECT COUNT(*) AS c FROM repair_request_revision WHERE request_id = ?',
        [targetRequestId],
      );
      const requestRevisionsAfterCount = Number(
        (requestRevisionsAfter as Array<{ c: number | string }>)[0]?.c ?? -1,
      );
      check(
        'V11 工单正文仍是本地内容、版本推进 ＋1、修订历史只追加一行',
        text(requestAfter?.['content_md']) === requestLocalContent &&
          Number(requestAfter?.['current_revision_no']) === requestLocalVersion + 1 &&
          requestRevisionsAfterCount === requestRevisionsBeforeCount + 1,
        `content_md=${text(requestAfter?.['content_md'] ?? null)}，` +
          `current_revision_no=${text(requestAfter?.['current_revision_no'] ?? null)}，` +
          `修订行数 ${requestRevisionsBeforeCount} → ${requestRevisionsAfterCount}`,
      );
      const requestConflictRows: unknown = await dataSource.query(
        'SELECT decision, status, local_resolution_state FROM sync_conflict WHERE conflict_id = ?',
        [requestConflictId],
      );
      const requestConflict = (requestConflictRows as Array<Record<string, unknown>>)[0];
      check(
        'V12 工单冲突事实落 LOCAL（决策、状态、幂等标记）',
        text(requestConflict?.['decision']) === 'LOCAL' &&
          text(requestConflict?.['status']) === 'RESOLVED' &&
          text(requestConflict?.['local_resolution_state']) === 'WRITTEN',
        `decision=${text(requestConflict?.['decision'] ?? null)}，` +
          `status=${text(requestConflict?.['status'] ?? null)}，` +
          `state=${text(requestConflict?.['local_resolution_state'] ?? null)}`,
      );
      // 工单夹具收尾：恢复原值并删除本轮新增修订行
      try {
        await dataSource.query(
          'UPDATE repair_request SET record_uuid = ?, content_md = ?, closure_status = ?, closed_at = ?, ' +
            'closure_reason = ?, handling_result = ?, handling_status = ?, handling_recorded_at = ?, ' +
            'handling_ended_at = ?, current_revision_no = ? WHERE id = ?',
          [
            originalRequestRow['record_uuid'] ?? null,
            originalRequestRow['content_md'] ?? null,
            originalRequestRow['closure_status'] ?? null,
            originalRequestRow['closed_at'] ?? null,
            originalRequestRow['closure_reason'] ?? null,
            originalRequestRow['handling_result'] ?? null,
            originalRequestRow['handling_status'] ?? null,
            originalRequestRow['handling_recorded_at'] ?? null,
            originalRequestRow['handling_ended_at'] ?? null,
            originalRequestRow['current_revision_no'] ?? null,
            targetRequestId,
          ],
        );
        await dataSource.query(
          'DELETE FROM repair_request_revision WHERE request_id = ? AND revision_no > ?',
          [targetRequestId, originalRequestRevisionNo],
        );
      } catch {
        // 恢复失败只影响本地夹具，由人工核对发现（不掩盖主结论）
      }
    }
  } finally {
    // ── 收尾：精确恢复原值 + 删除本轮冲突行与本轮新增修订行 ────────────────
    if (originalRow !== null && targetDocumentId > 0) {
      try {
        await dataSource.query(
          'UPDATE reference_document SET record_uuid = ?, title = ?, description = ?, content_text = ?, ' +
            'document_type = ?, schema_version = ?, publication_status = ?, ownership_status = ?, ' +
            'deprecated = ?, deleted_at = ?, current_revision_no = ?, source_kind = ?, source_report_id = ?, ' +
            'source_report_version_id = ?, owner_organization_id = ?, created_by_account_id = ? WHERE id = ?',
          [
            originalRow['record_uuid'] ?? null,
            originalRow['title'] ?? null,
            originalRow['description'] ?? null,
            originalRow['content_text'] ?? null,
            originalRow['document_type'] ?? null,
            originalRow['schema_version'] ?? null,
            originalRow['publication_status'] ?? null,
            originalRow['ownership_status'] ?? null,
            originalRow['deprecated'] ?? null,
            originalRow['deleted_at'] ?? null,
            originalRow['current_revision_no'] ?? null,
            originalRow['source_kind'] ?? null,
            originalRow['source_report_id'] ?? null,
            originalRow['source_report_version_id'] ?? null,
            originalRow['owner_organization_id'] ?? null,
            originalRow['created_by_account_id'] ?? null,
            targetDocumentId,
          ],
        );
      } catch {
        // 恢复失败只影响本地夹具，由人工核对发现（不掩盖主结论）
      }
    }
    // 只删本轮新增的修订行（revision_no 大于夹具原版本）
    try {
      await dataSource.query(
        'DELETE FROM reference_document_revision WHERE document_id = ? AND revision_no > ?',
        [targetDocumentId, originalRevisionNo],
      );
    } catch {
      // 同上
    }
    for (const id of ownedConflictIds) {
      try {
        await dataSource.query('DELETE FROM sync_conflict WHERE conflict_id = ?', [id]);
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
