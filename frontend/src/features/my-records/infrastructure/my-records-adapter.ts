// src/features/my-records/infrastructure/my-records-adapter.ts

import { executeGraphQL, readGraphQLErrorDetail } from '@/shared/graphql';

import type {
  MyRecordDetail,
  MyRecordDetailResult,
  MyRecordListFilter,
  MyRecordListPage,
  MyRecordSummary,
} from './my-records.types';

/**
 * 我的资料记录真实 GraphQL 数据访问层。
 *
 * 权限口径（服务端唯一真源）：仅工程师本人可读；管理员不能借本入口读取他人草稿，
 * 客户由守卫拒绝。前端只做展示，不承担授权判断。
 *
 * 错误口径：transport/auth/network 失败按共享错误模型上抛 GraphQLIngressError；
 * 详情的不存在 / 他人 / 跨公司 / 客户拒绝统一归并为 not-found（防探测）。
 */

const MY_RECORDS_QUERY = `
  query MyMaintenanceRecordList($pagination: PaginationArgs!, $filter: MaintenanceReportFilterInput) {
    myMaintenanceRecordList(pagination: $pagination, filter: $filter) {
      items {
        id
        sourceType
        repairRequestId
        title
        status
        currentVersionNo
        maintenanceDate
        updatedAt
        publishedDocumentId
        syncStatus {
          status
          message
          conflictId
          canResolveConflict
        }
      }
      total
      page
      pageSize
    }
  }
`;

const MY_RECORD_DETAIL_QUERY = `
  query MyMaintenanceRecordDetail($id: Int!) {
    myMaintenanceRecordDetail(id: $id) {
      report {
        id
        sourceType
        repairRequestId
        title
        customerFactoryName
        equipmentModelId
        equipmentModelText
        maintenanceDate
        maintenanceEngineerName
        status
        currentVersionNo
        lastSubmittedAt
        lastReviewedAt
        aiUsage
        aiScore
        aiCorrectness
        aiHelpfulness
        aiNote
        createdAt
        updatedAt
      }
      alarms {
        alarmIndex
        alarmCode
        alarmDescription
        phaseCode
        resetResult
      }
      steps {
        stepNo
        stepCode
        phaseCode
        partName
        actionText
        resultText
        newAlarmCode
        isValidNewBranch
      }
      currentAttachments {
        id
        originalFilename
        mimeType
        byteSize
        description
        sortOrder
        status
      }
      latestReturnComment
      currentVersion {
        id
        versionNo
        changeKind
        changeReason
        schemaVersion
        submittedAt
      }
      currentVersionAttachments {
        versionId
        attachmentId
        sortOrder
        descriptionSnapshot
        publishFlag
      }
      currentReview {
        id
        versionId
        decision
        comment
        reviewedAt
      }
      reviewHistory {
        id
        versionId
        decision
        comment
        reviewedAt
      }
      canEdit
      equipmentModelName
      publishedDocumentId
      syncStatus {
        status
        message
        conflictId
        canResolveConflict
      }
    }
  }
`;

type MyRecordsData = {
  // 查询名与后端任务 07 读侧对齐（myMaintenanceRecordList）；此处曾遗留旧名
  // myMaintenanceReports 导致 tsc 失败，2026-11-22 同步修正
  myMaintenanceRecordList: {
    items: MyRecordSummary[];
    total?: number | null;
    page?: number | null;
    pageSize?: number | null;
  };
};

type MyRecordDetailData = {
  myMaintenanceRecordDetail: MyRecordDetail;
};

type MyRecordsVariables = {
  pagination: {
    mode: 'OFFSET';
    page: number;
    pageSize: number;
    withTotal: true;
  };
  filter?: {
    sourceType?: string;
    recordKind?: string;
    titleKeyword?: string;
  };
};

/**
 * 查询本人记录列表（OFFSET，total 由后端按同一归属谓词计数）。
 * 筛选为空时整体省略 filter 字段（与后端「无筛选」语义一致）。
 */
export async function fetchMyRecords(params: {
  page: number;
  pageSize: number;
  filter?: MyRecordListFilter;
}): Promise<MyRecordListPage> {
  const filter = params.filter;
  const hasFilter =
    filter !== undefined &&
    (filter.sourceType !== undefined ||
      filter.recordKind !== undefined ||
      filter.titleKeyword !== undefined);
  const variables: MyRecordsVariables = {
    pagination: {
      mode: 'OFFSET',
      page: params.page,
      pageSize: params.pageSize,
      withTotal: true,
    },
    ...(hasFilter
      ? {
          filter: {
            ...(filter.sourceType ? { sourceType: filter.sourceType } : {}),
            ...(filter.recordKind ? { recordKind: filter.recordKind } : {}),
            ...(filter.titleKeyword ? { titleKeyword: filter.titleKeyword } : {}),
          },
        }
      : {}),
  };

  const data = await executeGraphQL<MyRecordsData, MyRecordsVariables>(MY_RECORDS_QUERY, variables);

  return {
    items: data.myMaintenanceRecordList.items,
    total: data.myMaintenanceRecordList.total ?? 0,
    page: data.myMaintenanceRecordList.page ?? params.page,
    pageSize: data.myMaintenanceRecordList.pageSize ?? params.pageSize,
  };
}

/** 查询本人记录详情；他人/跨公司/不存在/角色拒绝统一 not-found */
export async function fetchMyRecord(id: number): Promise<MyRecordDetailResult> {
  try {
    const data = await executeGraphQL<MyRecordDetailData, { id: number }>(MY_RECORD_DETAIL_QUERY, {
      id,
    });

    return { ok: true, detail: data.myMaintenanceRecordDetail };
  } catch (error) {
    const detail = readGraphQLErrorDetail(error);

    if (detail?.code === 'NOT_FOUND' || detail?.code === 'FORBIDDEN') {
      return {
        ok: false,
        reason: 'not-found',
        message: detail.errorMessage ?? '该记录不存在或不可查看。',
      };
    }

    throw error;
  }
}
