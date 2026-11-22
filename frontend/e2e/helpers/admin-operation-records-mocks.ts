// e2e/helpers/admin-operation-records-mocks.ts
//
// 关键操作记录页（任务 10）的仓库内确定性 GraphQL mock：
// - 只登记本页真实发出的 operation（会话身份复核 `MySessionIdentity` + 只读查询
//   `ManagementAuditEvents`），多一个（新增请求 / 拼错名字）一律抛错并让用例失败；
// - 夹具里的 operation / result / targetType 全部取自前端契约里的枚举白名单，
//   不出现协议层无法表达的值（避免用非法数据「测」出假绿）；
// - 会话不经过登录接口：spec 用 helpers/auth-session-seed 预置 sessionStorage，
//   因此本文件不需要任何账号、Token、开发库或 backend/env/.env.development。

import type { Page } from '@playwright/test';

export const OPERATION_RECORDS_MOCK_ROUTE = '**/graphql';

/** 单次 GraphQL 请求中分发所需的字段（其余字段与本 mock 无关）。 */
type OperationRecordsRequest = {
  operationName?: string;
  variables?: {
    pagination?: { page?: number; pageSize?: number };
  };
};

export type OperationRecordsMockItem = {
  eventId: string;
  occurredAt: string;
  actorAdminLevel: number;
  actorNickname: string | null;
  organizationId: number | null;
  organizationName: string | null;
  operation: 'ADMIN_DELETE_DOCUMENT' | 'CORRECT_DOCUMENT_OWNERSHIP' | 'RESTORE_LOCAL_BUSINESS';
  targetType: string;
  targetId: string;
  result: 'SUCCEEDED' | 'FAILED' | 'DENIED';
  detail: {
    reason: string | null;
    stage: string | null;
    changedFields: string[] | null;
    attemptNo: number | null;
    beforeOrganizationName: string | null;
    afterOrganizationName: string | null;
  } | null;
};

/**
 * 15 条夹具（与真实链路实测的分页规模一致：一页 10 条、第二页 5 条）。
 *
 * 覆盖的读侧形态：
 * - 三类 operation 各若干条（协议层只有这三类可表达）；
 * - `organizationName` 为 null 的行（服务端可返回空公司，一级可见）；
 * - `actorNickname` 为 null 的行（占位文案由前端按当前语言渲染）；
 * - `detail.changedFields`（07 的 `changes` 形状投影出的字段名）；
 * - `detail.stage` 与 `detail.attemptNo`（恢复类读侧表达力）。
 */
export const OPERATION_RECORDS_ITEMS: OperationRecordsMockItem[] = [
  {
    eventId: 'evt-0015',
    occurredAt: '2026-11-22T10:15:00.000Z',
    actorAdminLevel: 1,
    actorNickname: '开发一级管理员一',
    organizationId: 2,
    organizationName: '开发联调公司 A',
    operation: 'ADMIN_DELETE_DOCUMENT',
    targetType: 'REFERENCE_DOCUMENT',
    targetId: 'doc-9212',
    result: 'SUCCEEDED',
    detail: {
      reason: '资料重复登记',
      stage: null,
      changedFields: null,
      attemptNo: null,
      beforeOrganizationName: null,
      afterOrganizationName: null,
    },
  },
  {
    eventId: 'evt-0014',
    occurredAt: '2026-11-22T10:14:00.000Z',
    actorAdminLevel: 1,
    actorNickname: '开发一级管理员一',
    organizationId: 3,
    organizationName: '开发联调公司 B',
    operation: 'CORRECT_DOCUMENT_OWNERSHIP',
    targetType: 'REFERENCE_DOCUMENT',
    targetId: 'doc-9210',
    result: 'SUCCEEDED',
    detail: {
      reason: '上传者与所属公司登记有误',
      stage: null,
      changedFields: ['createdByAccountId', 'ownerOrganizationId', 'ownershipStatus'],
      attemptNo: null,
      beforeOrganizationName: '开发联调公司 A',
      afterOrganizationName: '开发联调公司 B',
    },
  },
  {
    eventId: 'evt-0013',
    occurredAt: '2026-11-22T10:13:00.000Z',
    actorAdminLevel: 2,
    actorNickname: '开发二级管理员一',
    organizationId: 2,
    organizationName: '开发联调公司 A',
    operation: 'RESTORE_LOCAL_BUSINESS',
    targetType: 'BACKUP_RESTORE_RUN',
    targetId: 'restore-8f21c0de-0000-4000-8000-000000000001',
    result: 'FAILED',
    detail: {
      reason: '恢复包校验未通过',
      stage: 'EXECUTE',
      changedFields: null,
      attemptNo: 2,
      beforeOrganizationName: null,
      afterOrganizationName: null,
    },
  },
  {
    eventId: 'evt-0012',
    occurredAt: '2026-11-22T10:12:00.000Z',
    actorAdminLevel: 1,
    actorNickname: null,
    organizationId: null,
    organizationName: null,
    operation: 'ADMIN_DELETE_DOCUMENT',
    targetType: 'REFERENCE_DOCUMENT',
    targetId: 'doc-9208',
    result: 'DENIED',
    detail: null,
  },
  {
    eventId: 'evt-0011',
    occurredAt: '2026-11-22T10:11:00.000Z',
    actorAdminLevel: 1,
    actorNickname: '开发一级管理员一',
    organizationId: 2,
    organizationName: '开发联调公司 A',
    operation: 'ADMIN_DELETE_DOCUMENT',
    targetType: 'REFERENCE_DOCUMENT',
    targetId: 'doc-9206',
    result: 'SUCCEEDED',
    detail: null,
  },
  {
    eventId: 'evt-0010',
    occurredAt: '2026-11-22T10:10:00.000Z',
    actorAdminLevel: 1,
    actorNickname: '开发一级管理员一',
    organizationId: 2,
    organizationName: '开发联调公司 A',
    operation: 'ADMIN_DELETE_DOCUMENT',
    targetType: 'REFERENCE_DOCUMENT',
    targetId: 'doc-9204',
    result: 'SUCCEEDED',
    detail: null,
  },
  {
    eventId: 'evt-0009',
    occurredAt: '2026-11-22T10:09:00.000Z',
    actorAdminLevel: 1,
    actorNickname: '开发一级管理员一',
    organizationId: 2,
    organizationName: '开发联调公司 A',
    operation: 'ADMIN_DELETE_DOCUMENT',
    targetType: 'REFERENCE_DOCUMENT',
    targetId: 'doc-9202',
    result: 'SUCCEEDED',
    detail: null,
  },
  {
    eventId: 'evt-0008',
    occurredAt: '2026-11-22T10:08:00.000Z',
    actorAdminLevel: 1,
    actorNickname: '开发一级管理员一',
    organizationId: 2,
    organizationName: '开发联调公司 A',
    operation: 'ADMIN_DELETE_DOCUMENT',
    targetType: 'REFERENCE_DOCUMENT',
    targetId: 'doc-9200',
    result: 'SUCCEEDED',
    detail: null,
  },
  {
    eventId: 'evt-0007',
    occurredAt: '2026-11-22T10:07:00.000Z',
    actorAdminLevel: 1,
    actorNickname: '开发一级管理员一',
    organizationId: 2,
    organizationName: '开发联调公司 A',
    operation: 'ADMIN_DELETE_DOCUMENT',
    targetType: 'REFERENCE_DOCUMENT',
    targetId: 'doc-9198',
    result: 'SUCCEEDED',
    detail: null,
  },
  {
    eventId: 'evt-0006',
    occurredAt: '2026-11-22T10:06:00.000Z',
    actorAdminLevel: 1,
    actorNickname: '开发一级管理员一',
    organizationId: 2,
    organizationName: '开发联调公司 A',
    operation: 'ADMIN_DELETE_DOCUMENT',
    targetType: 'REFERENCE_DOCUMENT',
    targetId: 'doc-9196',
    result: 'SUCCEEDED',
    detail: null,
  },
  {
    eventId: 'evt-0005',
    occurredAt: '2026-11-22T10:05:00.000Z',
    actorAdminLevel: 1,
    actorNickname: '开发一级管理员一',
    organizationId: 2,
    organizationName: '开发联调公司 A',
    operation: 'ADMIN_DELETE_DOCUMENT',
    targetType: 'REFERENCE_DOCUMENT',
    targetId: 'doc-9194',
    result: 'SUCCEEDED',
    detail: null,
  },
  {
    eventId: 'evt-0004',
    occurredAt: '2026-11-22T10:04:00.000Z',
    actorAdminLevel: 1,
    actorNickname: '开发一级管理员一',
    organizationId: 2,
    organizationName: '开发联调公司 A',
    operation: 'ADMIN_DELETE_DOCUMENT',
    targetType: 'REFERENCE_DOCUMENT',
    targetId: 'doc-9192',
    result: 'SUCCEEDED',
    detail: null,
  },
  {
    eventId: 'evt-0003',
    occurredAt: '2026-11-22T10:03:00.000Z',
    actorAdminLevel: 1,
    actorNickname: '开发一级管理员一',
    organizationId: 2,
    organizationName: '开发联调公司 A',
    operation: 'ADMIN_DELETE_DOCUMENT',
    targetType: 'REFERENCE_DOCUMENT',
    targetId: 'doc-9190',
    result: 'SUCCEEDED',
    detail: null,
  },
  {
    eventId: 'evt-0002',
    occurredAt: '2026-11-22T10:02:00.000Z',
    actorAdminLevel: 1,
    actorNickname: '开发一级管理员一',
    organizationId: 2,
    organizationName: '开发联调公司 A',
    operation: 'ADMIN_DELETE_DOCUMENT',
    targetType: 'REFERENCE_DOCUMENT',
    targetId: 'doc-9188',
    result: 'SUCCEEDED',
    detail: null,
  },
  {
    eventId: 'evt-0001',
    occurredAt: '2026-11-22T10:01:00.000Z',
    actorAdminLevel: 1,
    actorNickname: '开发一级管理员一',
    organizationId: 2,
    organizationName: '开发联调公司 A',
    operation: 'ADMIN_DELETE_DOCUMENT',
    targetType: 'REFERENCE_DOCUMENT',
    targetId: 'doc-9186',
    result: 'SUCCEEDED',
    detail: null,
  },
];

/**
 * 安装关键操作记录页的 GraphQL mock。
 *
 * @param page 待测页面
 * @param options.items 夹具条目（默认 15 条）；传空数组即「零记录」
 * @param options.pageSize 服务端页大小（默认 10）
 * @param options.identity 会话身份复核返回值；必须与预置会话一致，
 *   否则应用会以服务端身份覆盖本地会话（本页副标题按等级分档，会被覆盖成别的等级）
 * @param options.extraOperations 额外登记的 operation（越权用例被守卫弹到角色首页后，
 *   角色首页自己的查询需要显式登记；不登记即失败关闭）
 */
export async function installAdminOperationRecordsMocks(
  page: Page,
  options: {
    items?: OperationRecordsMockItem[];
    pageSize?: number;
    identity?: { role: string; adminLevel: number | null; adminOrganizationId: number | null };
    extraOperations?: Record<string, unknown>;
  } = {},
): Promise<void> {
  const items = options.items ?? OPERATION_RECORDS_ITEMS;
  const pageSize = options.pageSize ?? 10;
  const identity = options.identity ?? {
    role: 'SUPER_ADMIN',
    adminLevel: 1,
    adminOrganizationId: 1001,
  };
  const extraOperations = options.extraOperations ?? {};

  await page.route(OPERATION_RECORDS_MOCK_ROUTE, async (route) => {
    const request = (route.request().postDataJSON() as OperationRecordsRequest | null) ?? {};
    const operationName = request.operationName;

    if (operationName === 'MySessionIdentity') {
      await route.fulfill({
        body: JSON.stringify({
          data: {
            mySessionIdentity: {
              accountId: 900201,
              role: identity.role,
              adminLevel: identity.adminLevel,
              customerOrganizationId: null,
              engineerOrganizationId: null,
              adminOrganizationId: identity.adminOrganizationId,
              registrationOrganizationId: null,
              restriction: 'NONE',
            },
          },
        }),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }

    if (operationName === 'ManagementAuditEvents') {
      const currentPage = request.variables?.pagination?.page ?? 1;
      const currentPageSize = request.variables?.pagination?.pageSize ?? pageSize;
      const start = (currentPage - 1) * currentPageSize;
      await route.fulfill({
        body: JSON.stringify({
          data: {
            managementAuditEvents: {
              items: items.slice(start, start + currentPageSize),
              total: items.length,
              page: currentPage,
              pageSize: currentPageSize,
            },
          },
        }),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }

    if (operationName !== undefined && operationName in extraOperations) {
      await route.fulfill({
        body: JSON.stringify({ data: extraOperations[operationName] }),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }

    // 失败关闭：不登记的 operation 一律让用例失败，不做「成功空 data」兜底。
    throw new Error(
      `[admin-operation-records-mocks] 未登记的 GraphQL operation：${operationName ?? '(缺少)'}`,
    );
  });
}
