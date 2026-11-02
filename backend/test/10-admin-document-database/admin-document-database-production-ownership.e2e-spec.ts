// test/10-admin-document-database/admin-document-database-production-ownership.e2e-spec.ts
//
// 敌对式终审 F1：**固定主键不等于所有权**。
//
// 场景：production fixture 的型号 / 维修申请 / 哨兵链历史上以固定主键（5296–5301）代表
// 「这些行属于我」，于是准备与清理阶段都会按固定 ID 直接删除。若隔离库中恰好存在
// 主键相同、但**归属不是本 spec** 的行（其他用例、历史残留、人工造数），这些行会被
// 无声删除或覆盖。
//
// 本 spec 在真实隔离库 `lithography_e2e` 上先造出「同主键、不同归属」的外部数据，
// 再调用 production fixture 的准备/清理 helper，断言外部数据的 ID、字段与行数**完全不变**。
// 预置数据不经任何 fixture helper 清除（不规避失败）；外部数据使用与 fixture 完全不同的
// 专属标记（modelCode / requestNo / loginName）以区分归属。
//
// 第四轮 Review P1-2：本 spec 自身同样是「验证安全性」的测试，**不得反过来覆盖或清理隔离库中的既有数据**：
// - 占用历史固定数字 ID 的外部链一律「先查空闲 → 仅 INSERT」（`e2e-insert-only-seed`；
//   绝不 save/upsert/update：save 对已存在主键会走 UPDATE，等于先改掉别人的行再拍快照）；
//   目标 ID 已被占用即失败关闭，写入中途抛错只报错、不更新既有行；
// - 回收只走「专属标记定位（只读）→ 逐字段 + 账号角色 + user_info 行数 + 父子引用 + 外部引用
//   核验（同一事务）→ 全部通过后按已确认的实际 ID 子到父删除」；任何一项不符即整次失败、**零 DELETE**，
//   绝不按固定 ID / 同名标记 / 账号 ID 兜底删除；
// - beforeAll 造数中途失败：先按同一套核验机制回收本轮已写入的行，再重抛**原始错误**（不掩盖根因）。
//
// 唯一索引事实（据实体定义，实测复核）：`loginName` / `requestNo` 具唯一索引，因此
// 「同 loginName 异主账号」「同 requestNo 异主申请」在库层面不可能并存，同名异主反例由
// **modelCode（非唯一）** 覆盖。
//
// 目标库安全：所有破坏性动作前复用不可跳过的白名单守卫（e2e-db-guard）。

import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PARAMS_PROVIDER_TOKEN, type Params } from 'nestjs-pino';
import { DataSource, EntityManager, In } from 'typeorm';

import { AccountStatus, IdentityTypeEnum } from '@app-types/models/account.types';
import { UserState } from '@app-types/models/user-info.types';
import { AccountEntity } from '@src/modules/account/base/entities/account.entity';
import { UserInfoEntity } from '@src/modules/account/base/entities/user-info.entity';
import { EquipmentModelEntity } from '@src/modules/lithography/entities/equipment-model.entity';
import { MaintenanceReportEntity } from '@src/modules/lithography/entities/maintenance-report.entity';
import { OrganizationEntity } from '@src/modules/lithography/entities/organization.entity';
import { RepairRequestEntity } from '@src/modules/lithography/entities/repair-request.entity';
import { CreateAccountUsecase } from '@src/usecases/account/create-account.usecase';

import { assertDataSourceOnAllowedE2eDatabase } from '../utils/e2e-db-guard';
import { assertFixedIdsVacant, insertOnlyAtFixedIds } from '../utils/e2e-insert-only-seed';
import {
  assertNoTriggerCaseFailures,
  assertTriggerNameFormat,
  createOwnedTrigger,
  createTriggerOwnershipTracker,
  disposeOwnedTriggerRecord,
  readOwnedTriggerFact,
  runWithOwnedTrigger,
  type OwnedTriggerRecord,
  type TriggerOwnershipTracker,
} from '../utils/e2e-trigger-ownership';
import { createTestAccount, type TestAccountConfig } from '../utils/test-accounts';
import { runAdminDocFixtureTeardown } from './admin-document-database-fixture';
import {
  PRODUCTION_FIXTURE_MARKERS,
  PRODUCTION_SENTINEL,
  PRODUCTION_SENTINEL_MODEL_SPEC,
  cleanupProductionFixtureByIds,
  cleanupProductionFixtureResidue,
  cleanupProductionSentinelChain,
  createProductionFixtureOwnership,
  ensureProductionSentinelChain,
  findProductionFixtureAccountIds,
  readProductionSentinelSnapshot,
  seedProductionFixtureAccounts,
  seedProductionFixtureBusiness,
  type ProductionFixtureOwnership,
} from './admin-document-database-production-fixture';

/** 历史固定主键（外部数据刻意占用这些 ID：主键碰撞不得改变归属判定） */
const LEGACY_FIXED_IDS = {
  modelId: 5298,
  openRequestId: 5300,
  acceptedRequestId: 5301,
  sentinelModelId: 5296,
  sentinelRequestId: 5297,
} as const;

/** 外部（非本 spec）数据标记：与 fixture 标记完全不同，用于区分归属 */
const FOREIGN = {
  accountLoginName: 'pr3collisionowner',
  modelCode: 'E2E-PR3-COLLISION-MODEL',
  openRequestNo: 'E2E-PR3-COLLISION-OPEN',
  acceptedRequestNo: 'E2E-PR3-COLLISION-ACCEPTED',
  sentinelModelCode: 'E2E-PR3-COLLISION-SENTINEL-MODEL',
  sentinelRequestNo: 'E2E-PR3-COLLISION-SENTINEL',
  /** 外部申请：编号与归属均不属于 fixture，仅用于引用本 spec 账号 */
  externalRefRequestNo: 'E2E-PR3-FOREIGN-EXT-REF',
  /** 外部维修报告的组织：固定主键仅 INSERT，专用标记以区分归属 */
  maintenanceReportOrgId: 9907201,
  maintenanceReportOrgCode: 'E2E-PR3-FOREIGN-REPORT-ORG',
} as const;

/** 外部链的专属自然标记（仅用于**定位**；命中后必须逐字段核验才可回收） */
const FOREIGN_REQUEST_NOS: readonly string[] = [
  FOREIGN.openRequestNo,
  FOREIGN.acceptedRequestNo,
  FOREIGN.sentinelRequestNo,
];

const FOREIGN_MODEL_CODES: readonly string[] = [FOREIGN.modelCode, FOREIGN.sentinelModelCode];

/**
 * P1：后序失败注入触发器（本轮唯一名称 + 同名预检 + 定义核验，见 e2e-trigger-ownership）。
 * 删除顺序为 request → model → user_info → account，因此在 user_info 上注入失败时
 * 申请与型号已被删除，正好检验同一事务整批回滚。
 */
const ROLLBACK_TRIGGER_TABLE = 'base_user_info';
const ROLLBACK_TRIGGER_BODY =
  "SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'E2E production 后序删除失败注入'";
let triggerSequence = 0;

const nextTriggerName = (label: string): string => {
  triggerSequence += 1;
  const name = `e2e_prod_${label}_${process.pid}_${triggerSequence}_${Date.now()}`;
  assertTriggerNameFormat(name);
  return name;
};

const FOREIGN_ACCOUNT_CONFIG: TestAccountConfig = {
  loginName: FOREIGN.accountLoginName,
  loginEmail: 'pr3.collision.owner@example.com',
  loginPassword: 'Pr3CollisionOwner@2024',
  status: AccountStatus.ACTIVE,
  accessGroup: [IdentityTypeEnum.CUSTOMER],
  identityType: IdentityTypeEnum.CUSTOMER,
};

// ---------------------------------------------------------------------------------------
// 外部碰撞链的**期望形状**：造数与回收核验共用同一真源（避免两套口径漂移）。
// 动态外键（customerAccountId / equipmentModelId / acceptedByEngineerAccountId）与时间列
// 不入期望子集：前者按运行时记录核验，后者由「前后快照完全一致」的断言覆盖。
// ---------------------------------------------------------------------------------------

const FOREIGN_ACCOUNT_FIELDS = {
  loginName: FOREIGN_ACCOUNT_CONFIG.loginName,
  loginEmail: FOREIGN_ACCOUNT_CONFIG.loginEmail,
  status: FOREIGN_ACCOUNT_CONFIG.status,
  identityHint: FOREIGN_ACCOUNT_CONFIG.identityType,
} as const;

const FOREIGN_USER_INFO_FIELDS = {
  nickname: `${FOREIGN_ACCOUNT_CONFIG.loginName}_nickname`,
  email: FOREIGN_ACCOUNT_CONFIG.loginEmail,
  accessGroup: FOREIGN_ACCOUNT_CONFIG.accessGroup,
  userState: UserState.ACTIVE,
} as const;

const FOREIGN_MODEL_FIELDS = {
  modelCode: FOREIGN.modelCode,
  modelName: '外部（非本 spec）型号：占用历史固定 ID',
  enabled: true,
  sortOrder: 1,
} as const;

const FOREIGN_SENTINEL_MODEL_FIELDS = {
  modelCode: FOREIGN.sentinelModelCode,
  modelName: '外部（非本 spec）哨兵型号：占用历史固定 ID',
  enabled: true,
  sortOrder: 2,
} as const;

const FOREIGN_REQUEST_FIELDS = [
  {
    id: LEGACY_FIXED_IDS.openRequestId,
    requestNo: FOREIGN.openRequestNo,
    errorCode: 'COLLISION-OPEN',
    faultDescription: '外部数据：占用历史固定申请 ID',
    contentMd: '# E2E-PR3-COLLISION-OPEN',
    isAccepted: false,
    deprecated: false,
    deletedAt: null,
  },
  {
    id: LEGACY_FIXED_IDS.acceptedRequestId,
    requestNo: FOREIGN.acceptedRequestNo,
    errorCode: 'COLLISION-ACCEPTED',
    faultDescription: '外部数据：占用历史固定申请 ID',
    contentMd: '# E2E-PR3-COLLISION-ACCEPTED',
    isAccepted: true,
    deprecated: false,
    deletedAt: null,
  },
  {
    id: LEGACY_FIXED_IDS.sentinelRequestId,
    requestNo: FOREIGN.sentinelRequestNo,
    errorCode: 'COLLISION-SENTINEL',
    faultDescription: '外部数据：占用历史固定哨兵 ID',
    contentMd: '# E2E-PR3-COLLISION-SENTINEL',
    isAccepted: false,
    deprecated: false,
    deletedAt: null,
  },
] as const;

/** P1-2：造数过程中的**增量记录**（每步成功立即写入，抛错时据此核验后精确回收） */
type ForeignRecorder = {
  accountId: number | null;
  modelIds: number[];
  requestIds: number[];
};

const createForeignRecorder = (): ForeignRecorder => ({
  accountId: null,
  modelIds: [],
  requestIds: [],
});

const ownershipViolation = (detail: string): Error =>
  new Error(`[removeForeignResidue] 阶段=归属校验 拒绝删除：${detail}`);

const assertForeignFields = (label: string, actual: unknown, expected: unknown): void => {
  const actualRecord = (actual ?? {}) as Record<string, unknown>;
  const expectedRecord = expected as Record<string, unknown>;
  for (const key of Object.keys(expectedRecord)) {
    if (JSON.stringify(actualRecord[key]) !== JSON.stringify(expectedRecord[key])) {
      throw ownershipViolation(
        `${label} 字段 ${key} 与外部链预期不符（实际 ${JSON.stringify(
          actualRecord[key],
        )}，预期 ${JSON.stringify(expectedRecord[key])}）`,
      );
    }
  }
};

const assertIdsWithin = (
  label: string,
  actual: readonly number[],
  verified: readonly number[],
): void => {
  const allowed = new Set(verified);
  for (const id of actual) {
    if (!allowed.has(id)) {
      throw ownershipViolation(`${label} id=${id} 不在本次已记录集合内`);
    }
  }
};

/** E2E 日志配置：stdout 直写（无 pino/file transport），不触碰生产日志目录 */
const E2E_LOGGER_PARAMS = {
  pinoHttp: {
    level: 'info',
  },
} as unknown as Params;

type ForeignSnapshot = {
  model: EquipmentModelEntity | null;
  openRequest: RepairRequestEntity | null;
  acceptedRequest: RepairRequestEntity | null;
  sentinelModel: EquipmentModelEntity | null;
  sentinelRequest: RepairRequestEntity | null;
  /** 按外部标记统计的行数：证明既没被删除也没被复制 */
  rowCounts: {
    models: number;
    requests: number;
  };
};

describe('production fixture 所有权：固定主键碰撞不得影响外部数据（F1）', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let foreignAccountId: number;
  /** 本 spec 自己创建、可回收的 fixture 账号（按记录 ID 收尾） */
  const fixtureOwnership: ProductionFixtureOwnership = createProductionFixtureOwnership();
  /** P1-2：外部链的本轮增量记录（仅用于定位回收边界，绝不作为归属依据） */
  const foreignRecorder = createForeignRecorder();
  /** R1：仅当 beforeAll 在「写任何行之前」完成白名单验证才置位，afterAll 据此决定能否清理。 */
  let fixtureTargetValidated = false;
  /** 部分失败用例共用的桩账号 ID（真实 FK 目标） */
  let fixtureCustomerAccountId: number;
  let fixtureEngineerAccountId: number;

  beforeAll(async () => {
    const [{ initGraphQLSchema }, { ApiModule: apiModule }] = await Promise.all([
      import('../../src/adapters/api/graphql/schema/schema.init'),
      import('../../src/bootstraps/api/api.module'),
    ]);

    initGraphQLSchema();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [apiModule],
    })
      .overrideProvider(PARAMS_PROVIDER_TOKEN)
      .useValue(E2E_LOGGER_PARAMS)
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    dataSource = moduleFixture.get<DataSource>(DataSource);

    // 🔒 第一条 DELETE 之前复用不可跳过的目标库白名单守卫
    await assertDataSourceOnAllowedE2eDatabase(dataSource);
    // R1：守卫通过后才允许清理（写任何行之前置位）；守卫拒绝 / 半途失败时
    // afterAll 只关闭 app，不会在未授权目标上 DELETE。
    fixtureTargetValidated = true;

    try {
      // 先清掉本 spec 上一次运行自己预置的外部数据（专属标记 → 逐字段/引用核验 → 精确回收）
      await removeForeignResidue(dataSource);
      // 再清掉**上一次 fixture 运行**的崩溃残留（按 fixture 专属标记 + 完整归属校验）
      await cleanupProductionFixtureResidue(dataSource);

      await presetForeignRows(foreignRecorder);
      if (foreignRecorder.accountId === null) {
        throw new Error('外部账号创建未返回数据库主键，拒绝继续');
      }
      foreignAccountId = foreignRecorder.accountId;

      // 本 spec 自己造一份 fixture 账号（业务行引用它们，属于本 spec 可回收范围）
      const seeded = await seedProductionFixtureAccounts({
        dataSource,
        ownership: fixtureOwnership,
        createAccountUsecase: app.get(CreateAccountUsecase),
      });
      if (seeded.failures.length > 0) {
        throw new Error(
          `所有权 spec 桩账号创建失败：${seeded.failures.map((f) => f.key).join(', ')}`,
        );
      }
      const idByKey = new Map(seeded.created.map((seed) => [seed.key, seed.accountId]));
      const customerAccountId = idByKey.get('customer');
      const engineerAccountId = idByKey.get('engineer');
      if (customerAccountId === undefined || engineerAccountId === undefined) {
        throw new Error('所有权 spec 桩账号记录不完整（缺少 customer / engineer）');
      }
      fixtureCustomerAccountId = customerAccountId;
      fixtureEngineerAccountId = engineerAccountId;
    } catch (seedError) {
      // 造数中途失败：先按同一套核验机制精确回收本轮已写入的行，再重抛**原始错误**（不掩盖根因）。
      try {
        await removeForeignResidue(dataSource);
        await cleanupProductionFixtureByIds(dataSource, fixtureOwnership);
      } catch {
        // 回收失败不掩盖原始造数错误：保留现场，afterAll 仍会以 targetValidated 再尝试一次
        // （失败关闭，绝不做固定 ID / 同名标记 / 账号 ID 兜底删除）。
      }
      throw seedError;
    }
  });

  afterAll(async () => {
    // R1：守卫拒绝、模块装配失败、连接未完成 → 只关闭已创建的 app，不做任何删除；
    // 清理失败不吞错且仍会关闭 app（try/finally 在 helper 内实现）。
    await runAdminDocFixtureTeardown({
      app,
      dataSource,
      targetValidated: fixtureTargetValidated,
      cleanup: async (ds) => {
        // 只回收本 spec 自己预置的外部数据（标记先行 → 逐字段/引用核验 → 记录 ID）
        await removeForeignResidue(ds);
        // 只回收本 spec 自己创建的 fixture 账号（按本轮记录的 ID）
        await cleanupProductionFixtureByIds(ds, fixtureOwnership);
      },
    });
  });

  /**
   * 预置「同主键、不同归属」的外部数据（显式占用历史固定 ID）。
   *
   * 安全前提（P1-2）：先确认全部目标固定 ID 空闲（只读），再以 `insertOnlyAtFixedIds`（纯 INSERT）
   * 写入；任一 ID 已被占用即失败关闭、零写入；每步成功立即记录实际 ID。
   */
  const presetForeignRows = async (recorder: ForeignRecorder): Promise<void> => {
    const modelRepo = dataSource.getRepository(EquipmentModelEntity);
    const requestRepo = dataSource.getRepository(RepairRequestEntity);

    await assertFixedIdsVacant(modelRepo, '外部碰撞链型号', [LEGACY_FIXED_IDS.modelId]);
    await assertFixedIdsVacant(requestRepo, '外部碰撞链申请', [
      LEGACY_FIXED_IDS.openRequestId,
      LEGACY_FIXED_IDS.acceptedRequestId,
    ]);

    const created = await createTestAccount(
      dataSource,
      app.get(CreateAccountUsecase),
      FOREIGN_ACCOUNT_CONFIG,
    );
    recorder.accountId = created.accountId;

    const [modelId] = await insertOnlyAtFixedIds(modelRepo, '外部碰撞链型号', [
      { id: LEGACY_FIXED_IDS.modelId, ...FOREIGN_MODEL_FIELDS },
    ]);
    recorder.modelIds.push(modelId);

    const requestIds = await insertOnlyAtFixedIds(requestRepo, '外部碰撞链申请', [
      {
        ...FOREIGN_REQUEST_FIELDS[0],
        customerAccountId: created.accountId,
        equipmentModelId: modelId,
        acceptedByEngineerAccountId: null,
        acceptedAt: null,
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
      },
      {
        ...FOREIGN_REQUEST_FIELDS[1],
        customerAccountId: created.accountId,
        equipmentModelId: modelId,
        acceptedByEngineerAccountId: created.accountId,
        acceptedAt: new Date('2026-08-02T01:00:00.000Z'),
        createdAt: new Date('2026-08-02T00:00:00.000Z'),
      },
    ]);
    recorder.requestIds.push(...requestIds);
  };

  /**
   * 预置「同主键、不同归属」的哨兵链（固定 ID 相同，字段与所属账号不同）。
   * 同样先查空闲、再仅 INSERT；账号沿用已创建的外部账号（不重复写入）。
   */
  const presetForeignSentinelRows = async (recorder: ForeignRecorder): Promise<void> => {
    const modelRepo = dataSource.getRepository(EquipmentModelEntity);
    const requestRepo = dataSource.getRepository(RepairRequestEntity);

    // 只读预检查先于任何写入（含账号前置断言）：目标 ID 已被占用时立即失败关闭
    await assertFixedIdsVacant(modelRepo, '外部哨兵型号', [LEGACY_FIXED_IDS.sentinelModelId]);
    await assertFixedIdsVacant(requestRepo, '外部哨兵申请', [LEGACY_FIXED_IDS.sentinelRequestId]);

    const accountId = recorder.accountId;
    if (accountId === null) {
      throw new Error('外部账号尚未创建，拒绝预置外部哨兵链');
    }

    const [modelId] = await insertOnlyAtFixedIds(modelRepo, '外部哨兵型号', [
      { id: LEGACY_FIXED_IDS.sentinelModelId, ...FOREIGN_SENTINEL_MODEL_FIELDS },
    ]);
    recorder.modelIds.push(modelId);

    const requestIds = await insertOnlyAtFixedIds(requestRepo, '外部哨兵申请', [
      {
        ...FOREIGN_REQUEST_FIELDS[2],
        customerAccountId: accountId,
        equipmentModelId: modelId,
        acceptedByEngineerAccountId: null,
        acceptedAt: null,
        createdAt: new Date('2026-08-03T00:00:00.000Z'),
      },
    ]);
    recorder.requestIds.push(...requestIds);
  };

  /**
   * 回收本 spec 自己预置的外部数据（上次运行残留 / 收尾）。
   *
   * 边界（P1-2）：**专属标记只用于定位（只读）**，命中后在同一事务内完成
   * 「逐字段核验账号及 user_info、型号、申请形状 → 账号角色 → 父子引用 → 外部引用」全量核验，
   * 全部通过后才按已确认的实际 ID 子到父删除；任何一项不符即整次失败、**零 DELETE**
   * （绝不做固定 ID / 同名标记 / 账号 ID 兜底删除）。
   */
  const removeForeignResidue = async (ds: DataSource): Promise<void> => {
    await assertDataSourceOnAllowedE2eDatabase(ds);

    await ds.transaction(async (manager) => {
      const accountRepo = manager.getRepository(AccountEntity);
      const userInfoRepo = manager.getRepository(UserInfoEntity);
      const modelRepo = manager.getRepository(EquipmentModelEntity);
      const requestRepo = manager.getRepository(RepairRequestEntity);

      // 1) 账号：专属 loginName 只用于定位，命中后逐字段核验
      const accounts = await accountRepo.find({
        where: { loginName: FOREIGN.accountLoginName },
      });
      for (const account of accounts) {
        assertForeignFields(`外部账号 id=${account.id}`, account, FOREIGN_ACCOUNT_FIELDS);
        const userInfoRows = await userInfoRepo.find({ where: { accountId: account.id } });
        if (userInfoRows.length !== 1) {
          throw ownershipViolation(
            `外部账号 id=${account.id} 的 user_info 行数=${userInfoRows.length} ≠ 1`,
          );
        }
        assertForeignFields(
          `外部账号 id=${account.id}.user_info`,
          userInfoRows[0],
          FOREIGN_USER_INFO_FIELDS,
        );
      }
      const accountIds = accounts.map((row) => row.id);

      // 2) 型号：专属 modelCode 只用于定位（modelCode 非唯一），命中后逐字段核验
      const models = await modelRepo.find({ where: { modelCode: In([...FOREIGN_MODEL_CODES]) } });
      for (const model of models) {
        const expected =
          model.modelCode === FOREIGN.modelCode
            ? FOREIGN_MODEL_FIELDS
            : FOREIGN_SENTINEL_MODEL_FIELDS;
        assertForeignFields(`外部型号 id=${model.id}`, model, expected);
      }
      const modelIds = models.map((row) => row.id);

      // 3) 申请：专属 requestNo 只用于定位，命中后逐字段 + 动态外键归属核验
      const requests = await requestRepo.find({
        where: { requestNo: In([...FOREIGN_REQUEST_NOS]) },
      });
      const expectedRequestByNo = new Map<string, (typeof FOREIGN_REQUEST_FIELDS)[number]>(
        FOREIGN_REQUEST_FIELDS.map((row) => [row.requestNo, row]),
      );
      for (const request of requests) {
        const expected = expectedRequestByNo.get(request.requestNo);
        if (!expected) {
          throw ownershipViolation(
            `申请 id=${request.id} requestNo=${request.requestNo} 不在外部链预期集合内`,
          );
        }
        if (request.id !== expected.id) {
          throw ownershipViolation(
            `申请 requestNo=${request.requestNo} 的主键 id=${request.id} ≠ 预期 ${expected.id}`,
          );
        }
        assertForeignFields(`外部申请 id=${request.id}`, request, expected);
        if (!accountIds.includes(request.customerAccountId)) {
          throw ownershipViolation(
            `外部申请 id=${request.id} 的客户账号=${request.customerAccountId} 不属于外部账号`,
          );
        }
        if (!modelIds.includes(request.equipmentModelId)) {
          throw ownershipViolation(
            `外部申请 id=${request.id} 的型号=${request.equipmentModelId} 不属于外部型号`,
          );
        }
        if (expected.isAccepted) {
          const acceptedBy = request.acceptedByEngineerAccountId;
          if (acceptedBy === null || !accountIds.includes(acceptedBy)) {
            throw ownershipViolation(
              `外部已接单申请 id=${request.id} 的接单账号=${String(acceptedBy)} 归属不明确`,
            );
          }
        }
      }

      // 4) 外部引用核验：任何引用外部账号 / 型号的行都必须落在本次已定位的申请集合内
      if (accountIds.length > 0 || modelIds.length > 0) {
        const referencingRequests = await requestRepo.find({
          where: [
            { customerAccountId: In(accountIds) },
            { acceptedByEngineerAccountId: In(accountIds) },
            { equipmentModelId: In(modelIds) },
          ],
          select: { id: true },
        });
        assertIdsWithin(
          '引用外部账号/型号的维修申请',
          referencingRequests.map((row) => row.id),
          requests.map((row) => row.id),
        );
      }

      // 5) 全部核验通过：按子到父精确删除（只删已确认的实际 ID）
      if (requests.length > 0) {
        await requestRepo.delete({ id: In(requests.map((row) => row.id)) });
      }
      if (modelIds.length > 0) {
        await modelRepo.delete({ id: In(modelIds) });
      }
      if (accountIds.length > 0) {
        await userInfoRepo.delete({ accountId: In(accountIds) });
        await accountRepo.delete({ id: In(accountIds) });
      }
    });
  };

  const readForeignSnapshot = async (): Promise<ForeignSnapshot> => {
    const [model, openRequest, acceptedRequest, sentinelModel, sentinelRequest, models, requests] =
      await Promise.all([
        dataSource
          .getRepository(EquipmentModelEntity)
          .findOne({ where: { id: LEGACY_FIXED_IDS.modelId } }),
        dataSource
          .getRepository(RepairRequestEntity)
          .findOne({ where: { id: LEGACY_FIXED_IDS.openRequestId } }),
        dataSource
          .getRepository(RepairRequestEntity)
          .findOne({ where: { id: LEGACY_FIXED_IDS.acceptedRequestId } }),
        dataSource
          .getRepository(EquipmentModelEntity)
          .findOne({ where: { id: LEGACY_FIXED_IDS.sentinelModelId } }),
        dataSource
          .getRepository(RepairRequestEntity)
          .findOne({ where: { id: LEGACY_FIXED_IDS.sentinelRequestId } }),
        dataSource
          .getRepository(EquipmentModelEntity)
          .count({ where: { modelCode: FOREIGN.modelCode } }),
        dataSource
          .getRepository(RepairRequestEntity)
          .count({ where: { requestNo: In([FOREIGN.openRequestNo, FOREIGN.acceptedRequestNo]) } }),
      ]);

    return {
      model,
      openRequest,
      acceptedRequest,
      sentinelModel,
      sentinelRequest,
      rowCounts: { models, requests },
    };
  };

  /** 按本轮登记 ID 读取夹具行（负例前后快照对照） */
  const readOwnedFixtureRows = async (
    ownership: ProductionFixtureOwnership,
  ): Promise<{
    accounts: AccountEntity[];
    userInfos: UserInfoEntity[];
    models: EquipmentModelEntity[];
    requests: RepairRequestEntity[];
  }> => {
    const accountIds = [...ownership.createdAccountIds];
    const modelIds = [...ownership.createdEquipmentModelIds];
    const requestIds = [...ownership.createdRepairRequestIds];
    return {
      accounts:
        accountIds.length > 0
          ? await dataSource
              .getRepository(AccountEntity)
              .find({ where: { id: In(accountIds) }, order: { id: 'ASC' } })
          : [],
      userInfos:
        accountIds.length > 0
          ? await dataSource
              .getRepository(UserInfoEntity)
              .find({ where: { accountId: In(accountIds) }, order: { id: 'ASC' } })
          : [],
      models:
        modelIds.length > 0
          ? await dataSource
              .getRepository(EquipmentModelEntity)
              .find({ where: { id: In(modelIds) }, order: { id: 'ASC' } })
          : [],
      requests:
        requestIds.length > 0
          ? await dataSource
              .getRepository(RepairRequestEntity)
              .find({ where: { id: In(requestIds) }, order: { id: 'ASC' } })
          : [],
    };
  };

  /**
   * P3：在**实际执行连接**上独立记录删除操作（`Repository.delete` 的最终通道是
   * `EntityManager.delete`），同时断言「DELETE 次数为 0」；快照不变只是补充证据，
   * 不能单独证明零删除（事务回滚也能恢复数据）。
   */
  const expectCleanupRejectedWithoutDeletes = async (
    action: () => Promise<void>,
    pattern: RegExp,
  ): Promise<void> => {
    const deleteSpy = jest.spyOn(EntityManager.prototype, 'delete');
    try {
      await expect(action()).rejects.toThrow(pattern);
      expect(deleteSpy.mock.calls).toHaveLength(0);
    } finally {
      deleteSpy.mockRestore();
    }
  };

  /**
   * P1：包装真实 DataSource，先放行 `allowBeforeFailure` 次元数据读取（同名预检），
   * 之后的元数据读取一律抛错——用于构造「CREATE 已成功、创建后回读失败」。
   */
  const createMetadataReadbackFailingDataSource = (
    real: DataSource,
    allowBeforeFailure: number,
  ): DataSource => {
    let remainingAllowed = allowBeforeFailure;
    return new Proxy(real, {
      get: (target, prop, receiver) => {
        if (prop === 'query') {
          return (sql: string, parameters?: unknown[]): Promise<unknown> => {
            if (typeof sql === 'string' && sql.includes('information_schema.TRIGGERS')) {
              if (remainingAllowed > 0) {
                remainingAllowed -= 1;
                return target.query(sql, parameters);
              }
              return Promise.reject(new Error('模拟触发器元数据首次回读失败'));
            }
            return target.query(sql, parameters);
          };
        }
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    });
  };

  /**
   * P1（第十七轮）：CREATE 成功后立刻把同名对象替换为不同定义，使随后的元数据回读
   * 「成功但读到替换对象」。用于验证成功回读不能认领外部替换对象。
   */
  const createReplacingAfterCreateDataSource = (
    real: DataSource,
    name: string,
    replacementBody: string,
    replacementTracker: TriggerOwnershipTracker,
  ): DataSource =>
    new Proxy(real, {
      get: (target, prop, receiver) => {
        if (prop === 'query') {
          return async (sql: string, parameters?: unknown[]): Promise<unknown> => {
            const result = await target.query(sql, parameters);
            if (typeof sql === 'string' && sql.startsWith('CREATE TRIGGER')) {
              // 模拟同名替换：删除本轮对象，并以统一 helper 登记替换对象
              // （替换资源同样有创建事实与收尾路径，不留裸 CREATE）
              await target.query(`DROP TRIGGER IF EXISTS \`${name}\``);
              await createOwnedTrigger({
                dataSource: target,
                name,
                tableName: ROLLBACK_TRIGGER_TABLE,
                body: replacementBody,
                tracker: replacementTracker,
              });
            }
            return result;
          };
        }
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    });

  /** 真实连接上的 DROP 故障注入：元数据回读照常，前 N 次 DROP 抛错。 */
  const createDropFailingDataSource = (real: DataSource, failCount: number): DataSource => {
    let remainingFailures = failCount;
    return new Proxy(real, {
      get: (target, prop, receiver) => {
        if (prop === 'query') {
          return (sql: string, parameters?: unknown[]): Promise<unknown> => {
            if (
              typeof sql === 'string' &&
              sql.startsWith('DROP TRIGGER') &&
              remainingFailures > 0
            ) {
              remainingFailures -= 1;
              return Promise.reject(new Error('注入故障：触发器 DROP 失败'));
            }
            return target.query(sql, parameters);
          };
        }
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    });
  };

  /**
   * 故障用例的最终收尾（不依赖断言成功）：按「已知定义」走受保护收尾路径，
   * 只有当前同名对象的定义与预期一致时才删除；不做按名称的裸 DROP。
   */
  const disposeExpectedTestTrigger = async (name: string, expectedBody: string): Promise<void> => {
    const tracker = createTriggerOwnershipTracker();
    const record: OwnedTriggerRecord = {
      name,
      tableName: ROLLBACK_TRIGGER_TABLE,
      body: expectedBody,
      fact: null,
    };
    await disposeOwnedTriggerRecord(dataSource, record, tracker);
  };

  /**
   * 逐项、逐记录独立收尾：任何一项失败只记录该阶段错误，不阻断后续尝试。
   */
  const disposeTrackerRecords = async (
    label: string,
    source: DataSource,
    tracker: TriggerOwnershipTracker,
    errors: Error[],
  ): Promise<void> => {
    for (const record of [...tracker.remaining()]) {
      try {
        await disposeOwnedTriggerRecord(source, record, tracker);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        errors.push(new Error(`[${label}] ${detail}`, { cause: error }));
      }
    }
  };

  /** 替身 DataSource：只记录 SQL 并按脚本回应，用于不触库地执行实际 helper 的异常路径。 */
  function createStubTriggerDataSource(options: {
    metadataResponses: ReadonlyArray<unknown>;
    dropFails?: boolean;
  }): { dataSource: DataSource; calls: string[] } {
    const calls: string[] = [];
    let metadataIndex = 0;
    const database = 'lithography_e2e';
    const dataSource = {
      options: { database },
      query: (sql: string): Promise<unknown> => {
        calls.push(sql);
        // 库门禁查询是唯一的 DATABASE() 入口；先于元数据分支匹配，
        // 避免仅按子串命中同时含 `DATABASE()` 的 TRIGGERS 查询。
        if (sql.startsWith('SELECT DATABASE()')) {
          return Promise.resolve([{ current_database: database }]);
        }
        if (sql.includes('information_schema.TRIGGERS')) {
          const response = options.metadataResponses[metadataIndex];
          metadataIndex += 1;
          if (response instanceof Error) {
            return Promise.reject(response);
          }
          return Promise.resolve(response === undefined ? [] : response);
        }
        if (sql.startsWith('DROP TRIGGER')) {
          return options.dropFails
            ? Promise.reject(new Error('注入故障：触发器 DROP 失败'))
            : Promise.resolve([]);
        }
        return Promise.resolve([]);
      },
    } as unknown as DataSource;
    return { dataSource, calls };
  }

  /** 临时确保物理清理许可存在（替身路径仍经过真实门禁），结束后恢复原值。 */
  async function withPhysicalCleanupConsent<TReturn>(
    run: () => Promise<TReturn>,
  ): Promise<TReturn> {
    const previous = process.env.E2E_ALLOW_PHYSICAL_CLEANUP;
    process.env.E2E_ALLOW_PHYSICAL_CLEANUP = '1';
    try {
      return await run();
    } finally {
      if (previous === undefined) {
        delete process.env.E2E_ALLOW_PHYSICAL_CLEANUP;
      } else {
        process.env.E2E_ALLOW_PHYSICAL_CLEANUP = previous;
      }
    }
  }

  it('部分失败：型号创建成功后第一条申请失败 → 只回收本轮已创建的型号', async () => {
    const ownership = createProductionFixtureOwnership();

    await expect(
      seedProductionFixtureBusiness({
        dataSource,
        ownership,
        customerAccountId: fixtureCustomerAccountId,
        engineerAccountId: fixtureEngineerAccountId,
        // 注入与外部数据相同的编号：第一条申请必然撞唯一索引
        requestNos: { open: FOREIGN.openRequestNo },
      }),
    ).rejects.toThrow();

    // 记录边界：只有型号被记录（申请尚未创建）
    expect(ownership.createdEquipmentModelIds).toHaveLength(1);
    expect(ownership.createdRepairRequestIds).toEqual([]);

    await cleanupProductionFixtureByIds(dataSource, ownership);

    const modelRepo = dataSource.getRepository(EquipmentModelEntity);
    expect(
      await modelRepo.findOne({ where: { id: ownership.createdEquipmentModelIds[0] } }),
    ).toBeNull();
    // 外部数据不受影响
    expect((await readForeignSnapshot()).rowCounts).toEqual({ models: 1, requests: 2 });
  });

  it('部分失败：第一条申请成功后第二条失败 → 只回收本轮型号与已创建申请', async () => {
    const ownership = createProductionFixtureOwnership();

    await expect(
      seedProductionFixtureBusiness({
        dataSource,
        ownership,
        customerAccountId: fixtureCustomerAccountId,
        engineerAccountId: fixtureEngineerAccountId,
        requestNos: { accepted: FOREIGN.acceptedRequestNo },
      }),
    ).rejects.toThrow();

    expect(ownership.createdEquipmentModelIds).toHaveLength(1);
    expect(ownership.createdRepairRequestIds).toHaveLength(1);

    await cleanupProductionFixtureByIds(dataSource, ownership);

    const requestRepo = dataSource.getRepository(RepairRequestEntity);
    const modelRepo = dataSource.getRepository(EquipmentModelEntity);
    expect(
      await requestRepo.findOne({ where: { id: ownership.createdRepairRequestIds[0] } }),
    ).toBeNull();
    expect(
      await modelRepo.findOne({ where: { id: ownership.createdEquipmentModelIds[0] } }),
    ).toBeNull();
    expect((await readForeignSnapshot()).rowCounts).toEqual({ models: 1, requests: 2 });
  });

  it('准备阶段：seedProductionFixtureBusiness 不得删除/覆盖同主键的外部型号与申请', async () => {
    const before = await readForeignSnapshot();
    expect(before.model).not.toBeNull();
    expect(before.openRequest).not.toBeNull();
    expect(before.acceptedRequest).not.toBeNull();

    const ownership = createProductionFixtureOwnership();
    const businessIds = await seedProductionFixtureBusiness({
      dataSource,
      ownership,
      customerAccountId: fixtureCustomerAccountId,
      engineerAccountId: fixtureEngineerAccountId,
    });

    // 主键由数据库生成：绝不复用（更不覆盖）历史固定主键
    expect(businessIds.equipmentModelId).not.toBe(LEGACY_FIXED_IDS.modelId);
    expect(businessIds.openRequestId).not.toBe(LEGACY_FIXED_IDS.openRequestId);
    expect(businessIds.acceptedRequestId).not.toBe(LEGACY_FIXED_IDS.acceptedRequestId);

    // 外部数据 ID、字段、行数完全不变
    expect(await readForeignSnapshot()).toEqual(before);

    await cleanupProductionFixtureByIds(dataSource, ownership);
    expect(await readForeignSnapshot()).toEqual(before);
  });

  it('清理阶段：按本轮记录 ID 与专属标记恢复均不得删除同主键的外部型号与申请', async () => {
    const before = await readForeignSnapshot();

    // 正常收尾：只按本轮记录的 ID（先造一份本轮数据，确保清理确有动作）
    const ownership = createProductionFixtureOwnership();
    await seedProductionFixtureBusiness({
      dataSource,
      ownership,
      customerAccountId: fixtureCustomerAccountId,
      engineerAccountId: fixtureEngineerAccountId,
    });
    await cleanupProductionFixtureByIds(dataSource, ownership);
    expect(await readForeignSnapshot()).toEqual(before);

    // 崩溃残留恢复：按 fixture 专属标记 + 完整归属校验
    const residueOwnership = createProductionFixtureOwnership();
    await seedProductionFixtureBusiness({
      dataSource,
      ownership: residueOwnership,
      customerAccountId: fixtureCustomerAccountId,
      engineerAccountId: fixtureEngineerAccountId,
    });
    const removed = await cleanupProductionFixtureResidue(dataSource);
    expect(removed.repairRequestIds.length).toBeGreaterThan(0);
    expect(await readForeignSnapshot()).toEqual(before);
  });

  it('外部维修报告引用夹具账号/型号/申请：两个清理入口都在首次 DELETE 前失败关闭且逐字段不变', async () => {
    // 前置：先按专属标记清掉可能残留的夹具行，保证本轮账号可用同一专属 loginName
    await cleanupProductionFixtureResidue(dataSource);

    const orgRepo = dataSource.getRepository(OrganizationEntity);
    const reportRepo = dataSource.getRepository(MaintenanceReportEntity);
    await assertFixedIdsVacant(orgRepo, '外部维修报告组织', [FOREIGN.maintenanceReportOrgId]);

    const ownership = createProductionFixtureOwnership();
    const seeded = await seedProductionFixtureAccounts({
      dataSource,
      ownership,
      createAccountUsecase: app.get(CreateAccountUsecase),
    });
    expect(seeded.failures).toEqual([]);
    const engineerAccountId = seeded.created.find((seed) => seed.key === 'engineer')?.accountId;
    const customerAccountId = seeded.created.find((seed) => seed.key === 'customer')?.accountId;
    if (engineerAccountId === undefined || customerAccountId === undefined) {
      throw new Error('外部维修报告用例的桩账号不完整（缺少 customer / engineer）');
    }

    const business = await seedProductionFixtureBusiness({
      dataSource,
      ownership,
      customerAccountId,
      engineerAccountId,
    });

    const accountIds = [...ownership.createdAccountIds];
    const modelIds = [...ownership.createdEquipmentModelIds];
    const requestIds = [...ownership.createdRepairRequestIds];
    const readFixtureRows = async (): Promise<{
      accounts: AccountEntity[];
      userInfos: UserInfoEntity[];
      models: EquipmentModelEntity[];
      requests: RepairRequestEntity[];
    }> => ({
      accounts: await dataSource
        .getRepository(AccountEntity)
        .find({ where: { id: In(accountIds) }, order: { id: 'ASC' } }),
      userInfos: await dataSource
        .getRepository(UserInfoEntity)
        .find({ where: { accountId: In(accountIds) }, order: { id: 'ASC' } }),
      models: await dataSource
        .getRepository(EquipmentModelEntity)
        .find({ where: { id: In(modelIds) }, order: { id: 'ASC' } }),
      requests: await dataSource
        .getRepository(RepairRequestEntity)
        .find({ where: { id: In(requestIds) }, order: { id: 'ASC' } }),
    });

    let reportId: number | null = null;
    let organizationId: number | null = null;
    try {
      // 外部组织：固定主键仅 INSERT（先查空闲，绝不覆盖既有行）
      [organizationId] = await insertOnlyAtFixedIds(orgRepo, '外部维修报告组织', [
        {
          id: FOREIGN.maintenanceReportOrgId,
          organizationCode: FOREIGN.maintenanceReportOrgCode,
          name: '外部维修报告组织（非本 spec）',
          kind: 'CLIENT',
          status: 'ACTIVE',
        },
      ]);

      // 外部维修报告：同时引用夹具账号、型号与申请（三者都是真实 FK 目标）
      const saved = await reportRepo.save(
        reportRepo.create({
          ownerOrganizationId: organizationId,
          sourceType: 'WORK_ORDER_SUMMARY',
          repairRequestId: business.openRequestId,
          equipmentModelId: business.equipmentModelId,
          maintenanceEngineerAccountId: engineerAccountId,
          maintenanceEngineerNameSnapshot: '外部维修报告工程师快照',
          createdByAccountId: engineerAccountId,
          updatedByAccountId: engineerAccountId,
        }),
      );
      reportId = saved.id;

      const beforeReport = await reportRepo.findOne({ where: { id: reportId } });
      const beforeOrganization = await orgRepo.findOne({ where: { id: organizationId } });
      const beforeFixture = await readFixtureRows();

      // 两个入口都必须在第一次 DELETE 之前拒绝：整批删除发生在预检之后
      await expect(cleanupProductionFixtureResidue(dataSource)).rejects.toThrow(
        /maintenance_report/,
      );
      await expect(cleanupProductionFixtureByIds(dataSource, ownership)).rejects.toThrow(
        /maintenance_report/,
      );

      // 外部记录与夹具目标逐字段不变（等价于 DELETE=0）
      expect(await reportRepo.findOne({ where: { id: reportId } })).toEqual(beforeReport);
      expect(await orgRepo.findOne({ where: { id: organizationId } })).toEqual(beforeOrganization);
      expect(await readFixtureRows()).toEqual(beforeFixture);
    } finally {
      // 先删外部报告、再删外部组织，最后才允许夹具精确回收
      if (reportId !== null) {
        await reportRepo.delete({ id: reportId });
      }
      if (organizationId !== null) {
        await orgRepo.delete({ id: organizationId });
      }
      await cleanupProductionFixtureByIds(dataSource, ownership);
    }

    // 收尾后夹具与外部组织均无残留
    expect(await findProductionFixtureAccountIds(dataSource)).toEqual([]);
    expect(await orgRepo.findOne({ where: { id: FOREIGN.maintenanceReportOrgId } })).toBeNull();
  });

  it('后序失败：残留与按 ID 两个入口都整批回滚，夹具逐字段不变且本轮触发器零残留', async () => {
    // 前置：先按专属标记清掉可能残留的夹具行，保证本轮账号可用同一专属 loginName
    await cleanupProductionFixtureResidue(dataSource);
    const foreignBefore = await readForeignSnapshot();
    const ownership = createProductionFixtureOwnership();
    const triggerName = nextTriggerName('rollback');
    const tracker = createTriggerOwnershipTracker();

    const accountIds = [...ownership.createdAccountIds];
    const modelIds = [...ownership.createdEquipmentModelIds];
    const requestIds = [...ownership.createdRepairRequestIds];
    const readFixtureRows = async (): Promise<{
      accounts: AccountEntity[];
      userInfos: UserInfoEntity[];
      models: EquipmentModelEntity[];
      requests: RepairRequestEntity[];
    }> => ({
      accounts: await dataSource
        .getRepository(AccountEntity)
        .find({ where: { id: In(accountIds) }, order: { id: 'ASC' } }),
      userInfos: await dataSource
        .getRepository(UserInfoEntity)
        .find({ where: { accountId: In(accountIds) }, order: { id: 'ASC' } }),
      models: await dataSource
        .getRepository(EquipmentModelEntity)
        .find({ where: { id: In(modelIds) }, order: { id: 'ASC' } }),
      requests: await dataSource
        .getRepository(RepairRequestEntity)
        .find({ where: { id: In(requestIds) }, order: { id: 'ASC' } }),
    });

    let fixtureBefore: Awaited<ReturnType<typeof readFixtureRows>> | undefined;

    const failures = await runWithOwnedTrigger({
      dataSource,
      triggerName,
      tableName: ROLLBACK_TRIGGER_TABLE,
      body: ROLLBACK_TRIGGER_BODY,
      setup: async () => {
        const seeded = await seedProductionFixtureAccounts({
          dataSource,
          ownership,
          createAccountUsecase: app.get(CreateAccountUsecase),
        });
        expect(seeded.failures).toEqual([]);
        const engineerAccountId = seeded.created.find((seed) => seed.key === 'engineer')?.accountId;
        const customerAccountId = seeded.created.find((seed) => seed.key === 'customer')?.accountId;
        if (engineerAccountId === undefined || customerAccountId === undefined) {
          throw new Error('后序失败用例的桩账号不完整（缺少 customer / engineer）');
        }
        accountIds.push(...ownership.createdAccountIds);
        await seedProductionFixtureBusiness({
          dataSource,
          ownership,
          customerAccountId,
          engineerAccountId,
        });
        modelIds.push(...ownership.createdEquipmentModelIds);
        requestIds.push(...ownership.createdRepairRequestIds);
        fixtureBefore = await readFixtureRows();
        expect(fixtureBefore.requests).toHaveLength(2);
      },
      run: async () => {
        // 申请与型号已在 user_info 之前删除；注入后序失败时必须整批回滚。
        await expect(cleanupProductionFixtureResidue(dataSource)).rejects.toThrow();
        expect(await readFixtureRows()).toEqual(fixtureBefore);
        expect(await readForeignSnapshot()).toEqual(foreignBefore);

        await expect(cleanupProductionFixtureByIds(dataSource, ownership)).rejects.toThrow();
        expect(await readFixtureRows()).toEqual(fixtureBefore);
        expect(await readForeignSnapshot()).toEqual(foreignBefore);
      },
      cleanupFixture: () => cleanupProductionFixtureByIds(dataSource, ownership),
      tracker,
    });
    assertNoTriggerCaseFailures(failures, 'production 后序删除失败回滚');

    expect(await readOwnedTriggerFact(dataSource, triggerName)).toBeNull();
    expect(await findProductionFixtureAccountIds(dataSource)).toEqual([]);
    expect(await readForeignSnapshot()).toEqual(foreignBefore);
  });

  it('哨兵包装入口：后序失败同样整批回滚，哨兵链逐字段不变且本轮触发器零残留', async () => {
    const foreignBefore = await readForeignSnapshot();
    const ownership = createProductionFixtureOwnership();
    const chain = await ensureProductionSentinelChain({
      dataSource,
      ownership,
      createAccountUsecase: app.get(CreateAccountUsecase),
    });
    const sentinelBefore = await readProductionSentinelSnapshot(dataSource, chain);
    const triggerName = nextTriggerName('sentinel');
    const tracker = createTriggerOwnershipTracker();

    const failures = await runWithOwnedTrigger({
      dataSource,
      triggerName,
      tableName: ROLLBACK_TRIGGER_TABLE,
      body: ROLLBACK_TRIGGER_BODY,
      setup: () => Promise.resolve(),
      run: async () => {
        await expect(cleanupProductionSentinelChain(dataSource, chain)).rejects.toThrow();
        expect(await readProductionSentinelSnapshot(dataSource, chain)).toEqual(sentinelBefore);
        expect(await readForeignSnapshot()).toEqual(foreignBefore);
      },
      cleanupFixture: () => cleanupProductionSentinelChain(dataSource, chain),
      tracker,
    });
    assertNoTriggerCaseFailures(failures, 'production 哨兵链后序删除失败回滚');

    expect(await readOwnedTriggerFact(dataSource, triggerName)).toBeNull();
    expect(await readProductionSentinelSnapshot(dataSource, chain)).toEqual({
      account: null,
      userInfo: null,
      model: null,
      request: null,
    });
    expect(await readForeignSnapshot()).toEqual(foreignBefore);
  });

  it('目标固定 ID 已被非本测试行占用时：外部哨兵预置失败关闭，占位行前后完全一致', async () => {
    const modelRepo = dataSource.getRepository(EquipmentModelEntity);
    // 占位行由本 spec 以**仅创建**语义写入（同一工具，不覆盖任何既有行）
    const [placeholderId] = await insertOnlyAtFixedIds(modelRepo, '占位哨兵型号', [
      {
        id: LEGACY_FIXED_IDS.sentinelModelId,
        modelCode: 'E2E-PR3-OCCUPIED-SENTINEL-MODEL',
        modelName: '占位：非本测试的既有行',
        enabled: true,
        sortOrder: 9,
      },
    ]);
    const before = await modelRepo.findOne({ where: { id: placeholderId } });
    const recorder = createForeignRecorder();

    try {
      await expect(presetForeignSentinelRows(recorder)).rejects.toThrow(/已被 .* 中的既有行占用/);

      // 失败关闭发生在任何写入之前：不记录任何 ID、账号也未变更
      expect(recorder).toEqual(createForeignRecorder());
      expect(await modelRepo.findOne({ where: { id: placeholderId } })).toEqual(before);
    } finally {
      const current = await modelRepo.findOne({ where: { id: placeholderId } });
      if (current?.modelCode === 'E2E-PR3-OCCUPIED-SENTINEL-MODEL') {
        await modelRepo.delete({ id: placeholderId });
      }
    }
  });

  it('同 modelCode 异字段型号：外部残留恢复失败关闭且零删除', async () => {
    const modelRepo = dataSource.getRepository(EquipmentModelEntity);
    // modelCode 非唯一：库中可并存「同编码、异字段」的外部型号（模拟同名异主）
    const conflicting = await modelRepo.save(
      modelRepo.create({
        modelCode: FOREIGN.sentinelModelCode,
        modelName: '外部同编码型号（非本 spec 形状）',
        enabled: false,
        sortOrder: 1,
      }),
    );
    const beforeForeign = await readForeignSnapshot();
    const beforeConflicting = await modelRepo.findOne({ where: { id: conflicting.id } });

    try {
      // 专属标记命中但字段核验不通过 → 整次失败关闭，零 DELETE
      await expect(removeForeignResidue(dataSource)).rejects.toThrow(/归属校验/);

      // 外部链（账号 / 型号 / 申请）与冲突型号均原样保留
      expect(await readForeignSnapshot()).toEqual(beforeForeign);
      expect(await modelRepo.findOne({ where: { id: conflicting.id } })).toEqual(beforeConflicting);
    } finally {
      const current = await modelRepo.findOne({ where: { id: conflicting.id } });
      if (current?.modelName === '外部同编码型号（非本 spec 形状）') {
        await modelRepo.delete({ id: conflicting.id });
      }
    }
  });

  it('哨兵链：ensure/cleanup 不得删除同主键、不同归属的外部哨兵行', async () => {
    await presetForeignSentinelRows(foreignRecorder);

    const before = await readForeignSnapshot();
    expect(before.sentinelModel).not.toBeNull();
    expect(before.sentinelRequest).not.toBeNull();

    const sentinelOwnership = createProductionFixtureOwnership();
    let sentinelIds: {
      accountId: number;
      equipmentModelId: number;
      repairRequestId: number;
    } | null = null;
    try {
      sentinelIds = await ensureProductionSentinelChain({
        dataSource,
        ownership: sentinelOwnership,
        createAccountUsecase: app.get(CreateAccountUsecase),
      });
      const afterEnsure = await readForeignSnapshot();
      expect(afterEnsure.sentinelModel).toEqual(before.sentinelModel);
      expect(afterEnsure.sentinelRequest).toEqual(before.sentinelRequest);

      await cleanupProductionSentinelChain(dataSource, sentinelIds);
      const afterCleanup = await readForeignSnapshot();
      expect(afterCleanup.sentinelModel).toEqual(before.sentinelModel);
      expect(afterCleanup.sentinelRequest).toEqual(before.sentinelRequest);
    } finally {
      // 无论断言结果如何，都不要把本 spec 自己造的哨兵残留留在库里
      if (sentinelIds) {
        await cleanupProductionSentinelChain(dataSource, sentinelIds);
      }
    }
  });

  it('夹具自身的哨兵链在专属清理下原样保留（对照：真正的本 spec 数据仍受保护）', async () => {
    // 重新造出本 spec 账号（专属标记此时空闲），使「清理确实发生」可被观察
    const ownership = createProductionFixtureOwnership();
    const reseeded = await seedProductionFixtureAccounts({
      dataSource,
      ownership,
      createAccountUsecase: app.get(CreateAccountUsecase),
    });
    expect(reseeded.failures).toEqual([]);

    const sentinelOwnership = createProductionFixtureOwnership();
    const sentinelIds = await ensureProductionSentinelChain({
      dataSource,
      ownership: sentinelOwnership,
      createAccountUsecase: app.get(CreateAccountUsecase),
    });

    const before = await readProductionSentinelSnapshot(dataSource, sentinelIds);
    expect(before.account).not.toBeNull();
    expect(before.model).not.toBeNull();
    expect(before.request).not.toBeNull();

    try {
      await cleanupProductionFixtureByIds(dataSource, ownership);
      // 本 spec 账号确实被回收，而夹具外哨兵链 ID、字段、行数完全一致
      expect(await findProductionFixtureAccountIds(dataSource)).toEqual([]);
      expect(await readProductionSentinelSnapshot(dataSource, sentinelIds)).toEqual(before);
    } finally {
      await cleanupProductionSentinelChain(dataSource, sentinelIds);
      await cleanupProductionFixtureByIds(dataSource, ownership);
    }
  });

  it('外部账号未被任何 fixture 动作回收', async () => {
    const account = await dataSource.getRepository(AccountEntity).findOne({
      where: { loginName: FOREIGN.accountLoginName },
    });
    expect(account).not.toBeNull();
    expect(account?.id).toBe(foreignAccountId);

    const userInfo = await dataSource
      .getRepository(UserInfoEntity)
      .findOne({ where: { accountId: foreignAccountId } });
    expect(userInfo).not.toBeNull();
  });

  // ---------------------------------------------------------------------------
  // P2（0922）：自然标记命中 ≠ 归属。「专属 loginName / modelCode」只用于**定位**，
  // 下面三个反例证明：字段不同、或引用关系不属于自身时，必须失败关闭且外部数据零变化。
  // ---------------------------------------------------------------------------

  it('反例 1：同 loginName、字段不同的账号不得被回收或复用', async () => {
    const accountRepo = dataSource.getRepository(AccountEntity);
    // 库里预先存在与哨兵账号同名、但邮箱/状态/角色都不属于本 spec 的账号
    const foreignSameNameAccount = await accountRepo.save(
      accountRepo.create({
        loginName: PRODUCTION_SENTINEL.loginName,
        loginEmail: 'pr3.foreign.same-name@example.com',
        loginPassword: 'Pr3ForeignSameName@2024',
        status: AccountStatus.SUSPENDED,
        identityHint: IdentityTypeEnum.ENGINEER,
      }),
    );
    const before = await accountRepo.findOne({ where: { id: foreignSameNameAccount.id } });
    expect(before).not.toBeNull();

    try {
      // 定位结果不包含该账号：自然标记命中但字段核验不通过，不算本 spec 账号
      expect(await findProductionFixtureAccountIds(dataSource)).toEqual([]);

      // 崩溃残留恢复：失败关闭，不删除任何行
      await expect(cleanupProductionFixtureResidue(dataSource)).rejects.toThrow(/归属校验/);

      // 哨兵链复用：不得复用（更不得覆盖）同名但字段不同的账号
      await expect(
        ensureProductionSentinelChain({
          dataSource,
          ownership: createProductionFixtureOwnership(),
          createAccountUsecase: app.get(CreateAccountUsecase),
        }),
      ).rejects.toThrow(/归属校验/);

      // 外部账号字段完全不变
      expect(await accountRepo.findOne({ where: { id: foreignSameNameAccount.id } })).toEqual(
        before,
      );
      // 失败关闭发生在任何写入之前：哨兵型号与哨兵申请均未被创建
      expect(
        await dataSource.getRepository(EquipmentModelEntity).count({
          where: { modelCode: PRODUCTION_SENTINEL_MODEL_SPEC.modelCode },
        }),
      ).toBe(0);
      expect(
        await dataSource.getRepository(RepairRequestEntity).count({
          where: { requestNo: PRODUCTION_FIXTURE_MARKERS.sentinelRequestNo },
        }),
      ).toBe(0);
    } finally {
      await accountRepo.delete({ id: foreignSameNameAccount.id });
    }
  });

  it('反例 2：同 modelCode、字段不同的型号不得被回收或复用', async () => {
    const modelRepo = dataSource.getRepository(EquipmentModelEntity);
    // 库里预先存在与哨兵型号同编码、但名称/启用/排序都不属于本 spec 的型号
    const foreignSameCodeModel = await modelRepo.save(
      modelRepo.create({
        modelCode: PRODUCTION_SENTINEL_MODEL_SPEC.modelCode,
        modelName: '外部（非本 spec）同编码型号',
        enabled: false,
        sortOrder: 1,
      }),
    );
    const before = await modelRepo.findOne({ where: { id: foreignSameCodeModel.id } });
    expect(before).not.toBeNull();

    try {
      await expect(cleanupProductionFixtureResidue(dataSource)).rejects.toThrow(/归属校验/);
      await expect(
        ensureProductionSentinelChain({
          dataSource,
          ownership: createProductionFixtureOwnership(),
          createAccountUsecase: app.get(CreateAccountUsecase),
        }),
      ).rejects.toThrow(/归属校验/);

      // 外部型号字段完全不变
      expect(await modelRepo.findOne({ where: { id: foreignSameCodeModel.id } })).toEqual(before);
      // 失败关闭发生在任何写入之前：哨兵账号与哨兵申请均未被创建
      expect(
        await dataSource.getRepository(AccountEntity).count({
          where: { loginName: PRODUCTION_SENTINEL.loginName },
        }),
      ).toBe(0);
      expect(
        await dataSource.getRepository(RepairRequestEntity).count({
          where: { requestNo: PRODUCTION_FIXTURE_MARKERS.sentinelRequestNo },
        }),
      ).toBe(0);
    } finally {
      await modelRepo.delete({ id: foreignSameCodeModel.id });
    }
  });

  it('反例 3：测试账号被不同 requestNo 的外部申请引用时，删除账号失败关闭', async () => {
    const sentinelOwnership = createProductionFixtureOwnership();
    const sentinelIds = await ensureProductionSentinelChain({
      dataSource,
      ownership: sentinelOwnership,
      createAccountUsecase: app.get(CreateAccountUsecase),
    });
    // 本轮真正 INSERT 的行进 createdSentinelIds
    expect(sentinelOwnership.createdSentinelIds.accountIds).toEqual([sentinelIds.accountId]);
    expect(sentinelOwnership.recoveredOwnedIds.accountIds).toEqual([]);

    // 再次 ensure：既有行字段校验通过 → 复用，落进 recoveredOwnedIds 而非 createdSentinelIds
    const reuseOwnership = createProductionFixtureOwnership();
    const reused = await ensureProductionSentinelChain({
      dataSource,
      ownership: reuseOwnership,
      createAccountUsecase: app.get(CreateAccountUsecase),
    });
    expect(reused).toEqual(sentinelIds);
    expect(reuseOwnership.createdSentinelIds.accountIds).toEqual([]);
    expect(reuseOwnership.createdSentinelIds.repairRequestIds).toEqual([]);
    expect(reuseOwnership.recoveredOwnedIds.accountIds).toEqual([sentinelIds.accountId]);
    expect(reuseOwnership.recoveredOwnedIds.repairRequestIds).toEqual([
      sentinelIds.repairRequestId,
    ]);

    const requestRepo = dataSource.getRepository(RepairRequestEntity);
    // 外部申请（不同 requestNo、不同归属）引用了本 spec 账号；型号引用哨兵链自身，避免牵连外部链
    const externalRequest = await requestRepo.save(
      requestRepo.create({
        requestNo: FOREIGN.externalRefRequestNo,
        customerAccountId: sentinelIds.accountId,
        equipmentModelId: sentinelIds.equipmentModelId,
        errorCode: 'FOREIGN-EXT-REF',
        faultDescription: '外部申请：引用本 spec 账号，但编号与归属均不属于 fixture',
        contentMd: '# E2E-PR3-FOREIGN-EXT-REF',
        createdAt: new Date('2026-08-04T00:00:00.000Z'),
        isAccepted: false,
        acceptedByEngineerAccountId: null,
        acceptedAt: null,
        deprecated: false,
        deletedAt: null,
      }),
    );
    const beforeSentinel = await readProductionSentinelSnapshot(dataSource, sentinelIds);
    const beforeExternal = await requestRepo.findOne({ where: { id: externalRequest.id } });

    try {
      // 不得按账号 ID 批量兜底删除账号的引用申请：失败关闭
      await expect(cleanupProductionSentinelChain(dataSource, sentinelIds)).rejects.toThrow(
        /账号引用申请/,
      );

      // 失败关闭发生在任何 DELETE 之前：哨兵链与外部申请均原样保留
      expect(await readProductionSentinelSnapshot(dataSource, sentinelIds)).toEqual(beforeSentinel);
      expect(await requestRepo.findOne({ where: { id: externalRequest.id } })).toEqual(
        beforeExternal,
      );
    } finally {
      // 外部申请先移除，哨兵链才可精确回收
      await requestRepo.delete({ id: externalRequest.id });
      await cleanupProductionSentinelChain(dataSource, sentinelIds);
    }
  });

  it('连续两轮：每轮动态主键，收尾后均无残留且不覆盖既有行', async () => {
    const beforeForeign = await readForeignSnapshot();
    const generatedIds: number[] = [];

    // 本用例自备桩账号：前置用例的崩溃残留恢复已回收过 beforeAll 的夹具账号，
    // 不复用 describe 级 ID（否则会依赖用例执行顺序）。
    const accountOwnership = createProductionFixtureOwnership();
    const seeded = await seedProductionFixtureAccounts({
      dataSource,
      ownership: accountOwnership,
      createAccountUsecase: app.get(CreateAccountUsecase),
    });
    expect(seeded.failures).toEqual([]);
    const idByKey = new Map(seeded.created.map((seed) => [seed.key, seed.accountId]));
    const customerAccountId = idByKey.get('customer');
    const engineerAccountId = idByKey.get('engineer');
    if (customerAccountId === undefined || engineerAccountId === undefined) {
      throw new Error('连续两轮用例的桩账号记录不完整（缺少 customer / engineer）');
    }

    try {
      for (let run = 0; run < 2; run += 1) {
        const ownership = createProductionFixtureOwnership();
        try {
          await seedProductionFixtureBusiness({
            dataSource,
            ownership,
            customerAccountId,
            engineerAccountId,
          });
          generatedIds.push(
            ownership.createdEquipmentModelIds[0],
            ownership.createdRepairRequestIds[0],
          );
        } finally {
          await cleanupProductionFixtureByIds(dataSource, ownership);
        }
      }
    } finally {
      await cleanupProductionFixtureByIds(dataSource, accountOwnership);
    }

    // 两轮主键互不相同（动态主键，不抢占固定 ID）
    expect(new Set(generatedIds).size).toBe(generatedIds.length);
    expect(generatedIds).not.toContain(LEGACY_FIXED_IDS.modelId);
    expect(generatedIds).not.toContain(LEGACY_FIXED_IDS.openRequestId);
    // 两轮结束后外部数据完全不变（未覆盖既有行、未留残留）
    expect(await readForeignSnapshot()).toEqual(beforeForeign);
  });

  // ---------------------------------------------------------------------------
  // 第十五轮 P1：触发器 CREATE 成功后立即登记 + 统一受保护收尾的回归。
  // 回读失败 / 销毁失败 / 夹具清理失败各自独立保留，不返回假零残留。
  // ---------------------------------------------------------------------------

  it('P1 回归 1：CREATE 成功、首次元数据回读抛错 → 创建事实仍可追踪，受保护收尾可执行', async () => {
    const triggerName = nextTriggerName('readback');
    const tracker = createTriggerOwnershipTracker();
    const flaky = createMetadataReadbackFailingDataSource(dataSource, 1);

    // CREATE 之前就进入保护：即使创建未正常返回，finally 仍按 tracker 收尾
    try {
      await expect(
        createOwnedTrigger({
          dataSource: flaky,
          name: triggerName,
          tableName: ROLLBACK_TRIGGER_TABLE,
          body: ROLLBACK_TRIGGER_BODY,
          tracker,
        }),
      ).rejects.toThrow('模拟触发器元数据首次回读失败');

      // CREATE 成功后立即登记：回读失败不丢记录，fact 仍为待核验（不得视为已确认归属）
      expect(tracker.records()).toHaveLength(1);
      expect(tracker.records()[0].name).toBe(triggerName);
      expect(tracker.records()[0].fact).toBeNull();
      expect(tracker.remaining().map((record) => record.name)).toEqual([triggerName]);

      await disposeOwnedTriggerRecord(dataSource, tracker.records()[0], tracker);
      expect(tracker.remaining()).toEqual([]);
    } finally {
      for (const record of [...tracker.remaining()]) {
        await disposeOwnedTriggerRecord(dataSource, record, tracker);
      }
    }

    expect(tracker.remaining()).toEqual([]);
    expect(await readOwnedTriggerFact(dataSource, triggerName)).toBeNull();
  });

  it('P1 回归 2：主流程失败且触发器销毁失败 → 两类错误分别保留，随后可安全收尾', async () => {
    const triggerName = nextTriggerName('doublefailure');
    const tracker = createTriggerOwnershipTracker();

    try {
      const failures = await runWithOwnedTrigger({
        dataSource,
        triggerName,
        tableName: ROLLBACK_TRIGGER_TABLE,
        body: ROLLBACK_TRIGGER_BODY,
        setup: () => Promise.resolve(),
        run: () => Promise.reject(new Error('模拟主流程失败')),
        dispose: () => Promise.reject(new Error('模拟触发器销毁失败')),
        cleanupFixture: () => Promise.resolve(),
        tracker,
      });

      expect(failures.map((failure) => failure.stage)).toEqual([
        '主错误',
        '触发器收尾错误',
        '触发器待收尾残留',
      ]);
      expect((failures[0].error as Error).message).toContain('模拟主流程失败');
      expect((failures[1].error as Error).message).toContain('模拟触发器销毁失败');
      expect((failures[2].error as Error).message).toContain('未完成安全收尾');
    } finally {
      await disposeExpectedTestTrigger(triggerName, ROLLBACK_TRIGGER_BODY);
    }

    expect(await readOwnedTriggerFact(dataSource, triggerName)).toBeNull();
  });

  it('P1 回归 3：触发器收尾与夹具清理同时失败 → 两类错误均可见', async () => {
    const triggerName = nextTriggerName('teardown');
    const tracker = createTriggerOwnershipTracker();

    try {
      const failures = await runWithOwnedTrigger({
        dataSource,
        triggerName,
        tableName: ROLLBACK_TRIGGER_TABLE,
        body: ROLLBACK_TRIGGER_BODY,
        setup: () => Promise.resolve(),
        run: () => Promise.resolve(),
        dispose: () => Promise.reject(new Error('模拟触发器销毁失败')),
        cleanupFixture: () => Promise.reject(new Error('模拟夹具清理失败')),
        tracker,
      });

      expect(failures.map((failure) => failure.stage)).toEqual([
        '触发器收尾错误',
        '触发器待收尾残留',
        '夹具清理错误',
      ]);
      expect((failures[0].error as Error).message).toContain('模拟触发器销毁失败');
      expect((failures[2].error as Error).message).toContain('模拟夹具清理失败');
    } finally {
      await disposeExpectedTestTrigger(triggerName, ROLLBACK_TRIGGER_BODY);
    }

    expect(await readOwnedTriggerFact(dataSource, triggerName)).toBeNull();
  });

  it('P1 回归 4a：同名外部对象已存在 → 创建前拒绝，外部定义不变', async () => {
    const triggerName = nextTriggerName('collision');
    // 同名碰撞负例同样必须登记：不得保留任何「无 tracker」的特殊通道
    const tracker = createTriggerOwnershipTracker();

    // CREATE 之前就进入保护：首次创建未正常返回时也按 tracker 收尾
    try {
      const owned = await createOwnedTrigger({
        dataSource,
        name: triggerName,
        tableName: ROLLBACK_TRIGGER_TABLE,
        body: ROLLBACK_TRIGGER_BODY,
        tracker,
      });
      const before = await readOwnedTriggerFact(dataSource, triggerName);
      expect(before).toEqual(owned);

      await expect(
        createOwnedTrigger({
          dataSource,
          name: triggerName,
          tableName: ROLLBACK_TRIGGER_TABLE,
          body: "SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'E2E 同名碰撞'",
          tracker,
        }),
      ).rejects.toThrow(/同名预检/);
      expect(await readOwnedTriggerFact(dataSource, triggerName)).toEqual(before);
    } finally {
      for (const record of [...tracker.remaining()]) {
        await disposeOwnedTriggerRecord(dataSource, record, tracker);
      }
    }

    expect(tracker.remaining()).toEqual([]);

    expect(await readOwnedTriggerFact(dataSource, triggerName)).toBeNull();
  });

  it('P1 回归 4b：本轮对象被同名替换 → 收尾拒绝删除，替换对象定义不变', async () => {
    const triggerName = nextTriggerName('replaced');
    const originalTracker = createTriggerOwnershipTracker();
    const replacementTracker = createTriggerOwnershipTracker();
    const replacementBody = "SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'E2E 替换后的同名对象'";
    const cleanupErrors: Error[] = [];
    let mainError: unknown;

    // CREATE 之前就进入保护：创建未正常返回时也按对应 tracker 收尾
    try {
      const owned = await createOwnedTrigger({
        dataSource,
        name: triggerName,
        tableName: ROLLBACK_TRIGGER_TABLE,
        body: ROLLBACK_TRIGGER_BODY,
        tracker: originalTracker,
      });
      const record = originalTracker.records()[0];
      expect(record.name).toBe(owned.name);

      // 模拟外部替换：外部先删除本轮对象，替换对象同样经统一 helper 登记
      await dataSource.query(`DROP TRIGGER IF EXISTS \`${triggerName}\``);
      const replacement = await createOwnedTrigger({
        dataSource,
        name: triggerName,
        tableName: ROLLBACK_TRIGGER_TABLE,
        body: replacementBody,
        tracker: replacementTracker,
      });
      expect(await readOwnedTriggerFact(dataSource, triggerName)).toEqual(replacement);

      await expect(disposeOwnedTriggerRecord(dataSource, record, originalTracker)).rejects.toThrow(
        /归属校验/,
      );

      // 拒绝删除后替换对象逐字段不变（零误删）
      expect(await readOwnedTriggerFact(dataSource, triggerName)).toEqual(replacement);
    } catch (error) {
      mainError = error;
    } finally {
      // 按实际创建阶段分别收尾：替换对象（已登记）→ 原对象（此时已不存在，为无害 no-op）
      await disposeTrackerRecords('替换对象', dataSource, replacementTracker, cleanupErrors);
      await disposeTrackerRecords('原对象', dataSource, originalTracker, cleanupErrors);
    }

    expect(mainError).toBeUndefined();
    expect(cleanupErrors).toEqual([]);
    expect(replacementTracker.remaining()).toEqual([]);
    expect(originalTracker.remaining()).toEqual([]);
    expect(await readOwnedTriggerFact(dataSource, triggerName)).toBeNull();
  });

  it('P1 回归 4c：CREATE 成功后对象被同名替换、回读成功 → 创建核验拒绝，替换对象零误删', async () => {
    const triggerName = nextTriggerName('replacedreadback');
    const originalTracker = createTriggerOwnershipTracker();
    const replacementTracker = createTriggerOwnershipTracker();
    const cleanupErrors: Error[] = [];
    const replacementBody = "SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'E2E 回读前替换的同一对象'";
    const replacing = createReplacingAfterCreateDataSource(
      dataSource,
      triggerName,
      replacementBody,
      replacementTracker,
    );

    try {
      await expect(
        createOwnedTrigger({
          dataSource: replacing,
          name: triggerName,
          tableName: ROLLBACK_TRIGGER_TABLE,
          body: ROLLBACK_TRIGGER_BODY,
          tracker: originalTracker,
        }),
      ).rejects.toThrow(/创建核验/);

      // 登记记录保留，且预期仍是 CREATE 时注入的原始定义，未被当前定义覆盖
      expect(originalTracker.records()).toHaveLength(1);
      expect(originalTracker.records()[0].body).toBe(ROLLBACK_TRIGGER_BODY);
      expect(originalTracker.records()[0].fact).toBeNull();

      const replacement = await readOwnedTriggerFact(dataSource, triggerName);
      expect(replacement?.definition).toBe(replacementBody);

      // 收尾以原始预期核验当前定义：不匹配即拒绝，零 DROP
      await expect(
        disposeOwnedTriggerRecord(dataSource, originalTracker.records()[0], originalTracker),
      ).rejects.toThrow(/归属校验/);
      expect(await readOwnedTriggerFact(dataSource, triggerName)).toEqual(replacement);
    } finally {
      await disposeTrackerRecords('替换对象', dataSource, replacementTracker, cleanupErrors);
      await disposeTrackerRecords('原对象', dataSource, originalTracker, cleanupErrors);
    }

    expect(cleanupErrors).toEqual([]);
    expect(replacementTracker.remaining()).toEqual([]);
    expect(originalTracker.remaining()).toEqual([]);
    expect(await readOwnedTriggerFact(dataSource, triggerName)).toBeNull();
  });

  it('P2 回归：原对象创建成功、替换创建失败 → 仅收尾原对象，替换保持零登记', async () => {
    const triggerName = nextTriggerName('replacefail');
    const originalTracker = createTriggerOwnershipTracker();
    const replacementTracker = createTriggerOwnershipTracker();
    const cleanupErrors: Error[] = [];
    const replacementBody = "SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'E2E 替换创建失败'";

    try {
      await createOwnedTrigger({
        dataSource,
        name: triggerName,
        tableName: ROLLBACK_TRIGGER_TABLE,
        body: ROLLBACK_TRIGGER_BODY,
        tracker: originalTracker,
      });

      // 替换创建失败：不得登记，也不得触发按替换定义的清理
      await expect(
        createOwnedTrigger({
          dataSource,
          name: triggerName,
          tableName: 'base_not_exists_e2e_trigger',
          body: replacementBody,
          tracker: replacementTracker,
        }),
      ).rejects.toThrow();
      expect(replacementTracker.records()).toEqual([]);
    } finally {
      await disposeTrackerRecords('原对象', dataSource, originalTracker, cleanupErrors);
    }

    expect(cleanupErrors).toEqual([]);
    expect(originalTracker.remaining()).toEqual([]);
    expect(replacementTracker.remaining()).toEqual([]);
    expect(await readOwnedTriggerFact(dataSource, triggerName)).toBeNull();
  });

  it('P2 回归：主错误与两项收尾错误同时发生 → 三类错误均保留且收尾不中断', async () => {
    const triggerName = nextTriggerName('multierror');
    const originalTracker = createTriggerOwnershipTracker();
    const replacementTracker = createTriggerOwnershipTracker();
    const replacementBody = "SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'E2E 多项错误替换对象'";
    const dropFail = createDropFailingDataSource(dataSource, 1);
    const cleanupErrors: Error[] = [];
    let mainError: unknown;

    try {
      await createOwnedTrigger({
        dataSource,
        name: triggerName,
        tableName: ROLLBACK_TRIGGER_TABLE,
        body: ROLLBACK_TRIGGER_BODY,
        tracker: originalTracker,
      });
      // 模拟外部替换：删除原对象并以统一 helper 创建替换对象
      await dataSource.query(`DROP TRIGGER IF EXISTS \`${triggerName}\``);
      await createOwnedTrigger({
        dataSource,
        name: triggerName,
        tableName: ROLLBACK_TRIGGER_TABLE,
        body: replacementBody,
        tracker: replacementTracker,
      });
      throw new Error('模拟主流程错误');
    } catch (error) {
      mainError = error;
    } finally {
      // 第一项收尾 DROP 失败（注入）；第二项仍必须尝试，不被前一项阻断
      await disposeTrackerRecords('替换对象', dropFail, replacementTracker, cleanupErrors);
      await disposeTrackerRecords('原对象', dataSource, originalTracker, cleanupErrors);
    }

    expect((mainError as Error).message).toBe('模拟主流程错误');
    expect(cleanupErrors.map((error) => error.message)).toEqual([
      expect.stringContaining('[替换对象] 注入故障：触发器 DROP 失败'),
      expect.stringContaining('[原对象]'),
    ]);
    // 现场保留：替换对象登记仍为待收尾，未因失败而伪装成已清理
    expect(replacementTracker.remaining()).toHaveLength(1);

    // 恢复后按已知替换定义收尾；原记录对应对象已不存在，受保护收尾为无害 no-op
    await disposeExpectedTestTrigger(triggerName, replacementBody);
    await disposeTrackerRecords('原对象', dataSource, originalTracker, []);
    expect(originalTracker.remaining()).toEqual([]);
    expect(await readOwnedTriggerFact(dataSource, triggerName)).toBeNull();
  });

  it('P2 回归：创建成功后前置断言失败 → finally 仍按 tracker 受保护收尾', async () => {
    const triggerName = nextTriggerName('postassert');
    const tracker = createTriggerOwnershipTracker();
    let mainError: unknown;

    try {
      await createOwnedTrigger({
        dataSource,
        name: triggerName,
        tableName: ROLLBACK_TRIGGER_TABLE,
        body: ROLLBACK_TRIGGER_BODY,
        tracker,
      });
      // 模拟创建后的前置断言失败：不得依赖断言成功才收尾
      throw new Error('模拟创建后前置断言失败');
    } catch (error) {
      mainError = error;
    } finally {
      for (const record of [...tracker.remaining()]) {
        await disposeOwnedTriggerRecord(dataSource, record, tracker);
      }
    }

    expect((mainError as Error).message).toBe('模拟创建后前置断言失败');
    expect(tracker.remaining()).toEqual([]);
    expect(await readOwnedTriggerFact(dataSource, triggerName)).toBeNull();
  });

  it('P1 回归 5a：正常完成 → 本轮触发器与夹具零残留', async () => {
    await cleanupProductionFixtureResidue(dataSource);
    const triggerName = nextTriggerName('normal');
    const tracker = createTriggerOwnershipTracker();
    const ownership = createProductionFixtureOwnership();

    const failures = await runWithOwnedTrigger({
      dataSource,
      triggerName,
      tableName: ROLLBACK_TRIGGER_TABLE,
      body: ROLLBACK_TRIGGER_BODY,
      setup: async () => {
        const seeded = await seedProductionFixtureAccounts({
          dataSource,
          ownership,
          createAccountUsecase: app.get(CreateAccountUsecase),
        });
        expect(seeded.failures).toEqual([]);
      },
      run: () => Promise.resolve(),
      cleanupFixture: () => cleanupProductionFixtureByIds(dataSource, ownership),
      tracker,
    });

    expect(failures).toEqual([]);
    expect(tracker.remaining()).toEqual([]);
    expect(await readOwnedTriggerFact(dataSource, triggerName)).toBeNull();
    expect(await readOwnedFixtureRows(ownership)).toEqual({
      accounts: [],
      userInfos: [],
      models: [],
      requests: [],
    });
    expect(await findProductionFixtureAccountIds(dataSource)).toEqual([]);
  });

  it('P1 回归 5b：中途断言失败 → 触发器受保护收尾、夹具零残留', async () => {
    await cleanupProductionFixtureResidue(dataSource);
    const triggerName = nextTriggerName('midassert');
    const ownership = createProductionFixtureOwnership();
    const tracker = createTriggerOwnershipTracker();

    const failures = await runWithOwnedTrigger({
      dataSource,
      triggerName,
      tableName: ROLLBACK_TRIGGER_TABLE,
      body: ROLLBACK_TRIGGER_BODY,
      setup: async () => {
        const seeded = await seedProductionFixtureAccounts({
          dataSource,
          ownership,
          createAccountUsecase: app.get(CreateAccountUsecase),
        });
        expect(seeded.failures).toEqual([]);
      },
      run: () => Promise.reject(new Error('模拟中途断言失败')),
      cleanupFixture: () => cleanupProductionFixtureByIds(dataSource, ownership),
      tracker,
    });

    expect(failures.map((failure) => failure.stage)).toEqual(['主错误']);
    expect((failures[0].error as Error).message).toContain('模拟中途断言失败');
    expect(await readOwnedTriggerFact(dataSource, triggerName)).toBeNull();
    expect(await readOwnedFixtureRows(ownership)).toEqual({
      accounts: [],
      userInfos: [],
      models: [],
      requests: [],
    });
    expect(await findProductionFixtureAccountIds(dataSource)).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // 第十六轮 P3：直接入口的异常回归（替身 DataSource 直接执行实际 helper）。
  // 真实库中的触发器残留另行通过 readOwnedTriggerFact 核对。
  // ---------------------------------------------------------------------------

  it('直接入口：缺少 tracker → CREATE 前拒绝，零 DDL', async () => {
    const triggerName = nextTriggerName('p3notracker');
    const stub = createStubTriggerDataSource({ metadataResponses: [] });
    const params = {
      dataSource: stub.dataSource,
      name: triggerName,
      tableName: ROLLBACK_TRIGGER_TABLE,
      body: ROLLBACK_TRIGGER_BODY,
    } as unknown as Parameters<typeof createOwnedTrigger>[0];

    await withPhysicalCleanupConsent(async () => {
      await expect(createOwnedTrigger(params)).rejects.toThrow(/追踪器校验/);
    });

    // 校验发生在任何 DDL（含同名预检查询）之前
    expect(stub.calls).toEqual([]);
    expect(await readOwnedTriggerFact(dataSource, triggerName)).toBeNull();
  });

  it('直接入口：CREATE 成功、回读失败、DROP 失败 → 两个原始错误与待收尾记录均保留，恢复后可安全收尾', async () => {
    const triggerName = nextTriggerName('p3readbackdrop');
    const tracker = createTriggerOwnershipTracker();

    await withPhysicalCleanupConsent(async () => {
      const createStub = createStubTriggerDataSource({
        metadataResponses: [[], new Error('模拟触发器回读失败')],
      });
      await expect(
        createOwnedTrigger({
          dataSource: createStub.dataSource,
          name: triggerName,
          tableName: ROLLBACK_TRIGGER_TABLE,
          body: ROLLBACK_TRIGGER_BODY,
          tracker,
        }),
      ).rejects.toThrow('模拟触发器回读失败');

      // CREATE 成功后立即登记：回读失败不丢记录，fact 仍为待核验
      expect(tracker.records()).toHaveLength(1);
      expect(tracker.records()[0].fact).toBeNull();
      expect(tracker.remaining().map((record) => record.name)).toEqual([triggerName]);

      const failingDisposeStub = createStubTriggerDataSource({
        metadataResponses: [
          [
            {
              name: triggerName,
              tableName: ROLLBACK_TRIGGER_TABLE,
              definition: ROLLBACK_TRIGGER_BODY,
            },
          ],
        ],
        dropFails: true,
      });
      await expect(
        disposeOwnedTriggerRecord(failingDisposeStub.dataSource, tracker.records()[0], tracker),
      ).rejects.toThrow('注入故障：触发器 DROP 失败');
      expect(tracker.remaining().map((record) => record.name)).toEqual([triggerName]);

      // 恢复后再次走同一受保护收尾
      const recoveredStub = createStubTriggerDataSource({
        metadataResponses: [
          [
            {
              name: triggerName,
              tableName: ROLLBACK_TRIGGER_TABLE,
              definition: ROLLBACK_TRIGGER_BODY,
            },
          ],
        ],
      });
      await disposeOwnedTriggerRecord(recoveredStub.dataSource, tracker.records()[0], tracker);
      expect(tracker.remaining()).toEqual([]);
      expect(recoveredStub.calls.some((sql) => sql.startsWith('DROP TRIGGER'))).toBe(true);
    });

    expect(await readOwnedTriggerFact(dataSource, triggerName)).toBeNull();
  });

  it('直接入口：同名对象被替换且回读失败 → 定义核验拒绝删除，替换对象零误删', async () => {
    const triggerName = nextTriggerName('p3replaced');
    const tracker = createTriggerOwnershipTracker();
    const replacedBody = "SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'E2E 替身替换后的同名对象'";

    await withPhysicalCleanupConsent(async () => {
      const createStub = createStubTriggerDataSource({
        metadataResponses: [[], new Error('模拟触发器回读失败')],
      });
      await expect(
        createOwnedTrigger({
          dataSource: createStub.dataSource,
          name: triggerName,
          tableName: ROLLBACK_TRIGGER_TABLE,
          body: ROLLBACK_TRIGGER_BODY,
          tracker,
        }),
      ).rejects.toThrow('模拟触发器回读失败');

      const replacedStub = createStubTriggerDataSource({
        metadataResponses: [
          [{ name: triggerName, tableName: ROLLBACK_TRIGGER_TABLE, definition: replacedBody }],
        ],
      });
      await expect(
        disposeOwnedTriggerRecord(replacedStub.dataSource, tracker.records()[0], tracker),
      ).rejects.toThrow(/归属校验/);

      // 定义核验拒绝后不得发出任何 DROP；替换对象仍然存在且待收尾记录保留
      expect(replacedStub.calls.some((sql) => sql.startsWith('DROP TRIGGER'))).toBe(false);
      expect(tracker.remaining().map((record) => record.name)).toEqual([triggerName]);
    });

    // 替身路径不产生 DDL：真实库中该名称从未被创建
    expect(await readOwnedTriggerFact(dataSource, triggerName)).toBeNull();
  });

  it('包装入口：触发器收尾成功后夹具清理失败 → 仅报告夹具清理错误，触发器零残留', async () => {
    const triggerName = nextTriggerName('p3cleanupfail');
    const tracker = createTriggerOwnershipTracker();
    const factRow = [
      {
        name: triggerName,
        tableName: ROLLBACK_TRIGGER_TABLE,
        definition: ROLLBACK_TRIGGER_BODY,
      },
    ];

    await withPhysicalCleanupConsent(async () => {
      const stub = createStubTriggerDataSource({ metadataResponses: [[], factRow, factRow] });
      const failures = await runWithOwnedTrigger({
        dataSource: stub.dataSource,
        triggerName,
        tableName: ROLLBACK_TRIGGER_TABLE,
        body: ROLLBACK_TRIGGER_BODY,
        setup: () => Promise.resolve(),
        run: () => Promise.resolve(),
        cleanupFixture: () => Promise.reject(new Error('模拟夹具清理失败')),
        tracker,
      });

      expect(failures.map((failure) => failure.stage)).toEqual(['夹具清理错误']);
      expect((failures[0].error as Error).message).toContain('模拟夹具清理失败');
      // 触发器收尾已成功落账：零残留，不存在“待收尾残留”噪声
      expect(tracker.remaining()).toEqual([]);
      expect(stub.calls.some((sql) => sql.startsWith('DROP TRIGGER'))).toBe(true);
    });

    expect(await readOwnedTriggerFact(dataSource, triggerName)).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // 第十五轮 P2/P3：两个生产清理入口分别覆盖账号 / 型号 / 工单的身份漂移。
  // 首次 DELETE 前拒绝（DELETE=0），目标与外部记录逐字段不变，恢复后仍可正常回收。
  // ---------------------------------------------------------------------------

  it('P2 漂移（按 ID 收尾）：账号身份漂移 → 首次 DELETE 前拒绝，DELETE=0 且逐字段不变', async () => {
    await cleanupProductionFixtureResidue(dataSource);
    const foreignBefore = await readForeignSnapshot();
    const ownership = createProductionFixtureOwnership();
    const seeded = await seedProductionFixtureAccounts({
      dataSource,
      ownership,
      createAccountUsecase: app.get(CreateAccountUsecase),
    });
    expect(seeded.failures).toEqual([]);
    const customer = seeded.created.find((seed) => seed.key === 'customer');
    if (!customer) {
      throw new Error('账号漂移用例缺少 customer 账号');
    }

    const accountRepo = dataSource.getRepository(AccountEntity);
    const original = await accountRepo.findOne({ where: { id: customer.accountId } });
    if (!original) {
      throw new Error('账号漂移用例的 customer 行不存在');
    }

    try {
      await accountRepo.update(
        { id: customer.accountId },
        {
          loginEmail: 'drifted.customer@example.com',
        },
      );
      const drifted = await readOwnedFixtureRows(ownership);

      await expectCleanupRejectedWithoutDeletes(
        () => cleanupProductionFixtureByIds(dataSource, ownership),
        /归属校验/,
      );

      expect(await readOwnedFixtureRows(ownership)).toEqual(drifted);
      expect(await readForeignSnapshot()).toEqual(foreignBefore);
    } finally {
      await accountRepo.update(
        { id: customer.accountId },
        {
          loginEmail: original.loginEmail,
        },
      );
    }

    await cleanupProductionFixtureByIds(dataSource, ownership);
    expect(await readOwnedFixtureRows(ownership)).toEqual({
      accounts: [],
      userInfos: [],
      models: [],
      requests: [],
    });
    expect(await findProductionFixtureAccountIds(dataSource)).toEqual([]);
    expect(await readForeignSnapshot()).toEqual(foreignBefore);
  });

  it('P2 漂移（按 ID 收尾）：型号身份漂移 → 首次 DELETE 前拒绝，DELETE=0 且逐字段不变', async () => {
    await cleanupProductionFixtureResidue(dataSource);
    const foreignBefore = await readForeignSnapshot();
    const ownership = createProductionFixtureOwnership();
    const seeded = await seedProductionFixtureAccounts({
      dataSource,
      ownership,
      createAccountUsecase: app.get(CreateAccountUsecase),
    });
    expect(seeded.failures).toEqual([]);
    const customerAccountId = seeded.created.find((seed) => seed.key === 'customer')?.accountId;
    const engineerAccountId = seeded.created.find((seed) => seed.key === 'engineer')?.accountId;
    if (customerAccountId === undefined || engineerAccountId === undefined) {
      throw new Error('型号漂移用例的桩账号不完整（缺少 customer / engineer）');
    }
    const business = await seedProductionFixtureBusiness({
      dataSource,
      ownership,
      customerAccountId,
      engineerAccountId,
    });

    const modelRepo = dataSource.getRepository(EquipmentModelEntity);
    const original = await modelRepo.findOne({ where: { id: business.equipmentModelId } });
    if (!original) {
      throw new Error('型号漂移用例的型号行不存在');
    }

    try {
      await modelRepo.update(
        { id: business.equipmentModelId },
        {
          modelName: '漂移后的型号名称（身份不符）',
        },
      );
      const drifted = await readOwnedFixtureRows(ownership);

      await expectCleanupRejectedWithoutDeletes(
        () => cleanupProductionFixtureByIds(dataSource, ownership),
        /归属校验/,
      );

      expect(await readOwnedFixtureRows(ownership)).toEqual(drifted);
      expect(await readForeignSnapshot()).toEqual(foreignBefore);
    } finally {
      await modelRepo.update(
        { id: business.equipmentModelId },
        {
          modelName: original.modelName,
        },
      );
    }

    await cleanupProductionFixtureByIds(dataSource, ownership);
    expect(await readOwnedFixtureRows(ownership)).toEqual({
      accounts: [],
      userInfos: [],
      models: [],
      requests: [],
    });
    expect(await readForeignSnapshot()).toEqual(foreignBefore);
  });

  it('P2 漂移（按 ID 收尾）：工单身份漂移 → 首次 DELETE 前拒绝，DELETE=0 且逐字段不变', async () => {
    await cleanupProductionFixtureResidue(dataSource);
    const foreignBefore = await readForeignSnapshot();
    const ownership = createProductionFixtureOwnership();
    const seeded = await seedProductionFixtureAccounts({
      dataSource,
      ownership,
      createAccountUsecase: app.get(CreateAccountUsecase),
    });
    expect(seeded.failures).toEqual([]);
    const customerAccountId = seeded.created.find((seed) => seed.key === 'customer')?.accountId;
    const engineerAccountId = seeded.created.find((seed) => seed.key === 'engineer')?.accountId;
    if (customerAccountId === undefined || engineerAccountId === undefined) {
      throw new Error('工单漂移用例的桩账号不完整（缺少 customer / engineer）');
    }
    const business = await seedProductionFixtureBusiness({
      dataSource,
      ownership,
      customerAccountId,
      engineerAccountId,
    });

    const requestRepo = dataSource.getRepository(RepairRequestEntity);
    const original = await requestRepo.findOne({ where: { id: business.openRequestId } });
    if (!original) {
      throw new Error('工单漂移用例的申请行不存在');
    }

    try {
      await requestRepo.update(
        { id: business.openRequestId },
        {
          requestNo: 'E2E-PR3-DRIFTED-REQUEST-NO',
        },
      );
      const drifted = await readOwnedFixtureRows(ownership);

      await expectCleanupRejectedWithoutDeletes(
        () => cleanupProductionFixtureByIds(dataSource, ownership),
        /归属校验/,
      );

      expect(await readOwnedFixtureRows(ownership)).toEqual(drifted);
      expect(await readForeignSnapshot()).toEqual(foreignBefore);
    } finally {
      await requestRepo.update(
        { id: business.openRequestId },
        {
          requestNo: original.requestNo,
        },
      );
    }

    await cleanupProductionFixtureByIds(dataSource, ownership);
    expect(await readOwnedFixtureRows(ownership)).toEqual({
      accounts: [],
      userInfos: [],
      models: [],
      requests: [],
    });
    expect(await readForeignSnapshot()).toEqual(foreignBefore);
  });

  it('P2 漂移（哨兵入口）：账号身份漂移 → 首次 DELETE 前拒绝，DELETE=0 且逐字段不变', async () => {
    await cleanupProductionFixtureResidue(dataSource);
    const foreignBefore = await readForeignSnapshot();
    const ownership = createProductionFixtureOwnership();
    const chain = await ensureProductionSentinelChain({
      dataSource,
      ownership,
      createAccountUsecase: app.get(CreateAccountUsecase),
    });

    const accountRepo = dataSource.getRepository(AccountEntity);
    const original = await accountRepo.findOne({ where: { id: chain.accountId } });
    if (!original) {
      throw new Error('哨兵账号漂移用例的账号行不存在');
    }

    try {
      await accountRepo.update(
        { id: chain.accountId },
        {
          loginEmail: 'drifted.sentinel@example.com',
        },
      );
      const drifted = await readProductionSentinelSnapshot(dataSource, chain);

      await expectCleanupRejectedWithoutDeletes(
        () => cleanupProductionSentinelChain(dataSource, chain),
        /归属校验/,
      );

      expect(await readProductionSentinelSnapshot(dataSource, chain)).toEqual(drifted);
      expect(await readForeignSnapshot()).toEqual(foreignBefore);
    } finally {
      await accountRepo.update({ id: chain.accountId }, { loginEmail: original.loginEmail });
    }

    await cleanupProductionSentinelChain(dataSource, chain);
    expect(await readProductionSentinelSnapshot(dataSource, chain)).toEqual({
      account: null,
      userInfo: null,
      model: null,
      request: null,
    });
    expect(await readForeignSnapshot()).toEqual(foreignBefore);
  });

  it('P2 漂移（哨兵入口）：型号身份漂移 → 首次 DELETE 前拒绝，DELETE=0 且逐字段不变', async () => {
    await cleanupProductionFixtureResidue(dataSource);
    const foreignBefore = await readForeignSnapshot();
    const ownership = createProductionFixtureOwnership();
    const chain = await ensureProductionSentinelChain({
      dataSource,
      ownership,
      createAccountUsecase: app.get(CreateAccountUsecase),
    });

    const modelRepo = dataSource.getRepository(EquipmentModelEntity);
    const original = await modelRepo.findOne({ where: { id: chain.equipmentModelId } });
    if (!original) {
      throw new Error('哨兵型号漂移用例的型号行不存在');
    }

    try {
      await modelRepo.update(
        { id: chain.equipmentModelId },
        {
          modelName: '漂移后的哨兵型号名称（身份不符）',
        },
      );
      const drifted = await readProductionSentinelSnapshot(dataSource, chain);

      await expectCleanupRejectedWithoutDeletes(
        () => cleanupProductionSentinelChain(dataSource, chain),
        /归属校验/,
      );

      expect(await readProductionSentinelSnapshot(dataSource, chain)).toEqual(drifted);
      expect(await readForeignSnapshot()).toEqual(foreignBefore);
    } finally {
      await modelRepo.update({ id: chain.equipmentModelId }, { modelName: original.modelName });
    }

    await cleanupProductionSentinelChain(dataSource, chain);
    expect(await readProductionSentinelSnapshot(dataSource, chain)).toEqual({
      account: null,
      userInfo: null,
      model: null,
      request: null,
    });
    expect(await readForeignSnapshot()).toEqual(foreignBefore);
  });

  it('P2 漂移（哨兵入口）：工单身份漂移 → 首次 DELETE 前拒绝，DELETE=0 且逐字段不变', async () => {
    await cleanupProductionFixtureResidue(dataSource);
    const foreignBefore = await readForeignSnapshot();
    const ownership = createProductionFixtureOwnership();
    const chain = await ensureProductionSentinelChain({
      dataSource,
      ownership,
      createAccountUsecase: app.get(CreateAccountUsecase),
    });

    const requestRepo = dataSource.getRepository(RepairRequestEntity);
    const original = await requestRepo.findOne({ where: { id: chain.repairRequestId } });
    if (!original) {
      throw new Error('哨兵工单漂移用例的申请行不存在');
    }

    try {
      await requestRepo.update(
        { id: chain.repairRequestId },
        {
          requestNo: 'E2E-PR3-DRIFTED-SENTINEL-REQ',
        },
      );
      const drifted = await readProductionSentinelSnapshot(dataSource, chain);

      await expectCleanupRejectedWithoutDeletes(
        () => cleanupProductionSentinelChain(dataSource, chain),
        /归属校验/,
      );

      expect(await readProductionSentinelSnapshot(dataSource, chain)).toEqual(drifted);
      expect(await readForeignSnapshot()).toEqual(foreignBefore);
    } finally {
      await requestRepo.update(
        { id: chain.repairRequestId },
        {
          requestNo: original.requestNo,
        },
      );
    }

    await cleanupProductionSentinelChain(dataSource, chain);
    expect(await readProductionSentinelSnapshot(dataSource, chain)).toEqual({
      account: null,
      userInfo: null,
      model: null,
      request: null,
    });
    expect(await readForeignSnapshot()).toEqual(foreignBefore);
  });
});
