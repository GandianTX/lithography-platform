/// <reference types="jest" />
import type { UsecaseSession } from '@app-types/auth/session.types';
import { MAINTENANCE_REPORT_ERROR, REPAIR_REQUEST_ERROR } from '@core/common/errors/domain-error';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { loadExplicitEnvConfig } from '@src/infrastructure/database/incremental-migration';
import { TypeOrmTransactionModule } from '@src/infrastructure/database/transaction/typeorm-transaction.module';
import { LoggerModule } from '@src/infrastructure/logger/logger.module';
import { LithographyModule } from '@src/modules/lithography/lithography.module';
import { join } from 'path';
import { DataSource, type QueryRunner } from 'typeorm';
import {
  assertFixtureIdsAvailable,
  assertRegisteredRowsAbsent,
  describeTeardownFailure,
  finalizeFixtureTeardown,
  OwnedFixtureLedger,
  prepareFixtureSetup,
  type ReferenceGuard,
  runOwnedFixtureCleanup,
  runTeardownSteps,
} from '../../../test/utils/e2e-owned-fixture';
import { ANALYSIS_OUTPUT_READER } from './ports/analysis-output-reader.contract';
import { AddMaintenanceReportAttachmentUsecase } from './add-maintenance-report-attachment.usecase';
import { MaintenanceReportUsecasesModule } from './maintenance-report-usecases.module';
import { RecordRepairRequestHandlingResultUsecase } from './record-repair-request-handling-result.usecase';
import { ReturnMaintenanceReportUsecase } from './return-maintenance-report.usecase';
import { SubmitMaintenanceReportUsecase } from './submit-maintenance-report.usecase';
import { UpdateMaintenanceReportDraftUsecase } from './update-maintenance-report-draft.usecase';

/**
 * 维修报告生命周期与并发实库验收。
 *
 * 默认跳过；启用时必须显式声明隔离库与清理许可：
 *   MAINTENANCE_REPORT_INTEGRATION=1 E2E_ALLOW_PHYSICAL_CLEANUP=1 \
 *     npx jest src/usecases/maintenance-report/maintenance-report.integration.spec.ts --runInBand
 *
 * 覆盖：草稿提交冻结 → 冻结后编辑拒绝 → 管理员退回 → 编辑后重提版本递增 →
 * 旧版本保留 → 并发编辑持锁期间提交冻结最新内容（先锁后读，无旧快照）。
 * AI 使用路径注入内存桩，不进入生产装配。
 */
const ENABLED = process.env.MAINTENANCE_REPORT_INTEGRATION === '1';
const describeIntegration = ENABLED ? describe : describe.skip;

const ENV_FILE = 'env/.env.e2e';
const ROUND_TAG = 'MAINTENANCE-REPORT-INT';

const FIXTURE = {
  org: { id: 9904401, code: 'S5MR_ORG' },
  engineer: 9904402,
  admin: 9904403,
  customer: 9904404,
  model: { id: 9904405, code: 'S5MR-MODEL' },
  repairRequest: 9904406,
  reportLifecycle: 9904407,
  alarm: 9904408,
  step: 9904409,
  reportConcurrent: 9904410,
  concurrentAlarm: 9904411,
  concurrentStep: 9904412,
  repairRequestConcurrent: 9904413,
  handlingRequest: 9904414,
  repairRequestAttachment: 9904415,
  reportAttachment: 9904416,
  alarmAttachment: 9904417,
  stepAttachment: 9904418,
  externalAttachment: 9904419,
  externalAttachmentInsertFail: 9904420,
  externalAttachmentAssertFail: 9904421,
  externalAttachmentCleanupFail: 9904422,
  externalAttachmentNormal: 9904423,
} as const;

const engineerSession: UsecaseSession = {
  accountId: FIXTURE.engineer,
  roles: ['ENGINEER'],
  activeRole: 'ENGINEER',
} as UsecaseSession;

const adminSession: UsecaseSession = {
  accountId: FIXTURE.admin,
  roles: ['SUPER_ADMIN'],
  activeRole: 'SUPER_ADMIN',
} as UsecaseSession;

jest.setTimeout(180_000);

describeIntegration('维修报告生命周期与并发实库验收', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let submitUsecase: SubmitMaintenanceReportUsecase;
  let updateUsecase: UpdateMaintenanceReportDraftUsecase;
  let addAttachmentUsecase: AddMaintenanceReportAttachmentUsecase;
  let returnUsecase: ReturnMaintenanceReportUsecase;
  let handlingUsecase: RecordRepairRequestHandlingResultUsecase;
  const analysisReader = { read: jest.fn() };
  let actualDatabase = '';
  let setupAllowed = false;
  // 记录本轮提交结果的版本 ID，供后续退回审核登记精确关联
  let lifecycleVersionId = 0;
  // 版本附件回归所提交的版本 ID，供账本外模拟记录用例复用
  let attachmentVersionId = 0;
  const ledger = new OwnedFixtureLedger(ROUND_TAG);

  const query = async <T = Record<string, unknown>>(
    sql: string,
    parameters?: unknown[],
  ): Promise<T[]> => dataSource.query(sql, parameters);

  // mysql2 对 JSON 列可能直接返回对象，统一兼容两种形态
  const parsePayload = (value: unknown): Record<string, unknown> =>
    typeof value === 'string'
      ? (JSON.parse(value) as Record<string, unknown>)
      : ((value ?? {}) as Record<string, unknown>);

  /**
   * 夹具创建一律在写入成功并取得实际主键后，立即按**写入输入与已知业务结果**同步登记；
   * 成功后的 SELECT 只用于需要时显式核验，不参与首次登记，避免回读失败让已提交行从账本消失。
   * 数据库生成值（如 NOW(3)）和日期列驱动形态不作为预期值登记。
   */

  /**
   * 提交结果返回的版本 ID 直接登记；版本附件只依据提交时已知的附件集合构造复合主键并逐行登记，
   * 无附件版本登记零条关联。全量关联查询只用于闭包核验发现账本外记录，不用于认领本轮资源。
   */
  const registerSubmittedVersion = (
    reportId: number,
    submitted: { versionId: number; versionNo: number },
    knownAttachments: readonly { id: number; sortOrder: number; description: string | null }[],
  ): void => {
    ledger.register({
      table: 'maintenance_report_version',
      key: { id: submitted.versionId },
      expected: {
        id: submitted.versionId,
        report_id: reportId,
        version_no: submitted.versionNo,
        change_kind: 'SUBMIT',
        submitted_by_account_id: engineerSession.accountId,
      },
    });
    for (const attachment of knownAttachments) {
      const key = { version_id: submitted.versionId, attachment_id: attachment.id };
      ledger.register({
        table: 'maintenance_report_version_attachment',
        key,
        expected: {
          ...key,
          report_id: reportId,
          sort_order: attachment.sortOrder,
          description_snapshot: attachment.description,
          // 提交前发布选择恒为 0（业务常量，不来自查询回读）
          publish_flag: 0,
        },
      });
    }
  };

  /** 退回审核按返回的审核 ID 登记；预期版本来自本轮已登记的提交结果 */
  const registerReturnedReview = (
    reportId: number,
    versionId: number,
    reviewed: { reviewId: number },
    comment: string,
  ): void => {
    ledger.register({
      table: 'maintenance_report_review',
      key: { id: reviewed.reviewId },
      expected: {
        id: reviewed.reviewId,
        report_id: reportId,
        version_id: versionId,
        decision: 'RETURN',
        comment,
        reviewed_by_account_id: adminSession.accountId,
      },
    });
  };

  /**
   * 引用闭包：只放行本轮登记的自有行，任何账本外关联都会让整批零删除。
   */
  const buildReferenceGuards = (): ReferenceGuard[] => {
    const reportIds = ledger.idsOf('maintenance_report');
    const versionIds = ledger.idsOf('maintenance_report_version');
    const requestIds = ledger.idsOf('repair_request');
    const modelIds = ledger.idsOf('equipment_model');
    const accountIds = ledger.idsOf('base_user_account');
    const orgIds = ledger.idsOf('organization');

    const referenceGuards: ReferenceGuard[] = [
      { table: 'engineer_response', column: 'request_id', ids: requestIds, label: '维修申请回复' },
      {
        table: 'maintenance_report',
        column: 'repair_request_id',
        ids: requestIds,
        label: '维修申请报告',
      },
      {
        table: 'maintenance_report_alarm',
        column: 'report_id',
        ids: reportIds,
        label: '报告报警',
      },
      {
        table: 'maintenance_report_step',
        column: 'report_id',
        ids: reportIds,
        label: '报告步骤',
      },
      {
        table: 'maintenance_report_version',
        column: 'report_id',
        ids: reportIds,
        label: '报告版本',
      },
      {
        table: 'maintenance_report_review',
        column: 'report_id',
        ids: reportIds,
        label: '报告审核',
      },
      {
        table: 'maintenance_report_attachment',
        column: 'report_id',
        ids: reportIds,
        label: '报告附件',
      },
      {
        table: 'maintenance_report_version_attachment',
        column: 'report_id',
        ids: reportIds,
        label: '版本附件报告',
      },
      {
        table: 'maintenance_report_version_attachment',
        column: 'version_id',
        ids: versionIds,
        label: '版本附件版本',
      },
      {
        table: 'maintenance_report_review',
        column: 'version_id',
        ids: versionIds,
        label: '审核关联版本',
      },
      {
        table: 'organization_membership',
        column: 'organization_id',
        ids: orgIds,
        label: '组织成员',
      },
      {
        table: 'repair_request',
        column: 'owner_organization_id',
        ids: orgIds,
        label: '组织维修申请',
      },
      {
        table: 'maintenance_report',
        column: 'owner_organization_id',
        ids: orgIds,
        label: '组织报告',
      },
      {
        table: 'organization_membership',
        column: 'account_id',
        ids: accountIds,
        label: '账号成员',
      },
      {
        table: 'repair_request',
        column: 'customer_account_id',
        ids: accountIds,
        label: '客户账号工单',
      },
      {
        table: 'repair_request',
        column: 'accepted_by_engineer_account_id',
        ids: accountIds,
        label: '接单工程师',
      },
      {
        table: 'repair_request',
        column: 'handling_recorded_by_account_id',
        ids: accountIds,
        label: '处理记录人',
      },
      {
        table: 'maintenance_report',
        column: 'maintenance_engineer_account_id',
        ids: accountIds,
        label: '报告工程师',
      },
      {
        table: 'maintenance_report',
        column: 'created_by_account_id',
        ids: accountIds,
        label: '报告创建人',
      },
      {
        table: 'maintenance_report',
        column: 'updated_by_account_id',
        ids: accountIds,
        label: '报告更新人',
      },
      {
        table: 'maintenance_report_version',
        column: 'submitted_by_account_id',
        ids: accountIds,
        label: '版本提交人',
      },
      {
        table: 'maintenance_report_review',
        column: 'reviewed_by_account_id',
        ids: accountIds,
        label: '审核人',
      },
      {
        table: 'maintenance_report_attachment',
        column: 'uploaded_by_account_id',
        ids: accountIds,
        label: '附件上传人',
      },
      {
        table: 'engineer_response',
        column: 'engineer_account_id',
        ids: accountIds,
        label: '回复工程师账号',
      },
      {
        table: 'engineer_response',
        column: 'customer_account_id',
        ids: accountIds,
        label: '回复客户账号',
      },
      {
        table: 'repair_request',
        column: 'equipment_model_id',
        ids: modelIds,
        label: '机型工单',
      },
      {
        table: 'maintenance_report',
        column: 'equipment_model_id',
        ids: modelIds,
        label: '机型报告',
      },
    ];

    return referenceGuards;
  };

  interface ExternalRecordRegistration {
    readonly ledger: OwnedFixtureLedger;
    createAttachment(input: {
      readonly id: number;
      readonly reportId: number;
      readonly sortOrder: number;
      readonly description: string;
    }): Promise<void>;
    createVersionAttachment(input: {
      readonly versionId: number;
      readonly attachmentId: number;
      readonly reportId: number;
      readonly sortOrder: number;
      readonly description: string;
    }): Promise<void>;
  }

  /**
   * 账本外模拟记录：独立账本在用例开始时创建，与主账本分开维护；
   * 每次成功写入后立即登记实际主键与预期字段；
   * 无论插入、登记还是断言失败，finally 都执行受保护清理，并与主错误分别汇总、互不覆盖。
   */
  const runExternalRecordCase = async (
    scenario: (registration: ExternalRecordRegistration) => Promise<void>,
  ): Promise<{ readonly ledger: OwnedFixtureLedger; readonly failure: string | null }> => {
    const externalLedger = new OwnedFixtureLedger(`${ROUND_TAG}-EXT`);
    const registration: ExternalRecordRegistration = {
      ledger: externalLedger,
      createAttachment: async ({ id, reportId, sortOrder, description }) => {
        // 固定 ID 写入前先确认不存在：碰撞立即失败并保留原数据
        await assertFixtureIdsAvailable(
          dataSource,
          'maintenance_report_attachment',
          [id],
          ROUND_TAG,
        );
        await query(
          `INSERT INTO maintenance_report_attachment
             (id, report_id, original_filename, mime_type, byte_size, checksum_sha256,
              storage_backend, storage_reference, sort_order, description, status,
              uploaded_by_account_id)
           VALUES (?, ?, ?, 'text/plain', 9, NULL, 'LOCAL', ?, ?, ?, 'CURRENT', ?)`,
          [
            id,
            reportId,
            `s5mr-external-${id}.txt`,
            `s5mr/external-${id}.txt`,
            sortOrder,
            description,
            FIXTURE.engineer,
          ],
        );
        externalLedger.register({
          table: 'maintenance_report_attachment',
          key: { id },
          expected: {
            id,
            report_id: reportId,
            original_filename: `s5mr-external-${id}.txt`,
            mime_type: 'text/plain',
            // bigint unsigned 列经驱动回读为字符串，预期值按同一形态登记
            byte_size: '9',
            checksum_sha256: null,
            storage_backend: 'LOCAL',
            storage_reference: `s5mr/external-${id}.txt`,
            sort_order: sortOrder,
            description,
            status: 'CURRENT',
            uploaded_by_account_id: FIXTURE.engineer,
          },
        });
      },
      createVersionAttachment: async ({
        versionId,
        attachmentId,
        reportId,
        sortOrder,
        description,
      }) => {
        await query(
          `INSERT INTO maintenance_report_version_attachment
             (version_id, attachment_id, report_id, sort_order, description_snapshot, publish_flag)
           VALUES (?, ?, ?, ?, ?, 0)`,
          [versionId, attachmentId, reportId, sortOrder, description],
        );
        const key = { version_id: versionId, attachment_id: attachmentId };
        externalLedger.register({
          table: 'maintenance_report_version_attachment',
          key,
          expected: {
            ...key,
            report_id: reportId,
            sort_order: sortOrder,
            description_snapshot: description,
            publish_flag: 0,
          },
        });
      },
    };

    let primaryError: unknown;
    let teardownErrors: readonly string[];
    try {
      await scenario(registration);
    } catch (error) {
      primaryError = error;
    } finally {
      teardownErrors = await runTeardownSteps([
        {
          label: '清理账本外模拟记录',
          run: () =>
            runOwnedFixtureCleanup({
              dataSource,
              expectedDatabase: actualDatabase,
              rows: externalLedger.list(),
            }),
        },
      ]);
    }

    return {
      ledger: externalLedger,
      failure: describeTeardownFailure({ primaryError, teardownErrors }),
    };
  };

  const insertFixtures = async (): Promise<void> => {
    // 固定 ID 创建前先确认不存在：碰撞立即失败并保留原数据
    await assertFixtureIdsAvailable(dataSource, 'organization', [FIXTURE.org.id], ROUND_TAG);
    await assertFixtureIdsAvailable(
      dataSource,
      'base_user_account',
      [FIXTURE.engineer, FIXTURE.admin, FIXTURE.customer],
      ROUND_TAG,
    );
    await assertFixtureIdsAvailable(dataSource, 'equipment_model', [FIXTURE.model.id], ROUND_TAG);
    await assertFixtureIdsAvailable(
      dataSource,
      'repair_request',
      [
        FIXTURE.repairRequest,
        FIXTURE.repairRequestConcurrent,
        FIXTURE.handlingRequest,
        FIXTURE.repairRequestAttachment,
      ],
      ROUND_TAG,
    );
    await assertFixtureIdsAvailable(
      dataSource,
      'maintenance_report',
      [FIXTURE.reportLifecycle, FIXTURE.reportConcurrent, FIXTURE.reportAttachment],
      ROUND_TAG,
    );
    await assertFixtureIdsAvailable(
      dataSource,
      'maintenance_report_alarm',
      [FIXTURE.alarm, FIXTURE.concurrentAlarm, FIXTURE.alarmAttachment],
      ROUND_TAG,
    );
    await assertFixtureIdsAvailable(
      dataSource,
      'maintenance_report_step',
      [FIXTURE.step, FIXTURE.concurrentStep, FIXTURE.stepAttachment],
      ROUND_TAG,
    );

    await query(
      `INSERT INTO organization (id, organization_code, name, kind, status)
       VALUES (${FIXTURE.org.id}, '${FIXTURE.org.code}', 'S5 报告集成组织', 'CLIENT', 'ACTIVE')`,
    );
    ledger.registerCreated('organization', FIXTURE.org.id, {
      organization_code: FIXTURE.org.code,
      name: 'S5 报告集成组织',
      kind: 'CLIENT',
      status: 'ACTIVE',
    });

    await query(
      `INSERT INTO base_user_account (id, login_name, login_password, status)
       VALUES (${FIXTURE.engineer}, 's5mr_engineer_9904402', 's5-integration-fixture', 'ACTIVE'),
              (${FIXTURE.admin}, 's5mr_admin_9904403', 's5-integration-fixture', 'ACTIVE'),
              (${FIXTURE.customer}, 's5mr_customer_9904404', 's5-integration-fixture', 'ACTIVE')`,
    );
    for (const account of [
      { id: FIXTURE.engineer, loginName: 's5mr_engineer_9904402' },
      { id: FIXTURE.admin, loginName: 's5mr_admin_9904403' },
      { id: FIXTURE.customer, loginName: 's5mr_customer_9904404' },
    ]) {
      ledger.registerCreated('base_user_account', account.id, {
        login_name: account.loginName,
        status: 'ACTIVE',
      });
    }

    // 成员关系 ID 由数据库生成：逐行写入后立即用驱动返回的 insertId 登记，不依赖成功后的 SELECT
    for (const membership of [
      { accountId: FIXTURE.engineer, role: 'ENGINEER' },
      { accountId: FIXTURE.admin, role: 'SUPER_ADMIN' },
      { accountId: FIXTURE.customer, role: 'CUSTOMER' },
    ]) {
      const inserted = (await query(
        `INSERT INTO organization_membership (organization_id, account_id, member_role, status)
         VALUES (?, ?, ?, 'ACTIVE')`,
        [FIXTURE.org.id, membership.accountId, membership.role],
      )) as unknown as { insertId: number };
      ledger.registerCreated('organization_membership', Number(inserted.insertId), {
        organization_id: FIXTURE.org.id,
        account_id: membership.accountId,
        member_role: membership.role,
        status: 'ACTIVE',
      });
    }

    await query(
      `INSERT INTO equipment_model (id, model_code, model_name, enabled)
       VALUES (${FIXTURE.model.id}, '${FIXTURE.model.code}', 'S5 报告集成机型', 1)`,
    );
    ledger.registerCreated('equipment_model', FIXTURE.model.id, {
      model_code: FIXTURE.model.code,
      model_name: 'S5 报告集成机型',
      enabled: 1,
    });

    for (const request of [
      {
        id: FIXTURE.repairRequest,
        no: 'S5MR_REQUEST',
        errorCode: 'E-S5MR',
        description: 'S5 报告集成夹具',
        content: '# S5 报告集成夹具',
      },
      {
        id: FIXTURE.repairRequestConcurrent,
        no: 'S5MR_REQUEST_2',
        errorCode: 'E-S5MR2',
        description: 'S5 报告并发夹具',
        content: '# S5 报告并发夹具',
      },
      {
        id: FIXTURE.handlingRequest,
        no: 'S5MR_HANDLING',
        errorCode: 'E-S5MR3',
        description: 'S5 处理结果夹具',
        content: '# S5 处理结果夹具',
      },
      {
        id: FIXTURE.repairRequestAttachment,
        no: 'S5MR_ATTACHMENT',
        errorCode: 'E-S5MR4',
        description: 'S5 版本附件夹具',
        content: '# S5 版本附件夹具',
      },
    ]) {
      // 处理结果位列显式写入 NULL，使“未处理”成为创建契约的一部分而非回读推断
      await query(
        `INSERT INTO repair_request
           (id, request_no, customer_account_id, equipment_model_id, error_code,
            fault_description, content_md, owner_organization_id, is_accepted,
            accepted_by_engineer_account_id, accepted_at,
            handling_result, handling_status, handling_recorded_at,
            handling_recorded_by_account_id, handling_ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, TRUE, ?, NOW(3), NULL, NULL, NULL, NULL, NULL)`,
        [
          request.id,
          request.no,
          FIXTURE.customer,
          FIXTURE.model.id,
          request.errorCode,
          request.description,
          request.content,
          FIXTURE.org.id,
          FIXTURE.engineer,
        ],
      );
      ledger.registerCreated('repair_request', request.id, {
        request_no: request.no,
        customer_account_id: FIXTURE.customer,
        equipment_model_id: FIXTURE.model.id,
        error_code: request.errorCode,
        fault_description: request.description,
        content_md: request.content,
        owner_organization_id: FIXTURE.org.id,
        is_accepted: 1,
        accepted_by_engineer_account_id: FIXTURE.engineer,
        handling_result: null,
        handling_status: null,
        handling_recorded_at: null,
        handling_recorded_by_account_id: null,
        handling_ended_at: null,
      });
    }

    for (const report of [
      {
        id: FIXTURE.reportLifecycle,
        repairRequest: FIXTURE.repairRequest,
        alarm: FIXTURE.alarm,
        step: FIXTURE.step,
        title: 'S5 生命周期报告',
      },
      {
        id: FIXTURE.reportConcurrent,
        repairRequest: FIXTURE.repairRequestConcurrent,
        alarm: FIXTURE.concurrentAlarm,
        step: FIXTURE.concurrentStep,
        title: 'S5 并发报告',
      },
      {
        id: FIXTURE.reportAttachment,
        repairRequest: FIXTURE.repairRequestAttachment,
        alarm: FIXTURE.alarmAttachment,
        step: FIXTURE.stepAttachment,
        title: 'S5 版本附件报告',
      },
    ]) {
      await query(
        `INSERT INTO maintenance_report
           (id, owner_organization_id, source_type, repair_request_id, title,
            customer_factory_name, equipment_model_id, maintenance_date,
            maintenance_engineer_account_id, maintenance_engineer_name_snapshot,
            phase_flow_version, status, current_version_no, ai_usage,
            created_by_account_id, updated_by_account_id, last_submitted_at, last_reviewed_at)
         VALUES (?, ?, 'WORK_ORDER_SUMMARY', ?, ?, ?, ?, '2026-10-01', ?, ?, 1, 'DRAFT', 0,
                 'NOT_USED', ?, ?, NULL, NULL)`,
        [
          report.id,
          FIXTURE.org.id,
          report.repairRequest,
          report.title,
          'S5 集成厂家',
          FIXTURE.model.id,
          FIXTURE.engineer,
          'S5 集成工程师',
          FIXTURE.engineer,
          FIXTURE.engineer,
        ],
      );
      // 登记后续预期变更会用到的状态、版本号与标题字段；提交/审核时间列显式写 NULL
      ledger.registerCreated('maintenance_report', report.id, {
        owner_organization_id: FIXTURE.org.id,
        source_type: 'WORK_ORDER_SUMMARY',
        repair_request_id: report.repairRequest,
        title: report.title,
        customer_factory_name: 'S5 集成厂家',
        equipment_model_id: FIXTURE.model.id,
        maintenance_engineer_account_id: FIXTURE.engineer,
        maintenance_engineer_name_snapshot: 'S5 集成工程师',
        phase_flow_version: 1,
        status: 'DRAFT',
        current_version_no: 0,
        ai_usage: 'NOT_USED',
        created_by_account_id: FIXTURE.engineer,
        updated_by_account_id: FIXTURE.engineer,
        last_submitted_at: null,
        last_reviewed_at: null,
      });
      await query(
        `INSERT INTO maintenance_report_alarm
           (id, report_id, alarm_index, alarm_code, alarm_description, phase_code, reset_result)
         VALUES (${report.alarm}, ${report.id}, 1, 'ALM-S5', 'S5 集成报警', 'PHASE_01', 'RESET_OK')`,
      );
      ledger.registerCreated('maintenance_report_alarm', report.alarm, {
        report_id: report.id,
        alarm_index: 1,
        alarm_code: 'ALM-S5',
        alarm_description: 'S5 集成报警',
        phase_code: 'PHASE_01',
        reset_result: 'RESET_OK',
      });
      await query(
        `INSERT INTO maintenance_report_step
           (id, report_id, step_no, step_code, phase_code, part_name, action_text, result_text,
            new_alarm_code, is_valid_new_branch)
         VALUES (${report.step}, ${report.id}, 1, 'STEP-S5', 'PHASE_01', 'S5 部件',
                 'S5 集成排查动作', 'S5 集成结果', NULL, 0)`,
      );
      ledger.registerCreated('maintenance_report_step', report.step, {
        report_id: report.id,
        step_no: 1,
        step_code: 'STEP-S5',
        phase_code: 'PHASE_01',
        part_name: 'S5 部件',
        action_text: 'S5 集成排查动作',
        result_text: 'S5 集成结果',
        new_alarm_code: null,
        is_valid_new_branch: 0,
      });
    }
  };

  beforeAll(async () => {
    const declared = process.env.MAINTENANCE_REPORT_INTEGRATION_DATABASE ?? 'lithography_e2e';
    const config = loadExplicitEnvConfig(ENV_FILE, declared);

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              FIELD_ENCRYPTION_KEY: 's5it-fixture-key-16',
              FIELD_ENCRYPTION_IV: 's5it-fixture-iv-16x',
            }),
          ],
        }),
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
          // 直接加载既存实体定义，避免 usecases 层 import ORM Entity（分层约束）
          entities: [join(__dirname, '../../modules/**/*.entity.ts')],
        }),
        TypeOrmTransactionModule,
        LithographyModule,
        MaintenanceReportUsecasesModule,
      ],
    })
      .overrideProvider(ANALYSIS_OUTPUT_READER)
      .useValue(analysisReader)
      .compile();

    dataSource = moduleRef.get(DataSource);
    // 环境门禁全部通过后才允许创建夹具；未通过则不登记任何资源
    const gate = await prepareFixtureSetup(dataSource, ROUND_TAG, config.database);
    actualDatabase = gate.database;
    setupAllowed = true;
    // 固定 ID 夹具不做启动前清除：发现碰撞立即失败并保留原数据
    await insertFixtures();

    submitUsecase = moduleRef.get(SubmitMaintenanceReportUsecase);
    updateUsecase = moduleRef.get(UpdateMaintenanceReportDraftUsecase);
    addAttachmentUsecase = moduleRef.get(AddMaintenanceReportAttachmentUsecase);
    returnUsecase = moduleRef.get(ReturnMaintenanceReportUsecase);
    handlingUsecase = moduleRef.get(RecordRepairRequestHandlingResultUsecase);
  });

  afterAll(async () => {
    await finalizeFixtureTeardown({
      steps: [
        {
          label: `清理夹具（目标库 ${actualDatabase || '(未确认)'}）`,
          run: async () => {
            if (!setupAllowed) return;
            await runOwnedFixtureCleanup({
              dataSource,
              expectedDatabase: actualDatabase,
              rows: ledger.list(),
              referenceGuards: buildReferenceGuards(),
            });
          },
        },
        {
          label: '核对夹具残留',
          run: async () => {
            if (!setupAllowed) return;
            const residue = await assertRegisteredRowsAbsent(dataSource, ledger.list());
            if (residue.length > 0) {
              throw new Error(`本轮登记资源仍存在：${residue.join('；')}`);
            }
          },
        },
        {
          label: '关闭测试模块',
          run: async () => {
            if (moduleRef) {
              await moduleRef.close();
            }
          },
        },
      ],
    });
  });

  it('提交冻结：版本号 1、状态 PENDING_REVIEW、快照含真实内容且未调用 AI 读取器', async () => {
    const submitted = await submitUsecase.execute({
      session: engineerSession,
      reportId: FIXTURE.reportLifecycle,
    });
    // 业务返回的版本 ID 先登记，再执行后续断言；本版本未上传附件，登记零条版本关联
    registerSubmittedVersion(FIXTURE.reportLifecycle, submitted, []);
    lifecycleVersionId = submitted.versionId;
    // 提交只影响状态、版本号与提交时间；其余所有权字段保持创建时的预期
    await ledger.applyExpectedChange(
      query,
      'maintenance_report',
      FIXTURE.reportLifecycle,
      { status: 'PENDING_REVIEW', current_version_no: 1 },
      ['last_submitted_at', 'updated_at'],
    );

    const rows = await query<{
      status: string;
      current_version_no: number;
      last_submitted_at: Date | null;
    }>(
      `SELECT status, current_version_no, last_submitted_at
         FROM maintenance_report WHERE id = ${FIXTURE.reportLifecycle}`,
    );
    expect(rows[0]).toMatchObject({
      status: 'PENDING_REVIEW',
      current_version_no: 1,
    });
    expect(rows[0]?.last_submitted_at).not.toBeNull();

    const versions = await query<{
      version_no: number;
      payload_snapshot: string;
      schema_version: number;
    }>(
      `SELECT version_no, payload_snapshot, schema_version
         FROM maintenance_report_version WHERE report_id = ${FIXTURE.reportLifecycle}`,
    );
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ version_no: 1, schema_version: 2 });
    expect(parsePayload(versions[0]?.payload_snapshot)).toMatchObject({
      title: 'S5 生命周期报告',
      customerFactoryName: 'S5 集成厂家',
      maintenanceDate: '2026-10-01',
    });
    expect(analysisReader.read).not.toHaveBeenCalled();
  });

  it('冻结后编辑：拒绝并保持冻结内容不变', async () => {
    await expect(
      updateUsecase.execute({
        session: engineerSession,
        reportId: FIXTURE.reportLifecycle,
        draft: { title: '冻结后不应写入' },
      }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.STATE_NOT_EDITABLE });

    const rows = await query<{ title: string }>(
      `SELECT title FROM maintenance_report WHERE id = ${FIXTURE.reportLifecycle}`,
    );
    expect(rows[0]?.title).toBe('S5 生命周期报告');
  });

  it('退回后重提：版本递增且旧版本完整保留', async () => {
    const reviewed = await returnUsecase.execute({
      session: adminSession,
      reportId: FIXTURE.reportLifecycle,
      comment: 'S5 集成退回',
    });
    registerReturnedReview(FIXTURE.reportLifecycle, lifecycleVersionId, reviewed, 'S5 集成退回');
    // 退回只改变状态与审核事实；版本号与创建者保持原预期
    await ledger.applyExpectedChange(
      query,
      'maintenance_report',
      FIXTURE.reportLifecycle,
      { status: 'RETURNED' },
      ['last_reviewed_at', 'updated_at', 'updated_by_account_id'],
    );

    await updateUsecase.execute({
      session: engineerSession,
      reportId: FIXTURE.reportLifecycle,
      draft: { title: 'S5 生命周期报告（修订）' },
    });
    // 编辑只改变标题与更新人/时间
    await ledger.applyExpectedChange(
      query,
      'maintenance_report',
      FIXTURE.reportLifecycle,
      { title: 'S5 生命周期报告（修订）' },
      ['updated_at', 'updated_by_account_id'],
    );

    const resubmitted = await submitUsecase.execute({
      session: engineerSession,
      reportId: FIXTURE.reportLifecycle,
    });
    registerSubmittedVersion(FIXTURE.reportLifecycle, resubmitted, []);
    lifecycleVersionId = resubmitted.versionId;
    // 重提只改变状态、版本号与提交时间
    await ledger.applyExpectedChange(
      query,
      'maintenance_report',
      FIXTURE.reportLifecycle,
      { status: 'PENDING_REVIEW', current_version_no: 2 },
      ['last_submitted_at', 'last_reviewed_at', 'updated_at'],
    );

    const rows = await query<{ status: string; current_version_no: number }>(
      `SELECT status, current_version_no FROM maintenance_report WHERE id = ${FIXTURE.reportLifecycle}`,
    );
    expect(rows[0]).toMatchObject({ status: 'PENDING_REVIEW', current_version_no: 2 });

    const versions = await query<{ version_no: number; payload_snapshot: string }>(
      `SELECT version_no, payload_snapshot FROM maintenance_report_version
        WHERE report_id = ${FIXTURE.reportLifecycle} ORDER BY version_no`,
    );
    expect(versions.map((row) => row.version_no)).toEqual([1, 2]);
    expect(parsePayload(versions[0]?.payload_snapshot).title).toBe('S5 生命周期报告');
    expect(parsePayload(versions[1]?.payload_snapshot).title).toBe('S5 生命周期报告（修订）');
  });

  it('并发：编辑持锁期间提交等待，锁释放后冻结最新内容（先锁后读）', async () => {
    const runner: QueryRunner = dataSource.createQueryRunner();
    try {
      await runner.connect();
      await runner.startTransaction();
      // 模拟并发编辑者：先锁定报告行
      await runner.query(
        `SELECT id FROM maintenance_report WHERE id = ${FIXTURE.reportConcurrent} FOR UPDATE`,
      );
      await runner.query(
        `UPDATE maintenance_report SET title = '并发编辑后的标题' WHERE id = ${FIXTURE.reportConcurrent}`,
      );

      const submitPromise = submitUsecase.execute({
        session: engineerSession,
        reportId: FIXTURE.reportConcurrent,
      });
      // 给提交事务足够时间走到锁定读（此刻会阻塞在编辑者持有的行锁上）
      await new Promise((resolve) => setTimeout(resolve, 300));
      await runner.commitTransaction();
      const submitted = await submitPromise;
      // 业务返回的版本 ID 先登记，再离开本用例；并发报告未上传附件
      registerSubmittedVersion(FIXTURE.reportConcurrent, submitted, []);
    } finally {
      if (runner.isTransactionActive) {
        await runner.rollbackTransaction().catch(() => undefined);
      }
      await runner.release().catch(() => undefined);
    }

    // 并发编辑改变了标题，提交改变了状态与版本号；其余字段保持原预期
    await ledger.applyExpectedChange(
      query,
      'maintenance_report',
      FIXTURE.reportConcurrent,
      { title: '并发编辑后的标题', status: 'PENDING_REVIEW', current_version_no: 1 },
      ['last_submitted_at', 'updated_at'],
    );

    const versions = await query<{ payload_snapshot: string }>(
      `SELECT payload_snapshot FROM maintenance_report_version
        WHERE report_id = ${FIXTURE.reportConcurrent}`,
    );
    expect(versions).toHaveLength(1);
    expect(parsePayload(versions[0]?.payload_snapshot).title).toBe('并发编辑后的标题');
  });

  it('工单处理结果：五类→三态固定映射，处理中可继续保存，终结后拒绝改写', async () => {
    await handlingUsecase.execute({
      session: engineerSession,
      repairRequestId: FIXTURE.handlingRequest,
      handlingResult: 'INTERRUPTED',
    });
    // 处理中只改变处理结果与处理状态；记录时间/记录人为数据库写入，受限读取
    await ledger.applyExpectedChange(
      query,
      'repair_request',
      FIXTURE.handlingRequest,
      { handling_result: 'INTERRUPTED', handling_status: 'IN_PROGRESS' },
      ['handling_recorded_at', 'handling_recorded_by_account_id', 'handling_ended_at'],
    );
    const afterProgress = await query<{
      handling_result: string;
      handling_status: string;
      handling_ended_at: Date | null;
    }>(
      `SELECT handling_result, handling_status, handling_ended_at
         FROM repair_request WHERE id = ${FIXTURE.handlingRequest}`,
    );
    expect(afterProgress[0]).toMatchObject({
      handling_result: 'INTERRUPTED',
      handling_status: 'IN_PROGRESS',
    });
    expect(afterProgress[0]?.handling_ended_at).toBeNull();

    await handlingUsecase.execute({
      session: engineerSession,
      repairRequestId: FIXTURE.handlingRequest,
      handlingResult: 'FIXED',
    });
    // 终结保存改变结果/状态并写入结束时间与记录人，其余字段保持原预期
    await ledger.applyExpectedChange(
      query,
      'repair_request',
      FIXTURE.handlingRequest,
      { handling_result: 'FIXED', handling_status: 'COMPLETED' },
      ['handling_ended_at', 'handling_recorded_at', 'handling_recorded_by_account_id'],
    );
    const afterFixed = await query<{
      handling_result: string;
      handling_status: string;
      handling_ended_at: Date | null;
    }>(
      `SELECT handling_result, handling_status, handling_ended_at
         FROM repair_request WHERE id = ${FIXTURE.handlingRequest}`,
    );
    expect(afterFixed[0]).toMatchObject({
      handling_result: 'FIXED',
      handling_status: 'COMPLETED',
    });
    expect(afterFixed[0]?.handling_ended_at).not.toBeNull();

    await expect(
      handlingUsecase.execute({
        session: engineerSession,
        repairRequestId: FIXTURE.handlingRequest,
        handlingResult: 'UNREPAIRABLE',
      }),
    ).rejects.toMatchObject({ code: REPAIR_REQUEST_ERROR.HANDLING_STATE_CONFLICT });

    const afterRejection = await query<{ handling_result: string; handling_status: string }>(
      `SELECT handling_result, handling_status
         FROM repair_request WHERE id = ${FIXTURE.handlingRequest}`,
    );
    expect(afterRejection[0]).toMatchObject({
      handling_result: 'FIXED',
      handling_status: 'COMPLETED',
    });
  });

  it('版本附件登记：无附件零关联，已知附件按复合主键登记，账本外关联拒绝整批清理且零删除', async () => {
    // 独立账本一开始即创建，此后全部插入与断言都在 try 内执行
    const { ledger: externalLedger, failure } = await runExternalRecordCase(
      async ({ createAttachment, createVersionAttachment }) => {
        // 无附件版本：此前三次提交均未上传附件，账本不得登记任何版本关联
        const versionsWithoutAttachments = ledger.idsOf('maintenance_report_version');
        expect(versionsWithoutAttachments.length).toBeGreaterThan(0);
        expect(
          ledger.list().filter((row) => row.table === 'maintenance_report_version_attachment'),
        ).toHaveLength(0);
        const missing = await query<{ total: number | string }>(
          `SELECT COUNT(*) AS total FROM maintenance_report_version_attachment
            WHERE version_id IN (${versionsWithoutAttachments.map(() => '?').join(', ')})`,
          versionsWithoutAttachments,
        );
        expect(Number(missing[0]?.total ?? 0)).toBe(0);

        // 已知附件：上传结果返回的新附件按实际 ID 核验上传人、存储引用与轮次输入后登记，
        // 登记先于后续业务断言
        const uploaded = await addAttachmentUsecase.execute({
          session: engineerSession,
          reportId: FIXTURE.reportAttachment,
          file: {
            originalFilename: 's5mr-known.txt',
            mimeType: 'text/plain',
            byteSize: 7,
            checksumSha256: null,
            storageBackend: 'LOCAL',
            storageReference: 's5mr/known.txt',
            description: 'S5MR 已知附件',
            sortOrder: 1,
          },
        });
        expect(uploaded.attachmentIds).toHaveLength(1);
        const knownAttachmentId = uploaded.attachmentIds[0];
        const uploadedRows = await query<{
          uploaded_by_account_id: number;
          storage_reference: string;
          original_filename: string;
        }>(
          `SELECT uploaded_by_account_id, storage_reference, original_filename
             FROM maintenance_report_attachment WHERE id = ?`,
          [knownAttachmentId],
        );
        expect(uploadedRows[0]).toMatchObject({
          uploaded_by_account_id: FIXTURE.engineer,
          storage_reference: 's5mr/known.txt',
          original_filename: 's5mr-known.txt',
        });
        ledger.register({
          table: 'maintenance_report_attachment',
          key: { id: knownAttachmentId },
          expected: {
            id: knownAttachmentId,
            report_id: FIXTURE.reportAttachment,
            uploaded_by_account_id: FIXTURE.engineer,
            storage_reference: 's5mr/known.txt',
            original_filename: 's5mr-known.txt',
          },
        });

        const submitted = await submitUsecase.execute({
          session: engineerSession,
          reportId: FIXTURE.reportAttachment,
        });
        attachmentVersionId = submitted.versionId;
        registerSubmittedVersion(FIXTURE.reportAttachment, submitted, [
          { id: knownAttachmentId, sortOrder: 1, description: 'S5MR 已知附件' },
        ]);
        await ledger.applyExpectedChange(
          query,
          'maintenance_report',
          FIXTURE.reportAttachment,
          { status: 'PENDING_REVIEW', current_version_no: 1 },
          ['last_submitted_at', 'updated_at'],
        );

        // 登记先于断言：复合主键与业务列按已知输入核验，不依赖查询结果反写预期
        const versionAttachmentRows = await query<{
          report_id: number;
          sort_order: number;
          description_snapshot: string | null;
          publish_flag: number;
        }>(
          `SELECT report_id, sort_order, description_snapshot, publish_flag
             FROM maintenance_report_version_attachment
            WHERE version_id = ? AND attachment_id = ?`,
          [submitted.versionId, knownAttachmentId],
        );
        expect(versionAttachmentRows).toHaveLength(1);
        expect(versionAttachmentRows[0]).toMatchObject({
          report_id: FIXTURE.reportAttachment,
          sort_order: 1,
          description_snapshot: 'S5MR 已知附件',
          publish_flag: 0,
        });

        // 账本外关联：同版本挂入未登记的附件与版本关联，每次成功写入后立即登记到独立账本
        await createAttachment({
          id: FIXTURE.externalAttachment,
          reportId: FIXTURE.reportAttachment,
          sortOrder: 2,
          description: 'S5MR 账本外附件',
        });
        await createVersionAttachment({
          versionId: submitted.versionId,
          attachmentId: FIXTURE.externalAttachment,
          reportId: FIXTURE.reportAttachment,
          sortOrder: 2,
          description: 'S5MR 账本外版本附件',
        });
        expect(ledger.has('maintenance_report_attachment', FIXTURE.externalAttachment)).toBe(false);
        expect(
          ledger.has('maintenance_report_version_attachment', {
            version_id: submitted.versionId,
            attachment_id: FIXTURE.externalAttachment,
          }),
        ).toBe(false);

        // 引用闭包发现账本外关联：整批清理拒绝且零删除，现场保留
        await expect(
          runOwnedFixtureCleanup({
            dataSource,
            expectedDatabase: actualDatabase,
            rows: ledger.list(),
            referenceGuards: buildReferenceGuards(),
          }),
        ).rejects.toThrow(/账本外记录/);

        const reportIds = ledger.idsOf('maintenance_report');
        const versionAttachmentsAfterRejection = await query<{ total: number | string }>(
          `SELECT COUNT(*) AS total FROM maintenance_report_version_attachment
            WHERE report_id IN (${reportIds.map(() => '?').join(', ')})`,
          reportIds,
        );
        expect(Number(versionAttachmentsAfterRejection[0]?.total ?? 0)).toBe(2);
        const reportStillPresent = await query<{ total: number | string }>(
          'SELECT COUNT(*) AS total FROM maintenance_report WHERE id = ?',
          [FIXTURE.reportAttachment],
        );
        expect(Number(reportStillPresent[0]?.total ?? 0)).toBe(1);
      },
    );

    expect(failure).toBeNull();
    // finally 已按独立账本精确清理模拟记录；主账本资源保持待收尾状态
    expect(await assertRegisteredRowsAbsent(dataSource, externalLedger.list())).toEqual([]);
    const knownAttachmentCount = await query<{ total: number | string }>(
      'SELECT COUNT(*) AS total FROM maintenance_report_attachment WHERE report_id = ?',
      [FIXTURE.reportAttachment],
    );
    expect(Number(knownAttachmentCount[0]?.total ?? 0)).toBe(1);
    const knownVersionAttachmentCount = await query<{ total: number | string }>(
      'SELECT COUNT(*) AS total FROM maintenance_report_version_attachment WHERE report_id = ?',
      [FIXTURE.reportAttachment],
    );
    expect(Number(knownVersionAttachmentCount[0]?.total ?? 0)).toBe(1);
  });

  it('账本外模拟记录：第二条 INSERT 失败时已创建附件被精确清理，原始错误完整可见', async () => {
    const attachmentId = FIXTURE.externalAttachmentInsertFail;
    const { ledger: externalLedger, failure } = await runExternalRecordCase(
      async ({ createAttachment, createVersionAttachment }) => {
        await createAttachment({
          id: attachmentId,
          reportId: FIXTURE.reportAttachment,
          sortOrder: 2,
          description: 'S5MR 第二条插入失败',
        });
        // 非法排序触发 CHECK 约束，模拟第二条 INSERT 失败
        await createVersionAttachment({
          versionId: attachmentVersionId,
          attachmentId,
          reportId: FIXTURE.reportAttachment,
          sortOrder: 0,
          description: 'S5MR 非法排序',
        });
      },
    );

    expect(externalLedger.idsOf('maintenance_report_attachment')).toEqual([attachmentId]);
    expect(failure).not.toBeNull();
    expect(failure).toContain('chk_maintenance_report_version_attachment_sort');
    expect(await assertRegisteredRowsAbsent(dataSource, externalLedger.list())).toEqual([]);
    const knownAttachmentCount = await query<{ total: number | string }>(
      'SELECT COUNT(*) AS total FROM maintenance_report_attachment WHERE report_id = ?',
      [FIXTURE.reportAttachment],
    );
    expect(Number(knownAttachmentCount[0]?.total ?? 0)).toBe(1);
  });

  it('账本外模拟记录：业务断言失败时两条已登记记录均被精确清理，原始断言错误可见', async () => {
    const attachmentId = FIXTURE.externalAttachmentAssertFail;
    const { ledger: externalLedger, failure } = await runExternalRecordCase(
      async ({ createAttachment, createVersionAttachment }) => {
        await createAttachment({
          id: attachmentId,
          reportId: FIXTURE.reportAttachment,
          sortOrder: 2,
          description: 'S5MR 断言失败',
        });
        await createVersionAttachment({
          versionId: attachmentVersionId,
          attachmentId,
          reportId: FIXTURE.reportAttachment,
          sortOrder: 2,
          description: 'S5MR 断言失败版本关联',
        });
        throw new Error('注入业务断言失败');
      },
    );

    expect(externalLedger.idsOf('maintenance_report_attachment')).toEqual([attachmentId]);
    expect(
      externalLedger.list().filter((row) => row.table === 'maintenance_report_version_attachment'),
    ).toHaveLength(1);
    expect(failure).toContain('注入业务断言失败');
    expect(await assertRegisteredRowsAbsent(dataSource, externalLedger.list())).toEqual([]);
  });

  it('账本外模拟记录：独立清理失败时错误被汇总且不留残渣', async () => {
    const attachmentId = FIXTURE.externalAttachmentCleanupFail;
    const { ledger: externalLedger, failure } = await runExternalRecordCase(
      async ({ createAttachment }) => {
        await createAttachment({
          id: attachmentId,
          reportId: FIXTURE.reportAttachment,
          sortOrder: 2,
          description: 'S5MR 清理失败',
        });
        // 由临时独立账本经受保护入口删除该行，再由原账本验证“记录缺失”的清理失败
        const removalLedger = new OwnedFixtureLedger(`${ROUND_TAG}-EXT-REMOVE`);
        // 该行由本轮 createAttachment 按已知输入创建，独立账本直接登记同一事实，不回读认领
        removalLedger.registerCreated('maintenance_report_attachment', attachmentId, {
          report_id: FIXTURE.reportAttachment,
          original_filename: `s5mr-external-${attachmentId}.txt`,
          mime_type: 'text/plain',
          byte_size: '9',
          checksum_sha256: null,
          storage_backend: 'LOCAL',
          storage_reference: `s5mr/external-${attachmentId}.txt`,
          sort_order: 2,
          description: 'S5MR 清理失败',
          status: 'CURRENT',
          uploaded_by_account_id: FIXTURE.engineer,
        });
        await runOwnedFixtureCleanup({
          dataSource,
          expectedDatabase: actualDatabase,
          rows: removalLedger.list(),
        });
        expect(await assertRegisteredRowsAbsent(dataSource, removalLedger.list())).toEqual([]);
      },
    );

    expect(externalLedger.idsOf('maintenance_report_attachment')).toEqual([attachmentId]);
    expect(failure).toContain('清理账本外模拟记录失败');
    expect(failure).toContain('登记资源已不存在');
    expect(
      await query('SELECT id FROM maintenance_report_attachment WHERE id = ?', [attachmentId]),
    ).toHaveLength(0);
  });

  it('账本外模拟记录：正常完成时全部已登记记录被精确清理且无主流程错误', async () => {
    const attachmentId = FIXTURE.externalAttachmentNormal;
    const { ledger: externalLedger, failure } = await runExternalRecordCase(
      async ({ createAttachment, createVersionAttachment }) => {
        await createAttachment({
          id: attachmentId,
          reportId: FIXTURE.reportAttachment,
          sortOrder: 2,
          description: 'S5MR 正常完成',
        });
        await createVersionAttachment({
          versionId: attachmentVersionId,
          attachmentId,
          reportId: FIXTURE.reportAttachment,
          sortOrder: 2,
          description: 'S5MR 正常完成版本关联',
        });
      },
    );

    expect(failure).toBeNull();
    expect(externalLedger.idsOf('maintenance_report_attachment')).toEqual([attachmentId]);
    expect(
      externalLedger.list().filter((row) => row.table === 'maintenance_report_version_attachment'),
    ).toHaveLength(1);
    expect(await assertRegisteredRowsAbsent(dataSource, externalLedger.list())).toEqual([]);
  });
});
