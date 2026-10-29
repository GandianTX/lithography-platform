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
const ISOLATED_DATABASES = ['lithography_e2e'];
const CLEANUP_CONSENT_ENV = 'E2E_ALLOW_PHYSICAL_CLEANUP';

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
  reportEditRace: 9904520,
  reportAttachmentRace: 9904521,
  attachment: 9904530,
  stepEditRace: 9904531,
  stepAttachmentRace: 9904532,
} as const;

const WORK_ORDER_IDS = [
  FIXTURE.workOrderCreateRace,
  FIXTURE.workOrderEditRace,
  FIXTURE.workOrderAttachmentRace,
  FIXTURE.workOrderCrossOrg,
];

const REPORT_ID_FILTER = `SELECT id FROM maintenance_report WHERE repair_request_id IN (${WORK_ORDER_IDS.join(
  ',',
)})`;

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

  const query = async <T = Record<string, unknown>>(sql: string): Promise<T[]> =>
    dataSource.query(sql);

  const parsePayload = (value: unknown): Record<string, unknown> =>
    typeof value === 'string'
      ? (JSON.parse(value) as Record<string, unknown>)
      : ((value ?? {}) as Record<string, unknown>);

  const assertConsent = (): void => {
    if (process.env[CLEANUP_CONSENT_ENV] !== '1') {
      throw new Error(`拒绝执行夹具写入/删除：缺少显式许可 ${CLEANUP_CONSENT_ENV}=1。`);
    }
  };

  const assertIsolatedTarget = async (declared: string): Promise<void> => {
    if (!ISOLATED_DATABASES.includes(declared.toLowerCase())) {
      throw new Error(
        `拒绝在库 "${declared}" 上执行集成验收：仅允许 ${ISOLATED_DATABASES.join(', ')}。`,
      );
    }
    const rows = await query<{ current: string }>('SELECT DATABASE() AS current');
    const current = (rows[0]?.current ?? '').toLowerCase();
    if (current !== declared.toLowerCase()) {
      throw new Error(`实际连接目标 "${current}" 与声明库 "${declared}" 不一致，拒绝写入。`);
    }
    actualDatabase = current;
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

  const deleteFixtures = async (): Promise<string[]> => {
    const errors: string[] = [];
    const steps: Array<{ label: string; sql: string }> = [
      {
        label: '报告审核',
        sql: `DELETE FROM maintenance_report_review WHERE report_id IN (${REPORT_ID_FILTER})`,
      },
      {
        label: '版本附件',
        sql: `DELETE FROM maintenance_report_version_attachment WHERE report_id IN (${REPORT_ID_FILTER})`,
      },
      {
        label: '报告版本',
        sql: `DELETE FROM maintenance_report_version WHERE report_id IN (${REPORT_ID_FILTER})`,
      },
      {
        label: '报告报警',
        sql: `DELETE FROM maintenance_report_alarm WHERE report_id IN (${REPORT_ID_FILTER})`,
      },
      {
        label: '报告步骤',
        sql: `DELETE FROM maintenance_report_step WHERE report_id IN (${REPORT_ID_FILTER})`,
      },
      {
        label: '报告附件',
        sql: `DELETE FROM maintenance_report_attachment WHERE report_id IN (${REPORT_ID_FILTER})`,
      },
      {
        label: '报告',
        sql: `DELETE FROM maintenance_report WHERE repair_request_id IN (${WORK_ORDER_IDS.join(',')})`,
      },
      {
        label: '维修申请',
        sql: `DELETE FROM repair_request WHERE id IN (${WORK_ORDER_IDS.join(',')}) AND request_no LIKE 'S5C_%'`,
      },
      {
        label: '机型',
        sql: `DELETE FROM equipment_model WHERE id = ${FIXTURE.model.id} AND model_code = '${FIXTURE.model.code}'`,
      },
      {
        label: '成员关系',
        sql: `DELETE FROM organization_membership WHERE organization_id IN (${FIXTURE.orgA.id}, ${FIXTURE.orgB.id})`,
      },
      {
        label: '账号',
        sql: `DELETE FROM base_user_account WHERE id IN (${FIXTURE.engineerA}, ${FIXTURE.engineerB}, ${FIXTURE.adminA}, ${FIXTURE.adminB}, ${FIXTURE.customerA})`,
      },
      {
        label: '组织',
        sql: `DELETE FROM organization WHERE id IN (${FIXTURE.orgA.id}, ${FIXTURE.orgB.id}) AND organization_code IN ('${FIXTURE.orgA.code}', '${FIXTURE.orgB.code}')`,
      },
    ];
    for (const step of steps) {
      try {
        await query(step.sql);
      } catch (error) {
        errors.push(`${step.label}清理失败：${(error as Error).message}`);
      }
    }
    return errors;
  };

  const assertNoResidue = async (): Promise<string[]> => {
    const errors: string[] = [];
    const checks: Array<{ label: string; sql: string }> = [
      {
        label: '报告及其子表残留',
        sql: `SELECT (SELECT COUNT(*) FROM maintenance_report WHERE repair_request_id IN (${WORK_ORDER_IDS.join(',')}))
                + (SELECT COUNT(*) FROM maintenance_report_version WHERE report_id IN (${REPORT_ID_FILTER}))
                + (SELECT COUNT(*) FROM maintenance_report_attachment WHERE report_id IN (${REPORT_ID_FILTER})) AS total`,
      },
      {
        label: '维修申请残留',
        sql: `SELECT COUNT(*) AS total FROM repair_request WHERE id IN (${WORK_ORDER_IDS.join(',')})`,
      },
      {
        label: '账号残留',
        sql: `SELECT COUNT(*) AS total FROM base_user_account WHERE id IN (${FIXTURE.engineerA}, ${FIXTURE.engineerB}, ${FIXTURE.adminA}, ${FIXTURE.adminB}, ${FIXTURE.customerA})`,
      },
      {
        label: '成员残留',
        sql: `SELECT COUNT(*) AS total FROM organization_membership WHERE organization_id IN (${FIXTURE.orgA.id}, ${FIXTURE.orgB.id})`,
      },
      {
        label: '组织残留',
        sql: `SELECT COUNT(*) AS total FROM organization WHERE id IN (${FIXTURE.orgA.id}, ${FIXTURE.orgB.id})`,
      },
    ];
    for (const check of checks) {
      try {
        const rows = await query<{ total: number | string }>(check.sql);
        if (Number(rows[0]?.total ?? 0) !== 0) {
          errors.push(`${check.label}：仍有 ${rows[0]?.total} 条`);
        }
      } catch (error) {
        errors.push(`${check.label}核对失败：${(error as Error).message}`);
      }
    }
    return errors;
  };

  const insertFixtures = async (): Promise<void> => {
    await query(
      `INSERT INTO organization (id, organization_code, name, kind, status)
       VALUES (${FIXTURE.orgA.id}, '${FIXTURE.orgA.code}', 'S5C 组织A', 'CLIENT', 'ACTIVE'),
              (${FIXTURE.orgB.id}, '${FIXTURE.orgB.code}', 'S5C 组织B', 'CLIENT', 'ACTIVE')`,
    );
    await query(
      `INSERT INTO base_user_account (id, login_name, login_password, status)
       VALUES (${FIXTURE.engineerA}, 's5c_engineer_a_9904503', 's5c-integration-fixture', 'ACTIVE'),
              (${FIXTURE.engineerB}, 's5c_engineer_b_9904504', 's5c-integration-fixture', 'ACTIVE'),
              (${FIXTURE.adminA}, 's5c_admin_a_9904505', 's5c-integration-fixture', 'ACTIVE'),
              (${FIXTURE.adminB}, 's5c_admin_b_9904506', 's5c-integration-fixture', 'ACTIVE'),
              (${FIXTURE.customerA}, 's5c_customer_a_9904507', 's5c-integration-fixture', 'ACTIVE')`,
    );
    await query(
      `INSERT INTO organization_membership (organization_id, account_id, member_role, status)
       VALUES (${FIXTURE.orgA.id}, ${FIXTURE.engineerA}, 'ENGINEER', 'ACTIVE'),
              (${FIXTURE.orgA.id}, ${FIXTURE.adminA}, 'SUPER_ADMIN', 'ACTIVE'),
              (${FIXTURE.orgA.id}, ${FIXTURE.customerA}, 'CUSTOMER', 'ACTIVE'),
              (${FIXTURE.orgB.id}, ${FIXTURE.engineerB}, 'ENGINEER', 'ACTIVE'),
              (${FIXTURE.orgB.id}, ${FIXTURE.adminB}, 'SUPER_ADMIN', 'ACTIVE')`,
    );
    await query(
      `INSERT INTO equipment_model (id, model_code, model_name, enabled)
       VALUES (${FIXTURE.model.id}, '${FIXTURE.model.code}', 'S5C 并发机型', 1)`,
    );
    await query(
      `INSERT INTO repair_request
         (id, request_no, customer_account_id, equipment_model_id, error_code,
          fault_description, content_md, owner_organization_id, is_accepted,
          accepted_by_engineer_account_id, accepted_at)
       VALUES (${FIXTURE.workOrderCreateRace}, 'S5C_CREATE_RACE', ${FIXTURE.customerA},
               ${FIXTURE.model.id}, 'E-S5C1', 'S5C 建稿竞争', '# S5C 建稿竞争',
               ${FIXTURE.orgA.id}, TRUE, ${FIXTURE.engineerA}, NOW(3)),
              (${FIXTURE.workOrderEditRace}, 'S5C_EDIT_RACE', ${FIXTURE.customerA},
               ${FIXTURE.model.id}, 'E-S5C2', 'S5C 提交与编辑竞争', '# S5C 提交与编辑竞争',
               ${FIXTURE.orgA.id}, TRUE, ${FIXTURE.engineerA}, NOW(3)),
              (${FIXTURE.workOrderAttachmentRace}, 'S5C_ATTACH_RACE', ${FIXTURE.customerA},
               ${FIXTURE.model.id}, 'E-S5C3', 'S5C 提交与附件竞争', '# S5C 提交与附件竞争',
               ${FIXTURE.orgA.id}, TRUE, ${FIXTURE.engineerA}, NOW(3)),
              (${FIXTURE.workOrderCrossOrg}, 'S5C_CROSS_ORG', ${FIXTURE.customerA},
               ${FIXTURE.model.id}, 'E-S5C4', 'S5C 跨组织拒绝', '# S5C 跨组织拒绝',
               ${FIXTURE.orgA.id}, TRUE, ${FIXTURE.engineerA}, NOW(3))`,
    );
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
            created_by_account_id, updated_by_account_id)
         VALUES (${report.id}, ${FIXTURE.orgA.id}, 'WORK_ORDER_SUMMARY', ${report.repairRequest},
                 '${report.title}', 'S5C 并发厂家', ${FIXTURE.model.id}, '2026-10-02',
                 ${FIXTURE.engineerA}, 'S5C 并发工程师', 1, 'DRAFT', 0, 'NOT_USED',
                 ${FIXTURE.engineerA}, ${FIXTURE.engineerA})`,
      );
      await query(
        `INSERT INTO maintenance_report_alarm
           (report_id, alarm_index, alarm_code, alarm_description, phase_code, reset_result)
         VALUES (${report.id}, 1, 'ALM-S5C', 'S5C 并发报警', 'PHASE_01', 'RESET_OK')`,
      );
      await query(
        `INSERT INTO maintenance_report_step
           (id, report_id, step_no, step_code, phase_code, part_name, action_text, result_text,
            new_alarm_code, is_valid_new_branch)
         VALUES (${report.step}, ${report.id}, 1, 'STEP-S5C', 'PHASE_01', 'S5C 部件',
                 'S5C 并发排查动作', 'S5C 并发结果', NULL, 0)`,
      );
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
  };

  beforeAll(async () => {
    assertConsent();
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
    await assertIsolatedTarget(config.database);
    await deleteFixtures();
    await insertFixtures();

    createUsecase = moduleRef.get(CreateMaintenanceReportDraftUsecase);
    submitUsecase = moduleRef.get(SubmitMaintenanceReportUsecase);
    updateUsecase = moduleRef.get(UpdateMaintenanceReportDraftUsecase);
    addAttachmentUsecase = moduleRef.get(AddMaintenanceReportAttachmentUsecase);
    returnUsecase = moduleRef.get(ReturnMaintenanceReportUsecase);
  });

  afterAll(async () => {
    const errors: string[] = [];
    if (moduleRef) {
      errors.push(...(await deleteFixtures()));
      errors.push(...(await assertNoResidue()));
      try {
        await observerSource?.destroy();
      } catch (error) {
        errors.push(`关闭观察连接失败：${(error as Error).message}`);
      }
      try {
        await moduleRef.close();
      } catch (error) {
        errors.push(`关闭测试模块失败：${(error as Error).message}`);
      }
    }
    if (errors.length > 0) {
      throw new Error(
        `夹具收尾失败（目标库 ${actualDatabase || '(未确认)'}）：${errors.join('；')}`,
      );
    }
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
        const first = createUsecase.execute(command);
        const second = createUsecase.execute(command);
        await waitForLockWaiters(2);
        await release();
        const settled = await Promise.allSettled([first, second]);
        return settled;
      },
    );

    const fulfilled = outcome.filter((item) => item.status === 'fulfilled');
    const rejected = outcome.filter(
      (item): item is PromiseRejectedResult => item.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({
      code: MAINTENANCE_REPORT_ERROR.WORK_ORDER_ALREADY_SUMMARIZED,
    });

    const reports = await query<{ id: number }>(
      `SELECT id FROM maintenance_report WHERE repair_request_id = ${FIXTURE.workOrderCreateRace}`,
    );
    expect(reports).toHaveLength(1);
    if (!reports[0]) {
      throw new Error('并发建稿后未找到唯一报告行');
    }
    const reportId = reports[0].id;
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
        const submit = submitUsecase.execute({
          session: engineerASession,
          reportId: FIXTURE.reportEditRace,
        });
        await waitForLockWaiters(2);
        await release();
        return Promise.all([edit, submit]);
      },
    );
    expect(outcome).toHaveLength(2);

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
        const submit = submitUsecase.execute({
          session: engineerASession,
          reportId: FIXTURE.reportAttachmentRace,
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
    await submitUsecase.execute({ session: engineerASession, reportId });

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
});
