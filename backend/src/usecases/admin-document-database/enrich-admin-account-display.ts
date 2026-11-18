// src/usecases/admin-document-database/enrich-admin-account-display.ts

import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import type {
  AdminAiConversationListItemQueryResult,
  AdminAiConversationListItemView,
  AdminAiReportDetailQueryResult,
  AdminAiReportDetailView,
  AdminAiReportListItemQueryResult,
  AdminAiReportListItemView,
  AdminRepairRequestListItemQueryResult,
  AdminRepairRequestListItemView,
  AdminRepairRequestSummaryQueryResult,
  AdminRepairRequestSummaryView,
} from '@src/modules/lithography/admin-document-database.types';

/** 客户展示昵称缺失时的安全回落（与参考资料创建人回落同口径） */
const ADMIN_CUSTOMER_NICKNAME_FALLBACK = '未知用户';

/** 工程师昵称缺失回落（与维修申请回复富集 ENGINEER_NICKNAME_FALLBACK 同口径） */
const ADMIN_ENGINEER_NICKNAME_FALLBACK = '工程师';

function stripKeys<T extends object>(view: T, keys: ReadonlyArray<keyof T>): T {
  const clone = { ...view };
  for (const key of keys) {
    delete clone[key];
  }
  return clone;
}

/**
 * 管理员维修申请列表富集（批量，一次账户域查询）：
 * 客户（昵称+公司名）与接单工程师（昵称）展示信息经账户域批量读取后填充，
 * 并剥离归属类账号 ID（customerAccountId / acceptedByEngineerAccountId 不对外输出）。
 */
export async function enrichAdminRepairRequestListItems(
  accountQueryService: AccountQueryService,
  items: AdminRepairRequestListItemQueryResult[],
): Promise<AdminRepairRequestListItemView[]> {
  if (items.length === 0) {
    return [];
  }
  const accountIds = items.flatMap((item) =>
    item.acceptedByEngineerAccountId !== null
      ? [item.customerAccountId, item.acceptedByEngineerAccountId]
      : [item.customerAccountId],
  );
  const displayInfos = await accountQueryService.findAccountDisplayInfosByAccountIds(accountIds);

  return items.map((item) => {
    const customer = displayInfos.get(item.customerAccountId);
    const engineer =
      item.acceptedByEngineerAccountId !== null
        ? displayInfos.get(item.acceptedByEngineerAccountId)
        : undefined;
    const view = stripKeys(item, ['customerAccountId', 'acceptedByEngineerAccountId']);
    return {
      ...view,
      customerNickname: customer?.nickname ?? ADMIN_CUSTOMER_NICKNAME_FALLBACK,
      companyName: customer?.companyName ?? null,
      acceptedByEngineerNickname:
        item.acceptedByEngineerAccountId !== null
          ? (engineer?.nickname ?? ADMIN_ENGINEER_NICKNAME_FALLBACK)
          : null,
    };
  });
}

/**
 * 管理员维修申请详情富集（单条，一次账户域批量查询）：
 * 客户、接单工程师、回复工程师与修订人展示昵称统一填充，
 * 并剥离所有归属类账号 ID。
 */
export async function enrichAdminRepairRequestSummary(
  accountQueryService: AccountQueryService,
  result: AdminRepairRequestSummaryQueryResult,
): Promise<AdminRepairRequestSummaryView> {
  const accountIds = new Set<number>([result.customerAccountId]);
  if (result.acceptedByEngineerAccountId !== null) {
    accountIds.add(result.acceptedByEngineerAccountId);
  }
  for (const response of result.responses) {
    accountIds.add(response.engineerAccountId);
  }
  for (const revision of result.revisions) {
    accountIds.add(revision.actorAccountId);
  }
  const displayInfos = await accountQueryService.findAccountDisplayInfosByAccountIds([
    ...accountIds,
  ]);
  const customer = displayInfos.get(result.customerAccountId);
  const engineer =
    result.acceptedByEngineerAccountId !== null
      ? displayInfos.get(result.acceptedByEngineerAccountId)
      : undefined;
  const view = stripKeys(result, ['customerAccountId', 'acceptedByEngineerAccountId']);
  return {
    ...view,
    customerNickname: customer?.nickname ?? ADMIN_CUSTOMER_NICKNAME_FALLBACK,
    companyName: customer?.companyName ?? null,
    acceptedByEngineerNickname:
      result.acceptedByEngineerAccountId !== null
        ? (engineer?.nickname ?? ADMIN_ENGINEER_NICKNAME_FALLBACK)
        : null,
    responses: result.responses.map((response) => ({
      ...stripKeys(response, ['engineerAccountId', 'customerAccountId']),
      engineerNickname:
        displayInfos.get(response.engineerAccountId)?.nickname ?? ADMIN_ENGINEER_NICKNAME_FALLBACK,
    })),
    revisions: result.revisions.map((revision) => ({
      ...stripKeys(revision, ['actorAccountId']),
      actorNickname:
        displayInfos.get(revision.actorAccountId)?.nickname ?? ADMIN_ENGINEER_NICKNAME_FALLBACK,
    })),
  };
}

/**
 * 管理员 AI 会话列表富集（批量）：工程师昵称经账户域批量读取后填充，
 * 剥离 engineerAccountId。缺失昵称回落「工程师」。
 */
export async function enrichAdminAiConversationListItems(
  accountQueryService: AccountQueryService,
  items: AdminAiConversationListItemQueryResult[],
): Promise<AdminAiConversationListItemView[]> {
  if (items.length === 0) {
    return [];
  }
  const engineerAccountIds = items.map((item) => item.engineerAccountId);
  const nicknames = await accountQueryService.findNicknamesByAccountIds(engineerAccountIds);
  return items.map((item) => {
    const view = stripKeys(item, ['engineerAccountId']);
    return {
      ...view,
      engineerNickname: nicknames.get(item.engineerAccountId) ?? ADMIN_ENGINEER_NICKNAME_FALLBACK,
    };
  });
}

/** 管理员 AI 报告列表富集（批量）：口径与会话富集一致 */
export async function enrichAdminAiReportListItems(
  accountQueryService: AccountQueryService,
  items: AdminAiReportListItemQueryResult[],
): Promise<AdminAiReportListItemView[]> {
  if (items.length === 0) {
    return [];
  }
  const engineerAccountIds = items.map((item) => item.engineerAccountId);
  const nicknames = await accountQueryService.findNicknamesByAccountIds(engineerAccountIds);
  return items.map((item) => {
    const view = stripKeys(item, ['engineerAccountId']);
    return {
      ...view,
      engineerNickname: nicknames.get(item.engineerAccountId) ?? ADMIN_ENGINEER_NICKNAME_FALLBACK,
    };
  });
}

/** 管理员 AI 报告详情富集（单条，含正文）：口径与列表富集一致 */
export async function enrichAdminAiReportDetail(
  accountQueryService: AccountQueryService,
  result: AdminAiReportDetailQueryResult,
): Promise<AdminAiReportDetailView> {
  const nicknames = await accountQueryService.findNicknamesByAccountIds([result.engineerAccountId]);
  const view = stripKeys(result, ['engineerAccountId']);
  return {
    ...view,
    engineerNickname: nicknames.get(result.engineerAccountId) ?? ADMIN_ENGINEER_NICKNAME_FALLBACK,
  };
}
