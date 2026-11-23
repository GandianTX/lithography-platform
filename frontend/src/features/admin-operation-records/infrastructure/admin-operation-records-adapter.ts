// src/features/admin-operation-records/infrastructure/admin-operation-records-adapter.ts

import { executeGraphQL } from '@/shared/graphql';

import type { OperationRecordItem, OperationRecordListPage } from './admin-operation-records.types';

/**
 * 关键操作记录 GraphQL 数据访问层（任务 10 S3.2）。
 *
 * - 只读：仅消费 SUPER_ADMIN 专用 `managementAuditEvents` Query，
 *   不触达任何写操作（后端也不存在对应 mutation）；
 * - 无筛选/排序参数：范围由后端按会话可信公司裁决，前端不传 organizationId/adminLevel；
 * - transport / auth / network 失败由共享层归一为 GraphQLIngressError 上抛。
 */

type PaginationVariables = {
  pagination: {
    mode: 'OFFSET';
    page: number;
    pageSize: number;
    withTotal: true;
  };
};

type OperationRecordPageData = {
  managementAuditEvents: {
    items: OperationRecordItem[];
    total: number;
    page: number;
    pageSize: number;
  };
};

const OPERATION_RECORDS_QUERY = `
  query ManagementAuditEvents($pagination: PaginationArgs!) {
    managementAuditEvents(pagination: $pagination) {
      items {
        eventId
        occurredAt
        actorAdminLevel
        actorNickname
        organizationId
        organizationName
        operation
        targetType
        targetId
        result
        detail {
          reason
          stage
          changedFields
          attemptNo
          beforeOrganizationName
          afterOrganizationName
        }
      }
      total
      page
      pageSize
    }
  }`;

/** 分页读取关键操作记录；排序固定在服务端（时间倒序 + 事件 ID 倒序）。 */
export async function fetchOperationRecords(
  page: number,
  pageSize: number,
): Promise<OperationRecordListPage> {
  const data = await executeGraphQL<OperationRecordPageData, PaginationVariables>(
    OPERATION_RECORDS_QUERY,
    { pagination: { mode: 'OFFSET', page, pageSize, withTotal: true } },
  );

  const pageData = data.managementAuditEvents;
  return {
    items: pageData.items,
    total: pageData.total,
    page: pageData.page,
    pageSize: pageData.pageSize,
  };
}
