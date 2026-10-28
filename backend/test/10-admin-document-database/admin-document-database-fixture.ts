// test/10-admin-document-database/admin-document-database-fixture.ts
//
// 普通 admin-document-database E2E 的专属安全夹具：
// - 账号与业务自然标记只用于定位，命中后必须逐字段、逐引用核验；
// - 所有主键由数据库生成，每步成功后立即记录本轮 ID；
// - 残留恢复与本轮收尾都在事务内完成全量预检，发现同名异主或外部引用即失败关闭；
// - 删除只使用已经验证且记录在所有权上下文中的本轮 ID。

import { AccountStatus, IdentityTypeEnum } from '@app-types/models/account.types';
import { AiConversationStatus, AiMessageRole } from '@app-types/models/ai-conversation.types';
import { UserState } from '@app-types/models/user-info.types';
import { AccountEntity } from '@src/modules/account/base/entities/account.entity';
import { UserInfoEntity } from '@src/modules/account/base/entities/user-info.entity';
import { AiConversationEntity } from '@src/modules/lithography/entities/ai-conversation.entity';
import { AiMessageEntity } from '@src/modules/lithography/entities/ai-message.entity';
import { AiReportEntity } from '@src/modules/lithography/entities/ai-report.entity';
import { EngineerResponseEntity } from '@src/modules/lithography/entities/engineer-response.entity';
import { EquipmentModelEntity } from '@src/modules/lithography/entities/equipment-model.entity';
import { ReferenceDocumentEntity } from '@src/modules/lithography/entities/reference-document.entity';
import { RepairRequestEntity } from '@src/modules/lithography/entities/repair-request.entity';
import { CreateAccountUsecase } from '@src/usecases/account/create-account.usecase';
import { DataSource, EntityManager, In } from 'typeorm';

import {
  assertDataSourceOnAllowedE2eDatabase,
  assertPhysicalCleanupConsent,
} from '../utils/e2e-db-guard';
import { createTestAccount, type TestAccountConfig } from '../utils/test-accounts';

export const ADMIN_DOC_FIXTURE_ACCOUNTS = {
  admin: {
    loginName: 'testpr3coreadmin',
    loginEmail: 'pr3.core.admin@example.com',
    loginPassword: 'TestPr3CoreAdmin@2024',
    status: AccountStatus.ACTIVE,
    accessGroup: [IdentityTypeEnum.SUPER_ADMIN],
    identityType: IdentityTypeEnum.SUPER_ADMIN,
  },
  engineer: {
    loginName: 'testpr3coreengineer',
    loginEmail: 'pr3.core.engineer@example.com',
    loginPassword: 'TestPr3CoreEngineer@2024',
    status: AccountStatus.ACTIVE,
    accessGroup: [IdentityTypeEnum.ENGINEER],
    identityType: IdentityTypeEnum.ENGINEER,
  },
  customer: {
    loginName: 'testpr3corecustomer',
    loginEmail: 'pr3.core.customer@example.com',
    loginPassword: 'TestPr3CoreCustomer@2024',
    status: AccountStatus.ACTIVE,
    accessGroup: [IdentityTypeEnum.CUSTOMER],
    identityType: IdentityTypeEnum.CUSTOMER,
  },
} satisfies Record<'admin' | 'engineer' | 'customer', TestAccountConfig>;

export type AdminDocFixtureAccountKey = keyof typeof ADMIN_DOC_FIXTURE_ACCOUNTS;

export const ADMIN_DOC_FIXTURE_MARKERS = {
  modelCode: 'E2E-ADM-DOCDB-CORE-MODEL',
  requestA: 'E2E-ADM-DOCDB-CORE-A',
  requestDeleted: 'E2E-ADM-DOCDB-CORE-DELETED',
  requestOlder: 'E2E-ADM-DOCDB-CORE-OLDER',
  conversationFeedback: 'E2E-ADM-DOCDB-CORE-FEEDBACK',
  messagePrefix: 'E2E-ADM-DOCDB-CORE-MESSAGE',
  reportA: 'E2E-ADM-DOCDB-CORE-REPORT-A',
  reportMismatch: 'E2E-ADM-DOCDB-CORE-REPORT-MISMATCH',
} as const;

const MODEL_SPEC = {
  modelCode: ADMIN_DOC_FIXTURE_MARKERS.modelCode,
  modelName: '管理员聚合型号（普通 spec 专属）',
  enabled: true,
  sortOrder: 510,
} as const;

export type AdminDocFixtureOwnership = {
  accountIds: number[];
  equipmentModelIds: number[];
  repairRequestIds: number[];
  conversationIds: number[];
  messageIds: number[];
  reportIds: number[];
  engineerResponseIds: number[];
};

export type AdminDocFixtureIds = {
  adminAccountId: number;
  engineerAccountId: number;
  customerAccountId: number;
  equipmentModelId: number;
  requestAId: number;
  requestDeletedId: number;
  requestOlderId: number;
  conversationAId: number;
  conversationActiveId: number;
  reportAId: number;
  reportMismatchId: number;
};

export type AdminDocFixtureFailurePoint =
  'after-model' | 'after-first-request' | 'after-conversations' | 'after-messages';

export const createAdminDocFixtureOwnership = (): AdminDocFixtureOwnership => ({
  accountIds: [],
  equipmentModelIds: [],
  repairRequestIds: [],
  conversationIds: [],
  messageIds: [],
  reportIds: [],
  engineerResponseIds: [],
});

const uniquePositiveIds = (ids: readonly number[]): number[] => [
  ...new Set(ids.filter((id) => Number.isInteger(id) && id > 0)),
];

const sameIds = (actual: readonly number[], expected: readonly number[]): boolean => {
  const left = uniquePositiveIds(actual).sort((a, b) => a - b);
  const right = uniquePositiveIds(expected).sort((a, b) => a - b);
  return left.length === right.length && left.every((id, index) => id === right[index]);
};

const ownershipError = (helper: string, detail: string): Error =>
  new Error(`[${helper}] 阶段=归属校验 拒绝删除：${detail}`);

const assertFixtureTarget = async (ds: DataSource, helper: string): Promise<void> => {
  try {
    await assertDataSourceOnAllowedE2eDatabase(ds);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`[${helper}] 阶段=目标库守卫 拒绝执行写入/删除：${detail}`, {
      cause: error,
    });
  }
};

/**
 * 删除专用双门禁（G4/F05）：物理清理许可 + 目标库白名单，互相独立，缺一即在第一条删除前失败。
 * 写入路径（seed*）仍只用库名守卫；许可只约束物理删除。
 */
const assertFixtureDeleteTarget = async (ds: DataSource, helper: string): Promise<void> => {
  try {
    assertPhysicalCleanupConsent();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`[${helper}] 阶段=清理许可门禁 拒绝执行删除：${detail}`, { cause: error });
  }
  await assertFixtureTarget(ds, helper);
};

const recordId = (ids: number[], id: number): void => {
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`夹具创建未返回有效数据库主键：${String(id)}`);
  }
  ids.push(id);
};

const assertValue = (helper: string, label: string, actual: unknown, expected: unknown): void => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw ownershipError(
      helper,
      `${label} 字段不一致（actual=${JSON.stringify(actual)}, expected=${JSON.stringify(expected)}）`,
    );
  }
};

const assertDate = (
  helper: string,
  label: string,
  actual: Date | null,
  expected: Date | null,
): void =>
  assertValue(helper, label, actual?.toISOString() ?? null, expected?.toISOString() ?? null);

const assertNoUnknownIds = (
  helper: string,
  label: string,
  actual: readonly number[],
  expected: readonly number[],
): void => {
  if (!sameIds(actual, expected)) {
    throw ownershipError(
      helper,
      `${label} ID 集合不等于本轮已记录集合（actual=${uniquePositiveIds(actual).join(',') || '空'}; expected=${uniquePositiveIds(expected).join(',') || '空'}）`,
    );
  }
};

const expectedAccountByLoginName = new Map(
  Object.values(ADMIN_DOC_FIXTURE_ACCOUNTS).map((config) => [config.loginName, config]),
);

/**
 * 解析并验证完整夹具图。所有查询都发生在同一事务中；返回前不会执行 DELETE。
 * `expected` 为 null 时用于恢复上轮残留，并以验证通过的实际 ID 建立所有权集合。
 */
const resolveAndVerifyFixture = async (
  manager: EntityManager,
  helper: string,
  expected: AdminDocFixtureOwnership | null,
): Promise<AdminDocFixtureOwnership> => {
  const accountRepo = manager.getRepository(AccountEntity);
  const userInfoRepo = manager.getRepository(UserInfoEntity);
  const modelRepo = manager.getRepository(EquipmentModelEntity);
  const requestRepo = manager.getRepository(RepairRequestEntity);
  const conversationRepo = manager.getRepository(AiConversationEntity);
  const messageRepo = manager.getRepository(AiMessageEntity);
  const reportRepo = manager.getRepository(AiReportEntity);
  const responseRepo = manager.getRepository(EngineerResponseEntity);
  const documentRepo = manager.getRepository(ReferenceDocumentEntity);

  const loginNames = [...expectedAccountByLoginName.keys()];
  const accounts = await accountRepo.find({ where: { loginName: In(loginNames) } });
  for (const account of accounts) {
    const config = account.loginName
      ? expectedAccountByLoginName.get(account.loginName)
      : undefined;
    if (!config) {
      throw ownershipError(helper, `账号 id=${account.id} 的 loginName 不属于普通 spec`);
    }
    assertValue(
      helper,
      `账号 ${config.loginName}.loginEmail`,
      account.loginEmail,
      config.loginEmail,
    );
    assertValue(helper, `账号 ${config.loginName}.status`, account.status, config.status);
    assertValue(
      helper,
      `账号 ${config.loginName}.identityHint`,
      account.identityHint,
      config.identityType,
    );

    const userInfo = await userInfoRepo.findOne({ where: { accountId: account.id } });
    if (!userInfo) {
      throw ownershipError(helper, `账号 ${config.loginName}(id=${account.id}) 缺少 user_info`);
    }
    assertValue(
      helper,
      `账号 ${config.loginName}.nickname`,
      userInfo.nickname,
      `${config.loginName}_nickname`,
    );
    assertValue(helper, `账号 ${config.loginName}.email`, userInfo.email, config.loginEmail);
    assertValue(
      helper,
      `账号 ${config.loginName}.accessGroup`,
      userInfo.accessGroup,
      config.accessGroup,
    );
    assertValue(
      helper,
      `账号 ${config.loginName}.metaDigest`,
      userInfo.metaDigest,
      config.accessGroup,
    );
    assertValue(helper, `账号 ${config.loginName}.userState`, userInfo.userState, UserState.ACTIVE);
  }
  const accountIds = accounts.map((row) => row.id);
  const accountIdSet = new Set(accountIds);
  const accountIdByLoginName = new Map(accounts.map((row) => [row.loginName, row.id]));

  const models = await modelRepo.find({
    where: { modelCode: ADMIN_DOC_FIXTURE_MARKERS.modelCode },
  });
  for (const model of models) {
    assertValue(helper, `型号 id=${model.id}.modelName`, model.modelName, MODEL_SPEC.modelName);
    assertValue(helper, `型号 id=${model.id}.enabled`, model.enabled, MODEL_SPEC.enabled);
    assertValue(helper, `型号 id=${model.id}.sortOrder`, model.sortOrder, MODEL_SPEC.sortOrder);
  }
  const equipmentModelIds = models.map((row) => row.id);
  const modelIdSet = new Set(equipmentModelIds);

  const markerRequestNos: readonly string[] = [
    ADMIN_DOC_FIXTURE_MARKERS.requestA,
    ADMIN_DOC_FIXTURE_MARKERS.requestDeleted,
    ADMIN_DOC_FIXTURE_MARKERS.requestOlder,
  ];
  const requestWhere = [
    { requestNo: In(markerRequestNos) },
    ...(accountIds.length > 0
      ? [{ customerAccountId: In(accountIds) }, { acceptedByEngineerAccountId: In(accountIds) }]
      : []),
    ...(equipmentModelIds.length > 0 ? [{ equipmentModelId: In(equipmentModelIds) }] : []),
  ];
  const requestCandidates = await requestRepo.find({ where: requestWhere });
  const expectedRequestFields = new Map<
    string,
    {
      errorCode: string;
      faultDescription: string;
      contentMd: string;
      createdAt: Date;
      deprecated: boolean;
      deletedAt: Date | null;
    }
  >([
    [
      ADMIN_DOC_FIXTURE_MARKERS.requestA,
      {
        errorCode: 'E-2001',
        faultDescription: '管理员聚合未接单',
        contentMd: '# E2E-ADM-DOCDB-CORE-A',
        createdAt: new Date('2026-08-25T01:00:00.000Z'),
        deprecated: false,
        deletedAt: null,
      },
    ],
    [
      ADMIN_DOC_FIXTURE_MARKERS.requestDeleted,
      {
        errorCode: 'E-2002',
        faultDescription: '已软删除，不应出现',
        contentMd: '# E2E-ADM-DOCDB-CORE-DELETED',
        createdAt: new Date('2026-08-26T01:00:00.000Z'),
        deprecated: true,
        deletedAt: new Date('2026-08-27T01:00:00.000Z'),
      },
    ],
    [
      ADMIN_DOC_FIXTURE_MARKERS.requestOlder,
      {
        errorCode: 'E-2003',
        faultDescription: '管理员聚合未接单二号',
        contentMd: '# E2E-ADM-DOCDB-CORE-OLDER',
        createdAt: new Date('2026-08-20T01:00:00.000Z'),
        deprecated: false,
        deletedAt: null,
      },
    ],
  ]);
  for (const request of requestCandidates) {
    if (!markerRequestNos.includes(request.requestNo)) {
      throw ownershipError(
        helper,
        `外部申请 ${request.requestNo}(id=${request.id}) 引用了普通 spec 的账号或型号`,
      );
    }
    if (!accountIdSet.has(request.customerAccountId) || !modelIdSet.has(request.equipmentModelId)) {
      throw ownershipError(
        helper,
        `申请 ${request.requestNo}(id=${request.id}) 的账号/型号归属不符`,
      );
    }
    const fields = expectedRequestFields.get(request.requestNo);
    if (!fields) {
      throw ownershipError(helper, `申请 ${request.requestNo}(id=${request.id}) 无期望字段定义`);
    }
    assertValue(
      helper,
      `申请 ${request.requestNo}.customerAccountId`,
      request.customerAccountId,
      accountIdByLoginName.get(ADMIN_DOC_FIXTURE_ACCOUNTS.customer.loginName),
    );
    assertValue(
      helper,
      `申请 ${request.requestNo}.equipmentModelId`,
      request.equipmentModelId,
      equipmentModelIds[0],
    );
    assertValue(helper, `申请 ${request.requestNo}.errorCode`, request.errorCode, fields.errorCode);
    assertValue(
      helper,
      `申请 ${request.requestNo}.faultDescription`,
      request.faultDescription,
      fields.faultDescription,
    );
    assertValue(helper, `申请 ${request.requestNo}.contentMd`, request.contentMd, fields.contentMd);
    assertDate(helper, `申请 ${request.requestNo}.createdAt`, request.createdAt, fields.createdAt);
    assertValue(helper, `申请 ${request.requestNo}.isAccepted`, request.isAccepted, false);
    assertValue(
      helper,
      `申请 ${request.requestNo}.acceptedByEngineerAccountId`,
      request.acceptedByEngineerAccountId,
      null,
    );
    assertValue(
      helper,
      `申请 ${request.requestNo}.deprecated`,
      request.deprecated,
      fields.deprecated,
    );
    assertDate(helper, `申请 ${request.requestNo}.deletedAt`, request.deletedAt, fields.deletedAt);
  }
  const repairRequestIds = requestCandidates.map((row) => row.id);
  const requestIdSet = new Set(repairRequestIds);
  const requestIdByNo = new Map(requestCandidates.map((row) => [row.requestNo, row.id]));

  const conversationCandidates =
    repairRequestIds.length === 0 && accountIds.length === 0
      ? []
      : await conversationRepo.find({
          where: [
            ...(repairRequestIds.length > 0 ? [{ requestId: In(repairRequestIds) }] : []),
            ...(accountIds.length > 0 ? [{ engineerAccountId: In(accountIds) }] : []),
          ],
        });
  const engineerAccountId = accountIdByLoginName.get(ADMIN_DOC_FIXTURE_ACCOUNTS.engineer.loginName);
  let completedConversationCount = 0;
  let activeConversationCount = 0;
  let completedConversationId: number | undefined;
  let activeConversationId: number | undefined;
  for (const conversation of conversationCandidates) {
    if (
      !requestIdSet.has(conversation.requestId) ||
      !accountIdSet.has(conversation.engineerAccountId)
    ) {
      throw ownershipError(helper, `会话 id=${conversation.id} 的申请/工程师归属不符`);
    }
    const isCompleted =
      conversation.status === AiConversationStatus.COMPLETED &&
      conversation.aiFeedback === ADMIN_DOC_FIXTURE_MARKERS.conversationFeedback &&
      conversation.completedAt !== null;
    const isActive =
      conversation.status === AiConversationStatus.ACTIVE &&
      conversation.aiFeedback === null &&
      conversation.completedAt === null;
    if (!isCompleted && !isActive) {
      throw ownershipError(helper, `会话 id=${conversation.id} 字段不属于普通 spec`);
    }
    assertValue(
      helper,
      `会话 id=${conversation.id}.requestId`,
      conversation.requestId,
      requestIdByNo.get(ADMIN_DOC_FIXTURE_MARKERS.requestA),
    );
    assertValue(
      helper,
      `会话 id=${conversation.id}.engineerAccountId`,
      conversation.engineerAccountId,
      engineerAccountId,
    );
    if (isCompleted) {
      completedConversationCount += 1;
      completedConversationId = conversation.id;
      assertDate(
        helper,
        `会话 id=${conversation.id}.createdAt`,
        conversation.createdAt,
        new Date('2026-09-02T09:00:00.000Z'),
      );
      assertDate(
        helper,
        `会话 id=${conversation.id}.completedAt`,
        conversation.completedAt,
        new Date('2026-09-02T10:00:00.000Z'),
      );
    } else {
      activeConversationCount += 1;
      activeConversationId = conversation.id;
      assertDate(
        helper,
        `会话 id=${conversation.id}.createdAt`,
        conversation.createdAt,
        new Date('2026-09-03T09:00:00.000Z'),
      );
    }
  }
  if (completedConversationCount > 1 || activeConversationCount > 1) {
    throw ownershipError(helper, '会话角色重复，存在无法确认归属的额外会话');
  }
  const conversationIds = conversationCandidates.map((row) => row.id);
  const conversationIdSet = new Set(conversationIds);

  const messages =
    conversationIds.length === 0
      ? []
      : await messageRepo.find({ where: { conversationId: In(conversationIds) } });
  for (const message of messages) {
    if (!conversationIdSet.has(message.conversationId)) {
      throw ownershipError(helper, `消息 id=${message.id} 的会话归属不符`);
    }
    assertValue(
      helper,
      `消息 id=${message.id}.conversationId`,
      message.conversationId,
      completedConversationId,
    );
    assertValue(
      helper,
      `消息 id=${message.id}.contentText`,
      message.contentText,
      `${ADMIN_DOC_FIXTURE_MARKERS.messagePrefix}-${message.messageSeq}`,
    );
    assertValue(
      helper,
      `消息 id=${message.id}.turnNo`,
      message.turnNo,
      Math.ceil(message.messageSeq / 2),
    );
    const expectedRole =
      message.messageSeq % 2 === 1 ? AiMessageRole.USER : AiMessageRole.ASSISTANT;
    assertValue(helper, `消息 id=${message.id}.role`, message.role, expectedRole);
  }
  const messageIds = messages.map((row) => row.id);

  const reportCandidates =
    repairRequestIds.length === 0 && conversationIds.length === 0 && accountIds.length === 0
      ? []
      : await reportRepo.find({
          where: [
            ...(repairRequestIds.length > 0 ? [{ requestId: In(repairRequestIds) }] : []),
            ...(conversationIds.length > 0 ? [{ conversationId: In(conversationIds) }] : []),
            ...(accountIds.length > 0 ? [{ engineerAccountId: In(accountIds) }] : []),
          ],
        });
  const expectedReportFields = new Map<
    string,
    {
      requestId: number | undefined;
      conversationId: number | undefined;
      reportType: string;
      contentMd: string;
      createdAt: Date;
    }
  >([
    [
      ADMIN_DOC_FIXTURE_MARKERS.reportA,
      {
        requestId: requestIdByNo.get(ADMIN_DOC_FIXTURE_MARKERS.requestA),
        conversationId: completedConversationId,
        reportType: 'DIAGNOSIS',
        contentMd: '# 普通 spec 报告 A 正文',
        createdAt: new Date('2026-09-02T10:30:00.000Z'),
      },
    ],
    [
      ADMIN_DOC_FIXTURE_MARKERS.reportMismatch,
      {
        requestId: requestIdByNo.get(ADMIN_DOC_FIXTURE_MARKERS.requestDeleted),
        conversationId: activeConversationId,
        reportType: 'TROUBLESHOOTING',
        contentMd: '# 普通 spec 报告 mismatch 正文',
        createdAt: new Date('2026-09-03T10:30:00.000Z'),
      },
    ],
  ]);
  const seenReportTitles = new Set<string>();
  for (const report of reportCandidates) {
    if (
      !requestIdSet.has(report.requestId) ||
      !conversationIdSet.has(report.conversationId) ||
      !accountIdSet.has(report.engineerAccountId)
    ) {
      throw ownershipError(helper, `报告 id=${report.id} 的申请/会话/工程师归属不符`);
    }
    const fields = expectedReportFields.get(report.reportTitle);
    if (!fields || seenReportTitles.has(report.reportTitle)) {
      throw ownershipError(helper, `报告 id=${report.id} 标题不属于普通 spec`);
    }
    seenReportTitles.add(report.reportTitle);
    assertValue(helper, `报告 ${report.reportTitle}.requestId`, report.requestId, fields.requestId);
    assertValue(
      helper,
      `报告 ${report.reportTitle}.conversationId`,
      report.conversationId,
      fields.conversationId,
    );
    assertValue(
      helper,
      `报告 ${report.reportTitle}.engineerAccountId`,
      report.engineerAccountId,
      engineerAccountId,
    );
    assertValue(
      helper,
      `报告 ${report.reportTitle}.reportType`,
      report.reportType,
      fields.reportType,
    );
    assertValue(helper, `报告 ${report.reportTitle}.contentMd`, report.contentMd, fields.contentMd);
    assertDate(helper, `报告 ${report.reportTitle}.createdAt`, report.createdAt, fields.createdAt);
  }
  const reportIds = reportCandidates.map((row) => row.id);

  const responses =
    repairRequestIds.length === 0 && accountIds.length === 0
      ? []
      : await responseRepo.find({
          where: [
            ...(repairRequestIds.length > 0 ? [{ requestId: In(repairRequestIds) }] : []),
            ...(accountIds.length > 0
              ? [{ engineerAccountId: In(accountIds) }, { customerAccountId: In(accountIds) }]
              : []),
          ],
        });
  const engineerResponseIds = responses.map((row) => row.id);
  if (responses.length > 0) {
    throw ownershipError(
      helper,
      `普通 spec 不创建工程师回复，但发现引用行 id=${engineerResponseIds.join(',')}`,
    );
  }

  const documents =
    equipmentModelIds.length === 0 && accountIds.length === 0
      ? []
      : await documentRepo.find({
          where: [
            ...(equipmentModelIds.length > 0 ? [{ equipmentModelId: In(equipmentModelIds) }] : []),
            ...(accountIds.length > 0 ? [{ createdByAccountId: In(accountIds) }] : []),
          ],
          select: { id: true },
        });
  if (documents.length > 0) {
    throw ownershipError(
      helper,
      `发现外部参考资料引用普通 spec 账号或型号：${documents.map((row) => row.id).join(',')}`,
    );
  }

  const resolved: AdminDocFixtureOwnership = {
    accountIds,
    equipmentModelIds,
    repairRequestIds,
    conversationIds,
    messageIds,
    reportIds,
    engineerResponseIds,
  };

  if (expected) {
    assertNoUnknownIds(helper, '账号', resolved.accountIds, expected.accountIds);
    assertNoUnknownIds(helper, '型号', resolved.equipmentModelIds, expected.equipmentModelIds);
    assertNoUnknownIds(helper, '申请', resolved.repairRequestIds, expected.repairRequestIds);
    assertNoUnknownIds(helper, '会话', resolved.conversationIds, expected.conversationIds);
    assertNoUnknownIds(helper, '消息', resolved.messageIds, expected.messageIds);
    assertNoUnknownIds(helper, '报告', resolved.reportIds, expected.reportIds);
    assertNoUnknownIds(
      helper,
      '工程师回复',
      resolved.engineerResponseIds,
      expected.engineerResponseIds,
    );
  }

  return resolved;
};

const deleteVerifiedFixture = async (
  manager: EntityManager,
  verified: AdminDocFixtureOwnership,
): Promise<void> => {
  if (verified.reportIds.length > 0) {
    await manager.getRepository(AiReportEntity).delete({ id: In(verified.reportIds) });
  }
  if (verified.messageIds.length > 0) {
    await manager.getRepository(AiMessageEntity).delete({ id: In(verified.messageIds) });
  }
  if (verified.engineerResponseIds.length > 0) {
    await manager
      .getRepository(EngineerResponseEntity)
      .delete({ id: In(verified.engineerResponseIds) });
  }
  if (verified.conversationIds.length > 0) {
    await manager.getRepository(AiConversationEntity).delete({ id: In(verified.conversationIds) });
  }
  if (verified.repairRequestIds.length > 0) {
    await manager.getRepository(RepairRequestEntity).delete({ id: In(verified.repairRequestIds) });
  }
  if (verified.equipmentModelIds.length > 0) {
    await manager
      .getRepository(EquipmentModelEntity)
      .delete({ id: In(verified.equipmentModelIds) });
  }
  if (verified.accountIds.length > 0) {
    await manager.getRepository(UserInfoEntity).delete({ accountId: In(verified.accountIds) });
    await manager.getRepository(AccountEntity).delete({ id: In(verified.accountIds) });
  }
};

const hasOwnershipIds = (ownership: AdminDocFixtureOwnership): boolean =>
  Object.values(ownership).some((ids) => ids.length > 0);

/** 恢复上轮崩溃残留：专属标记定位 → 全图归属核验 → 事务内精确回收。 */
export const cleanupAdminDocumentFixtureResidue = async (
  ds: DataSource,
): Promise<AdminDocFixtureOwnership> => {
  const helper = 'cleanupAdminDocumentFixtureResidue';
  await assertFixtureDeleteTarget(ds, helper);
  return ds.transaction(async (manager) => {
    const verified = await resolveAndVerifyFixture(manager, helper, null);
    await deleteVerifiedFixture(manager, verified);
    return verified;
  });
};

/** 本轮收尾：只接受运行时记录 ID，并在事务内重新核验完整归属后删除。 */
export const cleanupAdminDocumentFixtureByIds = async (
  ds: DataSource,
  ownership: AdminDocFixtureOwnership,
): Promise<void> => {
  if (!hasOwnershipIds(ownership)) {
    return;
  }
  const helper = 'cleanupAdminDocumentFixtureByIds';
  await assertFixtureDeleteTarget(ds, helper);
  await ds.transaction(async (manager) => {
    const verified = await resolveAndVerifyFixture(manager, helper, ownership);
    await deleteVerifiedFixture(manager, verified);
  });
};

export const seedAdminDocumentFixtureAccounts = async (opts: {
  dataSource: DataSource;
  ownership: AdminDocFixtureOwnership;
  createAccountUsecase?: CreateAccountUsecase | null;
}): Promise<Record<AdminDocFixtureAccountKey, number>> => {
  await assertFixtureTarget(opts.dataSource, 'seedAdminDocumentFixtureAccounts');
  const result = {} as Record<AdminDocFixtureAccountKey, number>;
  const keys = Object.keys(ADMIN_DOC_FIXTURE_ACCOUNTS) as AdminDocFixtureAccountKey[];
  for (const key of keys) {
    const created = await createTestAccount(
      opts.dataSource,
      opts.createAccountUsecase ?? null,
      ADMIN_DOC_FIXTURE_ACCOUNTS[key],
    );
    recordId(opts.ownership.accountIds, created.accountId);
    result[key] = created.accountId;
  }
  return result;
};

/** 创建普通 spec 完整业务图；测试可注入阶段失败以验证 beforeAll 部分成功清理。 */
export const seedAdminDocumentFixtureBusiness = async (opts: {
  dataSource: DataSource;
  ownership: AdminDocFixtureOwnership;
  customerAccountId: number;
  engineerAccountId: number;
  failurePoint?: AdminDocFixtureFailurePoint;
}): Promise<
  Omit<AdminDocFixtureIds, 'adminAccountId' | 'customerAccountId' | 'engineerAccountId'>
> => {
  const { dataSource, ownership, customerAccountId, engineerAccountId, failurePoint } = opts;
  await assertFixtureTarget(dataSource, 'seedAdminDocumentFixtureBusiness');

  const modelRepo = dataSource.getRepository(EquipmentModelEntity);
  const requestRepo = dataSource.getRepository(RepairRequestEntity);
  const conversationRepo = dataSource.getRepository(AiConversationEntity);
  const messageRepo = dataSource.getRepository(AiMessageEntity);
  const reportRepo = dataSource.getRepository(AiReportEntity);

  const model = await modelRepo.save(modelRepo.create(MODEL_SPEC));
  recordId(ownership.equipmentModelIds, model.id);
  if (failurePoint === 'after-model') {
    throw new Error('注入 beforeAll 失败：after-model');
  }

  const requestA = await requestRepo.save(
    requestRepo.create({
      requestNo: ADMIN_DOC_FIXTURE_MARKERS.requestA,
      customerAccountId,
      equipmentModelId: model.id,
      errorCode: 'E-2001',
      faultDescription: '管理员聚合未接单',
      contentMd: '# E2E-ADM-DOCDB-CORE-A',
      createdAt: new Date('2026-08-25T01:00:00.000Z'),
      isAccepted: false,
      acceptedByEngineerAccountId: null,
      acceptedAt: null,
      deprecated: false,
      deletedAt: null,
    }),
  );
  recordId(ownership.repairRequestIds, requestA.id);
  if (failurePoint === 'after-first-request') {
    throw new Error('注入 beforeAll 失败：after-first-request');
  }

  const requestDeleted = await requestRepo.save(
    requestRepo.create({
      requestNo: ADMIN_DOC_FIXTURE_MARKERS.requestDeleted,
      customerAccountId,
      equipmentModelId: model.id,
      errorCode: 'E-2002',
      faultDescription: '已软删除，不应出现',
      contentMd: '# E2E-ADM-DOCDB-CORE-DELETED',
      createdAt: new Date('2026-08-26T01:00:00.000Z'),
      isAccepted: false,
      acceptedByEngineerAccountId: null,
      acceptedAt: null,
      deprecated: true,
      deletedAt: new Date('2026-08-27T01:00:00.000Z'),
    }),
  );
  recordId(ownership.repairRequestIds, requestDeleted.id);

  const requestOlder = await requestRepo.save(
    requestRepo.create({
      requestNo: ADMIN_DOC_FIXTURE_MARKERS.requestOlder,
      customerAccountId,
      equipmentModelId: model.id,
      errorCode: 'E-2003',
      faultDescription: '管理员聚合未接单二号',
      contentMd: '# E2E-ADM-DOCDB-CORE-OLDER',
      createdAt: new Date('2026-08-20T01:00:00.000Z'),
      isAccepted: false,
      acceptedByEngineerAccountId: null,
      acceptedAt: null,
      deprecated: false,
      deletedAt: null,
    }),
  );
  recordId(ownership.repairRequestIds, requestOlder.id);

  const conversationA = await conversationRepo.save(
    conversationRepo.create({
      requestId: requestA.id,
      engineerAccountId,
      status: AiConversationStatus.COMPLETED,
      aiFeedback: ADMIN_DOC_FIXTURE_MARKERS.conversationFeedback,
      completedAt: new Date('2026-09-02T10:00:00.000Z'),
      createdAt: new Date('2026-09-02T09:00:00.000Z'),
    }),
  );
  recordId(ownership.conversationIds, conversationA.id);
  const conversationActive = await conversationRepo.save(
    conversationRepo.create({
      requestId: requestA.id,
      engineerAccountId,
      status: AiConversationStatus.ACTIVE,
      aiFeedback: null,
      completedAt: null,
      createdAt: new Date('2026-09-03T09:00:00.000Z'),
    }),
  );
  recordId(ownership.conversationIds, conversationActive.id);
  if (failurePoint === 'after-conversations') {
    throw new Error('注入 beforeAll 失败：after-conversations');
  }

  const messages = Array.from({ length: 200 }, (_, index) => {
    const messageSeq = index + 1;
    return messageRepo.create({
      conversationId: conversationA.id,
      messageSeq,
      turnNo: Math.ceil(messageSeq / 2),
      role: messageSeq % 2 === 1 ? AiMessageRole.USER : AiMessageRole.ASSISTANT,
      contentText: `${ADMIN_DOC_FIXTURE_MARKERS.messagePrefix}-${messageSeq}`,
      createdAt: new Date(2026, 8, 2, 9, 0, Math.floor(messageSeq / 60), (messageSeq % 60) * 1000),
    });
  });
  const savedMessages = await messageRepo.save(messages);
  for (const message of savedMessages) {
    recordId(ownership.messageIds, message.id);
  }
  if (failurePoint === 'after-messages') {
    throw new Error('注入 beforeAll 失败：after-messages');
  }

  const reportA = await reportRepo.save(
    reportRepo.create({
      requestId: requestA.id,
      conversationId: conversationA.id,
      engineerAccountId,
      reportTitle: ADMIN_DOC_FIXTURE_MARKERS.reportA,
      reportType: 'DIAGNOSIS',
      contentMd: '# 普通 spec 报告 A 正文',
      createdAt: new Date('2026-09-02T10:30:00.000Z'),
    }),
  );
  recordId(ownership.reportIds, reportA.id);
  const reportMismatch = await reportRepo.save(
    reportRepo.create({
      requestId: requestDeleted.id,
      conversationId: conversationActive.id,
      engineerAccountId,
      reportTitle: ADMIN_DOC_FIXTURE_MARKERS.reportMismatch,
      reportType: 'TROUBLESHOOTING',
      contentMd: '# 普通 spec 报告 mismatch 正文',
      createdAt: new Date('2026-09-03T10:30:00.000Z'),
    }),
  );
  recordId(ownership.reportIds, reportMismatch.id);

  return {
    equipmentModelId: model.id,
    requestAId: requestA.id,
    requestDeletedId: requestDeleted.id,
    requestOlderId: requestOlder.id,
    conversationAId: conversationA.id,
    conversationActiveId: conversationActive.id,
    reportAId: reportA.id,
    reportMismatchId: reportMismatch.id,
  };
};

/** afterAll 收尾所需的窄接口（便于 mock app/dataSource，不引入 Nest 类型耦合）。 */
export type AdminDocFixtureTeardownParams = {
  app?: { close: () => Promise<void> } | null;
  dataSource?: DataSource | null;
  targetValidated: boolean;
  cleanup: (ds: DataSource) => Promise<void>;
};

export const shouldRunAdminDocFixtureCleanup = (params: {
  dataSource?: DataSource | null;
  targetValidated: boolean;
}): boolean => Boolean(params.targetValidated && params.dataSource?.isInitialized);

export const runAdminDocFixtureTeardown = async (
  params: AdminDocFixtureTeardownParams,
): Promise<void> => {
  let cleanupError: Error | undefined;
  let closeError: Error | undefined;

  try {
    if (shouldRunAdminDocFixtureCleanup(params) && params.dataSource) {
      await params.cleanup(params.dataSource);
    }
  } catch (error) {
    cleanupError = error instanceof Error ? error : new Error(String(error));
  } finally {
    if (params.app) {
      try {
        await params.app.close();
      } catch (error) {
        closeError = error instanceof Error ? error : new Error(String(error));
      }
    }
  }

  if (cleanupError) {
    throw cleanupError;
  }
  if (closeError) {
    throw closeError;
  }
};
