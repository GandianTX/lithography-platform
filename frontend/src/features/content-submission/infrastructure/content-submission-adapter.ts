// src/features/content-submission/infrastructure/content-submission-adapter.ts

import { executeGraphQL, readGraphQLErrorDetail } from '@/shared/graphql';

import type {
  ContentSubmissionDecisionResult,
  ContentSubmissionDraftSaveResult,
  ContentSubmissionEditablePatch,
  ContentSubmissionKind,
  ContentSubmissionListFilter,
  ContentSubmissionListPage,
  ContentSubmissionListPagination,
  ContentSubmissionMineDetail,
  ContentSubmissionMineDetailResult,
  ContentSubmissionReviewDecisionInput,
  ContentSubmissionReviewDetail,
  ContentSubmissionReviewDetailResult,
  ContentSubmissionRevision,
  ContentSubmissionRevisionResult,
  ContentSubmissionStatus,
  ContentSubmissionSubmitResult,
  ContentSubmissionWriteFailureReason,
  CreateContentSubmissionDraftInput,
  SubmitContentSubmissionInput,
} from './content-submission.types';

/**
 * 内容投稿真实 GraphQL 数据访问层（A-PR0 §4.1 九操作；页面 / 导航 / 钩子不在本阶段范围）。
 *
 * 错误双轨制（frontend/docs/project-convention/graphql-error-model.md）：
 * - transport / auth / network / malformed 失败由共享层归一为 GraphQLIngressError 原样上抛；
 * - 业务拒绝（domain failure）返回显式结果 { ok: false, reason, message }，
 *   主信号是契约保证稳定的 extensions.code（backend/docs/api/graphql-error-contract-current.md），
 *   extensions.errorCode 仅作可选细化，生产环境隐藏时自动回退大类码映射，不会失效；
 * - 业务消息只读 extensions.errorMessage（生产可能隐藏），为空时用前端兜底文案，
 *   不取顶层通用 message；adapter 不读写 Session（Token 注入由 configureGraphQLRuntime 桥接）。
 */

const MY_LIST_QUERY = `
  query MyContentSubmissions($pagination: PaginationArgs!, $filter: ContentSubmissionFilterInput) {
    myContentSubmissions(pagination: $pagination, filter: $filter) {
      items {
        id
        title
        submissionKind
        status
        currentRevisionNo
        lastSubmittedAt
        updatedAt
        createdAt
      }
      total
      page
      pageSize
    }
  }
`;

const MY_DETAIL_QUERY = `
  query MyContentSubmission($id: Int!) {
    myContentSubmission(id: $id) {
      id
      submissionKind
      status
      currentRevisionNo
      lastSubmittedAt
      publishedAt
      material {
        title
        documentType
        equipmentModelId
        equipmentModelName
        equipmentModelText
        description
        contentText
      }
      faultCase {
        title
        equipmentModelId
        equipmentModelName
        equipmentModelText
        errorCode
        phenomenon
        conditionText
        reproductionSteps
        diagnosis
        actionTaken
        handlingStatus
        resolution
      }
      currentAttachment {
        id
        originalFilename
        mimeType
        byteSize
        uploadedAt
      }
      latestReview {
        decision
        comment
        publishAttachment
        reviewedAt
      }
      publishedDocument {
        documentId
        available
      }
      createdAt
      updatedAt
    }
  }
`;

const REVISION_QUERY = `
  query ContentSubmissionRevision($submissionId: Int!, $revisionNo: Int!) {
    contentSubmissionRevision(submissionId: $submissionId, revisionNo: $revisionNo) {
      revisionId
      submissionId
      submissionKind
      revisionNo
      schemaVersion
      titleSnapshot
      payloadSnapshot
      attachment {
        id
        originalFilename
        mimeType
        byteSize
        uploadedAt
      }
      noticeVersion
      confirmedAt
      submittedAt
      review {
        decision
        comment
        publishAttachment
        reviewedAt
      }
    }
  }
`;

const REVIEW_LIST_QUERY = `
  query ReviewContentSubmissions($pagination: PaginationArgs!, $filter: ContentSubmissionFilterInput) {
    reviewContentSubmissions(pagination: $pagination, filter: $filter) {
      items {
        id
        title
        submissionKind
        status
        currentRevisionNo
        lastSubmittedAt
        updatedAt
        createdAt
      }
      total
      page
      pageSize
    }
  }
`;

const REVIEW_DETAIL_QUERY = `
  query ReviewContentSubmission($id: Int!) {
    reviewContentSubmission(id: $id) {
      submissionId
      submissionKind
      status
      currentRevisionNo
      lastSubmittedAt
      submittedByAccountId
      currentRevision {
        revisionId
        submissionId
        submissionKind
        revisionNo
        schemaVersion
        titleSnapshot
        payloadSnapshot
        attachment {
          id
          originalFilename
          mimeType
          byteSize
          uploadedAt
        }
        noticeVersion
        confirmedAt
        submittedAt
        review {
          decision
          comment
          publishAttachment
          reviewedAt
        }
      }
      reviewHistory {
        revisionId
        revisionNo
        decision
        comment
        publishAttachment
        reviewedAt
      }
    }
  }
`;

const CREATE_DRAFT_MUTATION = `
  mutation CreateContentSubmissionDraft($input: CreateContentSubmissionDraftInput!) {
    createContentSubmissionDraft(input: $input) {
      id
      submissionKind
      status
      updatedAt
    }
  }
`;

const UPDATE_DRAFT_MUTATION = `
  mutation UpdateContentSubmissionDraft($id: Int!, $input: UpdateContentSubmissionDraftInput!) {
    updateContentSubmissionDraft(id: $id, input: $input) {
      id
      submissionKind
      status
      updatedAt
    }
  }
`;

const SUBMIT_MUTATION = `
  mutation SubmitContentSubmission($id: Int!, $input: SubmitContentSubmissionInput!) {
    submitContentSubmission(id: $id, input: $input) {
      submissionId
      revisionId
      revisionNo
      status
    }
  }
`;

const DECISION_MUTATION = `
  mutation ReviewContentSubmissionDecision($input: ReviewContentSubmissionDecisionInput!) {
    reviewContentSubmissionDecision(input: $input) {
      submissionId
      status
      documentId
    }
  }
`;

// ---- 错误映射（唯一真源：backend/src/core/common/errors/domain-error.ts 的 CONTENT_SUBMISSION_ERROR /
//      PERMISSION_ERROR 码组与 backend/src/infrastructure/graphql/filters/graphql-exception.filter.ts 的大类映射） ----

/**
 * 新建草稿拒绝原因主映射：create 的 NOT_FOUND 大类唯一来源是「型号不存在」
 * （草稿自身不可能冲突），无需 errorCode 细化分支。
 */
const CREATE_DRAFT_FAILURE_REASON_BY_CATEGORY_CODE: Record<
  string,
  ContentSubmissionWriteFailureReason
> = {
  NOT_FOUND: 'model-not-found',
  BAD_USER_INPUT: 'invalid-input',
  FORBIDDEN: 'forbidden',
  INTERNAL_SERVER_ERROR: 'operation-failed',
};

/**
 * 修改草稿拒绝原因主映射 + 可选细化。NOT_FOUND 大类有两个来源：
 * 投稿不存在/非本人（默认 not-found）与型号不存在（经 errorCode 细化为 model-not-found）。
 */
const UPDATE_DRAFT_FAILURE_REASON_BY_CATEGORY_CODE: Record<
  string,
  ContentSubmissionWriteFailureReason
> = {
  NOT_FOUND: 'not-found',
  BAD_USER_INPUT: 'invalid-input',
  CONFLICT: 'state-conflict',
  FORBIDDEN: 'forbidden',
  INTERNAL_SERVER_ERROR: 'operation-failed',
};

const REFINED_UPDATE_DRAFT_REASON_BY_ERROR_CODE: Partial<
  Record<string, ContentSubmissionWriteFailureReason>
> = {
  CONTENT_SUBMISSION_EQUIPMENT_MODEL_NOT_FOUND: 'model-not-found',
};

/** 送审拒绝原因主映射（完整性 / 未确认告知 → invalid-input；状态与归属走既有大类） */
const SUBMIT_FAILURE_REASON_BY_CATEGORY_CODE: Record<string, ContentSubmissionWriteFailureReason> =
  {
    NOT_FOUND: 'not-found',
    BAD_USER_INPUT: 'invalid-input',
    CONFLICT: 'state-conflict',
    FORBIDDEN: 'forbidden',
    INTERNAL_SERVER_ERROR: 'operation-failed',
  };

/** 审核决定拒绝原因主映射（版本不符 / 退回意见缺失等均落既有大类） */
const DECISION_FAILURE_REASON_BY_CATEGORY_CODE: Record<
  string,
  ContentSubmissionWriteFailureReason
> = {
  NOT_FOUND: 'not-found',
  BAD_USER_INPUT: 'invalid-input',
  CONFLICT: 'state-conflict',
  FORBIDDEN: 'forbidden',
  INTERNAL_SERVER_ERROR: 'operation-failed',
};

/** 写操作兜底文案（四类写操作共用；后端消息优先，为空时回落） */
const WRITE_FALLBACK_MESSAGE_BY_REASON: Record<ContentSubmissionWriteFailureReason, string> = {
  'not-found': '投稿不存在或不可操作。',
  'model-not-found': '所选设备型号不存在，请重新选择。',
  'invalid-input': '输入不符合要求，请检查后重新提交。',
  'state-conflict': '当前状态不允许该操作，请刷新后重试。',
  forbidden: '当前账号没有执行该操作的权限。',
  'operation-failed': '操作失败，请稍后重试。',
};

// ---- GraphQL 响应 shape（选择集与后端 DTO 逐字段对齐） ----

type DraftMutationPayload = {
  id: number;
  submissionKind: ContentSubmissionKind;
  status: ContentSubmissionStatus;
  updatedAt: string;
};

type CreateDraftData = { createContentSubmissionDraft: DraftMutationPayload };

type UpdateDraftData = { updateContentSubmissionDraft: DraftMutationPayload };

type ListPagePayload = {
  items: ContentSubmissionListPage['items'];
  total?: number | null;
  page?: number | null;
  pageSize?: number | null;
};

type MyListData = { myContentSubmissions: ListPagePayload };

type ReviewListData = { reviewContentSubmissions: ListPagePayload };

type MyDetailData = { myContentSubmission: ContentSubmissionMineDetail };

type RevisionData = { contentSubmissionRevision: ContentSubmissionRevision };

type ReviewDetailData = { reviewContentSubmission: ContentSubmissionReviewDetail };

type SubmitData = {
  submitContentSubmission: {
    submissionId: number;
    revisionId: number;
    revisionNo: number;
    status: ContentSubmissionStatus;
  };
};

type DecisionData = {
  reviewContentSubmissionDecision: {
    submissionId: number;
    status: ContentSubmissionStatus;
    documentId?: number | null;
  };
};

/** OFFSET 分页变量（调用方只传 page/pageSize，mode 与 withTotal 由 adapter 内部补齐） */
type ListVariables = {
  pagination: {
    mode: 'OFFSET';
    page: number;
    pageSize: number;
    withTotal: true;
  };
  /** 筛选变量（可空 InputType；无筛选时整体省略，空白搜索词视为无筛选） */
  filter?: {
    title?: string;
    submissionKind?: ContentSubmissionKind;
    status?: ContentSubmissionStatus;
  };
};

type WriteFailure = { reason: ContentSubmissionWriteFailureReason; message: string };

/**
 * 将 GraphQL 业务拒绝归一为显式失败结果；未命中映射的（transport / auth / 未知大类）
 * 原样上抛，与 reference-document 的双轨制口径一致。
 */
function toWriteFailure(
  error: unknown,
  reasonByCategoryCode: Record<string, ContentSubmissionWriteFailureReason>,
  reasonByErrorCode?: Partial<Record<string, ContentSubmissionWriteFailureReason>>,
): WriteFailure {
  const detail = readGraphQLErrorDetail(error);
  const categoryReason = detail?.code ? reasonByCategoryCode[detail.code] : undefined;

  if (!detail || !categoryReason) {
    throw error;
  }

  const reason =
    (detail.errorCode && reasonByErrorCode ? reasonByErrorCode[detail.errorCode] : undefined) ??
    categoryReason;

  return {
    reason,
    message: detail.errorMessage ?? WRITE_FALLBACK_MESSAGE_BY_REASON[reason],
  };
}

/** 读取链路 not-found 归并防探测：不存在 / 非授权范围统一 not-found；其余失败上抛 */
function toNotFoundFailure(error: unknown, fallbackMessage: string): { message: string } {
  const detail = readGraphQLErrorDetail(error);

  if (detail?.code === 'NOT_FOUND' || detail?.code === 'FORBIDDEN') {
    return { message: detail.errorMessage ?? fallbackMessage };
  }

  throw error;
}

function toListVariables(
  pagination: ContentSubmissionListPagination,
  filter?: ContentSubmissionListFilter,
): ListVariables {
  const titleKeyword = filter?.titleKeyword?.trim();

  return {
    pagination: {
      mode: 'OFFSET',
      page: pagination.page,
      pageSize: pagination.pageSize,
      withTotal: true,
    },
    ...(filter && (titleKeyword || filter.submissionKind || filter.status)
      ? {
          filter: {
            ...(titleKeyword ? { title: titleKeyword } : {}),
            ...(filter.submissionKind ? { submissionKind: filter.submissionKind } : {}),
            ...(filter.status ? { status: filter.status } : {}),
          },
        }
      : {}),
  };
}

function toListPage(
  page: ListPagePayload,
  pagination: ContentSubmissionListPagination,
): ContentSubmissionListPage {
  return {
    items: page.items,
    // 后端分页工厂 total 为可空字段（withTotal: true 时必返回），类型上兜底为 0
    total: page.total ?? 0,
    page: page.page ?? pagination.page,
    pageSize: page.pageSize ?? pagination.pageSize,
  };
}

/** 查询本人投稿列表（仅本人记录；标题模糊 + 类别等值 + 状态等值；更新时间倒序） */
export async function fetchMyContentSubmissions(
  pagination: ContentSubmissionListPagination,
  filter?: ContentSubmissionListFilter,
): Promise<ContentSubmissionListPage> {
  const data = await executeGraphQL<MyListData, ListVariables>(
    MY_LIST_QUERY,
    toListVariables(pagination, filter),
  );

  return toListPage(data.myContentSubmissions, pagination);
}

/**
 * 查询本人投稿详情（当前稿、当前状态、最近审核、版本入口、已发布正式资料关联）。
 * 不存在 / 他人投稿 / 跨组织由后端统一 NOT_FOUND；FORBIDDEN（守卫拒绝）
 * 同样归并 not-found，与既有详情读取的防探测契约处理一致。
 */
export async function fetchMyContentSubmission(
  id: number,
): Promise<ContentSubmissionMineDetailResult> {
  try {
    const data = await executeGraphQL<MyDetailData, { id: number }>(MY_DETAIL_QUERY, { id });

    return { ok: true, detail: data.myContentSubmission };
  } catch (error) {
    return {
      ok: false,
      reason: 'not-found',
      ...toNotFoundFailure(error, '投稿不存在或不可查看。'),
    };
  }
}

/** 查询冻结版本（本人或本组织管理员；非授权范围统一归并 not-found） */
export async function fetchContentSubmissionRevision(
  submissionId: number,
  revisionNo: number,
): Promise<ContentSubmissionRevisionResult> {
  try {
    const data = await executeGraphQL<RevisionData, { submissionId: number; revisionNo: number }>(
      REVISION_QUERY,
      { submissionId, revisionNo },
    );

    return { ok: true, revision: data.contentSubmissionRevision };
  } catch (error) {
    return {
      ok: false,
      reason: 'not-found',
      ...toNotFoundFailure(error, '该版本不存在或不可查看。'),
    };
  }
}

/** 查询审核队列（仅本组织管理员；缺省待审；送审时间倒序） */
export async function fetchReviewContentSubmissions(
  pagination: ContentSubmissionListPagination,
  filter?: ContentSubmissionListFilter,
): Promise<ContentSubmissionListPage> {
  const data = await executeGraphQL<ReviewListData, ListVariables>(
    REVIEW_LIST_QUERY,
    toListVariables(pagination, filter),
  );

  return toListPage(data.reviewContentSubmissions, pagination);
}

/** 查询审核详情（仅本组织管理员；非本组织统一归并 not-found） */
export async function fetchReviewContentSubmission(
  id: number,
): Promise<ContentSubmissionReviewDetailResult> {
  try {
    const data = await executeGraphQL<ReviewDetailData, { id: number }>(REVIEW_DETAIL_QUERY, {
      id,
    });

    return { ok: true, detail: data.reviewContentSubmission };
  } catch (error) {
    return {
      ok: false,
      reason: 'not-found',
      ...toNotFoundFailure(error, '投稿不存在或不可查看。'),
    };
  }
}

/**
 * 新建投稿草稿（仅工程师；创建人 / 组织由服务端从会话与可信事实确定）。
 * 保存草稿只要求一个非空文字业务字段；返回真实保存状态。
 */
export async function createContentSubmissionDraft(
  input: CreateContentSubmissionDraftInput,
): Promise<ContentSubmissionDraftSaveResult> {
  try {
    const data = await executeGraphQL<
      CreateDraftData,
      { input: CreateContentSubmissionDraftInput }
    >(CREATE_DRAFT_MUTATION, { input });
    const draft = data.createContentSubmissionDraft;

    return {
      ok: true,
      id: draft.id,
      submissionKind: draft.submissionKind,
      status: draft.status,
      updatedAt: draft.updatedAt,
    };
  } catch (error) {
    return { ok: false, ...toWriteFailure(error, CREATE_DRAFT_FAILURE_REASON_BY_CATEGORY_CODE) };
  }
}

/**
 * 修改投稿草稿（仅本人 DRAFT/RETURNED；PATCH 语义：未提供字段保持原值）。
 * NOT_FOUND 大类经 errorCode 细化区分「投稿不可编辑」与「所选型号不存在」。
 */
export async function updateContentSubmissionDraft(
  id: number,
  patch: ContentSubmissionEditablePatch,
): Promise<ContentSubmissionDraftSaveResult> {
  try {
    const data = await executeGraphQL<
      UpdateDraftData,
      { id: number; input: { patch: ContentSubmissionEditablePatch } }
    >(UPDATE_DRAFT_MUTATION, { id, input: { patch } });
    const draft = data.updateContentSubmissionDraft;

    return {
      ok: true,
      id: draft.id,
      submissionKind: draft.submissionKind,
      status: draft.status,
      updatedAt: draft.updatedAt,
    };
  } catch (error) {
    return {
      ok: false,
      ...toWriteFailure(
        error,
        UPDATE_DRAFT_FAILURE_REASON_BY_CATEGORY_CODE,
        REFINED_UPDATE_DRAFT_REASON_BY_ERROR_CODE,
      ),
    };
  }
}

/**
 * 送审 / 重提（仅本人 DRAFT/RETURNED）：从已保存稿冻结出新版本。
 * 完整性不足（含未确认入库告知）为 invalid-input；状态不允许重提为 state-conflict。
 */
export async function submitContentSubmission(
  id: number,
  input: SubmitContentSubmissionInput,
): Promise<ContentSubmissionSubmitResult> {
  try {
    const data = await executeGraphQL<
      SubmitData,
      { id: number; input: SubmitContentSubmissionInput }
    >(SUBMIT_MUTATION, { id, input });
    const result = data.submitContentSubmission;

    return {
      ok: true,
      submissionId: result.submissionId,
      revisionId: result.revisionId,
      revisionNo: result.revisionNo,
      status: result.status,
    };
  } catch (error) {
    return { ok: false, ...toWriteFailure(error, SUBMIT_FAILURE_REASON_BY_CATEGORY_CODE) };
  }
}

/**
 * 审核决定（仅本组织管理员）：RETURN 退回 / APPROVE 通过；
 * 仅接受当前待审 revisionId；通过时按 publishAttachment 决定是否发布附件。
 */
export async function reviewContentSubmissionDecision(
  input: ContentSubmissionReviewDecisionInput,
): Promise<ContentSubmissionDecisionResult> {
  try {
    const data = await executeGraphQL<
      DecisionData,
      { input: ContentSubmissionReviewDecisionInput }
    >(DECISION_MUTATION, { input });
    const result = data.reviewContentSubmissionDecision;

    return {
      ok: true,
      submissionId: result.submissionId,
      status: result.status,
      documentId: result.documentId ?? null,
    };
  } catch (error) {
    return { ok: false, ...toWriteFailure(error, DECISION_FAILURE_REASON_BY_CATEGORY_CODE) };
  }
}
