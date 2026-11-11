// test/06-repair-request/repair-request-fixture-ownership.e2e-spec.ts
//
// PR4 回归：维修申请 E2E 夹具（repair-request-fixture）在真实隔离库上的数据安全反例。
//
// 本 spec 是「验证安全性」的测试，自身同样不得反过来覆盖或清理隔离库中的既有数据：
// - 哨兵链（专属 loginName / modelCode / requestNo，均不属于夹具）代表「夹具外无关数据」，
//   夹具的任何清理动作都不得触碰它；
// - 崩溃残留按专属标记 + 完整归属核验后精确回收，无残留时 no-op（连跑两遍幂等）；
// - 部分造数失败时只回收已成功创建且已验证归属的记录；
// - 外部申请引用了夹具账号（非夹具 requestNo）时失败关闭，绝不误删夹具账号；
// - 同标记但正文指纹不同的申请、客户或正文与真源不一致的回复、状态或时间与真源不符的回复、
//   以及接单人不是夹具工程师账号的申请同样失败关闭，夹具零删除；
// - 真源内的两条合法回复必须能通过归属核验并被精确清理（回归防护：不能因核验过严而误拒）；
// - 测试内对本轮自建外部行的直接删除同样要过「显式清理许可 + 实际库白名单」双门禁，
//   且 ID 必须来自本轮记录集合、删除前按指纹谓词逐字段核验；
//
// 运行前置（物理删除的第二道独立门禁）：
// - 本 spec 会调用夹具的物理清理入口，因此执行者必须在启动前显式设置
//   `E2E_ALLOW_PHYSICAL_CLEANUP=1`（见 test/utils/e2e-db-guard.ts）。该开关不写入任何 npm script，
//   代码中也不提供默认值；缺失时所有删除入口在读取实际库名之前即失败关闭。
//
// 哨兵自身的造数与收尾同样遵循 fail-closed（本 spec 的 afterAll 亦不得成为不安全清理路径）：
// - 造数前先过目标库白名单守卫，再确认专属标记均为空闲，任一被占用即拒绝造数；
// - 只记录「实际创建成功并拿到数据库主键」的行；
// - 只有 `beforeAll` 的守卫通过（targetValidated）且 ownership 非空时才进入 teardown 清理；
// - 清理前在事务内逐字段核验已记录行的自然标记与引用，并核对「查出的 ID 集合 == 本轮记录的
//   去重 ID 集合」（任一记录在库中缺失即失败关闭），全部通过后才按实际 ID 精确删除；
// - 守卫未通过 / ownership 为空 → 零删除；事务成功提交后清空 ownership，使重复调用不再
//   开启删除事务；`app.close()` 始终在 finally 中执行。

import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AiConversationStatus } from '@app-types/models/ai-conversation.types';
import { AccountEntity } from '@src/modules/account/base/entities/account.entity';
import { UserInfoEntity } from '@src/modules/account/base/entities/user-info.entity';
import { EngineerResolutionStatus } from '@app-types/models/repair-request.types';
import { AiConversationEntity } from '@src/modules/lithography/entities/ai-conversation.entity';
import { EquipmentModelEntity } from '@src/modules/lithography/entities/equipment-model.entity';
import { EngineerResponseEntity } from '@src/modules/lithography/entities/engineer-response.entity';
import { MaintenanceReportEntity } from '@src/modules/lithography/entities/maintenance-report.entity';
import { OrganizationEntity } from '@src/modules/lithography/entities/organization.entity';
import { OrganizationMembershipEntity } from '@src/modules/lithography/entities/organization-membership.entity';
import { RepairProcessEntryEntity } from '@src/modules/lithography/entities/repair-process-entry.entity';
import { RepairRequestIntakeEntity } from '@src/modules/lithography/entities/repair-request-intake.entity';
import { RepairRequestRevisionEntity } from '@src/modules/lithography/entities/repair-request-revision.entity';
import { RepairRequestEntity } from '@src/modules/lithography/entities/repair-request.entity';
import { ApiModule } from '@src/bootstraps/api/api.module';
import { CreateAccountUsecase } from '@src/usecases/account/create-account.usecase';
import { AccountStatus, IdentityTypeEnum } from '@app-types/models/account.types';
import { App } from 'supertest/types';
import { DataSource, EntityTarget, FindOptionsWhere, In } from 'typeorm';
import { initGraphQLSchema } from '../../src/adapters/api/graphql/schema/schema.init';
import {
  assertDataSourceOnAllowedE2eDatabase,
  assertPhysicalCleanupConsent,
} from '../utils/e2e-db-guard';
import { createTestAccount } from '../utils/test-accounts';
import {
  assertNoTriggerCaseFailures,
  assertTriggerNameFormat,
  createOwnedTrigger,
  createTriggerOwnershipTracker,
  disposeOwnedTrigger,
  disposeOwnedTriggerRecord,
  readOwnedTriggerFact,
  runWithOwnedTrigger,
  type OwnedTriggerRecord,
  type TriggerOwnershipTracker,
} from '../utils/e2e-trigger-ownership';
import {
  REPAIR_REQUEST_FIXTURE_ACCOUNTS,
  REPAIR_REQUEST_FIXTURE_MARKERS,
  REPAIR_REQUEST_FIXTURE_RESPONSE_SPECS,
  cleanupRepairRequestFixtureByIds,
  cleanupRepairRequestFixtureResidue,
  createRepairRequestFixtureModel,
  createRepairRequestFixtureOwnership,
  createRepairRequestFixtureRequest,
  createRepairRequestFixtureResponse,
  runRepairRequestFixtureTeardown,
  seedRepairRequestFixtureAccounts,
  seedRepairRequestFixtureOrganizationScope,
  shouldRunRepairRequestFixtureCleanup,
  type RepairRequestFixtureAccountKey,
  type RepairRequestFixtureOwnership,
} from './repair-request-fixture';

/** 哨兵标记规格：账号 / 型号 / 申请三件套的专属自然标记（不属于夹具清理边界） */
type SentinelSpec = {
  readonly loginName: string;
  readonly loginEmail: string;
  readonly loginPassword: string;
  readonly modelCode: string;
  readonly modelName: string;
  readonly sortOrder: number;
  readonly requestNo: string;
};

/** 夹具外哨兵链（主）：独立 loginName / modelCode / requestNo，不属于专属清理边界 */
const SENTINEL: SentinelSpec = {
  loginName: 'testrrsentinelkeep',
  loginEmail: 'rr.sentinel.keep@example.com',
  loginPassword: 'RrSentinelKeep@2024',
  modelCode: 'E2E-RR-SENTINEL-MODEL',
  modelName: '哨兵型号（非夹具）',
  sortOrder: 901,
  requestNo: 'E2E-RR-SENTINEL-901',
};

/** 仅用于「部分造数失败」回归的探针标记：与主哨兵完全不重叠，用完即按记录 ID 回收 */
const PROBE_SENTINEL: SentinelSpec = {
  loginName: 'testrrsentinelprobe',
  loginEmail: 'rr.sentinel.probe@example.com',
  loginPassword: 'RrSentinelProbe@2024',
  modelCode: 'E2E-RR-SENTINEL-PROBE',
  modelName: '哨兵探针型号（非夹具）',
  sortOrder: 902,
  requestNo: 'E2E-RR-SENTINEL-902',
};

/** 全部哨兵标记的注册表：清理前的字段核验只接受注册表内的自然标记 */
const SENTINEL_SPECS: readonly SentinelSpec[] = [SENTINEL, PROBE_SENTINEL];
const SENTINEL_LOGIN_NAMES = new Set(SENTINEL_SPECS.map((spec) => spec.loginName));
const SENTINEL_MODEL_CODES = new Set(SENTINEL_SPECS.map((spec) => spec.modelCode));
const SENTINEL_REQUEST_NOS = new Set(SENTINEL_SPECS.map((spec) => spec.requestNo));

/** 哨兵所有权：只记录「本轮实际创建成功并拿到数据库主键」的行 */
type SentinelOwnership = {
  accountIds: number[];
  equipmentModelIds: number[];
  repairRequestIds: number[];
};

const createSentinelOwnership = (): SentinelOwnership => ({
  accountIds: [],
  equipmentModelIds: [],
  repairRequestIds: [],
});

const hasSentinelOwnership = (ownership: SentinelOwnership): boolean =>
  Object.values(ownership).some((ids) => ids.length > 0);

/** 事务成功提交后清空本轮记录；失败路径不调用，记录保留供诊断与重试 */
const clearSentinelOwnership = (ownership: SentinelOwnership): void => {
  ownership.accountIds.length = 0;
  ownership.equipmentModelIds.length = 0;
  ownership.repairRequestIds.length = 0;
};

/**
 * 本轮记录的去重 ID 必须与库中实际查出的 ID 集合完全一致：
 * 任一记录在数据库中已无对应行即视为归属异常，抛错使整笔事务回滚（零删除）。
 */
const assertRecordedIdsAllResolved = (
  helper: string,
  label: string,
  resolvedIds: ReadonlySet<number>,
  recordedIds: readonly number[],
): void => {
  const missing = recordedIds.filter((id) => !resolvedIds.has(id));
  if (missing.length > 0 || resolvedIds.size !== recordedIds.length) {
    throw ownershipRejection(
      helper,
      `${label}记录 ID 与查出 ID 不一致（记录=${recordedIds.join(',') || '空'}，查出=${
        [...resolvedIds].join(',') || '空'
      }，缺失=${missing.join(',') || '空'}）`,
    );
  }
};

const ownershipRejection = (helper: string, detail: string): Error =>
  new Error(`[${helper}] 阶段=归属校验 拒绝删除：${detail}`);

describe('维修申请夹具所有权（真实隔离库）', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let createAccountUsecase: CreateAccountUsecase;
  /** 主哨兵链的实际 ID 与所有权（供快照比对与 afterAll 精确回收） */
  let sentinelAccountId: number;
  let sentinelModelId: number;
  let sentinelRequestId: number;
  const sentinelOwnership = createSentinelOwnership();
  /** 探针哨兵所有权：即使用例中途失败，afterAll 也按已记录 ID 回收 */
  const probeOwnership = createSentinelOwnership();
  /** 只有目标库白名单守卫通过后才置为 true，teardown 以此为准入门控 */
  let fixtureTargetValidated = false;

  beforeAll(async () => {
    initGraphQLSchema();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ApiModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    dataSource = moduleFixture.get(DataSource);
    createAccountUsecase = app.get(CreateAccountUsecase);

    await assertDataSourceOnAllowedE2eDatabase(dataSource);
    fixtureTargetValidated = true;
    await cleanupRepairRequestFixtureResidue(dataSource);

    // 哨兵链：夹具外无关数据（账号 + 型号 + 引用二者的申请）
    const chain = await seedSentinelChain(SENTINEL, sentinelOwnership);
    sentinelAccountId = chain.accountId;
    sentinelModelId = chain.modelId;
    sentinelRequestId = chain.requestId;
  });

  afterAll(async () => {
    // fail-closed 收尾：守卫未通过 / ownership 为空 → 零删除；app.close 始终在 finally 执行
    await runRepairRequestFixtureTeardown({
      app,
      dataSource,
      targetValidated: fixtureTargetValidated,
      cleanup: async () => {
        await cleanupSentinelByIds(sentinelOwnership);
        await cleanupSentinelByIds(probeOwnership);
      },
    });
  });

  const readSentinelSnapshot = async (): Promise<{
    account: AccountEntity | null;
    userInfo: UserInfoEntity | null;
    model: EquipmentModelEntity | null;
    request: RepairRequestEntity | null;
  }> => {
    const account = await dataSource
      .getRepository(AccountEntity)
      .findOne({ where: { id: sentinelAccountId } });
    const userInfo = await dataSource
      .getRepository(UserInfoEntity)
      .findOne({ where: { accountId: sentinelAccountId } });
    const model = await dataSource
      .getRepository(EquipmentModelEntity)
      .findOne({ where: { id: sentinelModelId } });
    const request = await dataSource
      .getRepository(RepairRequestEntity)
      .findOne({ where: { requestNo: SENTINEL.requestNo } });
    return { account, userInfo, model, request };
  };

  const countFixtureAccounts = async (): Promise<number> =>
    dataSource.getRepository(AccountEntity).count({
      where: {
        loginName: In(Object.values(REPAIR_REQUEST_FIXTURE_ACCOUNTS).map((row) => row.loginName)),
      },
    });

  const countFixtureRequests = async (): Promise<number> =>
    dataSource.getRepository(RepairRequestEntity).count({
      where: {
        requestNo: In([
          ...REPAIR_REQUEST_FIXTURE_MARKERS.readRequestNos,
          ...REPAIR_REQUEST_FIXTURE_MARKERS.acceptRequestNos,
        ]),
      },
    });

  /** 挂在夹具申请下的工程师回复行数（用于核验「零删除」与「已清理」） */
  const countFixtureResponses = async (): Promise<number> => {
    const parents = await dataSource.getRepository(RepairRequestEntity).find({
      where: {
        requestNo: In([
          ...REPAIR_REQUEST_FIXTURE_MARKERS.readRequestNos,
          ...REPAIR_REQUEST_FIXTURE_MARKERS.acceptRequestNos,
        ]),
      },
      select: { id: true },
    });
    if (parents.length === 0) {
      return 0;
    }
    return dataSource
      .getRepository(EngineerResponseEntity)
      .count({ where: { requestId: In(parents.map((row) => row.id)) } });
  };

  it('无残留时清理为 no-op（连跑两遍幂等），哨兵链完全不变', async () => {
    const before = await readSentinelSnapshot();

    const first = await cleanupRepairRequestFixtureResidue(dataSource);
    const second = await cleanupRepairRequestFixtureResidue(dataSource);

    // 无残留：验证结果为空集合
    expect(first).toEqual({
      accountIds: [],
      organizationIds: [],
      membershipIds: [],
      equipmentModelIds: [],
      repairRequestIds: [],
      engineerResponseIds: [],
    });
    expect(second).toEqual(first);
    expect(await countFixtureAccounts()).toBe(0);
    expect(await countFixtureRequests()).toBe(0);
    // 哨兵链逐字段一致（ID、字段、行数未变）
    expect(await readSentinelSnapshot()).toEqual(before);
  });

  it('崩溃残留恢复：按专属标记精确回收本轮夹具，哨兵链不受影响', async () => {
    const before = await readSentinelSnapshot();
    const ownership = createRepairRequestFixtureOwnership();
    const accounts = await seedEngineerAccount(ownership);
    const modelId = await createRepairRequestFixtureModel({
      dataSource,
      ownership,
      key: 'read',
    });
    await createRepairRequestFixtureRequest({
      dataSource,
      ownership,
      seed: {
        requestNo: REPAIR_REQUEST_FIXTURE_MARKERS.readRequestNos[0],
        customerAccountId: accounts,
        equipmentModelId: modelId,
        errorCode: 'E-1001',
        faultDescription: '未接单场景',
        contentMd: '# E2E-RR-111',
        createdAt: new Date('2026-08-25T01:00:00.000Z'),
        isAccepted: false,
        acceptedByEngineerAccountId: null,
        acceptedAt: null,
        deprecated: false,
        deletedAt: null,
      },
    });
    expect(await countFixtureAccounts()).toBe(1);
    expect(await countFixtureRequests()).toBe(1);

    // 模拟崩溃：不持有本轮 ownership，仅按专属标记恢复残留
    const recovered = await cleanupRepairRequestFixtureResidue(dataSource);

    expect(recovered.accountIds).toEqual(ownership.accountIds);
    expect(recovered.equipmentModelIds).toEqual(ownership.equipmentModelIds);
    expect(recovered.repairRequestIds).toEqual(ownership.repairRequestIds);
    expect(await countFixtureAccounts()).toBe(0);
    expect(await countFixtureRequests()).toBe(0);
    // 再次运行 no-op（幂等）
    const again = await cleanupRepairRequestFixtureResidue(dataSource);
    expect(again.repairRequestIds).toEqual([]);
    expect(await readSentinelSnapshot()).toEqual(before);
  });

  it('部分造数失败：只回收已成功创建且已验证归属的记录', async () => {
    const before = await readSentinelSnapshot();
    const ownership = createRepairRequestFixtureOwnership();
    const accountId = await seedEngineerAccount(ownership);
    expect(ownership.accountIds).toEqual([accountId]);

    // 故意以不存在的客户账号造申请 → FK 失败；申请未被记录，账号已记录
    await expect(
      createRepairRequestFixtureRequest({
        dataSource,
        ownership,
        seed: {
          requestNo: REPAIR_REQUEST_FIXTURE_MARKERS.acceptRequestNos[0],
          customerAccountId: 999999999,
          equipmentModelId: sentinelModelId,
          errorCode: 'E-3001',
          faultDescription: '接单成功场景',
          contentMd: '# E2E-AC-131',
          createdAt: new Date('2026-08-30T01:00:00.000Z'),
          isAccepted: false,
          acceptedByEngineerAccountId: null,
          acceptedAt: null,
          deprecated: false,
          deletedAt: null,
        },
      }),
    ).rejects.toThrow();

    expect(ownership.repairRequestIds).toEqual([]);
    expect(await countFixtureRequests()).toBe(0);

    // 只按已记录 ID 回收（账号），申请不存在也不报错
    await cleanupRepairRequestFixtureByIds(dataSource, ownership);
    expect(ownership.accountIds).toEqual([accountId]);
    expect(await countFixtureAccounts()).toBe(0);
    expect(await readSentinelSnapshot()).toEqual(before);
  });

  it('外部申请引用夹具账号（非夹具 requestNo）时失败关闭，绝不误删夹具账号', async () => {
    const before = await readSentinelSnapshot();
    const ownership = createRepairRequestFixtureOwnership();
    const accountId = await seedEngineerAccount(ownership);

    // 外部申请：requestNo 不属于本夹具，却引用了夹具账号 → 归属校验必须失败关闭
    const requestRepo = dataSource.getRepository(RepairRequestEntity);
    /** 本轮自建的外部行 ID：直接删除前必须命中本集合 */
    const externalRequestIds: number[] = [];
    const foreign = await requestRepo.save(
      requestRepo.create({
        requestNo: 'E2E-RR-FOREIGN-901',
        customerAccountId: accountId,
        equipmentModelId: sentinelModelId,
        errorCode: 'E-FOREIGN',
        faultDescription: '外部申请引用夹具账号',
        contentMd: '# FOREIGN-901',
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
        isAccepted: false,
        acceptedByEngineerAccountId: null,
        acceptedAt: null,
        deprecated: false,
        deletedAt: null,
      }),
    );
    externalRequestIds.push(foreign.id);

    await expect(cleanupRepairRequestFixtureResidue(dataSource)).rejects.toThrow(/归属校验/);
    // 失败关闭：夹具账号仍在（未被误删）
    expect(await countFixtureAccounts()).toBe(1);

    // 收尾：先核验并删除本 spec 自建的外部申请，再按记录 ID 回收夹具账号
    await deleteRecordedExternalRow({
      helper: '外部申请收尾',
      entity: RepairRequestEntity,
      recordedIds: externalRequestIds,
      id: foreign.id,
      verify: (row) =>
        row.requestNo === 'E2E-RR-FOREIGN-901' &&
        row.errorCode === 'E-FOREIGN' &&
        row.contentMd === '# FOREIGN-901' &&
        row.customerAccountId === accountId &&
        row.equipmentModelId === sentinelModelId,
    });
    await cleanupRepairRequestFixtureByIds(dataSource, ownership);
    expect(await countFixtureAccounts()).toBe(0);
    expect(await readSentinelSnapshot()).toEqual(before);
  });

  it('外部账号持有夹具组织有效成员关系：失败关闭，夹具与外部成员关系零删除', async () => {
    const before = await readSentinelSnapshot();
    // 外部账号复用哨兵注册表（收尾同样走 fail-closed 清理入口），造数前确认标记空闲
    await assertSentinelMarkersFree(PROBE_SENTINEL);
    const fixtureOwnership = createRepairRequestFixtureOwnership();
    const externalMembershipIds: number[] = [];
    let externalAccountId: number | undefined;
    let primaryOrganizationId: number | undefined;

    try {
      const fixtureAccountId = await seedEngineerAccount(fixtureOwnership);
      const scope = await seedRepairRequestFixtureOrganizationScope({
        dataSource,
        ownership: fixtureOwnership,
        accountIds: { engineerA: fixtureAccountId },
      });
      primaryOrganizationId = scope.primaryOrganizationId;

      // 外部账号（非夹具账号）挂到夹具主组织 → 成员关系双侧闭包被打破，必须在删除前失败关闭
      externalAccountId = await createSentinelAccount(PROBE_SENTINEL, probeOwnership);
      const membershipRepo = dataSource.getRepository(OrganizationMembershipEntity);
      const membership = await membershipRepo.save(
        membershipRepo.create({
          organizationId: primaryOrganizationId,
          accountId: externalAccountId,
          memberRole: 'CUSTOMER',
          status: 'ACTIVE',
          leftAt: null,
        }),
      );
      externalMembershipIds.push(membership.id);

      await expect(cleanupRepairRequestFixtureResidue(dataSource)).rejects.toThrow(/归属校验/);
      // 失败关闭：夹具账号与外部成员关系都未被删除
      expect(await countFixtureAccounts()).toBe(1);
      expect(await membershipRepo.count({ where: { id: In(externalMembershipIds) } })).toBe(1);
    } finally {
      // 受保护收尾：先删外部成员关系（FK RESTRICT），再回收夹具，最后按哨兵记录回收账号
      const membershipRepo = dataSource.getRepository(OrganizationMembershipEntity);
      for (const id of externalMembershipIds) {
        const row = await membershipRepo.findOne({ where: { id } });
        if (row) {
          await deleteRecordedExternalRow({
            helper: '外部成员关系收尾',
            entity: OrganizationMembershipEntity,
            recordedIds: externalMembershipIds,
            id,
            verify: (candidate) =>
              candidate.accountId === externalAccountId &&
              candidate.organizationId === primaryOrganizationId &&
              candidate.memberRole === 'CUSTOMER' &&
              candidate.status === 'ACTIVE',
          });
        }
      }
      await cleanupRepairRequestFixtureByIds(dataSource, fixtureOwnership);
      await cleanupSentinelByIds(probeOwnership);
    }

    expect(await countFixtureAccounts()).toBe(0);
    expect(await countSentinelRows(PROBE_SENTINEL)).toEqual({
      accounts: 0,
      models: 0,
      requests: 0,
    });
    expect(await readSentinelSnapshot()).toEqual(before);
  });

  it('入向引用（残留入口）：AI 会话与维护报告引用夹具行时失败关闭，DELETE=0 且逐字段不变', async () => {
    const before = await readSentinelSnapshot();
    const ownership = createRepairRequestFixtureOwnership();
    /** 外部行只在本轮创建成功后登记，finally 收尾时按已记录 ID 核验删除 */
    let external: {
      conversationId: number;
      reportId: number;
      requestId: number;
      engineerId: number;
      modelId: number;
      organizationId: number;
    } | null = null;
    let fixtureBefore: Awaited<ReturnType<typeof readFixtureSnapshot>> | undefined;
    let conversationBefore: AiConversationEntity | null;
    let reportBefore: MaintenanceReportEntity | null;

    try {
      const engineerId = await seedEngineerAccount(ownership, 'engineerA');
      const customerId = await seedEngineerAccount(ownership, 'customerA');
      const scope = await seedRepairRequestFixtureOrganizationScope({
        dataSource,
        ownership,
        accountIds: { engineerA: engineerId },
      });
      const modelId = await createRepairRequestFixtureModel({ dataSource, ownership, key: 'read' });
      const requestId = await createRepairRequestFixtureRequest({
        dataSource,
        ownership,
        seed: {
          requestNo: REPAIR_REQUEST_FIXTURE_MARKERS.readRequestNos[0],
          customerAccountId: customerId,
          equipmentModelId: modelId,
          errorCode: 'E-1001',
          faultDescription: '未接单场景',
          contentMd: '# E2E-RR-111',
          createdAt: new Date('2026-08-25T01:00:00.000Z'),
          isAccepted: false,
          acceptedByEngineerAccountId: null,
          acceptedAt: null,
          deprecated: false,
          deletedAt: null,
        },
      });
      fixtureBefore = await readFixtureSnapshot(ownership);
      expect(fixtureBefore.accounts).toHaveLength(2);

      // 外部 AI 会话引用夹具申请与夹具工程师账号（request_id / engineer_account_id）
      const conversationRepo = dataSource.getRepository(AiConversationEntity);
      const conversation = await conversationRepo.save(
        conversationRepo.create({
          requestId,
          engineerAccountId: engineerId,
          status: AiConversationStatus.ACTIVE,
          aiFeedback: null,
          completedAt: null,
        }),
      );

      // 外部维护报告同时引用夹具组织 / 申请 / 型号 / 工程师与创建/修改人账号
      const reportRepo = dataSource.getRepository(MaintenanceReportEntity);
      const report = await reportRepo.save(
        reportRepo.create({
          ownerOrganizationId: scope.primaryOrganizationId,
          sourceType: 'WORK_ORDER_SUMMARY',
          repairRequestId: requestId,
          equipmentModelId: modelId,
          maintenanceEngineerAccountId: engineerId,
          maintenanceEngineerNameSnapshot: '夹具工程师A',
          createdByAccountId: engineerId,
          updatedByAccountId: engineerId,
        }),
      );

      external = {
        conversationId: conversation.id,
        reportId: report.id,
        requestId,
        engineerId,
        modelId,
        organizationId: scope.primaryOrganizationId,
      };
      conversationBefore = await readAiConversation(conversation.id);
      reportBefore = await readMaintenanceReport(report.id);

      // 集合外引用直接拒绝：既不认领也不删除这些外部行
      await expect(cleanupRepairRequestFixtureResidue(dataSource)).rejects.toThrow(/归属校验/);

      // DELETE=0：夹具行与两行外部记录逐字段不变（含主键、引用列与时间列）
      expect(fixtureBefore).toBeDefined();
      expect(await readFixtureSnapshot(ownership)).toEqual(fixtureBefore);
      expect(await readAiConversation(conversation.id)).toEqual(conversationBefore);
      expect(await readMaintenanceReport(report.id)).toEqual(reportBefore);
    } finally {
      if (external) {
        const e = external;
        await deleteRecordedExternalRow({
          helper: '外部AI会话收尾',
          entity: AiConversationEntity,
          recordedIds: [e.conversationId],
          id: e.conversationId,
          verify: (row) =>
            row.requestId === e.requestId &&
            row.engineerAccountId === e.engineerId &&
            row.status === AiConversationStatus.ACTIVE &&
            row.aiFeedback === null &&
            row.completedAt === null,
        });
        await deleteRecordedExternalRow({
          helper: '外部维护报告收尾',
          entity: MaintenanceReportEntity,
          recordedIds: [e.reportId],
          id: e.reportId,
          verify: (row) =>
            row.ownerOrganizationId === e.organizationId &&
            row.repairRequestId === e.requestId &&
            row.equipmentModelId === e.modelId &&
            row.maintenanceEngineerAccountId === e.engineerId &&
            row.createdByAccountId === e.engineerId &&
            row.updatedByAccountId === e.engineerId,
        });
      }
      await cleanupRepairRequestFixtureByIds(dataSource, ownership);
    }

    expect(await countFixtureAccounts()).toBe(0);
    expect(await countFixtureRequests()).toBe(0);
    expect(await readSentinelSnapshot()).toEqual(before);
  });

  it('入向引用（按 ID 入口）：外部 AI 会话引用夹具申请时失败关闭，DELETE=0 且逐字段不变', async () => {
    const before = await readSentinelSnapshot();
    const ownership = createRepairRequestFixtureOwnership();
    let external: { conversationId: number; requestId: number; engineerId: number } | null = null;
    let fixtureBefore: Awaited<ReturnType<typeof readFixtureSnapshot>> | undefined;
    let conversationBefore: AiConversationEntity | null;

    try {
      const engineerId = await seedEngineerAccount(ownership, 'engineerA');
      const customerId = await seedEngineerAccount(ownership, 'customerA');
      const modelId = await createRepairRequestFixtureModel({ dataSource, ownership, key: 'read' });
      const requestId = await createRepairRequestFixtureRequest({
        dataSource,
        ownership,
        seed: {
          requestNo: REPAIR_REQUEST_FIXTURE_MARKERS.readRequestNos[0],
          customerAccountId: customerId,
          equipmentModelId: modelId,
          errorCode: 'E-1001',
          faultDescription: '未接单场景',
          contentMd: '# E2E-RR-111',
          createdAt: new Date('2026-08-25T01:00:00.000Z'),
          isAccepted: false,
          acceptedByEngineerAccountId: null,
          acceptedAt: null,
          deprecated: false,
          deletedAt: null,
        },
      });
      fixtureBefore = await readFixtureSnapshot(ownership);

      const conversationRepo = dataSource.getRepository(AiConversationEntity);
      const conversation = await conversationRepo.save(
        conversationRepo.create({
          requestId,
          engineerAccountId: engineerId,
          status: AiConversationStatus.ACTIVE,
          aiFeedback: null,
          completedAt: null,
        }),
      );
      external = { conversationId: conversation.id, requestId, engineerId };
      conversationBefore = await readAiConversation(conversation.id);

      // 按 ID 入口只接受运行时记录 ID，但同样必须核验完整图与入向引用后零删除
      await expect(cleanupRepairRequestFixtureByIds(dataSource, ownership)).rejects.toThrow(
        /归属校验/,
      );

      expect(fixtureBefore).toBeDefined();
      expect(await readFixtureSnapshot(ownership)).toEqual(fixtureBefore);
      expect(await readAiConversation(conversation.id)).toEqual(conversationBefore);
    } finally {
      if (external) {
        const e = external;
        await deleteRecordedExternalRow({
          helper: '外部AI会话收尾（按 ID 入口）',
          entity: AiConversationEntity,
          recordedIds: [e.conversationId],
          id: e.conversationId,
          verify: (row) =>
            row.requestId === e.requestId &&
            row.engineerAccountId === e.engineerId &&
            row.status === AiConversationStatus.ACTIVE &&
            row.aiFeedback === null &&
            row.completedAt === null,
        });
      }
      await cleanupRepairRequestFixtureByIds(dataSource, ownership);
    }

    expect(await countFixtureAccounts()).toBe(0);
    expect(await countFixtureRequests()).toBe(0);
    expect(await readSentinelSnapshot()).toEqual(before);
  });

  it('未登记子行（两个入口）：intake / process / revision 引用夹具图时失败关闭，零删除且无关数据不变', async () => {
    const before = await readSentinelSnapshot();
    const ownership = createRepairRequestFixtureOwnership();
    let external: {
      intakeId: number;
      processId: number | string;
      revisionId: number | string;
      requestId: number;
      engineerId: number;
      customerId: number;
      modelId: number;
      primaryOrganizationId: number;
      peerOrganizationId: number;
    } | null = null;
    let fixtureBefore: Awaited<ReturnType<typeof readFixtureSnapshot>> | undefined;

    try {
      const engineerId = await seedEngineerAccount(ownership, 'engineerA');
      const customerId = await seedEngineerAccount(ownership, 'customerA');
      const scope = await seedRepairRequestFixtureOrganizationScope({
        dataSource,
        ownership,
        accountIds: { engineerA: engineerId },
      });
      const modelId = await createRepairRequestFixtureModel({ dataSource, ownership, key: 'read' });
      const requestId = await createRepairRequestFixtureRequest({
        dataSource,
        ownership,
        seed: {
          requestNo: REPAIR_REQUEST_FIXTURE_MARKERS.readRequestNos[0],
          customerAccountId: customerId,
          equipmentModelId: modelId,
          errorCode: 'E-1001',
          faultDescription: '未接单场景',
          contentMd: '# E2E-RR-111',
          createdAt: new Date('2026-08-25T01:00:00.000Z'),
          isAccepted: false,
          acceptedByEngineerAccountId: null,
          acceptedAt: null,
          deprecated: false,
          deletedAt: null,
        },
      });
      fixtureBefore = await readFixtureSnapshot(ownership);

      const intakeRepo = dataSource.getRepository(RepairRequestIntakeEntity);
      const intake = await intakeRepo.save(
        intakeRepo.create({
          recordUuid: randomUUID(),
          customerAccountId: customerId,
          customerOrganizationId: scope.primaryOrganizationId,
          serviceOrganizationId: scope.peerOrganizationId,
          equipmentModelId: modelId,
          errorCode: 'E-INTAKE',
          faultDescription: '未登记的报修原始输入',
          fileId: null,
          analysisStatus: 'COMPLETED',
          convertedRequestId: requestId,
          deletedAt: null,
        }),
      );
      const processRepo = dataSource.getRepository(RepairProcessEntryEntity);
      const processEntry = await processRepo.save(
        processRepo.create({
          entryUuid: randomUUID(),
          requestId,
          authorAccountId: engineerId,
          operationText: '未登记的维修过程',
          testResult: null,
          occurredAt: null,
          timeSource: 'MANUAL',
          fileId: null,
          versionNo: 1,
        }),
      );
      const revisionRepo = dataSource.getRepository(RepairRequestRevisionEntity);
      const revision = await revisionRepo.save(
        revisionRepo.create({
          requestId,
          revisionNo: 1,
          beforeSnapshot: JSON.stringify({ schema_version: 1 }),
          afterSnapshot: JSON.stringify({ schema_version: 1 }),
          schemaVersion: 1,
          actorAccountId: engineerId,
          reason: '未登记的管理修订',
        }),
      );
      external = {
        intakeId: intake.id,
        processId: processEntry.id,
        revisionId: revision.id,
        requestId,
        engineerId,
        customerId,
        modelId,
        primaryOrganizationId: scope.primaryOrganizationId,
        peerOrganizationId: scope.peerOrganizationId,
      };

      await expect(cleanupRepairRequestFixtureResidue(dataSource)).rejects.toThrow(/归属校验/);
      expect(await readFixtureSnapshot(ownership)).toEqual(fixtureBefore);
      await expect(cleanupRepairRequestFixtureByIds(dataSource, ownership)).rejects.toThrow(
        /归属校验/,
      );
      expect(await readFixtureSnapshot(ownership)).toEqual(fixtureBefore);
      expect(await readSentinelSnapshot()).toEqual(before);
    } finally {
      if (external) {
        const e = external;
        await deleteRecordedExternalRow({
          helper: '未登记修订收尾',
          entity: RepairRequestRevisionEntity,
          recordedIds: [e.revisionId],
          id: e.revisionId,
          verify: (row) =>
            row.requestId === e.requestId &&
            row.revisionNo === 1 &&
            row.actorAccountId === e.engineerId &&
            row.reason === '未登记的管理修订',
        });
        await deleteRecordedExternalRow({
          helper: '未登记过程收尾',
          entity: RepairProcessEntryEntity,
          recordedIds: [e.processId],
          id: e.processId,
          verify: (row) =>
            row.requestId === e.requestId &&
            row.authorAccountId === e.engineerId &&
            row.operationText === '未登记的维修过程' &&
            row.versionNo === 1,
        });
        await deleteRecordedExternalRow({
          helper: '未登记报修输入收尾',
          entity: RepairRequestIntakeEntity,
          recordedIds: [e.intakeId],
          id: e.intakeId,
          verify: (row) =>
            row.convertedRequestId === e.requestId &&
            row.customerAccountId === e.customerId &&
            row.equipmentModelId === e.modelId &&
            row.customerOrganizationId === e.primaryOrganizationId &&
            row.serviceOrganizationId === e.peerOrganizationId,
        });
      }
      await cleanupRepairRequestFixtureByIds(dataSource, ownership);
    }

    expect(await countFixtureAccounts()).toBe(0);
    expect(await countFixtureRequests()).toBe(0);
    expect(await readSentinelSnapshot()).toEqual(before);
  });

  it('重复执行（按 ID 入口）：首次合法清理成功后第二次拒绝且零删除，无关数据不变', async () => {
    const before = await readSentinelSnapshot();
    const ownership = createRepairRequestFixtureOwnership();

    const engineerId = await seedEngineerAccount(ownership, 'engineerA');
    const customerId = await seedEngineerAccount(ownership, 'customerA');
    await seedRepairRequestFixtureOrganizationScope({
      dataSource,
      ownership,
      accountIds: { engineerA: engineerId },
    });
    const modelId = await createRepairRequestFixtureModel({ dataSource, ownership, key: 'read' });
    await createRepairRequestFixtureRequest({
      dataSource,
      ownership,
      seed: {
        requestNo: REPAIR_REQUEST_FIXTURE_MARKERS.readRequestNos[0],
        customerAccountId: customerId,
        equipmentModelId: modelId,
        errorCode: 'E-1001',
        faultDescription: '未接单场景',
        contentMd: '# E2E-RR-111',
        createdAt: new Date('2026-08-25T01:00:00.000Z'),
        isAccepted: false,
        acceptedByEngineerAccountId: null,
        acceptedAt: null,
        deprecated: false,
        deletedAt: null,
      },
    });

    await cleanupRepairRequestFixtureByIds(dataSource, ownership);
    expect(await countFixtureAccounts()).toBe(0);
    expect(await countFixtureRequests()).toBe(0);
    expect(await readSentinelSnapshot()).toEqual(before);

    // 记录仍在调用方手中，但库中目标已被首次清理：第二次必须失败关闭，不能静默 no-op 或误删。
    await expect(cleanupRepairRequestFixtureByIds(dataSource, ownership)).rejects.toThrow(
      /归属校验/,
    );
    expect(await readSentinelSnapshot()).toEqual(before);
  });

  it('事实漂移（按 ID 入口）：记录主键在库中缺失时拒绝，不认领且零删除', async () => {
    const ownership = createRepairRequestFixtureOwnership();
    const accountId = await seedEngineerAccount(ownership, 'engineerA');
    const missingId = 2_000_000_000;
    ownership.accountIds.push(missingId);

    try {
      await expect(cleanupRepairRequestFixtureByIds(dataSource, ownership)).rejects.toThrow(
        /在库中不存在/,
      );
      expect(
        await dataSource.getRepository(AccountEntity).count({ where: { id: accountId } }),
      ).toBe(1);
    } finally {
      ownership.accountIds.splice(ownership.accountIds.indexOf(missingId), 1);
      await cleanupRepairRequestFixtureByIds(dataSource, ownership);
    }

    expect(await countFixtureAccounts()).toBe(0);
  });

  it('后序删除失败：残留与按 ID 两个入口都整批回滚，夹具逐字段不变且本轮触发器零残留', async () => {
    const before = await readSentinelSnapshot();
    const ownership = createRepairRequestFixtureOwnership();
    const triggerName = nextTriggerName('rollback');
    const tracker = createTriggerOwnershipTracker();
    let fixtureBefore: Awaited<ReturnType<typeof readFixtureSnapshot>> | undefined;

    const failures = await runWithOwnedTrigger({
      dataSource,
      triggerName,
      tableName: ROLLBACK_TRIGGER_TABLE,
      body: ROLLBACK_TRIGGER_BODY,
      setup: async () => {
        await seedEngineerAccount(ownership, 'engineerA');
        const customerId = await seedEngineerAccount(ownership, 'customerA');
        const modelId = await createRepairRequestFixtureModel({
          dataSource,
          ownership,
          key: 'read',
        });
        await createRepairRequestFixtureRequest({
          dataSource,
          ownership,
          seed: {
            requestNo: REPAIR_REQUEST_FIXTURE_MARKERS.readRequestNos[0],
            customerAccountId: customerId,
            equipmentModelId: modelId,
            errorCode: 'E-1001',
            faultDescription: '未接单场景',
            contentMd: '# E2E-RR-111',
            createdAt: new Date('2026-08-25T01:00:00.000Z'),
            isAccepted: false,
            acceptedByEngineerAccountId: null,
            acceptedAt: null,
            deprecated: false,
            deletedAt: null,
          },
        });
        expect(ownership.repairRequestIds).toHaveLength(1);
        fixtureBefore = await readFixtureSnapshot(ownership);
      },
      run: async () => {
        // 注入确定性后序失败：删除顺序中申请 / 型号已在 user_info 之前执行，
        // 失败时必须整批回滚，不能留下「父行已删、账号仍在」的半清理状态。
        await expect(cleanupRepairRequestFixtureResidue(dataSource)).rejects.toThrow();
        expect(await readFixtureSnapshot(ownership)).toEqual(fixtureBefore);

        await expect(cleanupRepairRequestFixtureByIds(dataSource, ownership)).rejects.toThrow();
        expect(await readFixtureSnapshot(ownership)).toEqual(fixtureBefore);
      },
      cleanupFixture: () => cleanupRepairRequestFixtureByIds(dataSource, ownership),
      tracker,
    });
    assertNoTriggerCaseFailures(failures, '后序删除失败回滚');

    expect(await readOwnedTriggerFact(dataSource, triggerName)).toBeNull();
    expect(await countFixtureAccounts()).toBe(0);
    expect(await countFixtureRequests()).toBe(0);
    expect(await readSentinelSnapshot()).toEqual(before);
  });

  it('触发器同名碰撞：创建前失败关闭，外部同名对象定义完全不变', async () => {
    const triggerName = nextTriggerName('collision');
    const tracker = createTriggerOwnershipTracker();
    const externalBody = 'SET @e2e_external_trigger_marker = 1';
    await assertDirectDeleteTarget('triggerCollision');

    // CREATE 之前进入保护：外部对象同样走统一 helper 登记，不保留裸 CREATE 通道
    try {
      const external = await createOwnedTrigger({
        dataSource,
        name: triggerName,
        tableName: ROLLBACK_TRIGGER_TABLE,
        body: externalBody,
        tracker,
      });
      // CREATE 后的回读与断言全部位于保护范围内
      expect(await readOwnedTriggerFact(dataSource, triggerName)).toEqual(external);

      await expect(
        createOwnedTrigger({
          dataSource,
          name: triggerName,
          tableName: ROLLBACK_TRIGGER_TABLE,
          body: ROLLBACK_TRIGGER_BODY,
          tracker,
        }),
      ).rejects.toThrow(/同名预检/);
      // 外部同名对象的表与定义均未被覆盖
      expect(await readOwnedTriggerFact(dataSource, triggerName)).toEqual(external);
    } finally {
      // 按登记时的原始创建事实收尾，不按当前查询结果重新认领
      for (const record of [...tracker.remaining()]) {
        await disposeOwnedTriggerRecord(dataSource, record, tracker);
      }
    }

    expect(tracker.remaining()).toEqual([]);
    expect(await readOwnedTriggerFact(dataSource, triggerName)).toBeNull();
  });

  it('触发器首次创建后回读失败：原始错误保留，finally 仍按登记事实精确收尾', async () => {
    const triggerName = nextTriggerName('createReadbackFail');
    const tracker = createTriggerOwnershipTracker();
    const externalBody = 'SET @e2e_external_trigger_marker = 1';
    // 放行同名预检，CREATE 成功后回读抛错
    const flaky = createMetadataReadbackFailingDataSource(dataSource, 1);
    await assertDirectDeleteTarget('triggerReadbackFail');

    try {
      await expect(
        createOwnedTrigger({
          dataSource: flaky,
          name: triggerName,
          tableName: ROLLBACK_TRIGGER_TABLE,
          body: externalBody,
          tracker,
        }),
      ).rejects.toThrow('模拟触发器元数据回读失败');
      // CREATE 成功即登记：回读失败不丢记录，且 fact 保持待核验
      expect(tracker.records()).toHaveLength(1);
      expect(tracker.records()[0].body).toBe(externalBody);
      expect(tracker.records()[0].fact).toBeNull();
    } finally {
      for (const record of [...tracker.remaining()]) {
        await disposeOwnedTriggerRecord(dataSource, record, tracker);
      }
    }

    expect(tracker.remaining()).toEqual([]);
    expect(await readOwnedTriggerFact(dataSource, triggerName)).toBeNull();
  });

  it('触发器创建失败：失败关闭且该名称零残留', async () => {
    const triggerName = nextTriggerName('createfail');
    const tracker = createTriggerOwnershipTracker();
    // CREATE 之前就进入保护：即使创建路径异常返回，也按 tracker 收尾
    try {
      await expect(
        createOwnedTrigger({
          dataSource,
          name: triggerName,
          tableName: 'base_not_exists_e2e_trigger',
          body: ROLLBACK_TRIGGER_BODY,
          tracker,
        }),
      ).rejects.toThrow();
      // CREATE 未成功 → 不产生登记记录，也没有对象可收尾
      expect(tracker.records()).toEqual([]);
    } finally {
      for (const record of [...tracker.remaining()]) {
        await disposeOwnedTriggerRecord(dataSource, record, tracker);
      }
    }
    expect(tracker.remaining()).toEqual([]);
    expect(await readOwnedTriggerFact(dataSource, triggerName)).toBeNull();
  });

  it('触发器安装后中途断言失败：本轮触发器仍被精确收尾，夹具清理错误独立保留', async () => {
    const before = await readSentinelSnapshot();
    const ownership = createRepairRequestFixtureOwnership();
    const triggerName = nextTriggerName('midassert');
    const tracker = createTriggerOwnershipTracker();

    const failures = await runWithOwnedTrigger({
      dataSource,
      triggerName,
      tableName: ROLLBACK_TRIGGER_TABLE,
      body: ROLLBACK_TRIGGER_BODY,
      setup: async () => {
        await seedEngineerAccount(ownership, 'engineerA');
      },
      run: () => Promise.reject(new Error('模拟中途断言失败')),
      cleanupFixture: () => cleanupRepairRequestFixtureByIds(dataSource, ownership),
      tracker,
    });

    // 主错误与其它阶段分别保留：只有主错误，没有触发器收尾 / 夹具清理错误
    expect(failures).toHaveLength(1);
    expect(failures[0].stage).toBe('主错误');
    expect(await readOwnedTriggerFact(dataSource, triggerName)).toBeNull();
    expect(await countFixtureAccounts()).toBe(0);
    expect(await readSentinelSnapshot()).toEqual(before);
  });

  it('触发器收尾失败：错误被单独保留，重试后本轮对象零残留', async () => {
    const triggerName = nextTriggerName('cleanupfail');
    // 从 CREATE 之前就建立 tracker 并进入 try/finally：创建未正常返回也执行受保护收尾
    const tracker = createTriggerOwnershipTracker();
    let owned: Awaited<ReturnType<typeof createOwnedTrigger>> | undefined;
    try {
      owned = await createOwnedTrigger({
        dataSource,
        name: triggerName,
        tableName: ROLLBACK_TRIGGER_TABLE,
        body: ROLLBACK_TRIGGER_BODY,
        tracker,
      });
      // 收尾替身：只让 DROP TRIGGER 失败，其余查询仍走真实连接
      const failingDataSource = {
        options: dataSource.options,
        query: (sql: string, parameters?: unknown[]): Promise<unknown> => {
          if (sql.startsWith('DROP TRIGGER')) {
            return Promise.reject(new Error('注入故障：触发器 DROP 失败'));
          }
          return dataSource.query(sql, parameters);
        },
      } as unknown as DataSource;

      await expect(disposeOwnedTrigger(failingDataSource, owned, tracker)).rejects.toThrow(
        /注入故障：触发器 DROP 失败/,
      );
      // 收尾失败后本轮对象仍在，不能被错误地视为已清理
      expect(tracker.remaining().map((record) => record.name)).toEqual([triggerName]);
      expect(await readOwnedTriggerFact(dataSource, triggerName)).toEqual(owned);
    } finally {
      // 故障用例的最终收尾不依赖断言成功：按登记记录走受保护收尾
      for (const record of [...tracker.remaining()]) {
        await disposeOwnedTriggerRecord(dataSource, record, tracker);
      }
    }
    expect(tracker.remaining()).toEqual([]);
    expect(await readOwnedTriggerFact(dataSource, triggerName)).toBeNull();
  });

  it('直接入口：缺少 tracker → CREATE 前拒绝，零 DDL', async () => {
    const triggerName = nextTriggerName('notracker');
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
    const triggerName = nextTriggerName('readbackdrop');
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
    const triggerName = nextTriggerName('replacedreadback');
    const tracker = createTriggerOwnershipTracker();
    const replacedBody = "SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'E2E 替换后的同名对象'";

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

    // 真实库中该名称从未被创建（替身路径不产生 DDL）
    expect(await readOwnedTriggerFact(dataSource, triggerName)).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // 第十九轮 P1/P3：销毁入口只接受「本 tracker 在 CREATE 成功后登记且仍待收尾」的记录。
  // 归属核验先于许可 / 库门禁 / 定义核验，未登记记录零查询零 DDL。
  // ---------------------------------------------------------------------------

  it('销毁入口：空 tracker + 拼装记录 → 归属核验拒绝，零查询零 DROP', async () => {
    const triggerName = nextTriggerName('emptytracker');
    const emptyTracker = createTriggerOwnershipTracker();
    const assembled: OwnedTriggerRecord = {
      name: triggerName,
      tableName: ROLLBACK_TRIGGER_TABLE,
      body: ROLLBACK_TRIGGER_BODY,
      fact: null,
    };
    const stub = createStubTriggerDataSource({
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

    await expect(
      disposeOwnedTriggerRecord(stub.dataSource, assembled, emptyTracker),
    ).rejects.toThrow(/归属校验/);
    expect(stub.calls).toEqual([]);
    expect(emptyTracker.remaining()).toEqual([]);
    expect(await readOwnedTriggerFact(dataSource, triggerName)).toBeNull();
  });

  it('销毁入口：记录登记在另一个 tracker → 归属核验拒绝，本轮对象逐字段不变', async () => {
    const triggerName = nextTriggerName('wrongtracker');
    const ownerTracker = createTriggerOwnershipTracker();
    const otherTracker = createTriggerOwnershipTracker();
    let owned: Awaited<ReturnType<typeof createOwnedTrigger>> | undefined;

    try {
      owned = await createOwnedTrigger({
        dataSource,
        name: triggerName,
        tableName: ROLLBACK_TRIGGER_TABLE,
        body: ROLLBACK_TRIGGER_BODY,
        tracker: ownerTracker,
      });

      const stub = createStubTriggerDataSource({ metadataResponses: [] });
      await expect(
        disposeOwnedTriggerRecord(stub.dataSource, ownerTracker.records()[0], otherTracker),
      ).rejects.toThrow(/归属校验/);
      expect(stub.calls).toEqual([]);
      expect(await readOwnedTriggerFact(dataSource, triggerName)).toEqual(owned);
      expect(ownerTracker.remaining().map((record) => record.name)).toEqual([triggerName]);
    } finally {
      for (const record of [...ownerTracker.remaining()]) {
        await disposeOwnedTriggerRecord(dataSource, record, ownerTracker);
      }
    }

    expect(await readOwnedTriggerFact(dataSource, triggerName)).toBeNull();
  });

  it('销毁入口：复制记录与登记对象不同 → 归属核验拒绝，不发出任何 DROP', async () => {
    const triggerName = nextTriggerName('copiedrecord');
    const tracker = createTriggerOwnershipTracker();

    try {
      await createOwnedTrigger({
        dataSource,
        name: triggerName,
        tableName: ROLLBACK_TRIGGER_TABLE,
        body: ROLLBACK_TRIGGER_BODY,
        tracker,
      });
      const copied = { ...tracker.records()[0] };
      const stub = createStubTriggerDataSource({ metadataResponses: [] });

      await expect(disposeOwnedTriggerRecord(stub.dataSource, copied, tracker)).rejects.toThrow(
        /归属校验/,
      );
      expect(stub.calls).toEqual([]);
      expect(await readOwnedTriggerFact(dataSource, triggerName)).not.toBeNull();
    } finally {
      for (const record of [...tracker.remaining()]) {
        await disposeOwnedTriggerRecord(dataSource, record, tracker);
      }
    }

    expect(await readOwnedTriggerFact(dataSource, triggerName)).toBeNull();
  });

  it('销毁入口：重复收尾 → 第二次在 DROP 前拒绝，不重复删除、不重新认领', async () => {
    const triggerName = nextTriggerName('repeatdispose');
    const tracker = createTriggerOwnershipTracker();
    const factRow = [
      {
        name: triggerName,
        tableName: ROLLBACK_TRIGGER_TABLE,
        definition: ROLLBACK_TRIGGER_BODY,
      },
    ];
    const stub = createStubTriggerDataSource({ metadataResponses: [[], factRow, factRow] });

    await withPhysicalCleanupConsent(async () => {
      await createOwnedTrigger({
        dataSource: stub.dataSource,
        name: triggerName,
        tableName: ROLLBACK_TRIGGER_TABLE,
        body: ROLLBACK_TRIGGER_BODY,
        tracker,
      });
      const record = tracker.records()[0];
      await disposeOwnedTriggerRecord(stub.dataSource, record, tracker);
      expect(tracker.remaining()).toEqual([]);

      const callsBefore = stub.calls.length;
      await expect(disposeOwnedTriggerRecord(stub.dataSource, record, tracker)).rejects.toThrow(
        /归属校验/,
      );
      expect(stub.calls.slice(callsBefore)).toEqual([]);
      expect(tracker.records()).toHaveLength(1);
    });

    expect(await readOwnedTriggerFact(dataSource, triggerName)).toBeNull();
  });

  it('同名同表同定义碰撞：第二次 CREATE 被拒且登记为 0 → 原对象只由自己的账本收尾', async () => {
    const triggerName = nextTriggerName('samecollision');
    const ownerTracker = createTriggerOwnershipTracker();
    const collisionTracker = createTriggerOwnershipTracker();
    const collisionCleanupErrors: Error[] = [];
    const ownerCleanupErrors: Error[] = [];
    let mainError: unknown;

    // P1：从原触发器 CREATE 之前进入外层保护；原对象清理只在外层 finally
    try {
      await createOwnedTrigger({
        dataSource,
        name: triggerName,
        tableName: ROLLBACK_TRIGGER_TABLE,
        body: ROLLBACK_TRIGGER_BODY,
        tracker: ownerTracker,
      });

      // 同名、同表、同定义：仍然必须被同名预检拒绝，且碰撞方登记为 0
      await expect(
        createOwnedTrigger({
          dataSource,
          name: triggerName,
          tableName: ROLLBACK_TRIGGER_TABLE,
          body: ROLLBACK_TRIGGER_BODY,
          tracker: collisionTracker,
        }),
      ).rejects.toThrow(/同名预检/);
      expect(collisionTracker.records()).toEqual([]);

      // 碰撞方收尾在保护范围内执行；失败只记录，不阻断后续断言
      await disposeTrackerRemaining(dataSource, collisionTracker, collisionCleanupErrors);

      // 关键断言：碰撞失败不得删除原对象
      expect(await readOwnedTriggerFact(dataSource, triggerName)).not.toBeNull();
    } catch (error) {
      mainError = error;
    } finally {
      // P2：两项收尾各自独立尝试，全部尝试结束后统一汇总
      await disposeTrackerRemaining(dataSource, collisionTracker, collisionCleanupErrors);
      await disposeTrackerRemaining(dataSource, ownerTracker, ownerCleanupErrors);
    }

    const failures: unknown[] = [
      ...(mainError === undefined ? [] : [mainError]),
      ...collisionCleanupErrors,
      ...ownerCleanupErrors,
    ];
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `同名碰撞用例失败：主错误=${mainError === undefined ? '无' : '有'}` +
          `，碰撞方收尾错误=${collisionCleanupErrors.length}` +
          `，原对象收尾错误=${ownerCleanupErrors.length}`,
      );
    }

    expect(collisionTracker.remaining()).toEqual([]);
    expect(ownerTracker.remaining()).toEqual([]);
    expect(await readOwnedTriggerFact(dataSource, triggerName)).toBeNull();
  });

  it('原对象创建成功后中途断言失败 → 仍按真实账本回收，原始错误保留', async () => {
    const triggerName = nextTriggerName('midassert');
    const tracker = createTriggerOwnershipTracker();
    const cleanupErrors: Error[] = [];
    let mainError: unknown;

    // 外层保护从 CREATE 之前开始；收尾不依赖断言成功
    try {
      await createOwnedTrigger({
        dataSource,
        name: triggerName,
        tableName: ROLLBACK_TRIGGER_TABLE,
        body: ROLLBACK_TRIGGER_BODY,
        tracker,
      });
      // 真实断言失败：对象仍在，却期望不存在
      expect(await readOwnedTriggerFact(dataSource, triggerName)).toBeNull();
    } catch (error) {
      mainError = error;
    } finally {
      await disposeTrackerRemaining(dataSource, tracker, cleanupErrors);
    }

    expect(cleanupErrors).toEqual([]);
    expect(tracker.remaining()).toEqual([]);
    // 原对象由自己的创建账本回收，不因断言失败而残留
    expect(await readOwnedTriggerFact(dataSource, triggerName)).toBeNull();
    expect(mainError).toBeInstanceOf(Error);
    expect((mainError as Error).message).toContain('toBeNull');
  });

  it('主错误与收尾错误同时发生 → 两类错误均保留，重试后原对象零残留', async () => {
    const triggerName = nextTriggerName('maincleanupfail');
    const tracker = createTriggerOwnershipTracker();
    const cleanupErrors: Error[] = [];
    let mainError: unknown;

    try {
      await createOwnedTrigger({
        dataSource,
        name: triggerName,
        tableName: ROLLBACK_TRIGGER_TABLE,
        body: ROLLBACK_TRIGGER_BODY,
        tracker,
      });
      throw new Error('模拟主流程错误');
    } catch (error) {
      mainError = error;
    } finally {
      // 第一次：注入 DROP 失败 → 记录错误，登记保留
      await disposeTrackerRemaining(
        createDropFailingDataSource(dataSource, 1),
        tracker,
        cleanupErrors,
      );
      // 第二次：真实连接重试，仍能精确收尾同一登记
      await disposeTrackerRemaining(dataSource, tracker, cleanupErrors);
    }

    expect((mainError as Error).message).toBe('模拟主流程错误');
    expect(cleanupErrors.map((error) => error.message)).toEqual(['注入故障：触发器 DROP 失败']);
    expect(tracker.remaining()).toEqual([]);
    expect(await readOwnedTriggerFact(dataSource, triggerName)).toBeNull();
  });

  it('清理守卫：未通过目标库校验时不得执行删除', () => {
    expect(shouldRunRepairRequestFixtureCleanup({ dataSource, targetValidated: false })).toBe(
      false,
    );
    expect(shouldRunRepairRequestFixtureCleanup({ dataSource, targetValidated: true })).toBe(true);
    expect(shouldRunRepairRequestFixtureCleanup({ dataSource: null, targetValidated: true })).toBe(
      false,
    );
  });

  it('物理清理许可缺失：三个清理入口都失败关闭，且不进入删除事务', async () => {
    const before = await readSentinelSnapshot();
    const previousConsent = process.env.E2E_ALLOW_PHYSICAL_CLEANUP;
    const transactionSpy = jest.spyOn(dataSource, 'transaction');
    delete process.env.E2E_ALLOW_PHYSICAL_CLEANUP;
    try {
      await expect(cleanupRepairRequestFixtureResidue(dataSource)).rejects.toThrow(
        /E2E_ALLOW_PHYSICAL_CLEANUP=1/,
      );
      await expect(
        cleanupRepairRequestFixtureByIds(dataSource, {
          accountIds: [sentinelAccountId],
          organizationIds: [],
          membershipIds: [],
          equipmentModelIds: [sentinelModelId],
          repairRequestIds: [sentinelRequestId],
          engineerResponseIds: [],
        }),
      ).rejects.toThrow(/E2E_ALLOW_PHYSICAL_CLEANUP=1/);
      // 测试内直接删除入口（哨兵收尾）同样必须先过许可门禁
      await expect(
        cleanupSentinelByIds({
          accountIds: [sentinelAccountId],
          equipmentModelIds: [sentinelModelId],
          repairRequestIds: [sentinelRequestId],
        }),
      ).rejects.toThrow(/E2E_ALLOW_PHYSICAL_CLEANUP=1/);
      // 许可缺失时连删除事务都不开启，零数据接触
      expect(transactionSpy).not.toHaveBeenCalled();
    } finally {
      if (previousConsent === undefined) {
        delete process.env.E2E_ALLOW_PHYSICAL_CLEANUP;
      } else {
        process.env.E2E_ALLOW_PHYSICAL_CLEANUP = previousConsent;
      }
      transactionSpy.mockRestore();
    }
    expect(await readSentinelSnapshot()).toEqual(before);
  });

  it('保留库名白名单与显式许可两道独立门禁：任一缺失都拒绝，互不替代', async () => {
    const previousConsent = process.env.E2E_ALLOW_PHYSICAL_CLEANUP;
    const wrongDbProbe = jest.fn(() =>
      Promise.resolve([{ current_database: 'lithography_drill' }]),
    );
    const missingConsentProbe = jest.fn(() =>
      Promise.resolve([{ current_database: 'lithography_e2e' }]),
    );
    // N04：fake DataSource 必须像真实 DataSource 一样显式给出预期库，
    // 不允许以“没有配置”为由跳过预期目标库解析。
    const wrongDbDataSource = {
      options: { database: 'lithography_e2e' },
      query: wrongDbProbe,
    } as unknown as DataSource;
    const unprobedDataSource = {
      options: { database: 'lithography_e2e' },
      query: missingConsentProbe,
    } as unknown as DataSource;
    try {
      // ① 有显式许可、库不在白名单 → 仍必须被库名门禁拒绝（许可不能替代库名检查）
      process.env.E2E_ALLOW_PHYSICAL_CLEANUP = '1';
      await expect(cleanupRepairRequestFixtureResidue(wrongDbDataSource)).rejects.toThrow(/白名单/);
      expect(wrongDbProbe).toHaveBeenCalledTimes(1);

      // ② 无显式许可 → 在读取实际库名之前就拒绝（许可门禁先于任何数据接触）
      delete process.env.E2E_ALLOW_PHYSICAL_CLEANUP;
      await expect(cleanupRepairRequestFixtureResidue(unprobedDataSource)).rejects.toThrow(
        /E2E_ALLOW_PHYSICAL_CLEANUP=1/,
      );
      expect(missingConsentProbe).not.toHaveBeenCalled();
    } finally {
      if (previousConsent === undefined) {
        delete process.env.E2E_ALLOW_PHYSICAL_CLEANUP;
      } else {
        process.env.E2E_ALLOW_PHYSICAL_CLEANUP = previousConsent;
      }
    }
  });

  it('同标记但内容不同的申请：失败关闭，夹具零删除', async () => {
    const before = await readSentinelSnapshot();
    const ownership = createRepairRequestFixtureOwnership();
    const accountId = await seedEngineerAccount(ownership);
    const modelId = await createRepairRequestFixtureModel({ dataSource, ownership, key: 'read' });

    // 外部数据复用了夹具标记与夹具账号/型号，但正文指纹与真源不一致
    const requestRepo = dataSource.getRepository(RepairRequestEntity);
    /** 本轮自建的冒名行 ID：直接删除前必须命中本集合 */
    const impostorRequestIds: number[] = [];
    const impostor = await requestRepo.save(
      requestRepo.create({
        requestNo: REPAIR_REQUEST_FIXTURE_MARKERS.readRequestNos[0],
        customerAccountId: accountId,
        equipmentModelId: modelId,
        errorCode: 'E-9999',
        faultDescription: '同标记但正文不同',
        contentMd: '# IMPOSTOR',
        createdAt: new Date('2026-08-25T01:00:00.000Z'),
        isAccepted: false,
        acceptedByEngineerAccountId: null,
        acceptedAt: null,
        deprecated: false,
        deletedAt: null,
      }),
    );
    impostorRequestIds.push(impostor.id);

    await expect(cleanupRepairRequestFixtureResidue(dataSource)).rejects.toThrow(/归属校验/);
    // 失败关闭：夹具行与冒名行都未被删除
    expect(await countFixtureAccounts()).toBe(1);
    expect(await countFixtureRequests()).toBe(1);

    // 收尾：先核验并删除冒名行，再回收本轮夹具
    await deleteRecordedExternalRow({
      helper: '冒名申请收尾',
      entity: RepairRequestEntity,
      recordedIds: impostorRequestIds,
      id: impostor.id,
      verify: (row) =>
        row.requestNo === REPAIR_REQUEST_FIXTURE_MARKERS.readRequestNos[0] &&
        row.errorCode === 'E-9999' &&
        row.contentMd === '# IMPOSTOR' &&
        row.customerAccountId === accountId &&
        row.equipmentModelId === modelId,
    });
    await cleanupRepairRequestFixtureByIds(dataSource, ownership);
    expect(await countFixtureAccounts()).toBe(0);
    expect(await countFixtureRequests()).toBe(0);
    expect(await readSentinelSnapshot()).toEqual(before);
  });

  it('回复客户或正文与夹具真源不一致：失败关闭，夹具零删除', async () => {
    const before = await readSentinelSnapshot();
    const ownership = createRepairRequestFixtureOwnership();
    const accountId = await seedEngineerAccount(ownership);
    const modelId = await createRepairRequestFixtureModel({ dataSource, ownership, key: 'read' });
    const requestId = await createRepairRequestFixtureRequest({
      dataSource,
      ownership,
      seed: {
        requestNo: REPAIR_REQUEST_FIXTURE_MARKERS.readRequestNos[0],
        customerAccountId: accountId,
        equipmentModelId: modelId,
        errorCode: 'E-1001',
        faultDescription: '未接单场景',
        contentMd: '# E2E-RR-111',
        createdAt: new Date('2026-08-25T01:00:00.000Z'),
        isAccepted: false,
        acceptedByEngineerAccountId: null,
        acceptedAt: null,
        deprecated: false,
        deletedAt: null,
      },
    });
    const responseRepo = dataSource.getRepository(EngineerResponseEntity);
    /** 本轮自建的外部回复 ID：直接删除前必须命中本集合 */
    const externalResponseIds: number[] = [];

    // ① 客户账号与父申请不一致（哨兵账号非夹具账号）→ 拒绝
    const foreignCustomerResponse = await responseRepo.save(
      responseRepo.create({
        requestId,
        engineerAccountId: accountId,
        customerAccountId: sentinelAccountId,
        resolutionStatus: EngineerResolutionStatus.PENDING,
        responseText: '已受理，排查中',
        createdAt: new Date('2026-08-27T02:00:00.000Z'),
      }),
    );
    externalResponseIds.push(foreignCustomerResponse.id);
    await expect(cleanupRepairRequestFixtureResidue(dataSource)).rejects.toThrow(/归属校验/);

    // ② 正文不在夹具真源内 → 仍然拒绝
    await deleteRecordedExternalRow({
      helper: '外部回复收尾①',
      entity: EngineerResponseEntity,
      recordedIds: externalResponseIds,
      id: foreignCustomerResponse.id,
      verify: (row) =>
        row.requestId === requestId &&
        row.engineerAccountId === accountId &&
        row.customerAccountId === sentinelAccountId &&
        row.responseText === '已受理，排查中',
    });
    const foreignTextResponse = await responseRepo.save(
      responseRepo.create({
        requestId,
        engineerAccountId: accountId,
        customerAccountId: accountId,
        resolutionStatus: EngineerResolutionStatus.PENDING,
        responseText: '外部正文（不在真源内）',
        createdAt: new Date('2026-08-27T03:00:00.000Z'),
      }),
    );
    externalResponseIds.push(foreignTextResponse.id);
    await expect(cleanupRepairRequestFixtureResidue(dataSource)).rejects.toThrow(/归属校验/);
    expect(await countFixtureRequests()).toBe(1);

    // 收尾：先核验并删除外部回复，再回收本轮夹具
    await deleteRecordedExternalRow({
      helper: '外部回复收尾②',
      entity: EngineerResponseEntity,
      recordedIds: externalResponseIds,
      id: foreignTextResponse.id,
      verify: (row) =>
        row.requestId === requestId &&
        row.engineerAccountId === accountId &&
        row.customerAccountId === accountId &&
        row.responseText === '外部正文（不在真源内）',
    });
    await cleanupRepairRequestFixtureByIds(dataSource, ownership);
    expect(await countFixtureAccounts()).toBe(0);
    expect(await countFixtureRequests()).toBe(0);
    expect(await readSentinelSnapshot()).toEqual(before);
  });

  it('真源内的合法回复通过归属核验并被精确清理；状态或时间不符时零删除', async () => {
    const before = await readSentinelSnapshot();
    const resolvedSpec = REPAIR_REQUEST_FIXTURE_RESPONSE_SPECS.resolved;

    /** RD-112 真源形态的「已接单」申请 + 两条合法回复（pending / resolved） */
    const seedAcceptedRequestWithLegalResponses = async () => {
      const ownership = createRepairRequestFixtureOwnership();
      const engineerId = await seedEngineerAccount(ownership, 'engineerA');
      const customerId = await seedEngineerAccount(ownership, 'customerA');
      const modelId = await createRepairRequestFixtureModel({ dataSource, ownership, key: 'read' });
      const requestId = await createRepairRequestFixtureRequest({
        dataSource,
        ownership,
        seed: {
          requestNo: 'E2E-RR-RD-112',
          customerAccountId: customerId,
          equipmentModelId: modelId,
          errorCode: 'E-1002',
          faultDescription: '本人接单场景',
          contentMd: '# E2E-RR-112',
          createdAt: new Date('2026-08-26T01:00:00.000Z'),
          isAccepted: true,
          acceptedByEngineerAccountId: engineerId,
          acceptedAt: new Date('2026-08-26T02:00:00.000Z'),
          deprecated: false,
          deletedAt: null,
        },
      });
      const responseIds: number[] = [];
      for (const key of ['pending', 'resolved'] as const) {
        const spec = REPAIR_REQUEST_FIXTURE_RESPONSE_SPECS[key];
        responseIds.push(
          await createRepairRequestFixtureResponse({
            dataSource,
            ownership,
            seed: {
              key,
              requestId,
              engineerAccountId: engineerId,
              customerAccountId: customerId,
              resolutionStatus: spec.resolutionStatus,
              responseText: spec.responseText,
              createdAt: spec.createdAt,
            },
          }),
        );
      }
      expect(ownership.engineerResponseIds).toEqual(responseIds);
      return { ownership, requestId, engineerId, customerId, responseIds };
    };

    // ① 两条合法回复：归属核验通过并被精确清理（不再被误判为外部数据）
    const legal = await seedAcceptedRequestWithLegalResponses();
    expect(await countFixtureResponses()).toBe(2);

    const recovered = await cleanupRepairRequestFixtureResidue(dataSource);
    expect([...recovered.engineerResponseIds].sort((a, b) => a - b)).toEqual(
      [...legal.responseIds].sort((a, b) => a - b),
    );
    expect(recovered.repairRequestIds).toEqual(legal.ownership.repairRequestIds);
    expect(await countFixtureResponses()).toBe(0);
    expect(await countFixtureRequests()).toBe(0);
    expect(await countFixtureAccounts()).toBe(0);
    expect(await readSentinelSnapshot()).toEqual(before);

    // ② 状态与真源不符（正文/时间取自 resolved，状态却是 pending）→ 失败关闭、零删除
    const mismatch = await seedAcceptedRequestWithLegalResponses();
    const responseRepo = dataSource.getRepository(EngineerResponseEntity);
    const tamperedResponseIds: number[] = [];
    const wrongStatus = await responseRepo.save(
      responseRepo.create({
        requestId: mismatch.requestId,
        engineerAccountId: mismatch.engineerId,
        customerAccountId: mismatch.customerId,
        resolutionStatus: EngineerResolutionStatus.PENDING,
        responseText: resolvedSpec.responseText,
        createdAt: resolvedSpec.createdAt,
      }),
    );
    tamperedResponseIds.push(wrongStatus.id);

    await expect(cleanupRepairRequestFixtureResidue(dataSource)).rejects.toThrow(/归属校验/);
    // 零删除：两条合法回复、被篡改的回复、申请与账号都仍在
    expect(await countFixtureResponses()).toBe(3);
    expect(await countFixtureRequests()).toBe(1);
    expect(await countFixtureAccounts()).toBe(2);

    // ③ 时间与真源不符（状态/正文取自 resolved，时间偏移一小时）→ 仍失败关闭、零删除
    await deleteRecordedExternalRow({
      helper: '篡改回复收尾①',
      entity: EngineerResponseEntity,
      recordedIds: tamperedResponseIds,
      id: wrongStatus.id,
      verify: (row) =>
        row.requestId === mismatch.requestId &&
        row.engineerAccountId === mismatch.engineerId &&
        row.customerAccountId === mismatch.customerId &&
        row.resolutionStatus === EngineerResolutionStatus.PENDING &&
        row.responseText === resolvedSpec.responseText,
    });
    const shiftedCreatedAt = new Date(resolvedSpec.createdAt.getTime() + 60 * 60 * 1000);
    const wrongTime = await responseRepo.save(
      responseRepo.create({
        requestId: mismatch.requestId,
        engineerAccountId: mismatch.engineerId,
        customerAccountId: mismatch.customerId,
        resolutionStatus: resolvedSpec.resolutionStatus,
        responseText: resolvedSpec.responseText,
        createdAt: shiftedCreatedAt,
      }),
    );
    tamperedResponseIds.push(wrongTime.id);

    await expect(cleanupRepairRequestFixtureResidue(dataSource)).rejects.toThrow(/归属校验/);
    expect(await countFixtureResponses()).toBe(3);
    expect(await countFixtureRequests()).toBe(1);

    // 收尾：先核验并删除外部回复，再回收合法回复与夹具
    await deleteRecordedExternalRow({
      helper: '篡改回复收尾②',
      entity: EngineerResponseEntity,
      recordedIds: tamperedResponseIds,
      id: wrongTime.id,
      verify: (row) =>
        row.requestId === mismatch.requestId &&
        row.engineerAccountId === mismatch.engineerId &&
        row.customerAccountId === mismatch.customerId &&
        row.resolutionStatus === resolvedSpec.resolutionStatus &&
        row.responseText === resolvedSpec.responseText &&
        row.createdAt.getTime() === shiftedCreatedAt.getTime(),
    });
    await cleanupRepairRequestFixtureByIds(dataSource, mismatch.ownership);
    expect(await countFixtureResponses()).toBe(0);
    expect(await countFixtureRequests()).toBe(0);
    expect(await countFixtureAccounts()).toBe(0);
    expect(await readSentinelSnapshot()).toEqual(before);
  });

  it('已接单但接单人不是夹具工程师账号：状态不变量失败关闭，夹具零删除', async () => {
    const before = await readSentinelSnapshot();
    const ownership = createRepairRequestFixtureOwnership();
    // 接单人故意使用 CUSTOMER 角色的夹具账号：虽属于夹具，但不是 ENGINEER
    const customerAsAcceptor = await seedEngineerAccount(ownership, 'customerA');
    const customerId = await seedEngineerAccount(ownership, 'customerB');
    const modelId = await createRepairRequestFixtureModel({ dataSource, ownership, key: 'read' });

    // 内容指纹与真源完全一致，仅状态字段违反不变量 → 必须由状态核验拒绝
    const requestId = await createRepairRequestFixtureRequest({
      dataSource,
      ownership,
      seed: {
        requestNo: REPAIR_REQUEST_FIXTURE_MARKERS.readRequestNos[0],
        customerAccountId: customerId,
        equipmentModelId: modelId,
        errorCode: 'E-1001',
        faultDescription: '未接单场景',
        contentMd: '# E2E-RR-111',
        createdAt: new Date('2026-08-25T01:00:00.000Z'),
        isAccepted: false,
        acceptedByEngineerAccountId: null,
        acceptedAt: null,
        deprecated: false,
        deletedAt: null,
      },
    });

    // 同标记、正文相同，但状态和运行时接单时间不同：必须在删除前拒绝。
    await dataSource.getRepository(RepairRequestEntity).update(
      { id: requestId },
      {
        isAccepted: true,
        acceptedByEngineerAccountId: customerAsAcceptor,
        acceptedAt: new Date('2026-08-25T02:00:00.000Z'),
      },
    );

    await expect(cleanupRepairRequestFixtureResidue(dataSource)).rejects.toThrow(/归属校验/);
    expect(await countFixtureAccounts()).toBe(2);
    expect(await countFixtureRequests()).toBe(1);

    // 收尾：先核验并删除违规申请（ID 取自本轮 ownership 记录），再回收本轮夹具
    await deleteRecordedExternalRow({
      helper: '违规申请收尾',
      entity: RepairRequestEntity,
      recordedIds: ownership.repairRequestIds,
      id: requestId,
      verify: (row) =>
        row.requestNo === REPAIR_REQUEST_FIXTURE_MARKERS.readRequestNos[0] &&
        row.errorCode === 'E-1001' &&
        row.contentMd === '# E2E-RR-111' &&
        row.customerAccountId === customerId &&
        row.equipmentModelId === modelId &&
        row.isAccepted === true &&
        row.acceptedByEngineerAccountId === customerAsAcceptor,
    });
    await cleanupRepairRequestFixtureByIds(dataSource, ownership);
    expect(await countFixtureAccounts()).toBe(0);
    expect(await countFixtureRequests()).toBe(0);
    expect(await readSentinelSnapshot()).toEqual(before);
  });

  it('守卫拒绝：teardown 不执行任何删除，哨兵链逐字段不变', async () => {
    const before = await readSentinelSnapshot();
    const cleanup = jest.fn(() => Promise.resolve());

    await runRepairRequestFixtureTeardown({
      app: null,
      dataSource,
      targetValidated: false,
      cleanup,
    });

    // 未授权：清理回调一次都不应被调用（删除调用为零）
    expect(cleanup).not.toHaveBeenCalled();
    expect(await readSentinelSnapshot()).toEqual(before);
    expect(await countSentinelRows(SENTINEL)).toEqual({
      accounts: 1,
      models: 1,
      requests: 1,
    });
  });

  it('ownership 为空：清理为 no-op，不开启任何删除事务', async () => {
    const before = await readSentinelSnapshot();
    const transactionSpy = jest.spyOn(dataSource, 'transaction');
    try {
      await cleanupSentinelByIds(createSentinelOwnership());
      expect(transactionSpy).not.toHaveBeenCalled();
    } finally {
      transactionSpy.mockRestore();
    }
    expect(await readSentinelSnapshot()).toEqual(before);
  });

  it('专属标记已被占用：拒绝造数且不触碰既有哨兵', async () => {
    const before = await readSentinelSnapshot();
    const ownership = createSentinelOwnership();

    // 主哨兵标记已存在 → 造数前必须探测到占用并失败关闭
    await expect(seedSentinelChain(SENTINEL, ownership)).rejects.toThrow(/标记占用/);
    expect(ownership).toEqual(createSentinelOwnership());
    expect(await readSentinelSnapshot()).toEqual(before);
    expect(await countSentinelRows(SENTINEL)).toEqual({
      accounts: 1,
      models: 1,
      requests: 1,
    });
  });

  it('哨兵部分造数失败：只回收已成功创建且已验证归属的记录', async () => {
    // 造数前必须先确认探针标记空闲：任一被占用即失败关闭，不进行任何写入
    await assertSentinelMarkersFree(PROBE_SENTINEL);
    const before = await readSentinelSnapshot();

    // 账号与型号成功并记录实际 ID
    const accountId = await createSentinelAccount(PROBE_SENTINEL, probeOwnership);
    const modelId = await createSentinelModel(PROBE_SENTINEL, probeOwnership);
    expect(probeOwnership.accountIds).toEqual([accountId]);
    expect(probeOwnership.equipmentModelIds).toEqual([modelId]);

    // 申请以不存在的客户账号造数 → FK 失败；申请未被记录
    await expect(
      createSentinelRequest({
        spec: PROBE_SENTINEL,
        ownership: probeOwnership,
        customerAccountId: 999999999,
        equipmentModelId: modelId,
      }),
    ).rejects.toThrow();
    expect(probeOwnership.repairRequestIds).toEqual([]);
    expect(await countSentinelRows(PROBE_SENTINEL)).toEqual({
      accounts: 1,
      models: 1,
      requests: 0,
    });

    // 只回收已记录且已验证归属的行；主哨兵链不受影响
    await cleanupSentinelByIds(probeOwnership);
    expect(await countSentinelRows(PROBE_SENTINEL)).toEqual({
      accounts: 0,
      models: 0,
      requests: 0,
    });
    expect(await readSentinelSnapshot()).toEqual(before);
  });

  it('记录含不存在的 ID：清理失败关闭，真实哨兵逐字段不变', async () => {
    const before = await readSentinelSnapshot();
    // 只读挑选并当场核验「三表均无此 ID」，不假定任何候选值天然空闲
    const orphanId = await pickUnusedId();

    const ownership = createSentinelOwnership();
    ownership.accountIds.push(sentinelAccountId);
    ownership.equipmentModelIds.push(sentinelModelId);
    ownership.repairRequestIds.push(sentinelRequestId, orphanId);

    await expect(cleanupSentinelByIds(ownership)).rejects.toThrow(/归属校验/);
    // 失败时记录保留供诊断（未被清空）
    expect(ownership.repairRequestIds).toEqual([sentinelRequestId, orphanId]);

    // 整笔事务回滚：真实哨兵链逐字段不变、行数不变
    expect(await readSentinelSnapshot()).toEqual(before);
    expect(await countSentinelRows(SENTINEL)).toEqual({
      accounts: 1,
      models: 1,
      requests: 1,
    });
  });

  it('成功清理后重复调用：不进入删除事务', async () => {
    const before = await readSentinelSnapshot();

    await seedSentinelChain(PROBE_SENTINEL, probeOwnership);
    expect(await countSentinelRows(PROBE_SENTINEL)).toEqual({
      accounts: 1,
      models: 1,
      requests: 1,
    });

    await cleanupSentinelByIds(probeOwnership);
    expect(await countSentinelRows(PROBE_SENTINEL)).toEqual({
      accounts: 0,
      models: 0,
      requests: 0,
    });
    // 事务成功提交后本轮记录被清空
    expect(probeOwnership).toEqual(createSentinelOwnership());

    const transactionSpy = jest.spyOn(dataSource, 'transaction');
    try {
      await cleanupSentinelByIds(probeOwnership);
      expect(transactionSpy).not.toHaveBeenCalled();
    } finally {
      transactionSpy.mockRestore();
    }

    expect(await countSentinelRows(PROBE_SENTINEL)).toEqual({
      accounts: 0,
      models: 0,
      requests: 0,
    });
    expect(await readSentinelSnapshot()).toEqual(before);
  });

  it('哨兵收尾在归属核验失败时失败关闭（拒绝删除该标记以外的行）', async () => {
    const before = await readSentinelSnapshot();
    const ownership = createSentinelOwnership();

    // 记录一个真实存在、但自然标记不属于哨兵注册表的行（夹具账号）
    const fixtureAccountId = await seedEngineerAccount(createRepairRequestFixtureOwnership());
    ownership.accountIds.push(fixtureAccountId);

    await expect(cleanupSentinelByIds(ownership)).rejects.toThrow(/归属校验/);
    // 失败关闭：该行仍在，哨兵链亦不变
    expect(await countFixtureAccounts()).toBe(1);
    expect(await readSentinelSnapshot()).toEqual(before);

    // 收尾：按夹具记录 ID 精确回收夹具账号
    const fixtureOwnership = createRepairRequestFixtureOwnership();
    fixtureOwnership.accountIds.push(fixtureAccountId);
    await cleanupRepairRequestFixtureByIds(dataSource, fixtureOwnership);
    expect(await countFixtureAccounts()).toBe(0);
  });

  /** 按条件读取多行并稳定排序（用于「逐字段不变」快照比对） */
  async function readRowsInOrder<T extends { id: number }>(
    entity: EntityTarget<T>,
    where: FindOptionsWhere<T>,
  ): Promise<T[]> {
    const rows = await dataSource.getRepository(entity).find({ where });
    return rows.sort((a, b) => a.id - b.id);
  }

  /** 夹具自身行（账号 / user_info / 组织 / 成员关系 / 型号 / 申请 / 回复）的逐字段快照 */
  async function readFixtureSnapshot(ownership: RepairRequestFixtureOwnership) {
    return {
      accounts: await readRowsInOrder(AccountEntity, { id: In([...ownership.accountIds]) }),
      userInfos: await readRowsInOrder(UserInfoEntity, {
        accountId: In([...ownership.accountIds]),
      }),
      organizations: await readRowsInOrder(OrganizationEntity, {
        id: In([...ownership.organizationIds]),
      }),
      memberships: await readRowsInOrder(OrganizationMembershipEntity, {
        id: In([...ownership.membershipIds]),
      }),
      models: await readRowsInOrder(EquipmentModelEntity, {
        id: In([...ownership.equipmentModelIds]),
      }),
      requests: await readRowsInOrder(RepairRequestEntity, {
        id: In([...ownership.repairRequestIds]),
      }),
      responses: await readRowsInOrder(EngineerResponseEntity, {
        requestId: In([...ownership.repairRequestIds]),
      }),
    };
  }

  const readAiConversation = (id: number): Promise<AiConversationEntity | null> =>
    dataSource.getRepository(AiConversationEntity).findOne({ where: { id } });

  const readMaintenanceReport = (id: number): Promise<MaintenanceReportEntity | null> =>
    dataSource.getRepository(MaintenanceReportEntity).findOne({ where: { id } });

  /** 造一个专属账号并记录到 ownership（默认工程师 A，供多处复用） */
  async function seedEngineerAccount(
    target: RepairRequestFixtureOwnership,
    key: RepairRequestFixtureAccountKey = 'engineerA',
  ): Promise<number> {
    const created = await seedRepairRequestFixtureAccounts({
      dataSource,
      ownership: target,
      createAccountUsecase,
      includeKeys: [key],
    });
    return created[key];
  }

  /** 哨兵 helper 自保护：第一条写操作之前复用不可跳过的目标库白名单守卫 */
  async function assertSentinelTarget(helper: string): Promise<void> {
    try {
      await assertDataSourceOnAllowedE2eDatabase(dataSource);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`[${helper}] 阶段=目标库守卫 拒绝执行写入/删除：${detail}`, { cause: error });
    }
  }

  // -------------------------------------------------------------------------
  // P3：故障注入触发器的对象所有权（本轮唯一名称 + 同名预检 + 定义核验）
  // -------------------------------------------------------------------------

  const ROLLBACK_TRIGGER_TABLE = 'base_user_info';
  const ROLLBACK_TRIGGER_BODY = "SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'E2E 后序删除失败注入'";
  let triggerSequence = 0;

  /** 本轮唯一、格式受控的触发器名称（进程 + 序号 + 时间戳，避免跨轮碰撞） */
  function nextTriggerName(label: string): string {
    triggerSequence += 1;
    const name = `e2e_rr_${label}_${process.pid}_${triggerSequence}_${Date.now()}`;
    assertTriggerNameFormat(name);
    return name;
  }

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

  /**
   * 真实连接上的元数据回读故障注入：先放行同名预检，CREATE 成功后的回读抛错。
   */
  function createMetadataReadbackFailingDataSource(
    real: DataSource,
    allowBeforeFailure: number,
  ): DataSource {
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
              return Promise.reject(new Error('模拟触发器元数据回读失败'));
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
  }

  /**
   * 逐记录独立收尾：只遍历传入 tracker 的真实未完成登记；任一项失败只记录，不阻断后续。
   */
  async function disposeTrackerRemaining(
    source: DataSource,
    tracker: TriggerOwnershipTracker,
    errors: Error[],
  ): Promise<void> {
    for (const record of [...tracker.remaining()]) {
      try {
        await disposeOwnedTriggerRecord(source, record, tracker);
      } catch (error) {
        errors.push(
          error instanceof Error
            ? error
            : new AggregateError([error], '触发器收尾出现非 Error 异常'),
        );
      }
    }
  }

  /** 真实连接上的 DROP 故障注入：前 failCount 次 DROP 抛错，其余放行。 */
  function createDropFailingDataSource(real: DataSource, failCount: number): DataSource {
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

  /**
   * 本 spec 内物理删除的双门禁（先许可、后库名，互相独立、互不替代）：
   * 哨兵收尾与测试内直接删除都必须经由本入口，任一缺失即在第一条删除语句前失败关闭。
   */
  async function assertDirectDeleteTarget(helper: string): Promise<void> {
    try {
      assertPhysicalCleanupConsent();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`[${helper}] 阶段=清理许可门禁 拒绝执行删除：${detail}`, { cause: error });
    }
    await assertSentinelTarget(helper);
  }

  /**
   * 测试内直接删除「本 spec 自建的外部行」（冒名申请 / 外部回复 / 违规申请）：
   * - 双门禁：显式清理许可 + 实际库名白名单；
   * - ID 必须来自本轮显式记录的集合，拒绝任意 ID（含哨兵与夹具行 ID）；
   * - 事务内按指纹谓词逐字段核验后才按该 ID 删除，核验失败即整笔回滚、零删除。
   */
  async function deleteRecordedExternalRow<T extends { id: number | string }>(opts: {
    helper: string;
    entity: EntityTarget<T>;
    recordedIds: readonly (number | string)[];
    id: number | string;
    verify: (row: T) => boolean;
  }): Promise<void> {
    const recorded = [...new Set(opts.recordedIds)];
    if (!recorded.includes(opts.id)) {
      throw new Error(
        `[${opts.helper}] 阶段=删除目标 拒绝删除：id=${opts.id} 不是本轮已记录的 ID（记录=${
          recorded.join(',') || '空'
        }）`,
      );
    }
    await assertDirectDeleteTarget(opts.helper);
    await dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(opts.entity);
      const where = { id: opts.id } as FindOptionsWhere<T>;
      const row = await repo.findOne({ where });
      if (!row) {
        throw new Error(`[${opts.helper}] 阶段=归属校验 拒绝删除：id=${opts.id} 在库中不存在`);
      }
      if (!opts.verify(row)) {
        throw new Error(
          `[${opts.helper}] 阶段=归属校验 拒绝删除：id=${opts.id} 的自然标记/正文与本轮造数不符`,
        );
      }
      await repo.delete(where);
    });
  }

  function recordSentinelId(ids: number[], id: number, helper: string): void {
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error(`[${helper}] 哨兵创建未返回有效数据库主键：${String(id)}`);
    }
    ids.push(id);
  }

  /** 造数前必须确认专属标记均为空闲：任一被占用即拒绝造数（fail closed） */
  async function assertSentinelMarkersFree(spec: SentinelSpec): Promise<void> {
    const helper = 'assertSentinelMarkersFree';
    const [account, model, request] = await Promise.all([
      dataSource.getRepository(AccountEntity).findOne({ where: { loginName: spec.loginName } }),
      dataSource
        .getRepository(EquipmentModelEntity)
        .findOne({ where: { modelCode: spec.modelCode } }),
      dataSource
        .getRepository(RepairRequestEntity)
        .findOne({ where: { requestNo: spec.requestNo } }),
    ]);
    const occupied = [
      account ? `账号 loginName=${spec.loginName}(id=${account.id})` : null,
      model ? `型号 modelCode=${spec.modelCode}(id=${model.id})` : null,
      request ? `申请 requestNo=${spec.requestNo}(id=${request.id})` : null,
    ].filter((row): row is string => row !== null);
    if (occupied.length > 0) {
      throw new Error(
        `[${helper}] 阶段=标记占用 拒绝造数：专属标记已被既有数据占用 → ${occupied.join('; ')}`,
      );
    }
  }

  async function countSentinelRows(
    spec: SentinelSpec,
  ): Promise<{ accounts: number; models: number; requests: number }> {
    const [accounts, models, requests] = await Promise.all([
      dataSource.getRepository(AccountEntity).count({ where: { loginName: spec.loginName } }),
      dataSource
        .getRepository(EquipmentModelEntity)
        .count({ where: { modelCode: spec.modelCode } }),
      dataSource.getRepository(RepairRequestEntity).count({ where: { requestNo: spec.requestNo } }),
    ]);
    return { accounts, models, requests };
  }

  /**
   * 只读挑选一个「账号 / 型号 / 申请三表均不存在」的候选 ID 供回归构造使用。
   * 现场核验而非假定：被占用即抛错，避免构造失效导致回归失去意义。
   */
  async function pickUnusedId(): Promise<number> {
    const candidate = 999_999_999;
    const [accounts, models, requests] = await Promise.all([
      dataSource.getRepository(AccountEntity).count({ where: { id: candidate } }),
      dataSource.getRepository(EquipmentModelEntity).count({ where: { id: candidate } }),
      dataSource.getRepository(RepairRequestEntity).count({ where: { id: candidate } }),
    ]);
    if (accounts + models + requests > 0) {
      throw new Error(
        `[pickUnusedId] 候选 ID ${candidate} 已被既有数据占用（账号=${accounts} 型号=${models} 申请=${requests}），回归构造失效`,
      );
    }
    return candidate;
  }

  async function createSentinelAccount(
    spec: SentinelSpec,
    ownership: SentinelOwnership,
  ): Promise<number> {
    const helper = 'createSentinelAccount';
    await assertSentinelTarget(helper);
    const created = await createTestAccount(dataSource, createAccountUsecase, {
      loginName: spec.loginName,
      loginEmail: spec.loginEmail,
      loginPassword: spec.loginPassword,
      status: AccountStatus.ACTIVE,
      accessGroup: [IdentityTypeEnum.CUSTOMER],
      identityType: IdentityTypeEnum.CUSTOMER,
    });
    recordSentinelId(ownership.accountIds, created.accountId, helper);
    return created.accountId;
  }

  async function createSentinelModel(
    spec: SentinelSpec,
    ownership: SentinelOwnership,
  ): Promise<number> {
    const helper = 'createSentinelModel';
    await assertSentinelTarget(helper);
    const repo = dataSource.getRepository(EquipmentModelEntity);
    const saved = await repo.save(
      repo.create({
        modelCode: spec.modelCode,
        modelName: spec.modelName,
        enabled: true,
        sortOrder: spec.sortOrder,
      }),
    );
    recordSentinelId(ownership.equipmentModelIds, saved.id, helper);
    return saved.id;
  }

  async function createSentinelRequest(opts: {
    spec: SentinelSpec;
    ownership: SentinelOwnership;
    customerAccountId: number;
    equipmentModelId: number;
  }): Promise<number> {
    const helper = 'createSentinelRequest';
    await assertSentinelTarget(helper);
    const repo = dataSource.getRepository(RepairRequestEntity);
    const saved = await repo.save(
      repo.create({
        requestNo: opts.spec.requestNo,
        customerAccountId: opts.customerAccountId,
        equipmentModelId: opts.equipmentModelId,
        errorCode: 'E-SENTINEL',
        faultDescription: `${opts.spec.modelName} 申请`,
        contentMd: `# ${opts.spec.requestNo}`,
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
        isAccepted: false,
        acceptedByEngineerAccountId: null,
        acceptedAt: null,
        deprecated: false,
        deletedAt: null,
      }),
    );
    recordSentinelId(opts.ownership.repairRequestIds, saved.id, helper);
    return saved.id;
  }

  /** 建完整哨兵链：先越守卫，再确认标记空闲，最后逐条记录实际 ID */
  async function seedSentinelChain(
    spec: SentinelSpec,
    ownership: SentinelOwnership,
  ): Promise<{ accountId: number; modelId: number; requestId: number }> {
    await assertSentinelTarget('seedSentinelChain');
    await assertSentinelMarkersFree(spec);
    const accountId = await createSentinelAccount(spec, ownership);
    const modelId = await createSentinelModel(spec, ownership);
    const requestId = await createSentinelRequest({
      spec,
      ownership,
      customerAccountId: accountId,
      equipmentModelId: modelId,
    });
    return { accountId, modelId, requestId };
  }

  /**
   * 哨兵收尾（fail closed）：
   * - ownership 为空 → 零删除，且不开启任何删除事务；
   * - 守卫未通过（缺显式清理许可或库名不在白名单）→ 抛错且零删除；
   * - 否则在事务内做三层核验：① 已记录行的自然标记属于哨兵注册表；② 申请引用落在本轮
   *   记录集合内；③ 查出的 ID 集合与本轮记录的去重 ID 集合完全一致（任一记录在库中缺失即
   *   拒绝）。三层全部通过后才按实际 ID 精确删除（申请 → 型号 → user_info → account），
   *   任一核验失败即回滚、零删除；
   * - 事务成功提交后清空 ownership，使重复调用不进入删除事务；抛错时保留记录。
   */
  async function cleanupSentinelByIds(ownership: SentinelOwnership): Promise<void> {
    if (!hasSentinelOwnership(ownership)) {
      return;
    }
    const helper = 'cleanupSentinelByIds';
    await assertDirectDeleteTarget(helper);
    await dataSource.transaction(async (manager) => {
      const accountIds = [...new Set(ownership.accountIds)];
      const modelIds = [...new Set(ownership.equipmentModelIds)];
      const requestIds = [...new Set(ownership.repairRequestIds)];

      const accounts =
        accountIds.length > 0
          ? await manager.getRepository(AccountEntity).find({ where: { id: In(accountIds) } })
          : [];
      for (const row of accounts) {
        if (!row.loginName || !SENTINEL_LOGIN_NAMES.has(row.loginName)) {
          throw ownershipRejection(
            helper,
            `账号 id=${row.id} 的 loginName=${String(row.loginName)} 不属于哨兵标记注册表`,
          );
        }
      }
      const accountIdSet = new Set(accounts.map((row) => row.id));
      assertRecordedIdsAllResolved(helper, '账号', accountIdSet, accountIds);

      const models =
        modelIds.length > 0
          ? await manager.getRepository(EquipmentModelEntity).find({ where: { id: In(modelIds) } })
          : [];
      for (const row of models) {
        if (!SENTINEL_MODEL_CODES.has(row.modelCode)) {
          throw ownershipRejection(
            helper,
            `型号 id=${row.id} 的 modelCode=${row.modelCode} 不属于哨兵标记注册表`,
          );
        }
      }
      const modelIdSet = new Set(models.map((row) => row.id));
      assertRecordedIdsAllResolved(helper, '型号', modelIdSet, modelIds);

      const requests =
        requestIds.length > 0
          ? await manager.getRepository(RepairRequestEntity).find({ where: { id: In(requestIds) } })
          : [];
      for (const row of requests) {
        if (!SENTINEL_REQUEST_NOS.has(row.requestNo)) {
          throw ownershipRejection(
            helper,
            `申请 id=${row.id} 的 requestNo=${row.requestNo} 不属于哨兵标记注册表`,
          );
        }
        if (!accountIdSet.has(row.customerAccountId)) {
          throw ownershipRejection(
            helper,
            `申请 ${row.requestNo} 的客户账号 ${row.customerAccountId} 不在本轮记录集合内`,
          );
        }
        if (!modelIdSet.has(row.equipmentModelId)) {
          throw ownershipRejection(
            helper,
            `申请 ${row.requestNo} 的型号 ${row.equipmentModelId} 不在本轮记录集合内`,
          );
        }
      }
      assertRecordedIdsAllResolved(
        helper,
        '申请',
        new Set(requests.map((row) => row.id)),
        requestIds,
      );

      if (requestIds.length > 0) {
        await manager.getRepository(RepairRequestEntity).delete({ id: In(requestIds) });
      }
      if (modelIds.length > 0) {
        await manager.getRepository(EquipmentModelEntity).delete({ id: In(modelIds) });
      }
      if (accountIds.length > 0) {
        await manager.getRepository(UserInfoEntity).delete({ accountId: In(accountIds) });
        await manager.getRepository(AccountEntity).delete({ id: In(accountIds) });
      }
    });

    // 事务已成功提交：清空本轮记录，避免 afterAll / 重复调用为已清理的数据再开删除事务。
    // 抛错时不会走到这里，记录保留供诊断与重试。
    clearSentinelOwnership(ownership);
  }
});
