/// <reference types="jest" />
import type { UsecaseSession } from '@app-types/auth/session.types';
import { MAINTENANCE_REPORT_ERROR } from '@core/common/errors/domain-error';
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
  finalizeFixtureTeardown,
  OwnedFixtureLedger,
  prepareFixtureSetup,
  type ReferenceGuard,
  runOwnedFixtureCleanup,
} from '../../../test/utils/e2e-owned-fixture';
import { ANALYSIS_OUTPUT_READER } from './ports/analysis-output-reader.contract';
import { AddMaintenanceReportAttachmentUsecase } from './add-maintenance-report-attachment.usecase';
import { CreateMaintenanceReportDraftUsecase } from './create-maintenance-report-draft.usecase';
import { MaintenanceReportUsecasesModule } from './maintenance-report-usecases.module';
import { ReturnMaintenanceReportUsecase } from './return-maintenance-report.usecase';
import { SubmitMaintenanceReportUsecase } from './submit-maintenance-report.usecase';
import { UpdateMaintenanceReportDraftUsecase } from './update-maintenance-report-draft.usecase';

/**
 * 维修报告真实 MySQL 并发与跨组织拒绝验收。
 *
 * 默认跳过；启用时必须显式声明隔离库与清理许可：
 *   MAINTENANCE_REPORT_CONCURRENCY_INTEGRATION=1 E2E_ALLOW_PHYSICAL_CLEANUP=1 \
 *     npx jest src/usecases/maintenance-report/maintenance-report.concurrency.integration.spec.ts --runInBand
 *
 * 竞争同步点全部来自数据库真实锁状态（performance_schema.data_lock_waits），
 * 不使用固定 sleep 或 Mock 调用顺序推断并发结果。
 */
const ENABLED = process.env.MAINTENANCE_REPORT_CONCURRENCY_INTEGRATION === '1';
const describeIntegration = ENABLED ? describe : describe.skip;

const ENV_FILE = 'env/.env.e2e';
const ROUND_TAG = 'MAINTENANCE-REPORT-CONC';

const FIXTURE = {
  orgA: { id: 9904501, code: 'S5C_ORG_A' },
  orgB: { id: 9904502, code: 'S5C_ORG_B' },
  engineerA: 9904503,
  engineerB: 9904504,
  adminA: 9904505,
  adminB: 9904506,
  customerA: 9904507,
  model: { id: 9904508, code: 'S5C-MODEL' },
  workOrderCreateRace: 9904510,
  workOrderEditRace: 9904511,
  workOrderAttachmentRace: 9904512,
  workOrderCrossOrg: 9904513,
  workOrderClosure: 9904515,
  reportEditRace: 9904520,
  reportAttachmentRace: 9904521,
  attachment: 9904530,
  stepEditRace: 9904531,
  stepAttachmentRace: 9904532,
  externalVersion: 9904540,
  externalAttachment: 9904541,
  externalReview: 9904542,
} as const;

const WORK_ORDER_IDS = [
  FIXTURE.workOrderCreateRace,
  FIXTURE.workOrderEditRace,
  FIXTURE.workOrderAttachmentRace,
  FIXTURE.workOrderCrossOrg,
  FIXTURE.workOrderClosure,
];

const engineerASession: UsecaseSession = {
  accountId: FIXTURE.engineerA,
  roles: ['ENGINEER'],
  activeRole: 'ENGINEER',
} as UsecaseSession;

const engineerBSession: UsecaseSession = {
  accountId: FIXTURE.engineerB,
  roles: ['ENGINEER'],
  activeRole: 'ENGINEER',
} as UsecaseSession;

const adminBSession: UsecaseSession = {
  accountId: FIXTURE.adminB,
  roles: ['SUPER_ADMIN'],
  activeRole: 'SUPER_ADMIN',
} as UsecaseSession;

const DRAFT = (title: string) => ({
  title,
  customerFactoryName: 'S5C 并发厂家',
  equipmentModelId: FIXTURE.model.id,
  maintenanceDate: '2026-10-02',
  alarms: [
    {
      alarmIndex: 1,
      alarmCode: 'ALM-S5C',
      alarmDescription: 'S5C 并发报警',
      phaseCode: 'PHASE_01',
      resetResult: 'RESET_OK',
    },
  ],
  steps: [
    {
      stepCode: 'STEP-S5C',
      phaseCode: 'PHASE_01',
      partName: 'S5C 部件',
      actionText: 'S5C 并发排查动作',
      resultText: 'S5C 并发结果',
      newAlarmCode: null,
      isValidNewBranch: false,
    },
  ],
});

jest.setTimeout(180_000);

describeIntegration('维修报告真实并发与跨组织拒绝验收', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let observerSource: DataSource;
  let createUsecase: CreateMaintenanceReportDraftUsecase;
  let submitUsecase: SubmitMaintenanceReportUsecase;
  let updateUsecase: UpdateMaintenanceReportDraftUsecase;
  let addAttachmentUsecase: AddMaintenanceReportAttachmentUsecase;
  let returnUsecase: ReturnMaintenanceReportUsecase;
  const analysisReader = { read: jest.fn() };
  let actualDatabase = '';
  let setupAllowed = false;
  const ledger = new OwnedFixtureLedger(ROUND_TAG);

  const query = async <T = Record<string, unknown>>(
    sql: string,
    parameters?: unknown[],
  ): Promise<T[]> => dataSource.query(sql, parameters);

  const parsePayload = (value: unknown): Record<string, unknown> =>
    typeof value === 'string'
      ? (JSON.parse(value) as Record<string, unknown>)
      : ((value ?? {}) as Record<string, unknown>);

  /**
   * 用创建输入声明的报警序号/步骤序号先登记待核验记录，再按这些自然键解析实际主键；
   * 解析失败时条目保留在待核验集合，清理与残留核对不会忽略已提交的子记录。
   */
  const registerCreatedReportContent = async (
    reportId: number,
    draft: ReturnType<typeof DRAFT>,
    target: OwnedFixtureLedger = ledger,
  ): Promise<void> => {
    for (const alarm of draft.alarms) {
      target.registerPending(
        'maintenance_report_alarm',
        { report_id: reportId, alarm_index: alarm.alarmIndex },
        {
          report_id: reportId,
          alarm_index: alarm.alarmIndex,
          alarm_code: alarm.alarmCode,
          alarm_description: alarm.alarmDescription,
          phase_code: alarm.phaseCode,
          reset_result: alarm.resetResult,
        },
      );
    }
    for (const [index, step] of draft.steps.entries()) {
      target.registerPending(
        'maintenance_report_step',
        { report_id: reportId, step_no: index + 1 },
        {
          report_id: reportId,
          step_no: index + 1,
          step_code: step.stepCode,
          phase_code: step.phaseCode,
          part_name: step.partName,
          action_text: step.actionText,
          result_text: step.resultText,
          new_alarm_code: step.newAlarmCode,
          // MySQL 布尔列回读为 0/1，预期值使用数值形态
          is_valid_new_branch: step.isValidNewBranch ? 1 : 0,
        },
      );
    }
    for (const alarm of draft.alarms) {
      await target.resolvePending(query, 'maintenance_report_alarm', {
        report_id: reportId,
        alarm_index: alarm.alarmIndex,
      });
    }
    for (const [index] of draft.steps.entries()) {
      await target.resolvePending(query, 'maintenance_report_step', {
        report_id: reportId,
        step_no: index + 1,
      });
    }
  };

  /**
   * 建稿成功后按创建结果与命令输入同步登记根记录，不做成功后的 SELECT。
   * 负责人姓名快照来自账号资料；夹具账号没有资料行时业务按固定回落“工程师”。
   */
  const registerCreatedDraftReport = (
    created: { reportId: number; status: string; currentVersionNo: number },
    repairRequestId: number,
    draft: ReturnType<typeof DRAFT>,
    target: OwnedFixtureLedger = ledger,
  ): void => {
    target.registerCreated('maintenance_report', created.reportId, {
      owner_organization_id: FIXTURE.orgA.id,
      source_type: 'WORK_ORDER_SUMMARY',
      repair_request_id: repairRequestId,
      title: draft.title,
      customer_factory_name: 'S5C 并发厂家',
      equipment_model_id: FIXTURE.model.id,
      maintenance_engineer_account_id: FIXTURE.engineerA,
      maintenance_engineer_name_snapshot: '工程师',
      phase_flow_version: 1,
      status: created.status,
      current_version_no: created.currentVersionNo,
      ai_usage: 'NOT_USED',
      created_by_account_id: FIXTURE.engineerA,
      updated_by_account_id: FIXTURE.engineerA,
      last_submitted_at: null,
      last_reviewed_at: null,
    });
  };

  /**
   * 提交结果返回的版本按实际 ID 登记；版本附件按该版本与本轮已知附件逐行登记复合主键，
   * 不再按 report_id 补登记账本外记录。
   */
  const registerSubmittedVersion = (
    reportId: number,
    submitted: { versionId: number; versionNo: number },
    expectedAttachments: readonly { id: number; sortOrder: number; description: string | null }[],
    target: OwnedFixtureLedger = ledger,
  ): void => {
    target.register({
      table: 'maintenance_report_version',
      key: { id: submitted.versionId },
      expected: {
        id: submitted.versionId,
        report_id: reportId,
        version_no: submitted.versionNo,
        change_kind: 'SUBMIT',
        submitted_by_account_id: engineerASession.accountId,
      },
    });
    for (const attachment of expectedAttachments) {
      const key = { version_id: submitted.versionId, attachment_id: attachment.id };
      target.register({
        table: 'maintenance_report_version_attachment',
        key,
        expected: {
          ...key,
          report_id: reportId,
          sort_order: attachment.sortOrder,
          description_snapshot: attachment.description,
          publish_flag: 0,
        },
      });
    }
  };

  /**
   * 用独立连接持有行锁作为竞争起点；等两个工作事务都进入 LOCK WAIT 后再放行，
   * 避免用 sleep 猜测谁先到达。
   */
  const runWithBarrier = async <T>(
    lockSql: string,
    expectedWaiters: number,
    run: (release: () => Promise<void>) => Promise<T>,
  ): Promise<T> => {
    const runner: QueryRunner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    let released = false;
    try {
      await runner.query(lockSql);
      const release = async (): Promise<void> => {
        if (released) return;
        released = true;
        await runner.commitTransaction();
      };
      const result = await run(release);
      if (!released) {
        throw new Error(`并发场景未在放行点释放行锁（期望 ${expectedWaiters} 个等待者）。`);
      }
      return result;
    } finally {
      if (runner.isTransactionActive) {
        await runner.rollbackTransaction();
      }
      await runner.release();
    }
  };

  const readLockWaiterCount = async (): Promise<number> => {
    const rows = await observerSource.query<Array<{ total: number | string }>>(
      'SELECT COUNT(DISTINCT REQUESTING_THREAD_ID) AS total FROM performance_schema.data_lock_waits',
    );
    return Number(rows[0]?.total ?? 0);
  };

  const waitForLockWaiters = async (expected: number, timeoutMs = 15_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    let observed = 0;
    while (Date.now() < deadline) {
      observed = await readLockWaiterCount();
      if (observed >= expected) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const locks = await observerSource.query<Array<Record<string, unknown>>>(
      `SELECT THREAD_ID, OBJECT_NAME, INDEX_NAME, LOCK_TYPE, LOCK_MODE, LOCK_STATUS, LOCK_DATA
         FROM performance_schema.data_locks ORDER BY THREAD_ID`,
    );
    const waits = await observerSource.query<Array<Record<string, unknown>>>(
      `SELECT REQUESTING_THREAD_ID, BLOCKING_THREAD_ID FROM performance_schema.data_lock_waits
         ORDER BY REQUESTING_THREAD_ID`,
    );
    throw new Error(
      `等待锁竞争超时：期望 ${expected} 个等待者，实际观察到 ${observed} 个；locks=${JSON.stringify(
        locks,
      )}；waits=${JSON.stringify(waits)}`,
    );
  };

  /** 引用闭包：只放行本轮登记的自有行，任何账本外关联都会让整批零删除 */
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

  const insertFixtures = async (): Promise<void> => {
    // 固定 ID 创建前先确认不存在：碰撞立即失败并保留原数据
    await assertFixtureIdsAvailable(
      dataSource,
      'organization',
      [FIXTURE.orgA.id, FIXTURE.orgB.id],
      ROUND_TAG,
    );
    await assertFixtureIdsAvailable(
      dataSource,
      'base_user_account',
      [FIXTURE.engineerA, FIXTURE.engineerB, FIXTURE.adminA, FIXTURE.adminB, FIXTURE.customerA],
      ROUND_TAG,
    );
    await assertFixtureIdsAvailable(dataSource, 'equipment_model', [FIXTURE.model.id], ROUND_TAG);
    await assertFixtureIdsAvailable(dataSource, 'repair_request', WORK_ORDER_IDS, ROUND_TAG);
    await assertFixtureIdsAvailable(
      dataSource,
      'maintenance_report',
      [FIXTURE.reportEditRace, FIXTURE.reportAttachmentRace],
      ROUND_TAG,
    );
    await assertFixtureIdsAvailable(
      dataSource,
      'maintenance_report_step',
      [FIXTURE.stepEditRace, FIXTURE.stepAttachmentRace],
      ROUND_TAG,
    );
    await assertFixtureIdsAvailable(
      dataSource,
      'maintenance_report_attachment',
      [FIXTURE.attachment, FIXTURE.externalAttachment],
      ROUND_TAG,
    );
    await assertFixtureIdsAvailable(
      dataSource,
      'maintenance_report_version',
      [FIXTURE.externalVersion],
      ROUND_TAG,
    );
    await assertFixtureIdsAvailable(
      dataSource,
      'maintenance_report_review',
      [FIXTURE.externalReview],
      ROUND_TAG,
    );

    await query(
      `INSERT INTO organization (id, organization_code, name, kind, status)
       VALUES (${FIXTURE.orgA.id}, '${FIXTURE.orgA.code}', 'S5C 组织A', 'CLIENT', 'ACTIVE'),
              (${FIXTURE.orgB.id}, '${FIXTURE.orgB.code}', 'S5C 组织B', 'CLIENT', 'ACTIVE')`,
    );
    ledger.registerCreated('organization', FIXTURE.orgA.id, {
      organization_code: FIXTURE.orgA.code,
      name: 'S5C 组织A',
      kind: 'CLIENT',
      status: 'ACTIVE',
    });
    ledger.registerCreated('organization', FIXTURE.orgB.id, {
      organization_code: FIXTURE.orgB.code,
      name: 'S5C 组织B',
      kind: 'CLIENT',
      status: 'ACTIVE',
    });

    await query(
      `INSERT INTO base_user_account (id, login_name, login_password, status)
       VALUES (${FIXTURE.engineerA}, 's5c_engineer_a_9904503', 's5c-integration-fixture', 'ACTIVE'),
              (${FIXTURE.engineerB}, 's5c_engineer_b_9904504', 's5c-integration-fixture', 'ACTIVE'),
              (${FIXTURE.adminA}, 's5c_admin_a_9904505', 's5c-integration-fixture', 'ACTIVE'),
              (${FIXTURE.adminB}, 's5c_admin_b_9904506', 's5c-integration-fixture', 'ACTIVE'),
              (${FIXTURE.customerA}, 's5c_customer_a_9904507', 's5c-integration-fixture', 'ACTIVE')`,
    );
    for (const account of [
      { id: FIXTURE.engineerA, loginName: 's5c_engineer_a_9904503' },
      { id: FIXTURE.engineerB, loginName: 's5c_engineer_b_9904504' },
      { id: FIXTURE.adminA, loginName: 's5c_admin_a_9904505' },
      { id: FIXTURE.adminB, loginName: 's5c_admin_b_9904506' },
      { id: FIXTURE.customerA, loginName: 's5c_customer_a_9904507' },
    ]) {
      ledger.registerCreated('base_user_account', account.id, {
        login_name: account.loginName,
        status: 'ACTIVE',
      });
    }

    // 成员关系 ID 由数据库生成：逐行写入后立即用驱动返回的 insertId 登记，不依赖成功后的 SELECT
    for (const membership of [
      { orgId: FIXTURE.orgA.id, accountId: FIXTURE.engineerA, role: 'ENGINEER' },
      { orgId: FIXTURE.orgA.id, accountId: FIXTURE.adminA, role: 'SUPER_ADMIN' },
      { orgId: FIXTURE.orgA.id, accountId: FIXTURE.customerA, role: 'CUSTOMER' },
      { orgId: FIXTURE.orgB.id, accountId: FIXTURE.engineerB, role: 'ENGINEER' },
      { orgId: FIXTURE.orgB.id, accountId: FIXTURE.adminB, role: 'SUPER_ADMIN' },
    ]) {
      const inserted = (await query(
        `INSERT INTO organization_membership (organization_id, account_id, member_role, status)
         VALUES (?, ?, ?, 'ACTIVE')`,
        [membership.orgId, membership.accountId, membership.role],
      )) as unknown as { insertId: number };
      ledger.registerCreated('organization_membership', Number(inserted.insertId), {
        organization_id: membership.orgId,
        account_id: membership.accountId,
        member_role: membership.role,
        status: 'ACTIVE',
      });
    }

    await query(
      `INSERT INTO equipment_model (id, model_code, model_name, enabled)
       VALUES (${FIXTURE.model.id}, '${FIXTURE.model.code}', 'S5C 并发机型', 1)`,
    );
    ledger.registerCreated('equipment_model', FIXTURE.model.id, {
      model_code: FIXTURE.model.code,
      model_name: 'S5C 并发机型',
      enabled: 1,
    });

    for (const request of [
      {
        id: FIXTURE.workOrderCreateRace,
        no: 'S5C_CREATE_RACE',
        errorCode: 'E-S5C1',
        description: 'S5C 建稿竞争',
        content: '# S5C 建稿竞争',
      },
      {
        id: FIXTURE.workOrderEditRace,
        no: 'S5C_EDIT_RACE',
        errorCode: 'E-S5C2',
        description: 'S5C 提交与编辑竞争',
        content: '# S5C 提交与编辑竞争',
      },
      {
        id: FIXTURE.workOrderAttachmentRace,
        no: 'S5C_ATTACH_RACE',
        errorCode: 'E-S5C3',
        description: 'S5C 提交与附件竞争',
        content: '# S5C 提交与附件竞争',
      },
      {
        id: FIXTURE.workOrderCrossOrg,
        no: 'S5C_CROSS_ORG',
        errorCode: 'E-S5C4',
        description: 'S5C 跨组织拒绝',
        content: '# S5C 跨组织拒绝',
      },
      {
        id: FIXTURE.workOrderClosure,
        no: 'S5C_CLOSURE',
        errorCode: 'E-S5C5',
        description: 'S5C 引用闭包',
        content: '# S5C 引用闭包',
      },
    ]) {
      await query(
        `INSERT INTO repair_request
           (id, request_no, customer_account_id, equipment_model_id, error_code,
            fault_description, content_md, owner_organization_id, is_accepted,
            accepted_by_engineer_account_id, accepted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, TRUE, ?, NOW(3))`,
        [
          request.id,
          request.no,
          FIXTURE.customerA,
          FIXTURE.model.id,
          request.errorCode,
          request.description,
          request.content,
          FIXTURE.orgA.id,
          FIXTURE.engineerA,
        ],
      );
      ledger.registerCreated('repair_request', request.id, {
        request_no: request.no,
        customer_account_id: FIXTURE.customerA,
        equipment_model_id: FIXTURE.model.id,
        error_code: request.errorCode,
        fault_description: request.description,
        content_md: request.content,
        owner_organization_id: FIXTURE.orgA.id,
        is_accepted: 1,
        accepted_by_engineer_account_id: FIXTURE.engineerA,
      });
    }

    for (const report of [
      {
        id: FIXTURE.reportEditRace,
        repairRequest: FIXTURE.workOrderEditRace,
        step: FIXTURE.stepEditRace,
        title: 'S5C 提交编辑竞争报告',
      },
      {
        id: FIXTURE.reportAttachmentRace,
        repairRequest: FIXTURE.workOrderAttachmentRace,
        step: FIXTURE.stepAttachmentRace,
        title: 'S5C 提交附件竞争报告',
      },
    ]) {
      await query(
        `INSERT INTO maintenance_report
           (id, owner_organization_id, source_type, repair_request_id, title,
            customer_factory_name, equipment_model_id, maintenance_date,
            maintenance_engineer_account_id, maintenance_engineer_name_snapshot,
            phase_flow_version, status, current_version_no, ai_usage,
            created_by_account_id, updated_by_account_id, last_submitted_at, last_reviewed_at)
         VALUES (?, ?, 'WORK_ORDER_SUMMARY', ?, ?, ?, ?, '2026-10-02', ?, ?, 1, 'DRAFT', 0,
                 'NOT_USED', ?, ?, NULL, NULL)`,
        [
          report.id,
          FIXTURE.orgA.id,
          report.repairRequest,
          report.title,
          'S5C 并发厂家',
          FIXTURE.model.id,
          FIXTURE.engineerA,
          'S5C 并发工程师',
          FIXTURE.engineerA,
          FIXTURE.engineerA,
        ],
      );
      ledger.registerCreated('maintenance_report', report.id, {
        owner_organization_id: FIXTURE.orgA.id,
        source_type: 'WORK_ORDER_SUMMARY',
        repair_request_id: report.repairRequest,
        title: report.title,
        customer_factory_name: 'S5C 并发厂家',
        equipment_model_id: FIXTURE.model.id,
        maintenance_engineer_account_id: FIXTURE.engineerA,
        maintenance_engineer_name_snapshot: 'S5C 并发工程师',
        phase_flow_version: 1,
        status: 'DRAFT',
        current_version_no: 0,
        ai_usage: 'NOT_USED',
        created_by_account_id: FIXTURE.engineerA,
        updated_by_account_id: FIXTURE.engineerA,
        last_submitted_at: null,
        last_reviewed_at: null,
      });
      // 报警 ID 由数据库生成：写入成功后立即用驱动返回的 insertId 登记
      const insertedAlarm = (await query(
        `INSERT INTO maintenance_report_alarm
           (report_id, alarm_index, alarm_code, alarm_description, phase_code, reset_result)
         VALUES (?, 1, 'ALM-S5C', 'S5C 并发报警', 'PHASE_01', 'RESET_OK')`,
        [report.id],
      )) as unknown as { insertId: number };
      ledger.registerCreated('maintenance_report_alarm', Number(insertedAlarm.insertId), {
        report_id: report.id,
        alarm_index: 1,
        alarm_code: 'ALM-S5C',
        alarm_description: 'S5C 并发报警',
        phase_code: 'PHASE_01',
        reset_result: 'RESET_OK',
      });
      await query(
        `INSERT INTO maintenance_report_step
           (id, report_id, step_no, step_code, phase_code, part_name, action_text, result_text,
            new_alarm_code, is_valid_new_branch)
         VALUES (${report.step}, ${report.id}, 1, 'STEP-S5C', 'PHASE_01', 'S5C 部件',
                 'S5C 并发排查动作', 'S5C 并发结果', NULL, 0)`,
      );
      ledger.registerCreated('maintenance_report_step', report.step, {
        report_id: report.id,
        step_no: 1,
        step_code: 'STEP-S5C',
        phase_code: 'PHASE_01',
        part_name: 'S5C 部件',
        action_text: 'S5C 并发排查动作',
        result_text: 'S5C 并发结果',
        new_alarm_code: null,
        is_valid_new_branch: 0,
      });
    }
    await query(
      `INSERT INTO maintenance_report_attachment
         (id, report_id, original_filename, mime_type, byte_size, checksum_sha256,
          storage_backend, storage_reference, sort_order, description, status,
          uploaded_by_account_id)
       VALUES (${FIXTURE.attachment}, ${FIXTURE.reportAttachmentRace}, 's5c-existing.txt',
               'text/plain', 10, NULL, 'LOCAL', 's5c/existing.txt', 1, 'S5C 既有附件',
               'CURRENT', ${FIXTURE.engineerA})`,
    );
    ledger.registerCreated('maintenance_report_attachment', FIXTURE.attachment, {
      report_id: FIXTURE.reportAttachmentRace,
      original_filename: 's5c-existing.txt',
      mime_type: 'text/plain',
      byte_size: '10',
      checksum_sha256: null,
      storage_backend: 'LOCAL',
      storage_reference: 's5c/existing.txt',
      sort_order: 1,
      description: 'S5C 既有附件',
      status: 'CURRENT',
      uploaded_by_account_id: FIXTURE.engineerA,
    });
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
              FIELD_ENCRYPTION_KEY: 's5c-fixture-key-16',
              FIELD_ENCRYPTION_IV: 's5c-fixture-iv-16x',
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
    observerSource = new DataSource({
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
      entities: [],
    });
    await observerSource.initialize();
    // 环境门禁全部通过后才允许创建夹具；未通过则不登记任何资源
    const gate = await prepareFixtureSetup(dataSource, ROUND_TAG, config.database);
    actualDatabase = gate.database;
    setupAllowed = true;
    // 固定 ID 夹具不做启动前清除：发现碰撞立即失败并保留原数据
    await insertFixtures();

    createUsecase = moduleRef.get(CreateMaintenanceReportDraftUsecase);
    submitUsecase = moduleRef.get(SubmitMaintenanceReportUsecase);
    updateUsecase = moduleRef.get(UpdateMaintenanceReportDraftUsecase);
    addAttachmentUsecase = moduleRef.get(AddMaintenanceReportAttachmentUsecase);
    returnUsecase = moduleRef.get(ReturnMaintenanceReportUsecase);
  });

  afterAll(async () => {
    await finalizeFixtureTeardown({
      steps: [
        {
          label: `清理夹具（目标库 ${actualDatabase || '(未确认)'}）`,
          run: async () => {
            if (!setupAllowed || !dataSource) return;
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
            if (!setupAllowed || !dataSource) return;
            const residue = await assertRegisteredRowsAbsent(
              dataSource,
              ledger.list(),
              ledger.pendingRows(),
            );
            if (residue.length > 0) {
              throw new Error(`本轮登记资源仍存在：${residue.join('；')}`);
            }
          },
        },
        {
          label: '关闭观测连接',
          run: async () => {
            if (observerSource) {
              await observerSource.destroy();
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

  it('同一工单并发建稿：仅一份总结，败方得到明确业务冲突，无部分写入', async () => {
    const command = {
      session: engineerASession,
      sourceType: 'WORK_ORDER_SUMMARY',
      repairRequestId: FIXTURE.workOrderCreateRace,
      draft: DRAFT('S5C 建稿竞争'),
    };

    const outcome = await runWithBarrier(
      `SELECT id FROM repair_request WHERE id = ${FIXTURE.workOrderCreateRace} FOR UPDATE`,
      2,
      async (release) => {
        // 任一分支确认创建成功后立即登记根记录与输入声明的子树，再返回结果
        const registerCreated = async (created: {
          reportId: number;
          status: string;
          currentVersionNo: number;
        }): Promise<void> => {
          registerCreatedDraftReport(created, FIXTURE.workOrderCreateRace, command.draft);
          await registerCreatedReportContent(created.reportId, command.draft);
        };
        const first = createUsecase.execute(command).then(async (created) => {
          await registerCreated(created);
          return created;
        });
        const second = createUsecase.execute(command).then(async (created) => {
          await registerCreated(created);
          return created;
        });
        await waitForLockWaiters(2);
        await release();
        // 等全部分支结束并收集成功/失败信息后再断言
        return Promise.allSettled([first, second]);
      },
    );

    const fulfilled = outcome.filter((item) => item.status === 'fulfilled');
    const rejected = outcome.filter((item) => item.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const failure = rejected[0];
    expect(failure?.status === 'rejected' ? failure.reason : null).toMatchObject({
      code: MAINTENANCE_REPORT_ERROR.WORK_ORDER_ALREADY_SUMMARIZED,
    });

    const success = fulfilled[0];
    if (success?.status !== 'fulfilled') {
      throw new Error('并发建稿后未找到成功分支的报告 ID');
    }
    const reportId = success.value.reportId;
    const reports = await query<{ id: number }>(
      `SELECT id FROM maintenance_report WHERE repair_request_id = ${FIXTURE.workOrderCreateRace}`,
    );
    expect(reports).toHaveLength(1);
    expect(reports[0]?.id).toBe(reportId);

    const children = await query<{ alarms: number | string; steps: number | string }>(
      `SELECT (SELECT COUNT(*) FROM maintenance_report_alarm WHERE report_id = ${reportId}) AS alarms,
              (SELECT COUNT(*) FROM maintenance_report_step WHERE report_id = ${reportId}) AS steps`,
    );
    expect(Number(children[0]?.alarms ?? 0)).toBe(1);
    expect(Number(children[0]?.steps ?? 0)).toBe(1);
  });

  it('提交与编辑竞争：编辑先持锁时提交冻结最新内容，冻结后编辑被拒绝', async () => {
    const editedTitle = 'S5C 编辑后标题';
    const outcome = await runWithBarrier(
      `SELECT id FROM maintenance_report WHERE id = ${FIXTURE.reportEditRace} FOR UPDATE`,
      2,
      async (release) => {
        const edit = updateUsecase.execute({
          session: engineerASession,
          reportId: FIXTURE.reportEditRace,
          draft: { title: editedTitle },
        });
        await waitForLockWaiters(1);
        // 提交创建版本成功后立即按返回的版本 ID 登记，再返回结果
        const submit = submitUsecase
          .execute({
            session: engineerASession,
            reportId: FIXTURE.reportEditRace,
          })
          .then((result) => {
            registerSubmittedVersion(FIXTURE.reportEditRace, result, []);
            return result;
          });
        await waitForLockWaiters(2);
        await release();
        return Promise.allSettled([edit, submit]);
      },
    );
    const editFulfilled = outcome.filter((item) => item.status === 'fulfilled');
    const editRejected = outcome.filter((item) => item.status === 'rejected');
    expect(editFulfilled).toHaveLength(2);
    expect(editRejected).toHaveLength(0);

    // 并发编辑改变了标题，提交改变了状态与版本号；其余所有权字段保持原预期
    await ledger.applyExpectedChange(
      query,
      'maintenance_report',
      FIXTURE.reportEditRace,
      { title: editedTitle, status: 'PENDING_REVIEW', current_version_no: 1 },
      ['last_submitted_at', 'updated_at', 'updated_by_account_id'],
    );

    const reportRows = await query<{ status: string; current_version_no: number; title: string }>(
      `SELECT status, current_version_no, title FROM maintenance_report WHERE id = ${FIXTURE.reportEditRace}`,
    );
    expect(reportRows[0]).toMatchObject({
      status: 'PENDING_REVIEW',
      current_version_no: 1,
      title: editedTitle,
    });

    const versions = await query<{ payload_snapshot: string; schema_version: number }>(
      `SELECT payload_snapshot, schema_version FROM maintenance_report_version WHERE report_id = ${FIXTURE.reportEditRace}`,
    );
    expect(versions).toHaveLength(1);
    expect(parsePayload(versions[0]?.payload_snapshot)).toMatchObject({
      title: editedTitle,
      customerFactoryName: 'S5C 并发厂家',
    });

    await expect(
      updateUsecase.execute({
        session: engineerASession,
        reportId: FIXTURE.reportEditRace,
        draft: { title: 'S5C 冻结后不应写入' },
      }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.STATE_NOT_EDITABLE });
  });

  it('提交与附件修改竞争：提交快照完整，冻结后附件新增被拒绝且无部分写入', async () => {
    const outcome = await runWithBarrier(
      `SELECT id FROM maintenance_report WHERE id = ${FIXTURE.reportAttachmentRace} FOR UPDATE`,
      2,
      async (release) => {
        // 提交创建版本/版本附件成功后立即按返回值与已知附件逐行登记，再返回结果
        const submit = submitUsecase
          .execute({
            session: engineerASession,
            reportId: FIXTURE.reportAttachmentRace,
          })
          .then((result) => {
            registerSubmittedVersion(FIXTURE.reportAttachmentRace, result, [
              { id: FIXTURE.attachment, sortOrder: 1, description: 'S5C 既有附件' },
            ]);
            return result;
          });
        await waitForLockWaiters(1);
        const attachment = addAttachmentUsecase.execute({
          session: engineerASession,
          reportId: FIXTURE.reportAttachmentRace,
          file: {
            originalFilename: 's5c-late.txt',
            mimeType: 'text/plain',
            byteSize: 8,
            checksumSha256: null,
            storageBackend: 'LOCAL',
            storageReference: 's5c/late.txt',
            description: 'S5C 冻结后新增',
            sortOrder: 2,
          },
        });
        await waitForLockWaiters(2);
        await release();
        const settled = await Promise.allSettled([submit, attachment]);
        return settled;
      },
    );

    expect(outcome[0]?.status).toBe('fulfilled');
    const rejected = outcome[1] as PromiseRejectedResult;
    expect(rejected.status).toBe('rejected');
    expect(rejected.reason).toMatchObject({
      code: MAINTENANCE_REPORT_ERROR.STATE_NOT_EDITABLE,
    });

    // 提交只改变状态与版本号；版本行和复合主键版本附件已在分支内登记
    await ledger.applyExpectedChange(
      query,
      'maintenance_report',
      FIXTURE.reportAttachmentRace,
      { status: 'PENDING_REVIEW', current_version_no: 1 },
      ['last_submitted_at', 'updated_at', 'updated_by_account_id'],
    );

    const attachments = await query<{ id: number }>(
      `SELECT id FROM maintenance_report_attachment WHERE report_id = ${FIXTURE.reportAttachmentRace}`,
    );
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.id).toBe(FIXTURE.attachment);

    const versionAttachments = await query<{ attachment_id: number; publish_flag: number }>(
      `SELECT attachment_id, publish_flag FROM maintenance_report_version_attachment WHERE report_id = ${FIXTURE.reportAttachmentRace}`,
    );
    expect(versionAttachments).toHaveLength(1);
    expect(versionAttachments[0]).toMatchObject({
      attachment_id: FIXTURE.attachment,
      publish_flag: 0,
    });
  });

  it('跨组织写入口拒绝：建稿、编辑、提交、附件与审核均不产生部分写入', async () => {
    await expect(
      createUsecase.execute({
        session: engineerBSession,
        sourceType: 'WORK_ORDER_SUMMARY',
        repairRequestId: FIXTURE.workOrderCrossOrg,
        draft: DRAFT('S5C 跨组织建稿'),
      }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.WORK_ORDER_OWNER_MISMATCH });

    const afterRejectedCreate = await query<{ total: number | string }>(
      `SELECT COUNT(*) AS total FROM maintenance_report WHERE repair_request_id = ${FIXTURE.workOrderCrossOrg}`,
    );
    expect(Number(afterRejectedCreate[0]?.total ?? 0)).toBe(0);

    const created = await createUsecase.execute({
      session: engineerASession,
      sourceType: 'WORK_ORDER_SUMMARY',
      repairRequestId: FIXTURE.workOrderCrossOrg,
      draft: DRAFT('S5C 跨组织报告'),
    });
    const reportId = created.reportId;
    // 跨组织用例内部创建的报告按创建结果与命令输入登记根记录，再按输入声明的自然键登记子树
    registerCreatedDraftReport(created, FIXTURE.workOrderCrossOrg, DRAFT('S5C 跨组织报告'));
    await registerCreatedReportContent(reportId, DRAFT('S5C 跨组织报告'));
    const submitted = await submitUsecase.execute({ session: engineerASession, reportId });
    // 提交创建的版本行按返回值登记，再记录本操作的显式预期变更
    registerSubmittedVersion(reportId, submitted, []);
    await ledger.applyExpectedChange(
      query,
      'maintenance_report',
      reportId,
      { status: 'PENDING_REVIEW', current_version_no: 1 },
      ['last_submitted_at', 'updated_at', 'updated_by_account_id'],
    );

    await expect(
      updateUsecase.execute({
        session: engineerBSession,
        reportId,
        draft: { title: '跨组织不应写入' },
      }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.NOT_FOUND });

    await expect(
      submitUsecase.execute({ session: engineerBSession, reportId }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.NOT_FOUND });

    await expect(
      addAttachmentUsecase.execute({
        session: engineerBSession,
        reportId,
        file: {
          originalFilename: 's5c-cross-org.txt',
          mimeType: 'text/plain',
          byteSize: 6,
          checksumSha256: null,
          storageBackend: 'LOCAL',
          storageReference: 's5c/cross-org.txt',
          description: '跨组织不应写入',
          sortOrder: 1,
        },
      }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.NOT_FOUND });

    await expect(
      returnUsecase.execute({
        session: adminBSession,
        reportId,
        comment: '跨组织不应审核',
      }),
    ).rejects.toMatchObject({ code: MAINTENANCE_REPORT_ERROR.NOT_FOUND });

    const reportRows = await query<{ title: string; status: string; current_version_no: number }>(
      `SELECT title, status, current_version_no FROM maintenance_report WHERE id = ${reportId}`,
    );
    expect(reportRows[0]).toMatchObject({
      title: 'S5C 跨组织报告',
      status: 'PENDING_REVIEW',
      current_version_no: 1,
    });
    const childRows = await query<{
      versions: number | string;
      attachments: number | string;
      reviews: number | string;
    }>(
      `SELECT (SELECT COUNT(*) FROM maintenance_report_version WHERE report_id = ${reportId}) AS versions,
              (SELECT COUNT(*) FROM maintenance_report_attachment WHERE report_id = ${reportId}) AS attachments,
              (SELECT COUNT(*) FROM maintenance_report_review WHERE report_id = ${reportId}) AS reviews`,
    );
    expect(Number(childRows[0]?.versions ?? -1)).toBe(1);
    expect(Number(childRows[0]?.attachments ?? -1)).toBe(0);
    expect(Number(childRows[0]?.reviews ?? -1)).toBe(0);
  });

  it('引用闭包：账本外附件/版本/审核/版本附件不被认领，清理零删除且外部记录保留', async () => {
    const closureLedger = new OwnedFixtureLedger(`${ROUND_TAG}-CLOSURE`);
    const externalLedger = new OwnedFixtureLedger(`${ROUND_TAG}-EXTERNAL`);
    const closureDraft = DRAFT('S5C 引用闭包报告');
    let completed = false;
    const created = await createUsecase.execute({
      session: engineerASession,
      sourceType: 'WORK_ORDER_SUMMARY',
      repairRequestId: FIXTURE.workOrderClosure,
      draft: closureDraft,
    });
    const reportId = created.reportId;

    try {
      // 建稿成功后立即按创建结果登记，后续回读只用于比对
      registerCreatedDraftReport(created, FIXTURE.workOrderClosure, closureDraft, closureLedger);
      await registerCreatedReportContent(reportId, closureDraft, closureLedger);

      // 本轮上传结果：按返回的新附件 ID 登记，并核对上传人、存储引用与本轮标识
      const uploaded = await addAttachmentUsecase.execute({
        session: engineerASession,
        reportId,
        file: {
          originalFilename: 's5c-closure-own.txt',
          mimeType: 'text/plain',
          byteSize: 7,
          checksumSha256: null,
          storageBackend: 'LOCAL',
          storageReference: 's5c/closure-own.txt',
          description: 'S5C 本轮附件',
          sortOrder: 1,
        },
      });
      const ownAttachmentId = uploaded.attachmentIds
        .filter((id) => !closureLedger.has('maintenance_report_attachment', id))
        .pop();
      if (ownAttachmentId === undefined) {
        throw new Error('上传结果未返回本轮新增的附件 ID');
      }
      // 上传成功后立即按返回 ID 与上传输入登记，随后回读仅用于比对
      closureLedger.registerCreated('maintenance_report_attachment', ownAttachmentId, {
        report_id: reportId,
        original_filename: 's5c-closure-own.txt',
        mime_type: 'text/plain',
        checksum_sha256: null,
        storage_backend: 'LOCAL',
        storage_reference: 's5c/closure-own.txt',
        sort_order: 1,
        description: 'S5C 本轮附件',
        status: 'CURRENT',
        uploaded_by_account_id: FIXTURE.engineerA,
      });
      const uploadedRows = await query<{
        uploaded_by_account_id: number;
        storage_reference: string;
        original_filename: string;
      }>(
        `SELECT uploaded_by_account_id, storage_reference, original_filename
           FROM maintenance_report_attachment WHERE id = ?`,
        [ownAttachmentId],
      );
      expect(uploadedRows[0]).toMatchObject({
        uploaded_by_account_id: FIXTURE.engineerA,
        storage_reference: 's5c/closure-own.txt',
        original_filename: 's5c-closure-own.txt',
      });

      // 外部记录：其他上传人的附件、额外版本、审核与版本附件，均不在本轮结果内
      await query(
        `INSERT INTO maintenance_report_attachment
           (id, report_id, original_filename, mime_type, byte_size, checksum_sha256,
            storage_backend, storage_reference, sort_order, description, status,
            uploaded_by_account_id)
         VALUES (${FIXTURE.externalAttachment}, ${reportId}, 's5c-external.txt', 'text/plain',
                 9, NULL, 'LOCAL', 's5c/external.txt', 2, 'S5C 账本外附件', 'CURRENT',
                 ${FIXTURE.engineerB})`,
      );
      externalLedger.registerCreated('maintenance_report_attachment', FIXTURE.externalAttachment, {
        report_id: reportId,
        original_filename: 's5c-external.txt',
        mime_type: 'text/plain',
        byte_size: '9',
        checksum_sha256: null,
        storage_backend: 'LOCAL',
        storage_reference: 's5c/external.txt',
        sort_order: 2,
        description: 'S5C 账本外附件',
        status: 'CURRENT',
        uploaded_by_account_id: FIXTURE.engineerB,
      });
      await query(
        `INSERT INTO maintenance_report_version
           (id, report_id, version_no, change_kind, schema_version, payload_snapshot,
            submitted_by_account_id, submitted_at)
         VALUES (${FIXTURE.externalVersion}, ${reportId}, 2, 'SUBMIT', 2,
                 JSON_OBJECT('title', 'S5C 账本外版本'), ${FIXTURE.engineerB}, NOW(3))`,
      );
      externalLedger.registerCreated('maintenance_report_version', FIXTURE.externalVersion, {
        report_id: reportId,
        version_no: 2,
        change_kind: 'SUBMIT',
        schema_version: 2,
        submitted_by_account_id: FIXTURE.engineerB,
      });
      await query(
        `INSERT INTO maintenance_report_review
           (id, report_id, version_id, decision, comment, reviewed_by_account_id, reviewed_at)
         VALUES (${FIXTURE.externalReview}, ${reportId}, ${FIXTURE.externalVersion}, 'RETURN',
                 'S5C 账本外审核', ${FIXTURE.adminB}, NOW(3))`,
      );
      externalLedger.registerCreated('maintenance_report_review', FIXTURE.externalReview, {
        report_id: reportId,
        version_id: FIXTURE.externalVersion,
        decision: 'RETURN',
        comment: 'S5C 账本外审核',
        reviewed_by_account_id: FIXTURE.adminB,
      });
      await query(
        `INSERT INTO maintenance_report_version_attachment
           (version_id, attachment_id, report_id, sort_order, description_snapshot, publish_flag)
         VALUES (${FIXTURE.externalVersion}, ${FIXTURE.externalAttachment}, ${reportId}, 1,
                 'S5C 账本外版本附件', 0)`,
      );
      const externalVersionAttachmentKey = {
        version_id: FIXTURE.externalVersion,
        attachment_id: FIXTURE.externalAttachment,
      };
      externalLedger.register({
        table: 'maintenance_report_version_attachment',
        key: externalVersionAttachmentKey,
        expected: {
          ...externalVersionAttachmentKey,
          report_id: reportId,
          sort_order: 1,
          description_snapshot: 'S5C 账本外版本附件',
          publish_flag: 0,
        },
      });

      // 发现记录不等于登记本轮资源：账本不得包含任何外部记录
      expect(closureLedger.has('maintenance_report_attachment', FIXTURE.externalAttachment)).toBe(
        false,
      );
      expect(closureLedger.has('maintenance_report_version', FIXTURE.externalVersion)).toBe(false);
      expect(closureLedger.has('maintenance_report_review', FIXTURE.externalReview)).toBe(false);
      expect(
        closureLedger.has('maintenance_report_version_attachment', {
          version_id: FIXTURE.externalVersion,
          attachment_id: FIXTURE.externalAttachment,
        }),
      ).toBe(false);

      const guards: ReferenceGuard[] = [
        {
          table: 'maintenance_report_alarm',
          column: 'report_id',
          ids: [reportId],
          label: '本轮报警',
        },
        {
          table: 'maintenance_report_step',
          column: 'report_id',
          ids: [reportId],
          label: '本轮步骤',
        },
        {
          table: 'maintenance_report_version',
          column: 'report_id',
          ids: [reportId],
          label: '本轮版本',
        },
        {
          table: 'maintenance_report_review',
          column: 'report_id',
          ids: [reportId],
          label: '本轮审核',
        },
        {
          table: 'maintenance_report_attachment',
          column: 'report_id',
          ids: [reportId],
          label: '本轮附件',
        },
        {
          table: 'maintenance_report_version_attachment',
          column: 'report_id',
          ids: [reportId],
          label: '本轮版本附件',
        },
      ];

      await expect(
        runOwnedFixtureCleanup({
          dataSource,
          expectedDatabase: actualDatabase,
          rows: closureLedger.list(),
          referenceGuards: guards,
        }),
      ).rejects.toThrow(/账本外记录/);

      // 零删除：本轮子树与全部外部记录都仍在
      const afterRejected = await query<{
        ownAttachment: number | string;
        externalAttachment: number | string;
        externalVersion: number | string;
        externalReview: number | string;
        externalVersionAttachment: number | string;
      }>(
        `SELECT
           (SELECT COUNT(*) FROM maintenance_report_attachment WHERE id = ${ownAttachmentId}) AS ownAttachment,
           (SELECT COUNT(*) FROM maintenance_report_attachment WHERE id = ${FIXTURE.externalAttachment}) AS externalAttachment,
           (SELECT COUNT(*) FROM maintenance_report_version WHERE id = ${FIXTURE.externalVersion}) AS externalVersion,
           (SELECT COUNT(*) FROM maintenance_report_review WHERE id = ${FIXTURE.externalReview}) AS externalReview,
           (SELECT COUNT(*) FROM maintenance_report_version_attachment
             WHERE version_id = ${FIXTURE.externalVersion} AND attachment_id = ${FIXTURE.externalAttachment}) AS externalVersionAttachment`,
      );
      expect(Number(afterRejected[0]?.ownAttachment ?? 0)).toBe(1);
      expect(Number(afterRejected[0]?.externalAttachment ?? 0)).toBe(1);
      expect(Number(afterRejected[0]?.externalVersion ?? 0)).toBe(1);
      expect(Number(afterRejected[0]?.externalReview ?? 0)).toBe(1);
      expect(Number(afterRejected[0]?.externalVersionAttachment ?? 0)).toBe(1);

      // 解除外部关联后，本轮子树可正常清理
      const externalCleanup = await runOwnedFixtureCleanup({
        dataSource,
        expectedDatabase: actualDatabase,
        rows: externalLedger.list(),
      });
      expect(externalCleanup.deletedRows).toBeGreaterThan(0);

      const closureCleanup = await runOwnedFixtureCleanup({
        dataSource,
        expectedDatabase: actualDatabase,
        rows: closureLedger.list(),
        referenceGuards: guards,
      });
      expect(closureCleanup.deletedRows).toBeGreaterThan(0);
      expect(await assertRegisteredRowsAbsent(dataSource, closureLedger.list())).toHaveLength(0);
      expect(await assertRegisteredRowsAbsent(dataSource, externalLedger.list())).toHaveLength(0);
      completed = true;
    } finally {
      if (!completed) {
        // 失败时按精确登记分步尽力清尾，原始失败不被覆盖
        await runOwnedFixtureCleanup({
          dataSource,
          expectedDatabase: actualDatabase,
          rows: externalLedger.list(),
        }).catch(() => undefined);
        await runOwnedFixtureCleanup({
          dataSource,
          expectedDatabase: actualDatabase,
          rows: closureLedger.list(),
        }).catch(() => undefined);
      }
    }
  });
});
