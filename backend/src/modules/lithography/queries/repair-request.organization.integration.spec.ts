/// <reference types="jest" />
import { PERMISSION_ERROR } from '@core/common/errors/domain-error';
import { loadExplicitEnvConfig } from '@src/infrastructure/database/incremental-migration';
import { DataSource } from 'typeorm';
import { AccountEntity } from '@src/modules/account/base/entities/account.entity';
import { UserInfoEntity } from '@src/modules/account/base/entities/user-info.entity';
import { EngineerResponseEntity } from '../entities/engineer-response.entity';
import { EquipmentModelEntity } from '../entities/equipment-model.entity';
import { OrganizationEntity } from '../entities/organization.entity';
import { RepairRequestEntity } from '../entities/repair-request.entity';
import { RepairRequestQueryService } from './repair-request.query.service';

/**
 * 组织范围实库集成验收（维修申请读侧）。
 *
 * 目的：用真实 MySQL + 真实 Repository 验证 S5 收紧后的可见口径——
 * 无归属存量工单不向全体工程师开放，仅在 MINE（接单本人）与客户本人视角可见。
 *
 * 默认跳过；启用时必须显式声明隔离库与清理许可：
 *   REPAIR_REQUEST_ORG_INTEGRATION=1 E2E_ALLOW_PHYSICAL_CLEANUP=1 \
 *     npx jest src/modules/lithography/queries/repair-request.organization.integration.spec.ts --runInBand
 *
 * 前置：`env/.env.e2e` 指向隔离库 `lithography_e2e`，且该库为当前迁移终态。
 * 夹具使用固定高位 ID 并在收尾时按精确 ID 删除、核对零残留。
 */
const ENABLED = process.env.REPAIR_REQUEST_ORG_INTEGRATION === '1';
const describeIntegration = ENABLED ? describe : describe.skip;

const ENV_FILE = 'env/.env.e2e';
const ISOLATED_DATABASES = ['lithography_e2e'];
const CLEANUP_CONSENT_ENV = 'E2E_ALLOW_PHYSICAL_CLEANUP';

const FIXTURE = {
  orgA: { id: 9903301, code: 'S5IT_ORG_A' },
  orgB: { id: 9903302, code: 'S5IT_ORG_B' },
  customer: { id: 9903101, loginName: 's5it_customer_9903101' },
  engineer: { id: 9903102, loginName: 's5it_engineer_9903102' },
  otherEngineer: { id: 9903103, loginName: 's5it_engineer_9903103' },
  model: { id: 9903104, code: 'S5IT-MODEL' },
  requestNoPrefix: 'S5IT_',
  requests: {
    orgAUnaccepted: 9903201,
    orgBAcceptedByOther: 9903202,
    nullUnaccepted: 9903203,
    nullAcceptedByViewer: 9903204,
    orgAAcceptedByViewerOwnedByOtherCustomer: 9903205,
  },
} as const;

const REQUEST_IDS = Object.values(FIXTURE.requests);

const customerSession = { accountId: FIXTURE.customer.id, roles: ['CUSTOMER'] };
const engineerSession = { accountId: FIXTURE.engineer.id, roles: ['ENGINEER'] };
const otherCustomerSession = { accountId: FIXTURE.otherEngineer.id, roles: ['CUSTOMER'] };

jest.setTimeout(120_000);

describeIntegration('维修申请组织范围实库验收', () => {
  let dataSource: DataSource;
  let service: RepairRequestQueryService;
  let actualDatabase = '';

  const query = async <T = Record<string, unknown>>(sql: string): Promise<T[]> =>
    dataSource.query(sql);

  const assertCleanupConsent = (): void => {
    if (process.env[CLEANUP_CONSENT_ENV] !== '1') {
      throw new Error(
        `拒绝执行夹具写入/删除：缺少显式许可 ${CLEANUP_CONSENT_ENV}=1（不提供默认值）。`,
      );
    }
  };

  const assertIsolatedTarget = async (declaredDatabase: string): Promise<void> => {
    if (!ISOLATED_DATABASES.includes(declaredDatabase.toLowerCase())) {
      throw new Error(
        `拒绝在库 "${declaredDatabase}" 上执行集成验收：仅允许 [${ISOLATED_DATABASES.join(', ')}]。`,
      );
    }
    const rows = await query<{ current: string }>('SELECT DATABASE() AS current');
    const current = (rows[0]?.current ?? '').toLowerCase();
    if (current !== declaredDatabase.toLowerCase()) {
      throw new Error(
        `实际连接目标 "${current}" 与声明库 "${declaredDatabase}" 不一致，拒绝写入。`,
      );
    }
    actualDatabase = current;
  };

  const deleteFixtures = async (): Promise<string[]> => {
    const errors: string[] = [];
    const steps: Array<{ label: string; sql: string }> = [
      {
        label: '维修申请',
        sql: `DELETE FROM repair_request WHERE id IN (${REQUEST_IDS.join(',')}) AND request_no LIKE '${FIXTURE.requestNoPrefix}%'`,
      },
      {
        label: '机型',
        sql: `DELETE FROM equipment_model WHERE id = ${FIXTURE.model.id} AND model_code = '${FIXTURE.model.code}'`,
      },
      {
        label: '账号',
        sql: `DELETE FROM base_user_account WHERE id IN (${FIXTURE.customer.id},${FIXTURE.engineer.id},${FIXTURE.otherEngineer.id}) AND login_name IN ('${FIXTURE.customer.loginName}','${FIXTURE.engineer.loginName}','${FIXTURE.otherEngineer.loginName}')`,
      },
      {
        label: '组织',
        sql: `DELETE FROM organization WHERE id IN (${FIXTURE.orgA.id},${FIXTURE.orgB.id}) AND organization_code IN ('${FIXTURE.orgA.code}','${FIXTURE.orgB.code}')`,
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
        label: '维修申请残留',
        sql: `SELECT COUNT(*) AS total FROM repair_request WHERE id IN (${REQUEST_IDS.join(',')})`,
      },
      {
        label: '账号残留',
        sql: `SELECT COUNT(*) AS total FROM base_user_account WHERE id IN (${FIXTURE.customer.id},${FIXTURE.engineer.id},${FIXTURE.otherEngineer.id})`,
      },
      {
        label: '组织残留',
        sql: `SELECT COUNT(*) AS total FROM organization WHERE id IN (${FIXTURE.orgA.id},${FIXTURE.orgB.id})`,
      },
      {
        label: '机型残留',
        sql: `SELECT COUNT(*) AS total FROM equipment_model WHERE id = ${FIXTURE.model.id}`,
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
       VALUES (${FIXTURE.orgA.id}, '${FIXTURE.orgA.code}', 'S5 集成组织 A', 'CLIENT', 'ACTIVE'),
              (${FIXTURE.orgB.id}, '${FIXTURE.orgB.code}', 'S5 集成组织 B', 'PEER', 'ACTIVE')`,
    );
    await query(
      `INSERT INTO base_user_account (id, login_name, login_password, status)
       VALUES (${FIXTURE.customer.id}, '${FIXTURE.customer.loginName}', 's5-integration-fixture', 'ACTIVE'),
              (${FIXTURE.engineer.id}, '${FIXTURE.engineer.loginName}', 's5-integration-fixture', 'ACTIVE'),
              (${FIXTURE.otherEngineer.id}, '${FIXTURE.otherEngineer.loginName}', 's5-integration-fixture', 'ACTIVE')`,
    );
    await query(
      `INSERT INTO equipment_model (id, model_code, model_name, enabled)
       VALUES (${FIXTURE.model.id}, '${FIXTURE.model.code}', 'S5 集成机型', 1)`,
    );
    const values = [
      {
        id: FIXTURE.requests.orgAUnaccepted,
        no: 'S5IT_ORG_A',
        customer: FIXTURE.customer.id,
        org: `${FIXTURE.orgA.id}`,
        accepted: 'FALSE',
        engineer: 'NULL',
      },
      {
        id: FIXTURE.requests.orgBAcceptedByOther,
        no: 'S5IT_ORG_B_ACCEPTED',
        customer: FIXTURE.customer.id,
        org: `${FIXTURE.orgB.id}`,
        accepted: 'TRUE',
        engineer: `${FIXTURE.otherEngineer.id}`,
      },
      {
        id: FIXTURE.requests.nullUnaccepted,
        no: 'S5IT_NULL_UNACCEPTED',
        customer: FIXTURE.customer.id,
        org: 'NULL',
        accepted: 'FALSE',
        engineer: 'NULL',
      },
      {
        id: FIXTURE.requests.nullAcceptedByViewer,
        no: 'S5IT_NULL_ACCEPTED_SELF',
        customer: FIXTURE.customer.id,
        org: 'NULL',
        accepted: 'TRUE',
        engineer: `${FIXTURE.engineer.id}`,
      },
      {
        id: FIXTURE.requests.orgAAcceptedByViewerOwnedByOtherCustomer,
        no: 'S5IT_ORG_A_ACCEPTED',
        customer: FIXTURE.otherEngineer.id,
        org: `${FIXTURE.orgA.id}`,
        accepted: 'TRUE',
        engineer: `${FIXTURE.engineer.id}`,
      },
    ];
    for (const item of values) {
      await query(
        `INSERT INTO repair_request
           (id, request_no, customer_account_id, equipment_model_id, error_code,
            fault_description, content_md, owner_organization_id, is_accepted,
            accepted_by_engineer_account_id, accepted_at)
         VALUES (${item.id}, '${item.no}', ${item.customer}, ${FIXTURE.model.id}, 'E-S5IT',
                 'S5 集成夹具', '# S5 集成夹具', ${item.org}, ${item.accepted},
                 ${item.engineer}, ${item.accepted === 'TRUE' ? 'NOW(3)' : 'NULL'})`,
      );
    }
  };

  beforeAll(async () => {
    assertCleanupConsent();
    const declaredDatabase =
      process.env.REPAIR_REQUEST_ORG_INTEGRATION_DATABASE ?? 'lithography_e2e';
    const config = loadExplicitEnvConfig(ENV_FILE, declaredDatabase);

    dataSource = new DataSource({
      type: 'mysql',
      host: config.host,
      port: config.port,
      username: config.username,
      password: config.password,
      database: config.database,
      timezone: config.timezone,
      charset: config.charset,
      entities: [
        RepairRequestEntity,
        EngineerResponseEntity,
        EquipmentModelEntity,
        OrganizationEntity,
        AccountEntity,
        UserInfoEntity,
      ],
      synchronize: false,
      logging: false,
    });
    await dataSource.initialize();
    await assertIsolatedTarget(config.database);

    // 上次异常中断时先清理同名夹具，再写入本轮固定 ID 夹具
    await deleteFixtures();
    await insertFixtures();

    service = new RepairRequestQueryService(
      dataSource.getRepository(RepairRequestEntity),
      dataSource.getRepository(EngineerResponseEntity),
      dataSource.getRepository(EquipmentModelEntity),
    );
  });

  afterAll(async () => {
    const errors: string[] = [];
    if (dataSource?.isInitialized) {
      errors.push(...(await deleteFixtures()));
      errors.push(...(await assertNoResidue()));
      try {
        await dataSource.destroy();
      } catch (error) {
        errors.push(`关闭连接失败：${(error as Error).message}`);
      }
    }
    if (errors.length > 0) {
      throw new Error(
        `夹具收尾失败（目标库 ${actualDatabase || '(未确认)'}）：${errors.join('；')}`,
      );
    }
  });

  it('ALL：仅本组织可见，无归属存量不因组织缺失进入全量视图', async () => {
    const result = await service.listByEngineer({
      engineerAccountId: FIXTURE.engineer.id,
      scope: 'ALL',
      filter: {},
      pagination: { page: 1, pageSize: 50, withTotal: true },
      viewerOrganizationId: FIXTURE.orgA.id,
    });

    const ids = result.items.map((item) => item.id);
    expect(ids).toEqual(expect.arrayContaining([FIXTURE.requests.orgAUnaccepted]));
    expect(ids).not.toContain(FIXTURE.requests.orgBAcceptedByOther);
    expect(ids).not.toContain(FIXTURE.requests.nullUnaccepted);
    expect(ids).not.toContain(FIXTURE.requests.nullAcceptedByViewer);
  });

  it('ALL：无组织上下文返回空页，不放开到全库', async () => {
    const result = await service.listByEngineer({
      engineerAccountId: FIXTURE.engineer.id,
      scope: 'ALL',
      filter: {},
      pagination: { page: 1, pageSize: 50, withTotal: true },
      viewerOrganizationId: null,
    });

    expect(result).toEqual({ items: [], total: 0, page: 1, pageSize: 50 });
  });

  it('AVAILABLE：本组织待接单池不含无归属存量', async () => {
    const result = await service.listByEngineer({
      engineerAccountId: FIXTURE.engineer.id,
      scope: 'AVAILABLE',
      filter: {},
      pagination: { page: 1, pageSize: 50, withTotal: true },
      viewerOrganizationId: FIXTURE.orgA.id,
    });

    const ids = result.items.map((item) => item.id);
    expect(ids).toContain(FIXTURE.requests.orgAUnaccepted);
    expect(ids).not.toContain(FIXTURE.requests.nullUnaccepted);
  });

  it('MINE：本人已接单的本组织与无归属存量均可见，未接单的无归属存量不可见', async () => {
    const result = await service.listByEngineer({
      engineerAccountId: FIXTURE.engineer.id,
      scope: 'MINE',
      filter: {},
      pagination: { page: 1, pageSize: 50, withTotal: true },
      viewerOrganizationId: FIXTURE.orgA.id,
    });

    const ids = result.items.map((item) => item.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        FIXTURE.requests.nullAcceptedByViewer,
        FIXTURE.requests.orgAAcceptedByViewerOwnedByOtherCustomer,
      ]),
    );
    expect(ids).not.toContain(FIXTURE.requests.nullUnaccepted);
    expect(ids).not.toContain(FIXTURE.requests.orgBAcceptedByOther);
  });

  it('MINE：无组织上下文仍可见本人已接单的无归属存量', async () => {
    const result = await service.listByEngineer({
      engineerAccountId: FIXTURE.engineer.id,
      scope: 'MINE',
      filter: {},
      pagination: { page: 1, pageSize: 50, withTotal: true },
      viewerOrganizationId: null,
    });

    const ids = result.items.map((item) => item.id);
    expect(ids).toEqual(expect.arrayContaining([FIXTURE.requests.nullAcceptedByViewer]));
    expect(ids).not.toContain(FIXTURE.requests.nullUnaccepted);
  });

  it('详情：无归属且未接单的存量对工程师拒绝（不因组织列缺失开放）', async () => {
    await expect(
      service.findDetail({
        requestId: FIXTURE.requests.nullUnaccepted,
        session: engineerSession,
        scope: 'ENGINEER',
        viewerOrganizationId: null,
      }),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.ACCESS_DENIED });
  });

  it('详情：无归属但由本人接单的存量仍可读（接单工程师访问保持）', async () => {
    await expect(
      service.findDetail({
        requestId: FIXTURE.requests.nullAcceptedByViewer,
        session: engineerSession,
        scope: 'ENGINEER',
        viewerOrganizationId: null,
      }),
    ).resolves.toMatchObject({ id: FIXTURE.requests.nullAcceptedByViewer });
  });

  it('详情：本组织工单可读，跨组织工单拒绝', async () => {
    await expect(
      service.findDetail({
        requestId: FIXTURE.requests.orgAAcceptedByViewerOwnedByOtherCustomer,
        session: engineerSession,
        scope: 'ENGINEER',
        viewerOrganizationId: FIXTURE.orgA.id,
      }),
    ).resolves.toMatchObject({
      id: FIXTURE.requests.orgAAcceptedByViewerOwnedByOtherCustomer,
    });

    await expect(
      service.findDetail({
        requestId: FIXTURE.requests.orgBAcceptedByOther,
        session: engineerSession,
        scope: 'ENGINEER',
        viewerOrganizationId: FIXTURE.orgA.id,
      }),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.ACCESS_DENIED });
  });

  it('客户入口：仅本人申请可读（含无归属存量），他人申请拒绝', async () => {
    await expect(
      service.findDetail({
        requestId: FIXTURE.requests.nullUnaccepted,
        session: customerSession,
        scope: 'CUSTOMER',
      }),
    ).resolves.toMatchObject({ id: FIXTURE.requests.nullUnaccepted });

    await expect(
      service.findDetail({
        requestId: FIXTURE.requests.orgAAcceptedByViewerOwnedByOtherCustomer,
        session: customerSession,
        scope: 'CUSTOMER',
      }),
    ).rejects.toMatchObject({ code: PERMISSION_ERROR.ACCESS_DENIED });

    await expect(
      service.findDetail({
        requestId: FIXTURE.requests.orgAAcceptedByViewerOwnedByOtherCustomer,
        session: otherCustomerSession,
        scope: 'CUSTOMER',
      }),
    ).resolves.toMatchObject({
      id: FIXTURE.requests.orgAAcceptedByViewerOwnedByOtherCustomer,
    });
  });
});
