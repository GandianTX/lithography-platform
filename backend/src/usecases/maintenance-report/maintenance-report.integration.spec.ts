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
import { ANALYSIS_OUTPUT_READER } from './ports/analysis-output-reader.contract';
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
const ISOLATED_DATABASES = ['lithography_e2e'];
const CLEANUP_CONSENT_ENV = 'E2E_ALLOW_PHYSICAL_CLEANUP';

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
  let returnUsecase: ReturnMaintenanceReportUsecase;
  let handlingUsecase: RecordRepairRequestHandlingResultUsecase;
  const analysisReader = { read: jest.fn() };
  let actualDatabase = '';

  const query = async <T = Record<string, unknown>>(sql: string): Promise<T[]> =>
    dataSource.query(sql);

  // mysql2 对 JSON 列可能直接返回对象，统一兼容两种形态
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

  const deleteFixtures = async (): Promise<string[]> => {
    const errors: string[] = [];
    const steps: Array<{ label: string; sql: string }> = [
      {
        label: '报告审核',
        sql: 'DELETE FROM maintenance_report_review WHERE report_id IN (9904407, 9904410)',
      },
      {
        label: '版本附件',
        sql: 'DELETE FROM maintenance_report_version_attachment WHERE version_id IN (SELECT id FROM maintenance_report_version WHERE report_id IN (9904407, 9904410))',
      },
      {
        label: '报告版本',
        sql: 'DELETE FROM maintenance_report_version WHERE report_id IN (9904407, 9904410)',
      },
      {
        label: '报告报警',
        sql: 'DELETE FROM maintenance_report_alarm WHERE report_id IN (9904407, 9904410)',
      },
      {
        label: '报告步骤',
        sql: 'DELETE FROM maintenance_report_step WHERE report_id IN (9904407, 9904410)',
      },
      {
        label: '报告',
        sql: 'DELETE FROM maintenance_report WHERE id IN (9904407, 9904410)',
      },
      {
        label: '维修申请',
        sql: "DELETE FROM repair_request WHERE id IN (9904406, 9904413, 9904414) AND request_no LIKE 'S5MR_%'",
      },
      {
        label: '机型',
        sql: `DELETE FROM equipment_model WHERE id = ${FIXTURE.model.id} AND model_code = '${FIXTURE.model.code}'`,
      },
      {
        label: '成员关系',
        sql: 'DELETE FROM organization_membership WHERE organization_id = 9904401 AND account_id IN (9904402, 9904403, 9904404)',
      },
      {
        label: '账号',
        sql: 'DELETE FROM base_user_account WHERE id IN (9904402, 9904403, 9904404)',
      },
      {
        label: '组织',
        sql: `DELETE FROM organization WHERE id = ${FIXTURE.org.id} AND organization_code = '${FIXTURE.org.code}'`,
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
        label: '报告残留',
        sql: 'SELECT (SELECT COUNT(*) FROM maintenance_report WHERE id IN (9904407, 9904410)) + (SELECT COUNT(*) FROM maintenance_report_version WHERE report_id IN (9904407, 9904410)) AS total',
      },
      {
        label: '账号残留',
        sql: 'SELECT COUNT(*) AS total FROM base_user_account WHERE id IN (9904402, 9904403, 9904404)',
      },
      {
        label: '维修申请残留',
        sql: 'SELECT COUNT(*) AS total FROM repair_request WHERE id IN (9904406, 9904413, 9904414)',
      },
      {
        label: '成员残留',
        sql: 'SELECT COUNT(*) AS total FROM organization_membership WHERE organization_id = 9904401',
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
       VALUES (${FIXTURE.org.id}, '${FIXTURE.org.code}', 'S5 报告集成组织', 'CLIENT', 'ACTIVE')`,
    );
    await query(
      `INSERT INTO base_user_account (id, login_name, login_password, status)
       VALUES (${FIXTURE.engineer}, 's5mr_engineer_9904402', 's5-integration-fixture', 'ACTIVE'),
              (${FIXTURE.admin}, 's5mr_admin_9904403', 's5-integration-fixture', 'ACTIVE'),
              (${FIXTURE.customer}, 's5mr_customer_9904404', 's5-integration-fixture', 'ACTIVE')`,
    );
    await query(
      `INSERT INTO organization_membership (organization_id, account_id, member_role, status)
       VALUES (${FIXTURE.org.id}, ${FIXTURE.engineer}, 'ENGINEER', 'ACTIVE'),
              (${FIXTURE.org.id}, ${FIXTURE.admin}, 'SUPER_ADMIN', 'ACTIVE'),
              (${FIXTURE.org.id}, ${FIXTURE.customer}, 'CUSTOMER', 'ACTIVE')`,
    );
    await query(
      `INSERT INTO equipment_model (id, model_code, model_name, enabled)
       VALUES (${FIXTURE.model.id}, '${FIXTURE.model.code}', 'S5 报告集成机型', 1)`,
    );
    await query(
      `INSERT INTO repair_request
         (id, request_no, customer_account_id, equipment_model_id, error_code,
          fault_description, content_md, owner_organization_id, is_accepted,
          accepted_by_engineer_account_id, accepted_at)
       VALUES (${FIXTURE.repairRequest}, 'S5MR_REQUEST', ${FIXTURE.customer}, ${FIXTURE.model.id},
               'E-S5MR', 'S5 报告集成夹具', '# S5 报告集成夹具', ${FIXTURE.org.id}, TRUE,
               ${FIXTURE.engineer}, NOW(3)),
              (${FIXTURE.repairRequestConcurrent}, 'S5MR_REQUEST_2', ${FIXTURE.customer}, ${FIXTURE.model.id},
               'E-S5MR2', 'S5 报告并发夹具', '# S5 报告并发夹具', ${FIXTURE.org.id}, TRUE,
               ${FIXTURE.engineer}, NOW(3)),
              (${FIXTURE.handlingRequest}, 'S5MR_HANDLING', ${FIXTURE.customer}, ${FIXTURE.model.id},
               'E-S5MR3', 'S5 处理结果夹具', '# S5 处理结果夹具', ${FIXTURE.org.id}, TRUE,
               ${FIXTURE.engineer}, NOW(3))`,
    );
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
    ]) {
      await query(
        `INSERT INTO maintenance_report
           (id, owner_organization_id, source_type, repair_request_id, title,
            customer_factory_name, equipment_model_id, maintenance_date,
            maintenance_engineer_account_id, maintenance_engineer_name_snapshot,
            phase_flow_version, status, current_version_no, ai_usage,
            created_by_account_id, updated_by_account_id)
         VALUES (${report.id}, ${FIXTURE.org.id}, 'WORK_ORDER_SUMMARY', ${report.repairRequest},
                 '${report.title}', 'S5 集成厂家', ${FIXTURE.model.id}, '2026-10-01',
                 ${FIXTURE.engineer}, 'S5 集成工程师', 1, 'DRAFT', 0, 'NOT_USED',
                 ${FIXTURE.engineer}, ${FIXTURE.engineer})`,
      );
      await query(
        `INSERT INTO maintenance_report_alarm
           (id, report_id, alarm_index, alarm_code, alarm_description, phase_code, reset_result)
         VALUES (${report.alarm}, ${report.id}, 1, 'ALM-S5', 'S5 集成报警', 'PHASE_01', 'RESET_OK')`,
      );
      await query(
        `INSERT INTO maintenance_report_step
           (id, report_id, step_no, step_code, phase_code, part_name, action_text, result_text,
            new_alarm_code, is_valid_new_branch)
         VALUES (${report.step}, ${report.id}, 1, 'STEP-S5', 'PHASE_01', 'S5 部件',
                 'S5 集成排查动作', 'S5 集成结果', NULL, 0)`,
      );
    }
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
    await assertIsolatedTarget(config.database);
    // 上次异常中断时先清理同 ID 夹具，再写入本轮夹具
    await deleteFixtures();
    await insertFixtures();

    submitUsecase = moduleRef.get(SubmitMaintenanceReportUsecase);
    updateUsecase = moduleRef.get(UpdateMaintenanceReportDraftUsecase);
    returnUsecase = moduleRef.get(ReturnMaintenanceReportUsecase);
    handlingUsecase = moduleRef.get(RecordRepairRequestHandlingResultUsecase);
  });

  afterAll(async () => {
    const errors: string[] = [];
    if (moduleRef) {
      errors.push(...(await deleteFixtures()));
      errors.push(...(await assertNoResidue()));
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

  it('提交冻结：版本号 1、状态 PENDING_REVIEW、快照含真实内容且未调用 AI 读取器', async () => {
    await submitUsecase.execute({ session: engineerSession, reportId: FIXTURE.reportLifecycle });

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
    await returnUsecase.execute({
      session: adminSession,
      reportId: FIXTURE.reportLifecycle,
      comment: 'S5 集成退回',
    });

    await updateUsecase.execute({
      session: engineerSession,
      reportId: FIXTURE.reportLifecycle,
      draft: { title: 'S5 生命周期报告（修订）' },
    });

    await submitUsecase.execute({ session: engineerSession, reportId: FIXTURE.reportLifecycle });

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
      await submitPromise;
    } finally {
      if (runner.isTransactionActive) {
        await runner.rollbackTransaction().catch(() => undefined);
      }
      await runner.release().catch(() => undefined);
    }

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
});
