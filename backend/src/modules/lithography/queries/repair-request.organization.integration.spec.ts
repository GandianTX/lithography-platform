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
import {
  assertFixtureIdsAvailable,
  assertRegisteredRowsAbsent,
  type ControlledFixtureTable,
  finalizeFixtureTeardown,
  OwnedFixtureLedger,
  prepareFixtureSetup,
  type ReferenceGuard,
  runOwnedFixtureCleanup,
} from '../../../../test/utils/e2e-owned-fixture';
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
const ROUND_TAG = 'REPAIR-REQUEST-ORG-INT';

const FIXTURE = {
  orgA: { id: 9903301, code: 'S5IT_ORG_A' },
  orgB: { id: 9903302, code: 'S5IT_ORG_B' },
  customer: { id: 9903101, loginName: 's5it_customer_9903101' },
  engineer: { id: 9903102, loginName: 's5it_engineer_9903102' },
  otherEngineer: { id: 9903103, loginName: 's5it_engineer_9903103' },
  model: { id: 9903104, code: 'S5IT-MODEL' },
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
  let setupAllowed = false;
  const ledger = new OwnedFixtureLedger(ROUND_TAG);

  const query = async <T = Record<string, unknown>>(
    sql: string,
    parameters?: unknown[],
  ): Promise<T[]> => dataSource.query(sql, parameters);

  const registerRow = async (table: ControlledFixtureTable, id: number): Promise<void> => {
    await ledger.registerById(query, table, id);
  };

  /** 引用闭包：只放行本轮登记的自有行，账本外任何引用都整批拒绝清理 */
  const buildReferenceGuards = (): ReferenceGuard[] => {
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
        table: 'repair_request',
        column: 'owner_organization_id',
        ids: orgIds,
        label: '组织维修申请',
      },
      {
        table: 'organization_membership',
        column: 'organization_id',
        ids: orgIds,
        label: '组织成员',
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
        table: 'organization_membership',
        column: 'account_id',
        ids: accountIds,
        label: '账号成员',
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
    ];

    return referenceGuards.filter((guard) => guard.ids.length > 0);
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
      [FIXTURE.customer.id, FIXTURE.engineer.id, FIXTURE.otherEngineer.id],
      ROUND_TAG,
    );
    await assertFixtureIdsAvailable(dataSource, 'equipment_model', [FIXTURE.model.id], ROUND_TAG);
    await assertFixtureIdsAvailable(dataSource, 'repair_request', REQUEST_IDS, ROUND_TAG);

    await query(
      `INSERT INTO organization (id, organization_code, name, kind, status)
       VALUES (${FIXTURE.orgA.id}, '${FIXTURE.orgA.code}', 'S5 集成组织 A', 'CLIENT', 'ACTIVE'),
              (${FIXTURE.orgB.id}, '${FIXTURE.orgB.code}', 'S5 集成组织 B', 'PEER', 'ACTIVE')`,
    );
    await registerRow('organization', FIXTURE.orgA.id);
    await registerRow('organization', FIXTURE.orgB.id);

    await query(
      `INSERT INTO base_user_account (id, login_name, login_password, status)
       VALUES (${FIXTURE.customer.id}, '${FIXTURE.customer.loginName}', 's5-integration-fixture', 'ACTIVE'),
              (${FIXTURE.engineer.id}, '${FIXTURE.engineer.loginName}', 's5-integration-fixture', 'ACTIVE'),
              (${FIXTURE.otherEngineer.id}, '${FIXTURE.otherEngineer.loginName}', 's5-integration-fixture', 'ACTIVE')`,
    );
    for (const accountId of [FIXTURE.customer.id, FIXTURE.engineer.id, FIXTURE.otherEngineer.id]) {
      await registerRow('base_user_account', accountId);
    }

    await query(
      `INSERT INTO equipment_model (id, model_code, model_name, enabled)
       VALUES (${FIXTURE.model.id}, '${FIXTURE.model.code}', 'S5 集成机型', 1)`,
    );
    await registerRow('equipment_model', FIXTURE.model.id);
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
      await registerRow('repair_request', item.id);
    }
  };

  beforeAll(async () => {
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
    // 环境门禁全部通过后才允许创建夹具；未通过则不登记任何资源
    const gate = await prepareFixtureSetup(dataSource, ROUND_TAG, config.database);
    actualDatabase = gate.database;
    setupAllowed = true;
    // 固定 ID 夹具不做启动前清除：发现碰撞立即失败并保留原数据
    await insertFixtures();

    service = new RepairRequestQueryService(
      dataSource.getRepository(RepairRequestEntity),
      dataSource.getRepository(EngineerResponseEntity),
      dataSource.getRepository(EquipmentModelEntity),
    );
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
          label: '关闭数据库连接',
          run: async () => {
            if (dataSource?.isInitialized) {
              await dataSource.destroy();
            }
          },
        },
      ],
    });
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
