// src/usecases/repair-request/enrich-repair-request-nicknames.ts

import { RepairRequestAcceptanceViewStatus } from '@app-types/models/repair-request.types';
import {
  AccountDisplayProfile,
  AccountQueryService,
} from '@src/modules/account/queries/account.query.service';
import {
  EngineerResponseView,
  RepairRequestDetailQueryResult,
  RepairRequestDetailView,
  RepairRequestEngineerDetailView,
  RepairRequestEngineerListItemQueryResult,
  RepairRequestEngineerListItemView,
} from '@src/modules/lithography/lithography.types';

/** 昵称缺失时的安全回落展示（负责人 20260901 裁定 3） */
const ENGINEER_NICKNAME_FALLBACK = '工程师';

/** 客户昵称缺失时的安全回落展示（与工程师回落同一「读时关联 + 缺失回落」口径） */
const CUSTOMER_NICKNAME_FALLBACK = '客户';

/**
 * 接单状态视角计算（当前会话事实分类，非权限决策）：
 * 未接单 → AVAILABLE；接单人为当前会话 → MINE；否则 → TAKEN_BY_OTHER。
 */
export function computeAcceptanceViewStatus(
  isAccepted: boolean,
  acceptedByEngineerAccountId: number | null,
  viewerAccountId: number,
): RepairRequestAcceptanceViewStatus {
  if (!isAccepted) {
    return RepairRequestAcceptanceViewStatus.AVAILABLE;
  }
  return acceptedByEngineerAccountId === viewerAccountId
    ? RepairRequestAcceptanceViewStatus.MINE
    : RepairRequestAcceptanceViewStatus.TAKEN_BY_OTHER;
}

/**
 * 单条回复昵称解析：与详情批量富集共用「昵称缺失回落工程师」规则
 * （回复写用例在开启写事务前读取当前工程师安全昵称时使用）
 */
export async function resolveEngineerNickname(
  accountQueryService: AccountQueryService,
  engineerAccountId: number,
): Promise<string> {
  const nicknames = await accountQueryService.findNicknamesByAccountIds([engineerAccountId]);
  return nicknames.get(engineerAccountId) ?? ENGINEER_NICKNAME_FALLBACK;
}

/**
 * 回复装配/写入结果 → 稳定读视图（单一映射口径，避免批量与单条各自拼装）；
 * 参数仅要求读视图除昵称外的四个字段，详情批量装配结果与写事务快照均可直接传入
 */
export function toEngineerResponseView(
  response: Omit<EngineerResponseView, 'engineerNickname'>,
  engineerNickname: string,
): EngineerResponseView {
  return {
    id: response.id,
    engineerNickname,
    resolutionStatus: response.resolutionStatus,
    responseText: response.responseText,
    createdAt: response.createdAt,
  };
}

/**
 * 详情昵称富集：把 QueryService 装配结果中的工程师账号 ID 关联为当前安全昵称。
 *
 * - 跨域读取经账号域 QueryService 契约（usecase 编排，不直接跨域读表）
 * - 一次批量查询，避免逐条回复 N+1
 * - 昵称缺失/空白回落「工程师」；工程师账号 ID 不进入对外视图
 */
export async function enrichRepairRequestDetailNicknames(
  accountQueryService: AccountQueryService,
  result: RepairRequestDetailQueryResult,
): Promise<RepairRequestDetailView> {
  const engineerAccountIds = result.responses.map((response) => response.engineerAccountId);
  const nicknames = await accountQueryService.findNicknamesByAccountIds(engineerAccountIds);
  // 显式逐字段装配：QueryResult 上的归属类账号 ID 属内部富集输入，
  // 不进入对外视图（与 enrichEngineerRepairRequestDetail 同一口径，编译期防泄漏）
  return {
    id: result.id,
    requestNo: result.requestNo,
    equipmentModel: result.equipmentModel,
    errorCode: result.errorCode,
    faultDescription: result.faultDescription,
    contentMd: result.contentMd,
    createdAt: result.createdAt,
    isAccepted: result.isAccepted,
    acceptedAt: result.acceptedAt,
    latestResolutionStatus: result.latestResolutionStatus,
    responses: result.responses.map((response) =>
      toEngineerResponseView(
        response,
        nicknames.get(response.engineerAccountId) ?? ENGINEER_NICKNAME_FALLBACK,
      ),
    ),
    closureStatus: result.closureStatus,
    closedAt: result.closedAt,
    closureReason: result.closureReason,
    handlingResult: result.handlingResult,
    handlingStatus: result.handlingStatus,
    // 客户视图不包含任何内部维修过程、结构化维修记录、原件或 AI 分析
    // （即使未来读服务装配口径变化也不外泄）
    processEntries: [],
    maintenance: null,
    maintenanceSteps: [],
    maintenanceFaultPanels: [],
    intake: null,
    canEditMaintenance: false,
  };
}

/**
 * 工程师列表批量富集：把归属账号 ID 关联为客户/接单工程师安全展示资料，
 * 并计算当前会话视角状态。
 *
 * - 一次批量账号资料查询（客户 + 接单工程师合并去重），禁止逐行 N+1
 * - 昵称缺失/空白回落「客户」/「工程师」；账号 ID 不进入对外视图
 */
export async function enrichEngineerListItems(
  accountQueryService: AccountQueryService,
  items: RepairRequestEngineerListItemQueryResult[],
  viewerAccountId: number,
): Promise<RepairRequestEngineerListItemView[]> {
  const profileAccountIds = items.flatMap((item) => [
    item.customerAccountId,
    ...(item.acceptedByEngineerAccountId !== null ? [item.acceptedByEngineerAccountId] : []),
  ]);
  const profiles =
    await accountQueryService.findAccountDisplayProfilesByAccountIds(profileAccountIds);
  return items.map((item) => {
    const acceptedProfile: AccountDisplayProfile | undefined =
      item.acceptedByEngineerAccountId !== null
        ? profiles.get(item.acceptedByEngineerAccountId)
        : undefined;
    return {
      id: item.id,
      requestNo: item.requestNo,
      equipmentModel: item.equipmentModel,
      errorCode: item.errorCode,
      createdAt: item.createdAt,
      isAccepted: item.isAccepted,
      acceptedAt: item.acceptedAt,
      latestResolutionStatus: item.latestResolutionStatus,
      closureStatus: item.closureStatus,
      closedAt: item.closedAt,
      handlingResult: item.handlingResult,
      handlingStatus: item.handlingStatus,
      customerNickname:
        profiles.get(item.customerAccountId)?.nickname ?? CUSTOMER_NICKNAME_FALLBACK,
      customerCompanyName: profiles.get(item.customerAccountId)?.companyName ?? null,
      acceptanceViewStatus: computeAcceptanceViewStatus(
        item.isAccepted,
        item.acceptedByEngineerAccountId,
        viewerAccountId,
      ),
      acceptedEngineerNickname: acceptedProfile ? acceptedProfile.nickname : null,
    };
  });
}

/**
 * 工程师详情富集：客户/接单工程师展示资料与当前会话视角状态。
 * 回复工程师昵称与客户/接单人资料合并为一次批量账号查询，禁止 N+1；
 * 归属类账号 ID 不进入对外视图。
 */
export async function enrichEngineerRepairRequestDetail(
  accountQueryService: AccountQueryService,
  result: RepairRequestDetailQueryResult,
  viewerAccountId: number,
): Promise<RepairRequestEngineerDetailView> {
  const [nicknames, profiles] = await Promise.all([
    accountQueryService.findNicknamesByAccountIds(
      result.responses.map((response) => response.engineerAccountId),
    ),
    accountQueryService.findAccountDisplayProfilesByAccountIds([
      result.customerAccountId,
      ...(result.acceptedByEngineerAccountId !== null ? [result.acceptedByEngineerAccountId] : []),
    ]),
  ]);
  const customerProfile = profiles.get(result.customerAccountId);
  const acceptedProfile =
    result.acceptedByEngineerAccountId !== null
      ? profiles.get(result.acceptedByEngineerAccountId)
      : undefined;
  // 显式装配：昵称查询与展示资料查询各一次，归属类账号 ID 不进入对外视图
  return {
    id: result.id,
    requestNo: result.requestNo,
    equipmentModel: result.equipmentModel,
    errorCode: result.errorCode,
    faultDescription: result.faultDescription,
    contentMd: result.contentMd,
    createdAt: result.createdAt,
    isAccepted: result.isAccepted,
    acceptedAt: result.acceptedAt,
    latestResolutionStatus: result.latestResolutionStatus,
    responses: result.responses.map((response) =>
      toEngineerResponseView(
        response,
        nicknames.get(response.engineerAccountId) ?? ENGINEER_NICKNAME_FALLBACK,
      ),
    ),
    closureStatus: result.closureStatus,
    closedAt: result.closedAt,
    closureReason: result.closureReason,
    handlingResult: result.handlingResult,
    handlingStatus: result.handlingStatus,
    processEntries: result.processEntries,
    maintenance: result.maintenance,
    maintenanceSteps: result.maintenanceSteps,
    maintenanceFaultPanels: result.maintenanceFaultPanels,
    intake: result.intake,
    canEditMaintenance: result.canEditMaintenance,
    customerNickname: customerProfile?.nickname ?? CUSTOMER_NICKNAME_FALLBACK,
    customerCompanyName: customerProfile?.companyName ?? null,
    acceptanceViewStatus: computeAcceptanceViewStatus(
      result.isAccepted,
      result.acceptedByEngineerAccountId,
      viewerAccountId,
    ),
    acceptedEngineerNickname: acceptedProfile ? acceptedProfile.nickname : null,
  };
}
