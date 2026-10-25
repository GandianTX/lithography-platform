// test/10-admin-document-database/admin-document-database-fixture-ownership.e2e-spec.ts
//
// 第四轮 Review：普通 admin-document-database E2E 夹具的真实隔离库数据安全反例。
//
// 本 spec 是「验证安全性」的测试，自身同样不得反过来覆盖或清理隔离库中的既有数据：
// - 需要占用历史固定数字 ID 的碰撞链一律「先查空闲 → 仅 INSERT」（绝不 save/upsert/update，
//   insert 遇唯一键冲突只报错、不更新）；目标 ID 已被非本测试行占用时失败关闭；
// - 造数全过程纳入 try/finally：每步成功立即记录实际 ID，任何一步抛错都按已记录行核验字段与
//   全部引用后才按子到父精确回收；未确认归属宁可报错保留数据，绝不按固定 ID / 同名标记兜底删除。

import { AccountStatus, IdentityTypeEnum } from '@app-types/models/account.types';
import { AiConversationStatus, AiMessageRole } from '@app-types/models/ai-conversation.types';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AccountEntity } from '@src/modules/account/base/entities/account.entity';
import { UserInfoEntity } from '@src/modules/account/base/entities/user-info.entity';
import { AiConversationEntity } from '@src/modules/lithography/entities/ai-conversation.entity';
import { AiMessageEntity } from '@src/modules/lithography/entities/ai-message.entity';
import { AiReportEntity } from '@src/modules/lithography/entities/ai-report.entity';
import { EquipmentModelEntity } from '@src/modules/lithography/entities/equipment-model.entity';
import { RepairRequestEntity } from '@src/modules/lithography/entities/repair-request.entity';
import { CreateAccountUsecase } from '@src/usecases/account/create-account.usecase';
import { DataSource, In, type FindOptionsWhere } from 'typeorm';

import { assertDataSourceOnAllowedE2eDatabase } from '../utils/e2e-db-guard';
import {
  createOwnedResourceLedger,
  runGuardedSpecCleanup,
  toResidueAccountFingerprint,
} from '../utils/e2e-scoped-cleanup';
import { assertFixedIdsVacant, insertOnlyAtFixedIds } from '../utils/e2e-insert-only-seed';
import { createTestAccount, type TestAccountConfig } from '../utils/test-accounts';
import {
  ADMIN_DOC_FIXTURE_ACCOUNTS,
  ADMIN_DOC_FIXTURE_MARKERS,
  cleanupAdminDocumentFixtureByIds,
  cleanupAdminDocumentFixtureResidue,
  createAdminDocFixtureOwnership,
  runAdminDocFixtureTeardown,
  seedAdminDocumentFixtureAccounts,
  seedAdminDocumentFixtureBusiness,
  type AdminDocFixtureFailurePoint,
  type AdminDocFixtureOwnership,
} from './admin-document-database-fixture';

/** 普通 spec 的历史固定主键：外部链刻意占用这些 ID，证明固定主键不代表所有权 */
const LEGACY_IDS = {
  model: 51,
  requests: [211, 212, 213],
  conversations: [301, 302],
  reports: [401, 402],
  message: 501,
} as const;

const FOREIGN = {
  loginName: 'pr3corecollision',
  modelCode: 'E2E-ADM-CORE-FOREIGN-MODEL',
  requestNos: ['E2E-ADM-CORE-FOREIGN-211', 'E2E-ADM-CORE-FOREIGN-212', 'E2E-ADM-CORE-FOREIGN-213'],
  reportTitles: ['E2E-ADM-CORE-FOREIGN-401', 'E2E-ADM-CORE-FOREIGN-402'],
  externalReferenceRequestNo: 'E2E-ADM-CORE-FOREIGN-REF',
} as const;

const FOREIGN_ACCOUNT: TestAccountConfig = {
  loginName: FOREIGN.loginName,
  loginEmail: 'pr3.core.collision@example.com',
  loginPassword: 'Pr3CoreCollision@2024',
  status: AccountStatus.ACTIVE,
  accessGroup: [IdentityTypeEnum.CUSTOMER],
  identityType: IdentityTypeEnum.CUSTOMER,
};

// ---------------------------------------------------------------------------------------
// 外部碰撞链的**期望形状**：造数与回收核验共用同一真源（避免两套口径漂移）。
// 时间列不入期望子集，由「前后快照完全一致」的断言覆盖。
// ---------------------------------------------------------------------------------------

const FOREIGN_ACCOUNT_FIELDS = {
  loginName: FOREIGN_ACCOUNT.loginName,
  loginEmail: FOREIGN_ACCOUNT.loginEmail,
  status: FOREIGN_ACCOUNT.status,
  identityHint: FOREIGN_ACCOUNT.identityType,
} as const;

const FOREIGN_MODEL_FIELDS = {
  modelCode: FOREIGN.modelCode,
  modelName: '外部型号：占用普通 spec 历史主键',
  enabled: true,
  sortOrder: 1,
} as const;

const FOREIGN_REQUEST_FIELDS = LEGACY_IDS.requests.map((id, index) => ({
  id,
  requestNo: FOREIGN.requestNos[index],
  errorCode: `FOREIGN-${id}`,
  faultDescription: `外部申请：占用历史主键 ${id}`,
  contentMd: `# FOREIGN-${id}`,
  isAccepted: false,
  acceptedByEngineerAccountId: null,
  deprecated: false,
  deletedAt: null,
}));

const FOREIGN_CONVERSATION_FIELDS = [
  {
    id: LEGACY_IDS.conversations[0],
    requestId: LEGACY_IDS.requests[0],
    status: AiConversationStatus.COMPLETED,
    aiFeedback: '外部会话反馈',
  },
  {
    id: LEGACY_IDS.conversations[1],
    requestId: LEGACY_IDS.requests[0],
    status: AiConversationStatus.ACTIVE,
    aiFeedback: null,
  },
] as const;

const FOREIGN_MESSAGE_FIELDS = {
  id: LEGACY_IDS.message,
  conversationId: LEGACY_IDS.conversations[0],
  messageSeq: 1,
  turnNo: 1,
  role: AiMessageRole.USER,
  contentText: '外部消息：固定会话 ID 不代表所有权',
} as const;

const FOREIGN_REPORT_FIELDS = [
  {
    id: LEGACY_IDS.reports[0],
    requestId: LEGACY_IDS.requests[0],
    conversationId: LEGACY_IDS.conversations[0],
    reportTitle: FOREIGN.reportTitles[0],
    reportType: 'FOREIGN-A',
    contentMd: '# foreign report 401',
  },
  {
    id: LEGACY_IDS.reports[1],
    requestId: LEGACY_IDS.requests[1],
    conversationId: LEGACY_IDS.conversations[1],
    reportTitle: FOREIGN.reportTitles[1],
    reportType: 'FOREIGN-B',
    contentMd: '# foreign report 402',
  },
] as const;

/** 造数过程中的**增量记录**：每步成功立即写入，抛错时据此精确回收 */
type ForeignChainRecorder = {
  accountId: number | null;
  modelId: number | null;
  requestIds: number[];
  conversationIds: number[];
  messageIds: number[];
  reportIds: number[];
};

const createForeignChainRecorder = (): ForeignChainRecorder => ({
  accountId: null,
  modelId: null,
  requestIds: [],
  conversationIds: [],
  messageIds: [],
  reportIds: [],
});

/** 完整外部链 ID（造数成功后使用；缺失即视为造数未完成） */
type ForeignChainIds = {
  accountId: number;
  modelId: number;
  requestIds: number[];
  conversationIds: number[];
  messageIds: number[];
  reportIds: number[];
};

const requireForeignChain = (recorder: ForeignChainRecorder): ForeignChainIds => {
  if (recorder.accountId === null || recorder.modelId === null) {
    throw new Error('外部碰撞链未记录到账号/型号主键，拒绝按不完整记录继续');
  }
  return {
    accountId: recorder.accountId,
    modelId: recorder.modelId,
    requestIds: recorder.requestIds,
    conversationIds: recorder.conversationIds,
    messageIds: recorder.messageIds,
    reportIds: recorder.reportIds,
  };
};

const ownershipViolation = (detail: string): Error =>
  new Error(`[cleanupVerifiedForeignChain] 阶段=归属校验 拒绝删除：${detail}`);

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

describe('普通 admin-document-database fixture 所有权（真实隔离库）', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let createAccountUsecase: CreateAccountUsecase;
  /** R1：仅当 beforeAll 在「写夹具之前」完成白名单验证才置位，afterAll 据此决定能否清理。 */
  let fixtureTargetValidated = false;

  beforeAll(async () => {
    const [{ initGraphQLSchema }, { ApiModule: apiModule }] = await Promise.all([
      import('../../src/adapters/api/graphql/schema/schema.init'),
      import('../../src/bootstraps/api/api.module'),
    ]);
    initGraphQLSchema();
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [apiModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    dataSource = moduleFixture.get(DataSource);
    createAccountUsecase = app.get(CreateAccountUsecase);
    await assertDataSourceOnAllowedE2eDatabase(dataSource);
    fixtureTargetValidated = true;
    await cleanupAdminDocumentFixtureResidue(dataSource);
  });

  afterAll(async () => {
    // R1：守卫拒绝 / 模块装配失败 / 连接未完成 → 只关闭已创建的 app，不做任何删除；
    // 清理失败不吞错且仍会关闭 app（try/finally 在 helper 内实现）。
    await runAdminDocFixtureTeardown({
      app,
      dataSource,
      targetValidated: fixtureTargetValidated,
      cleanup: async (ds) => {
        await cleanupAdminDocumentFixtureResidue(ds);
      },
    });
  });

  const seedFixtureAccounts = async (
    ownership: AdminDocFixtureOwnership,
  ): Promise<{ admin: number; engineer: number; customer: number }> =>
    seedAdminDocumentFixtureAccounts({
      dataSource,
      ownership,
      createAccountUsecase,
    });

  const countFixtureMarkers = async (): Promise<{
    accounts: number;
    models: number;
    requests: number;
  }> => {
    const [accounts, models, requests] = await Promise.all([
      dataSource.getRepository(AccountEntity).count({
        where: {
          loginName: In(Object.values(ADMIN_DOC_FIXTURE_ACCOUNTS).map((row) => row.loginName)),
        },
      }),
      dataSource
        .getRepository(EquipmentModelEntity)
        .count({ where: { modelCode: ADMIN_DOC_FIXTURE_MARKERS.modelCode } }),
      dataSource.getRepository(RepairRequestEntity).count({
        where: {
          requestNo: In([
            ADMIN_DOC_FIXTURE_MARKERS.requestA,
            ADMIN_DOC_FIXTURE_MARKERS.requestDeleted,
            ADMIN_DOC_FIXTURE_MARKERS.requestOlder,
          ]),
        },
      }),
    ]);
    return { accounts, models, requests };
  };

  const readForeignChain = async (ids: ForeignChainIds): Promise<Record<string, unknown>> => {
    const [account, model, requests, conversations, messages, reports] = await Promise.all([
      dataSource.getRepository(AccountEntity).findOne({ where: { id: ids.accountId } }),
      dataSource.getRepository(EquipmentModelEntity).findOne({ where: { id: ids.modelId } }),
      dataSource.getRepository(RepairRequestEntity).find({
        where: { id: In(ids.requestIds) },
        order: { id: 'ASC' },
      }),
      dataSource.getRepository(AiConversationEntity).find({
        where: { id: In(ids.conversationIds) },
        order: { id: 'ASC' },
      }),
      dataSource.getRepository(AiMessageEntity).find({
        where: { id: In(ids.messageIds) },
        order: { id: 'ASC' },
      }),
      dataSource.getRepository(AiReportEntity).find({
        where: { id: In(ids.reportIds) },
        order: { id: 'ASC' },
      }),
    ]);
    return { account, model, requests, conversations, messages, reports };
  };

  /**
   * 构造「占用普通 spec 历史固定主键」的外部链（账号按自然标记创建，其余按固定 ID 仅 INSERT）。
   *
   * 安全前提（P1-1）：
   * 1. **先**在隔离库检查全部目标固定 ID 是否空闲——任一被占用即失败关闭，
   *    此时还没有创建任何行（含账号），占位行零变化；
   * 2. 真正写入一律走 `insertOnlyAtFixedIds`（INSERT 语义；冲突只报错，绝不 UPDATE）；
   * 3. 每步成功立即写入 recorder —— 中途抛错时调用方据此核验后精确回收。
   */
  const seedLegacyCollisionChain = async (
    recorder: ForeignChainRecorder,
  ): Promise<ForeignChainIds> => {
    const modelRepo = dataSource.getRepository(EquipmentModelEntity);
    const requestRepo = dataSource.getRepository(RepairRequestEntity);
    const conversationRepo = dataSource.getRepository(AiConversationEntity);
    const messageRepo = dataSource.getRepository(AiMessageEntity);
    const reportRepo = dataSource.getRepository(AiReportEntity);

    // 1) 写入前预检查：目标固定 ID 必须全部空闲（不产生任何写入）
    await assertFixedIdsVacant(modelRepo, '外部碰撞链型号', [LEGACY_IDS.model]);
    await assertFixedIdsVacant(requestRepo, '外部碰撞链申请', LEGACY_IDS.requests);
    await assertFixedIdsVacant(conversationRepo, '外部碰撞链会话', LEGACY_IDS.conversations);
    await assertFixedIdsVacant(messageRepo, '外部碰撞链消息', [LEGACY_IDS.message]);
    await assertFixedIdsVacant(reportRepo, '外部碰撞链报告', LEGACY_IDS.reports);

    // 2) 仅创建写入：账号走 usecase（动态主键），其余按固定 ID INSERT
    const created = await createTestAccount(dataSource, createAccountUsecase, FOREIGN_ACCOUNT);
    recorder.accountId = created.accountId;

    const [modelId] = await insertOnlyAtFixedIds(modelRepo, '外部碰撞链型号', [
      { id: LEGACY_IDS.model, ...FOREIGN_MODEL_FIELDS },
    ]);
    recorder.modelId = modelId;

    const requestIds = await insertOnlyAtFixedIds(
      requestRepo,
      '外部碰撞链申请',
      FOREIGN_REQUEST_FIELDS.map((row, index) => ({
        ...row,
        customerAccountId: created.accountId,
        equipmentModelId: modelId,
        createdAt: new Date(`2026-07-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`),
      })),
    );
    recorder.requestIds.push(...requestIds);

    const conversationIds = await insertOnlyAtFixedIds(
      conversationRepo,
      '外部碰撞链会话',
      FOREIGN_CONVERSATION_FIELDS.map((row) => ({
        ...row,
        engineerAccountId: created.accountId,
        completedAt: row.aiFeedback === null ? null : new Date('2026-07-10T01:00:00.000Z'),
        createdAt:
          row.id === LEGACY_IDS.conversations[0]
            ? new Date('2026-07-10T00:00:00.000Z')
            : new Date('2026-07-11T00:00:00.000Z'),
      })),
    );
    recorder.conversationIds.push(...conversationIds);

    const messageIds = await insertOnlyAtFixedIds(messageRepo, '外部碰撞链消息', [
      { ...FOREIGN_MESSAGE_FIELDS, createdAt: new Date('2026-07-10T00:01:00.000Z') },
    ]);
    recorder.messageIds.push(...messageIds);

    const reportIds = await insertOnlyAtFixedIds(
      reportRepo,
      '外部碰撞链报告',
      FOREIGN_REPORT_FIELDS.map((row, index) => ({
        ...row,
        engineerAccountId: created.accountId,
        createdAt: new Date(`2026-07-1${index}T02:00:00.000Z`),
      })),
    );
    recorder.reportIds.push(...reportIds);

    return requireForeignChain(recorder);
  };

  /**
   * 回收本次记录的外部链（正常收尾与中途失败共用同一套机制）：
   * 逐字段核验 → 全部引用核验 → 同一事务内按子到父精确删除；任何一项不符即整次失败、零 DELETE。
   */
  const cleanupVerifiedForeignChain = async (recorder: ForeignChainRecorder): Promise<void> => {
    await assertDataSourceOnAllowedE2eDatabase(dataSource);

    await dataSource.transaction(async (manager) => {
      const accountRepo = manager.getRepository(AccountEntity);
      const modelRepo = manager.getRepository(EquipmentModelEntity);
      const requestRepo = manager.getRepository(RepairRequestEntity);
      const conversationRepo = manager.getRepository(AiConversationEntity);
      const messageRepo = manager.getRepository(AiMessageEntity);
      const reportRepo = manager.getRepository(AiReportEntity);

      // 1) 逐字段核验（与造数同一真源）
      if (recorder.accountId !== null) {
        const account = await accountRepo.findOne({ where: { id: recorder.accountId } });
        if (account === null) {
          throw ownershipViolation(`外部账号 id=${recorder.accountId} 已不存在，拒绝继续删除`);
        }
        assertForeignFields(`外部账号 id=${recorder.accountId}`, account, FOREIGN_ACCOUNT_FIELDS);
        const userInfoCount = await manager
          .getRepository(UserInfoEntity)
          .count({ where: { accountId: recorder.accountId } });
        if (userInfoCount !== 1) {
          throw ownershipViolation(
            `外部账号 id=${recorder.accountId} 的 user_info 行数=${userInfoCount} ≠ 1`,
          );
        }
      }

      if (recorder.modelId !== null) {
        const model = await modelRepo.findOne({ where: { id: recorder.modelId } });
        if (model === null) {
          throw ownershipViolation(`外部型号 id=${recorder.modelId} 已不存在，拒绝继续删除`);
        }
        assertForeignFields(`外部型号 id=${recorder.modelId}`, model, FOREIGN_MODEL_FIELDS);
      }

      if (recorder.requestIds.length > 0) {
        const requests = await requestRepo.find({
          where: { id: In(recorder.requestIds) },
          order: { id: 'ASC' },
        });
        for (const expected of FOREIGN_REQUEST_FIELDS) {
          const actual = requests.find((row) => row.id === expected.id);
          if (actual === undefined) {
            throw ownershipViolation(`外部申请 id=${expected.id} 已不存在，拒绝继续删除`);
          }
          assertForeignFields(`外部申请 id=${expected.id}`, actual, expected);
          if (recorder.accountId !== null && actual.customerAccountId !== recorder.accountId) {
            throw ownershipViolation(
              `外部申请 id=${expected.id} 的客户账号=${actual.customerAccountId} 与记录的外部账号不符`,
            );
          }
          if (recorder.modelId !== null && actual.equipmentModelId !== recorder.modelId) {
            throw ownershipViolation(
              `外部申请 id=${expected.id} 的型号=${actual.equipmentModelId} 与记录的外部型号不符`,
            );
          }
        }
      }

      if (recorder.conversationIds.length > 0) {
        const conversations = await conversationRepo.find({
          where: { id: In(recorder.conversationIds) },
          order: { id: 'ASC' },
        });
        for (const expected of FOREIGN_CONVERSATION_FIELDS) {
          const actual = conversations.find((row) => row.id === expected.id);
          if (actual === undefined) {
            throw ownershipViolation(`外部会话 id=${expected.id} 已不存在，拒绝继续删除`);
          }
          assertForeignFields(`外部会话 id=${expected.id}`, actual, expected);
          if (recorder.accountId !== null && actual.engineerAccountId !== recorder.accountId) {
            throw ownershipViolation(
              `外部会话 id=${expected.id} 的工程师账号=${String(
                actual.engineerAccountId,
              )} 与记录的外部账号不符`,
            );
          }
        }
      }

      if (recorder.messageIds.length > 0) {
        const messages = await messageRepo.find({
          where: { id: In(recorder.messageIds) },
          order: { id: 'ASC' },
        });
        const actual = messages.find((row) => row.id === FOREIGN_MESSAGE_FIELDS.id);
        if (actual === undefined) {
          throw ownershipViolation(
            `外部消息 id=${FOREIGN_MESSAGE_FIELDS.id} 已不存在，拒绝继续删除`,
          );
        }
        assertForeignFields(
          `外部消息 id=${FOREIGN_MESSAGE_FIELDS.id}`,
          actual,
          FOREIGN_MESSAGE_FIELDS,
        );
      }

      if (recorder.reportIds.length > 0) {
        const reports = await reportRepo.find({
          where: { id: In(recorder.reportIds) },
          order: { id: 'ASC' },
        });
        for (const expected of FOREIGN_REPORT_FIELDS) {
          const actual = reports.find((row) => row.id === expected.id);
          if (actual === undefined) {
            throw ownershipViolation(`外部报告 id=${expected.id} 已不存在，拒绝继续删除`);
          }
          assertForeignFields(`外部报告 id=${expected.id}`, actual, expected);
        }
      }

      // 2) 全部引用核验：任何引用本外部链的行都必须落在本次已记录集合内
      const requestFilters: FindOptionsWhere<RepairRequestEntity>[] = [];
      if (recorder.accountId !== null) {
        requestFilters.push({ customerAccountId: recorder.accountId });
        requestFilters.push({ acceptedByEngineerAccountId: recorder.accountId });
      }
      if (recorder.modelId !== null) {
        requestFilters.push({ equipmentModelId: recorder.modelId });
      }
      if (requestFilters.length > 0) {
        const referencingRequests = await requestRepo.find({
          where: requestFilters,
          select: { id: true },
        });
        assertIdsWithin(
          '引用外部账号/型号的维修申请',
          referencingRequests.map((row) => row.id),
          recorder.requestIds,
        );
      }

      const conversationFilters: FindOptionsWhere<AiConversationEntity>[] = [];
      if (recorder.requestIds.length > 0) {
        conversationFilters.push({ requestId: In(recorder.requestIds) });
      }
      if (recorder.accountId !== null) {
        conversationFilters.push({ engineerAccountId: recorder.accountId });
      }
      if (conversationFilters.length > 0) {
        const referencingConversations = await conversationRepo.find({
          where: conversationFilters,
          select: { id: true },
        });
        assertIdsWithin(
          '引用外部申请/账号的 AI 会话',
          referencingConversations.map((row) => row.id),
          recorder.conversationIds,
        );
      }

      if (recorder.conversationIds.length > 0) {
        const referencingMessages = await messageRepo.find({
          where: { conversationId: In(recorder.conversationIds) },
          select: { id: true },
        });
        assertIdsWithin(
          '引用外部会话的 AI 消息',
          referencingMessages.map((row) => row.id),
          recorder.messageIds,
        );
      }

      const reportFilters: FindOptionsWhere<AiReportEntity>[] = [];
      if (recorder.requestIds.length > 0) {
        reportFilters.push({ requestId: In(recorder.requestIds) });
      }
      if (recorder.conversationIds.length > 0) {
        reportFilters.push({ conversationId: In(recorder.conversationIds) });
      }
      if (recorder.accountId !== null) {
        reportFilters.push({ engineerAccountId: recorder.accountId });
      }
      if (reportFilters.length > 0) {
        const referencingReports = await reportRepo.find({
          where: reportFilters,
          select: { id: true },
        });
        assertIdsWithin(
          '引用外部申请/会话/账号的 AI 报告',
          referencingReports.map((row) => row.id),
          recorder.reportIds,
        );
      }

      // 3) 核验全部通过：按子到父精确删除（只删本次记录的 ID）
      if (recorder.reportIds.length > 0) {
        await reportRepo.delete({ id: In(recorder.reportIds) });
      }
      if (recorder.messageIds.length > 0) {
        await messageRepo.delete({ id: In(recorder.messageIds) });
      }
      if (recorder.conversationIds.length > 0) {
        await conversationRepo.delete({ id: In(recorder.conversationIds) });
      }
      if (recorder.requestIds.length > 0) {
        await requestRepo.delete({ id: In(recorder.requestIds) });
      }
      if (recorder.modelId !== null) {
        await modelRepo.delete({ id: recorder.modelId });
      }
      if (recorder.accountId !== null) {
        await manager.getRepository(UserInfoEntity).delete({ accountId: recorder.accountId });
        await accountRepo.delete({ id: recorder.accountId });
      }
    });
  };

  it('历史固定数字 ID 被外部链占用时，普通夹具准备与清理均不改变外部数据', async () => {
    const recorder = createForeignChainRecorder();
    try {
      const foreignIds = await seedLegacyCollisionChain(recorder);
      const before = await readForeignChain(foreignIds);
      const ownership = createAdminDocFixtureOwnership();

      try {
        const accounts = await seedFixtureAccounts(ownership);
        const business = await seedAdminDocumentFixtureBusiness({
          dataSource,
          ownership,
          customerAccountId: accounts.customer,
          engineerAccountId: accounts.engineer,
        });
        expect(business.equipmentModelId).not.toBe(LEGACY_IDS.model);
        expect(business.requestAId).not.toBe(LEGACY_IDS.requests[0]);
        expect(business.conversationAId).not.toBe(LEGACY_IDS.conversations[0]);
        expect(business.reportAId).not.toBe(LEGACY_IDS.reports[0]);
        expect(await readForeignChain(foreignIds)).toEqual(before);

        await cleanupAdminDocumentFixtureByIds(dataSource, ownership);
        expect(await readForeignChain(foreignIds)).toEqual(before);
      } finally {
        if ((await countFixtureMarkers()).accounts > 0) {
          await cleanupAdminDocumentFixtureByIds(dataSource, ownership);
        }
      }
    } finally {
      // 外部链按记录 ID + 逐字段/引用核验回收（绝不用固定 ID 兜底）
      await cleanupVerifiedForeignChain(recorder);
    }
  });

  it('目标固定 ID 已被非本测试行占用时：外部链准备失败关闭，占位行前后完全一致', async () => {
    const modelRepo = dataSource.getRepository(EquipmentModelEntity);
    // 占位行由本 spec 以**仅创建**语义写入（同一工具，不覆盖任何既有行）
    const [placeholderId] = await insertOnlyAtFixedIds(modelRepo, '占位型号', [
      {
        id: LEGACY_IDS.model,
        modelCode: 'E2E-ADM-CORE-OCCUPIED-MODEL',
        modelName: '占位：非本测试的既有行',
        enabled: true,
        sortOrder: 9,
      },
    ]);
    const before = await modelRepo.findOne({ where: { id: placeholderId } });
    const recorder = createForeignChainRecorder();

    try {
      await expect(seedLegacyCollisionChain(recorder)).rejects.toThrow(/已被 .* 中的既有行占用/);

      // 失败关闭发生在任何写入之前：不记录任何 ID、不创建账号
      expect(recorder).toEqual(createForeignChainRecorder());
      expect(
        await dataSource.getRepository(AccountEntity).count({
          where: { loginName: FOREIGN.loginName },
        }),
      ).toBe(0);

      // 占位行字段完全不变
      expect(await modelRepo.findOne({ where: { id: placeholderId } })).toEqual(before);
    } finally {
      await cleanupVerifiedForeignChain(recorder);
      const current = await modelRepo.findOne({ where: { id: placeholderId } });
      if (current?.modelCode === 'E2E-ADM-CORE-OCCUPIED-MODEL') {
        await modelRepo.delete({ id: placeholderId });
      }
    }
  });

  it('同名异主账号：残留恢复失败关闭，账号字段完全不变', async () => {
    const repo = dataSource.getRepository(AccountEntity);
    const foreign = await repo.save(
      repo.create({
        loginName: ADMIN_DOC_FIXTURE_ACCOUNTS.admin.loginName,
        loginEmail: 'foreign.same-name@example.com',
        loginPassword: 'foreign-not-a-fixture-hash',
        status: AccountStatus.SUSPENDED,
        identityHint: IdentityTypeEnum.ENGINEER,
      }),
    );
    const before = await repo.findOne({ where: { id: foreign.id } });
    try {
      await expect(cleanupAdminDocumentFixtureResidue(dataSource)).rejects.toThrow(/归属校验/);
      expect(await repo.findOne({ where: { id: foreign.id } })).toEqual(before);
    } finally {
      const current = await repo.findOne({ where: { id: foreign.id } });
      if (current?.loginEmail === 'foreign.same-name@example.com') {
        await repo.delete({ id: foreign.id });
      }
    }
  });

  it('同 modelCode 异字段型号：残留恢复失败关闭，型号完全不变', async () => {
    const repo = dataSource.getRepository(EquipmentModelEntity);
    const foreign = await repo.save(
      repo.create({
        modelCode: ADMIN_DOC_FIXTURE_MARKERS.modelCode,
        modelName: '外部同编码型号',
        enabled: false,
        sortOrder: 1,
      }),
    );
    const before = await repo.findOne({ where: { id: foreign.id } });
    try {
      await expect(cleanupAdminDocumentFixtureResidue(dataSource)).rejects.toThrow(/归属校验/);
      expect(await repo.findOne({ where: { id: foreign.id } })).toEqual(before);
    } finally {
      const current = await repo.findOne({ where: { id: foreign.id } });
      if (current?.modelName === '外部同编码型号') {
        await repo.delete({ id: foreign.id });
      }
    }
  });

  it('外部申请引用夹具账号/型号时，清理在任何 DELETE 前失败关闭', async () => {
    const ownership = createAdminDocFixtureOwnership();
    let externalRequestId: number | null = null;
    let businessRequestAId: number | null = null;
    try {
      const accounts = await seedFixtureAccounts(ownership);
      const business = await seedAdminDocumentFixtureBusiness({
        dataSource,
        ownership,
        customerAccountId: accounts.customer,
        engineerAccountId: accounts.engineer,
      });
      businessRequestAId = business.requestAId;
      const requestRepo = dataSource.getRepository(RepairRequestEntity);
      const external = await requestRepo.save(
        requestRepo.create({
          requestNo: FOREIGN.externalReferenceRequestNo,
          customerAccountId: accounts.customer,
          equipmentModelId: business.equipmentModelId,
          errorCode: 'FOREIGN-REFERENCE',
          faultDescription: '外部申请引用普通 spec 的账号和型号',
          contentMd: '# FOREIGN-REFERENCE',
          createdAt: new Date('2026-07-20T00:00:00.000Z'),
          isAccepted: false,
          acceptedByEngineerAccountId: null,
          acceptedAt: null,
          deprecated: false,
          deletedAt: null,
        }),
      );
      externalRequestId = external.id;
      const fixtureRequestBefore = await requestRepo.findOne({
        where: { id: business.requestAId },
      });
      const externalBefore = await requestRepo.findOne({ where: { id: external.id } });

      await expect(cleanupAdminDocumentFixtureByIds(dataSource, ownership)).rejects.toThrow(
        /外部申请/,
      );
      expect(await requestRepo.findOne({ where: { id: business.requestAId } })).toEqual(
        fixtureRequestBefore,
      );
      expect(await requestRepo.findOne({ where: { id: external.id } })).toEqual(externalBefore);
    } finally {
      // 外部申请先移除，本轮夹具数据才可精确回收
      if (externalRequestId !== null) {
        await dataSource
          .getRepository(RepairRequestEntity)
          .delete({ id: externalRequestId, requestNo: FOREIGN.externalReferenceRequestNo });
      }
      if (businessRequestAId !== null) {
        await cleanupAdminDocumentFixtureByIds(dataSource, ownership);
      }
    }
  });

  const FAILURE_POINTS: readonly AdminDocFixtureFailurePoint[] = [
    'after-model',
    'after-first-request',
    'after-conversations',
    'after-messages',
  ];

  const EXPECTED_OWNERSHIP_BY_FAILURE_POINT = new Map<
    AdminDocFixtureFailurePoint,
    { models: number; requests: number; conversations: number; messages: number; reports: number }
  >([
    ['after-model', { models: 1, requests: 0, conversations: 0, messages: 0, reports: 0 }],
    ['after-first-request', { models: 1, requests: 1, conversations: 0, messages: 0, reports: 0 }],
    ['after-conversations', { models: 1, requests: 3, conversations: 2, messages: 0, reports: 0 }],
    // conversationA 在失败点之前已写入 200 条消息（100 轮 × 每轮 USER + ASSISTANT）
    ['after-messages', { models: 1, requests: 3, conversations: 2, messages: 200, reports: 0 }],
  ]);

  for (const failurePoint of FAILURE_POINTS) {
    it(`造数中途失败（账号已创建 + ${failurePoint}）：只回收本轮已记录并核验通过的行`, async () => {
      const ownership = createAdminDocFixtureOwnership();
      try {
        const accounts = await seedFixtureAccounts(ownership);
        expect(ownership.accountIds).toHaveLength(3);

        await expect(
          seedAdminDocumentFixtureBusiness({
            dataSource,
            ownership,
            customerAccountId: accounts.customer,
            engineerAccountId: accounts.engineer,
            failurePoint,
          }),
        ).rejects.toThrow(failurePoint);

        const expected = EXPECTED_OWNERSHIP_BY_FAILURE_POINT.get(failurePoint);
        if (expected === undefined) {
          throw new Error(`未定义中途失败点 ${failurePoint} 的期望归属`);
        }
        expect(ownership.equipmentModelIds).toHaveLength(expected.models);
        expect(ownership.repairRequestIds).toHaveLength(expected.requests);
        expect(ownership.conversationIds).toHaveLength(expected.conversations);
        expect(ownership.messageIds).toHaveLength(expected.messages);
        expect(ownership.reportIds).toHaveLength(expected.reports);
      } finally {
        await cleanupAdminDocumentFixtureByIds(dataSource, ownership);
      }
      expect(await countFixtureMarkers()).toEqual({ accounts: 0, models: 0, requests: 0 });
    });
  }

  it('连续两轮：每轮动态主键，清理后均无残留', async () => {
    const generatedIds: number[] = [];
    for (let run = 0; run < 2; run += 1) {
      const ownership = createAdminDocFixtureOwnership();
      try {
        const accounts = await seedFixtureAccounts(ownership);
        const business = await seedAdminDocumentFixtureBusiness({
          dataSource,
          ownership,
          customerAccountId: accounts.customer,
          engineerAccountId: accounts.engineer,
        });
        generatedIds.push(business.equipmentModelId, business.requestAId);
      } finally {
        await cleanupAdminDocumentFixtureByIds(dataSource, ownership);
      }
      expect(await countFixtureMarkers()).toEqual({ accounts: 0, models: 0, requests: 0 });
    }
    expect(new Set(generatedIds).size).toBe(generatedIds.length);
  });

  it('R25-01 C05：真实业务夹具创建后、组织建立前失败，组合收尾保留原错误并关闭应用', async () => {
    const { ApiModule: apiModule } = await import('../../src/bootstraps/api/api.module');
    const moduleFixture = await Test.createTestingModule({ imports: [apiModule] }).compile();
    const scenarioApp = moduleFixture.createNestApplication();
    const ownership = createAdminDocFixtureOwnership();
    const calls: string[] = [];
    const injected = new Error('R25-01：组织建立前失败');
    const close = jest.spyOn(scenarioApp, 'close');
    let targetValidated = false;
    try {
      await scenarioApp.init();
      const ds = scenarioApp.get<DataSource>(DataSource);
      await assertDataSourceOnAllowedE2eDatabase(ds);
      targetValidated = true;
      await expect(
        (async () => {
          try {
            const accounts = await seedAdminDocumentFixtureAccounts({
              dataSource: ds,
              ownership,
              createAccountUsecase: scenarioApp.get(CreateAccountUsecase),
            });
            await seedAdminDocumentFixtureBusiness({
              dataSource: ds,
              ownership,
              customerAccountId: accounts.customer,
              engineerAccountId: accounts.engineer,
            });
            expect(await countFixtureMarkers()).toEqual({ accounts: 3, models: 1, requests: 3 });
            throw injected;
          } finally {
            await runAdminDocFixtureTeardown({
              app: scenarioApp,
              dataSource: ds,
              targetValidated,
              cleanup: async (cleanupDs) => {
                calls.push('organization');
                await runGuardedSpecCleanup({
                  dataSource: cleanupDs,
                  owned: createOwnedResourceLedger(),
                  retainedAccounts: Object.values(ADMIN_DOC_FIXTURE_ACCOUNTS).map(
                    toResidueAccountFingerprint,
                  ),
                  helper: 'R25-01 C05 实际组织链收尾',
                });
                calls.push('fixture');
                await cleanupAdminDocumentFixtureByIds(cleanupDs, ownership);
              },
            });
          }
        })(),
      ).rejects.toBe(injected);
      expect(calls).toEqual(['organization', 'fixture']);
      expect(close).toHaveBeenCalledTimes(1);
      expect(ds.isInitialized).toBe(false);
      expect(await countFixtureMarkers()).toEqual({ accounts: 0, models: 0, requests: 0 });
    } finally {
      // 断言/初始化失败也释放真实应用；闭库后的兜底只使用已验证的主连接及本轮账本。
      if (close.mock.calls.length === 0) await scenarioApp.close();
      if (targetValidated && (await countFixtureMarkers()).accounts > 0) {
        await cleanupAdminDocumentFixtureByIds(dataSource, ownership);
      }
    }
  });

  it('R25-01 C06：真实账号和业务残留无组织时，实际预清理恢复并连续两轮重建', async () => {
    for (let run = 0; run < 2; run += 1) {
      const previous = createAdminDocFixtureOwnership();
      const current = createAdminDocFixtureOwnership();
      let previousCleared = false;
      let currentCleared = false;
      try {
        const accounts = await seedFixtureAccounts(previous);
        await seedAdminDocumentFixtureBusiness({
          dataSource,
          ownership: previous,
          customerAccountId: accounts.customer,
          engineerAccountId: accounts.engineer,
        });
        // 与实际 beforeAll 相同的顺序：先组织链，再 fixture 残留 owner；不向后者传旧账本。
        await runGuardedSpecCleanup({
          dataSource,
          residue: {
            organizations: [
              {
                organizationCode: 'E2E_DOCDB_R25_ABSENT',
                name: 'R25 未创建组织',
                kind: 'CLIENT',
              },
            ],
          },
          retainedAccounts: Object.values(ADMIN_DOC_FIXTURE_ACCOUNTS).map(
            toResidueAccountFingerprint,
          ),
          helper: 'R25-01 C06 实际组织链预清理',
        });
        await cleanupAdminDocumentFixtureResidue(dataSource);
        previousCleared = true;
        expect(await countFixtureMarkers()).toEqual({ accounts: 0, models: 0, requests: 0 });
        const nextAccounts = await seedFixtureAccounts(current);
        await seedAdminDocumentFixtureBusiness({
          dataSource,
          ownership: current,
          customerAccountId: nextAccounts.customer,
          engineerAccountId: nextAccounts.engineer,
        });
        expect(nextAccounts.admin).not.toBe(accounts.admin);
        await cleanupAdminDocumentFixtureByIds(dataSource, current);
        currentCleared = true;
        expect(await countFixtureMarkers()).toEqual({ accounts: 0, models: 0, requests: 0 });
      } finally {
        if (!currentCleared) await cleanupAdminDocumentFixtureByIds(dataSource, current);
        if (!previousCleared) await cleanupAdminDocumentFixtureByIds(dataSource, previous);
      }
    }
  });
});
