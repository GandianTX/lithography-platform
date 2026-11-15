// src/features/repair-request/infrastructure/engineer-repair-request-adapter.spec.ts

/**
 * 工程师维修申请读写 adapter（防腐层）单测。
 *
 * 只 mock 共享 GraphQL 执行入口，验证：
 * - Query / Mutation 文档与变量口径（接单入参只有申请 ID）；
 * - DTO → 内部干净模型的显式映射与可空字段归一；
 * - 业务拒绝主映射只依赖 extensions.code 大类，errorCode / errorMessage 缺失时安全兜底；
 * - transport / auth / 未知 GraphQL 错误继续上抛，交共享链路处理。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as sharedGraphql from '@/shared/graphql';
import { GraphQLIngressError } from '@/shared/graphql';
import * as sharedHttp from '@/shared/http';
import { translate } from '@/shared/i18n';

import type {
  EngineerRepairListScope,
  RepairRequestDetailDTO,
} from './engineer-repair-request.types';
import {
  acceptRepairRequest,
  closeRepairRequest,
  createEngineerResponse,
  createRepairProcessEntry,
  downloadRepairProcessFile,
  ENGINEER_DETAIL_NOT_ACCESSIBLE_MESSAGE_KEY,
  fetchEngineerRepairRequestDetail,
  fetchEngineerRepairRequests,
  updateRepairProcessEntry,
  uploadRepairProcessFile,
} from './engineer-repair-request-adapter';

vi.mock('@/shared/graphql', async (importOriginal) => {
  const actual = await importOriginal<typeof sharedGraphql>();

  return {
    ...actual,
    executeGraphQL: vi.fn(),
  };
});

vi.mock('@/shared/http', async (importOriginal) => {
  const actual = await importOriginal<typeof sharedHttp>();

  return {
    ...actual,
    fetchRestWithAuthRetry: vi.fn(),
  };
});

const executeGraphQLMock = vi.mocked(sharedGraphql.executeGraphQL);
const fetchRestWithAuthRetryMock = vi.mocked(sharedHttp.fetchRestWithAuthRetry);

const DETAIL_DTO: RepairRequestDetailDTO = {
  id: 21,
  requestNo: 'RR20260902100000ABC123',
  equipmentModel: { id: 3, modelCode: 'LITHO-9000', modelName: '光刻机 9000' },
  errorCode: 'E-100',
  faultDescription: '设备无法启动',
  contentMd: '# 设备维修申请',
  createdAt: '2026-09-02T08:00:00.000Z',
  isAccepted: true,
  acceptedAt: '2026-09-02T08:30:00.000Z',
  latestResolutionStatus: 'PENDING',
  customerNickname: '林客户',
  customerCompanyName: '林氏精密制造',
  acceptanceViewStatus: 'MINE',
  acceptedEngineerNickname: '陈工',
  closureStatus: null,
  closedAt: null,
  closureReason: null,
  handlingResult: null,
  handlingStatus: null,
  processEntries: [],
  responses: [
    {
      id: 51,
      engineerNickname: '陈工',
      resolutionStatus: 'RESOLVED',
      responseText: '已更换干涉仪镜片',
      createdAt: '2026-09-02T09:00:00.000Z',
    },
  ],
};

/** 与 DETAIL_DTO 等价的内部干净模型（逐字段显式映射的期望值） */
const DETAIL_MODEL = {
  id: 21,
  requestNo: 'RR20260902100000ABC123',
  equipmentModel: { id: 3, modelCode: 'LITHO-9000', modelName: '光刻机 9000' },
  errorCode: 'E-100',
  faultDescription: '设备无法启动',
  contentMd: '# 设备维修申请',
  createdAt: '2026-09-02T08:00:00.000Z',
  isAccepted: true,
  acceptedAt: '2026-09-02T08:30:00.000Z',
  latestResolutionStatus: 'PENDING',
  customerNickname: '林客户',
  customerCompanyName: '林氏精密制造',
  acceptanceViewStatus: 'MINE',
  acceptedEngineerNickname: '陈工',
  closureStatus: null,
  closedAt: null,
  closureReason: null,
  handlingResult: null,
  handlingStatus: null,
  processEntries: [],
  responses: [
    {
      id: 51,
      engineerNickname: '陈工',
      resolutionStatus: 'RESOLVED',
      responseText: '已更换干涉仪镜片',
      createdAt: '2026-09-02T09:00:00.000Z',
    },
  ],
};

function buildDomainIngressError(options: {
  code: string;
  errorCode?: string;
  errorMessage?: string;
}) {
  const extensions: Record<string, unknown> = { code: options.code };
  if (options.errorCode !== undefined) {
    extensions.errorCode = options.errorCode;
  }
  if (options.errorMessage !== undefined) {
    extensions.errorMessage = options.errorMessage;
  }

  return new GraphQLIngressError({
    type: 'graphql',
    message: options.errorMessage ?? '请求处理失败。',
    graphqlErrors: [{ message: options.errorMessage ?? '请求处理失败。', extensions }],
  });
}

/** 默认（中文）语言下按词条真源翻译，避免在测试里复制第二份文案 */
const NOT_ACCESSIBLE_MESSAGE = translate('zh-CN', ENGINEER_DETAIL_NOT_ACCESSIBLE_MESSAGE_KEY);

beforeEach(() => {
  executeGraphQLMock.mockReset();
  fetchRestWithAuthRetryMock.mockReset();
});

const NO_FILTER = { equipmentModelId: null, customerNickname: null };

describe('fetchEngineerRepairRequests', () => {
  it.each<[EngineerRepairListScope, number]>([
    ['ALL', 1],
    ['AVAILABLE', 1],
    ['MINE', 3],
    ['TAKEN_BY_OTHER', 2],
  ])('scope=%s 时按该范围与页码发送 OFFSET 分页参数，无筛选时 filter 缺省', async (scope, page) => {
    executeGraphQLMock.mockResolvedValue({
      engineerRepairRequests: { items: [], total: 0, page, pageSize: 10 },
    });

    await fetchEngineerRepairRequests({ scope, filter: NO_FILTER, page, pageSize: 10 });

    expect(executeGraphQLMock).toHaveBeenCalledTimes(1);
    const [document, variables] = executeGraphQLMock.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(document).toContain(
      'engineerRepairRequests(scope: $scope, pagination: $pagination, filter: $filter)',
    );
    expect(variables.scope).toBe(scope);
    expect(variables.pagination).toEqual({ mode: 'OFFSET', page, pageSize: 10, withTotal: true });
    // 无筛选时不携带 filter 键位值（undefined 键在 wire 序列化时整体缺省）
    expect(variables.filter).toBeUndefined();
  });

  it('单项筛选只携带对应键位：设备型号等值筛选', async () => {
    executeGraphQLMock.mockResolvedValue({
      engineerRepairRequests: { items: [], total: 0, page: 1, pageSize: 10 },
    });

    await fetchEngineerRepairRequests({
      scope: 'ALL',
      filter: { equipmentModelId: 7, customerNickname: null },
      page: 1,
      pageSize: 10,
    });

    const [, variables] = executeGraphQLMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(variables.filter).toEqual({ equipmentModelId: 7 });
  });

  it('单项筛选只携带对应键位：客户昵称关键词筛选', async () => {
    executeGraphQLMock.mockResolvedValue({
      engineerRepairRequests: { items: [], total: 0, page: 1, pageSize: 10 },
    });

    await fetchEngineerRepairRequests({
      scope: 'MINE',
      filter: { equipmentModelId: null, customerNickname: '林客户' },
      page: 1,
      pageSize: 10,
    });

    const [, variables] = executeGraphQLMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(variables.filter).toEqual({ customerNickname: '林客户' });
  });

  it('组合筛选同时携带两项；空白昵称视为未筛选（归一在 UI 层完成后传入）', async () => {
    executeGraphQLMock.mockResolvedValue({
      engineerRepairRequests: { items: [], total: 0, page: 1, pageSize: 10 },
    });

    await fetchEngineerRepairRequests({
      scope: 'ALL',
      filter: { equipmentModelId: 7, customerNickname: '  林  ' },
      page: 1,
      pageSize: 10,
    });

    const [, variables] = executeGraphQLMock.mock.calls[0] as [string, Record<string, unknown>];
    // adapter 只透传，不做二次清洗（与后端输入口径一致：空白语义由后端收敛）
    expect(variables.filter).toEqual({ equipmentModelId: 7, customerNickname: '  林  ' });
  });

  it('列表 DTO 映射为内部模型，可空字段归一为 null', async () => {
    executeGraphQLMock.mockResolvedValue({
      engineerRepairRequests: {
        items: [
          {
            id: 21,
            requestNo: 'RR20260902100000ABC123',
            equipmentModel: { id: 3, modelCode: 'LITHO-9000', modelName: '光刻机 9000' },
            errorCode: 'E-100',
            createdAt: '2026-09-02T08:00:00.000Z',
            isAccepted: true,
            acceptedAt: '2026-09-02T08:30:00.000Z',
            latestResolutionStatus: 'RESOLVED',
            customerNickname: '林客户',
            customerCompanyName: '林氏精密制造',
            acceptanceViewStatus: 'MINE',
            acceptedEngineerNickname: '陈工',
            closureStatus: 'CLOSED',
            closedAt: '2026-09-02T09:00:00.000Z',
            handlingResult: 'FIXED',
            handlingStatus: 'COMPLETED',
          },
          {
            // 后端返回 null 与字段缺省两种形态必须分别保留，不得用 ?? null 合并
            id: 22,
            requestNo: 'RR20260902110000DEF456',
            equipmentModel: { id: 4, modelCode: 'LITHO-8000', modelName: '光刻机 8000' },
            errorCode: 'E-200',
            createdAt: '2026-09-02T08:10:00.000Z',
            isAccepted: false,
            acceptedAt: null,
            customerNickname: '赵客户',
            customerCompanyName: null,
            acceptanceViewStatus: 'AVAILABLE',
          },
          {
            // 显式 null：字段存在但值为空（数据库合法未结单）
            id: 23,
            requestNo: 'RR20260902120000GHI789',
            equipmentModel: { id: 4, modelCode: 'LITHO-8000', modelName: '光刻机 8000' },
            errorCode: 'E-300',
            createdAt: '2026-09-02T08:20:00.000Z',
            isAccepted: false,
            acceptedAt: null,
            customerNickname: '钱客户',
            customerCompanyName: null,
            acceptanceViewStatus: 'AVAILABLE',
            closureStatus: null,
            closedAt: null,
          },
        ],
        total: 3,
        page: 1,
        pageSize: 10,
      },
    });

    const page = await fetchEngineerRepairRequests({
      scope: 'AVAILABLE',
      filter: NO_FILTER,
      page: 1,
      pageSize: 10,
    });

    expect(page).toEqual({
      items: [
        {
          id: 21,
          requestNo: 'RR20260902100000ABC123',
          equipmentModel: { id: 3, modelCode: 'LITHO-9000', modelName: '光刻机 9000' },
          errorCode: 'E-100',
          createdAt: '2026-09-02T08:00:00.000Z',
          isAccepted: true,
          acceptedAt: '2026-09-02T08:30:00.000Z',
          latestResolutionStatus: 'RESOLVED',
          customerNickname: '林客户',
          customerCompanyName: '林氏精密制造',
          acceptanceViewStatus: 'MINE',
          acceptedEngineerNickname: '陈工',
          closureStatus: 'CLOSED',
          closedAt: '2026-09-02T09:00:00.000Z',
          handlingResult: 'FIXED',
          handlingStatus: 'COMPLETED',
        },
        {
          id: 22,
          requestNo: 'RR20260902110000DEF456',
          equipmentModel: { id: 4, modelCode: 'LITHO-8000', modelName: '光刻机 8000' },
          errorCode: 'E-200',
          createdAt: '2026-09-02T08:10:00.000Z',
          isAccepted: false,
          acceptedAt: null,
          latestResolutionStatus: null,
          customerNickname: '赵客户',
          customerCompanyName: null,
          acceptanceViewStatus: 'AVAILABLE',
          acceptedEngineerNickname: null,
          closureStatus: undefined,
          closedAt: undefined,
          handlingResult: null,
          handlingStatus: null,
        },
        {
          id: 23,
          requestNo: 'RR20260902120000GHI789',
          equipmentModel: { id: 4, modelCode: 'LITHO-8000', modelName: '光刻机 8000' },
          errorCode: 'E-300',
          createdAt: '2026-09-02T08:20:00.000Z',
          isAccepted: false,
          acceptedAt: null,
          latestResolutionStatus: null,
          customerNickname: '钱客户',
          customerCompanyName: null,
          acceptanceViewStatus: 'AVAILABLE',
          acceptedEngineerNickname: null,
          closureStatus: null,
          closedAt: null,
          handlingResult: null,
          handlingStatus: null,
        },
      ],
      total: 3,
      page: 1,
      pageSize: 10,
    });

    // 缺失字段保持 undefined（不可确认），显式 null 保持 null（合法未结单）
    expect(page.items[1].closureStatus).toBeUndefined();
    expect(page.items[1].closedAt).toBeUndefined();
    expect(page.items[2].closureStatus).toBeNull();
    expect(page.items[2].closedAt).toBeNull();
  });

  it('分页字段缺省时回落查询参数，不向 application 泄出 undefined', async () => {
    executeGraphQLMock.mockResolvedValue({ engineerRepairRequests: {} });

    await expect(
      fetchEngineerRepairRequests({
        scope: 'MINE',
        filter: NO_FILTER,
        page: 2,
        pageSize: 20,
      }),
    ).resolves.toEqual({ items: [], total: 0, page: 2, pageSize: 20 });
  });
});

describe('fetchEngineerRepairRequestDetail', () => {
  it('详情与回复时间线映射为内部模型', async () => {
    executeGraphQLMock.mockResolvedValue({ engineerRepairRequest: DETAIL_DTO });

    await expect(fetchEngineerRepairRequestDetail(21)).resolves.toEqual({
      ok: true,
      detail: DETAIL_MODEL,
    });
    expect(executeGraphQLMock).toHaveBeenCalledWith(
      expect.stringContaining('engineerRepairRequest(id: $id)'),
      { id: 21 },
    );
  });

  it('可空字段与缺省 responses 归一（null / 空时间线 / 富集字段缺失）', async () => {
    executeGraphQLMock.mockResolvedValue({
      engineerRepairRequest: {
        ...DETAIL_DTO,
        acceptedAt: null,
        latestResolutionStatus: null,
        customerNickname: null,
        customerCompanyName: null,
        acceptanceViewStatus: null,
        acceptedEngineerNickname: null,
      },
    });

    const result = await fetchEngineerRepairRequestDetail(21);
    expect(result).toMatchObject({
      ok: true,
      detail: {
        acceptedAt: null,
        latestResolutionStatus: null,
        customerNickname: null,
        customerCompanyName: null,
        acceptanceViewStatus: null,
        acceptedEngineerNickname: null,
      },
    });

    executeGraphQLMock.mockResolvedValue({
      engineerRepairRequest: { ...DETAIL_DTO, responses: undefined },
    });
    await expect(fetchEngineerRepairRequestDetail(21)).resolves.toMatchObject({
      ok: true,
      detail: { responses: [] },
    });
  });

  it.each([
    ['NOT_FOUND', 'not-accessible', NOT_ACCESSIBLE_MESSAGE],
    ['FORBIDDEN', 'not-accessible', NOT_ACCESSIBLE_MESSAGE],
    ['INTERNAL_SERVER_ERROR', 'load-failed', '维修申请详情加载失败，请稍后重试。'],
    ['BAD_USER_INPUT', 'load-failed', '维修申请详情加载失败，请稍后重试。'],
  ])(
    '业务拒绝大类码 %s 映射为 reason=%s，errorMessage 缺失时走统一安全兜底文案',
    async (code, reason, message) => {
      executeGraphQLMock.mockRejectedValue(buildDomainIngressError({ code }));

      await expect(fetchEngineerRepairRequestDetail(21)).resolves.toEqual({
        ok: false,
        reason,
        message,
      });
    },
  );

  it('后端提供 errorMessage 时优先展示后端消息', async () => {
    executeGraphQLMock.mockRejectedValue(
      buildDomainIngressError({
        code: 'NOT_FOUND',
        errorCode: 'REPAIR_REQUEST_NOT_FOUND',
        errorMessage: '维修申请不存在或已删除',
      }),
    );

    await expect(fetchEngineerRepairRequestDetail(21)).resolves.toEqual({
      ok: false,
      reason: 'not-accessible',
      message: '维修申请不存在或已删除',
    });
  });

  it('未收录大类码 / auth / 网络错误继续上抛，交共享 GraphQL 与 auth-session 链路', async () => {
    const unknownGraphqlError = buildDomainIngressError({ code: 'GRAPHQL_VALIDATION_FAILED' });
    const authError = new GraphQLIngressError({ type: 'auth', message: 'token invalid' });
    const networkError = new GraphQLIngressError({ type: 'network', message: 'fetch failed' });

    for (const error of [unknownGraphqlError, authError, networkError]) {
      executeGraphQLMock.mockRejectedValueOnce(error);
      await expect(fetchEngineerRepairRequestDetail(21)).rejects.toBe(error);
    }
  });
});

describe('acceptRepairRequest', () => {
  it('Mutation 变量只有申请 ID，不含工程师账号 ID 与接单时间', async () => {
    executeGraphQLMock.mockResolvedValue({ acceptRepairRequest: DETAIL_DTO });

    await acceptRepairRequest(21);

    expect(executeGraphQLMock).toHaveBeenCalledTimes(1);
    const [document, variables] = executeGraphQLMock.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(variables).toEqual({ id: 21 });
    expect(document).toContain('acceptRepairRequest(id: $id)');
    // 接单人身份与接单时间由后端 Session / 系统时间决定，前端不得声明这类变量
    expect(document).not.toContain('engineerAccountId');
    expect(document).not.toContain('acceptedByEngineerAccountId');
    expect(document).not.toContain('$acceptedAt');
  });

  it('接单成功返回后端最新详情（内部干净模型）', async () => {
    executeGraphQLMock.mockResolvedValue({ acceptRepairRequest: DETAIL_DTO });

    await expect(acceptRepairRequest(21)).resolves.toEqual({ ok: true, detail: DETAIL_MODEL });
  });

  it.each([
    ['CONFLICT', 'already-accepted', '该维修申请已被接单，请刷新后查看最新状态'],
    ['NOT_FOUND', 'not-accessible', '维修申请不存在或已删除。'],
    ['FORBIDDEN', 'insufficient-permission', '当前账号无权接单维修申请。'],
    ['INTERNAL_SERVER_ERROR', 'accept-failed', '接单失败，请稍后重试。'],
    ['BAD_USER_INPUT', 'accept-failed', '接单失败，请稍后重试。'],
  ])(
    '业务拒绝大类码 %s 映射为 reason=%s，errorCode / errorMessage 缺失时走安全兜底文案',
    async (code, reason, message) => {
      executeGraphQLMock.mockRejectedValue(buildDomainIngressError({ code }));

      await expect(acceptRepairRequest(21)).resolves.toEqual({ ok: false, reason, message });
    },
  );

  it('后端暴露细节码与消息时优先使用后端消息（生产隐藏细节码不影响大类映射）', async () => {
    executeGraphQLMock.mockRejectedValue(
      buildDomainIngressError({
        code: 'CONFLICT',
        errorCode: 'REPAIR_REQUEST_ALREADY_ACCEPTED',
        errorMessage: '维修申请已被接单，请刷新后查看最新状态',
      }),
    );

    await expect(acceptRepairRequest(21)).resolves.toEqual({
      ok: false,
      reason: 'already-accepted',
      message: '维修申请已被接单，请刷新后查看最新状态',
    });
  });

  it('未收录大类码 / UNAUTHENTICATED / 网络错误继续上抛', async () => {
    const unknownGraphqlError = buildDomainIngressError({ code: 'GRAPHQL_VALIDATION_FAILED' });
    const authError = new GraphQLIngressError({ type: 'auth', message: 'token invalid' });
    const networkError = new GraphQLIngressError({ type: 'network', message: 'fetch failed' });

    for (const error of [unknownGraphqlError, authError, networkError]) {
      executeGraphQLMock.mockRejectedValueOnce(error);
      await expect(acceptRepairRequest(21)).rejects.toBe(error);
    }
  });
});

/* ------------------------------ 回复 ------------------------------ */

/** 与后端公共读模型 DTO 对齐的成功返回样本 */
const RESPONSE_DTO = {
  id: 61,
  engineerNickname: '陈工',
  resolutionStatus: 'PENDING',
  responseText: '已更换备件，待观察',
  createdAt: '2026-09-02T10:00:00.000Z',
};

const RESPONSE_INPUT = {
  requestId: 21,
  responseText: '已更换备件，待观察',
  resolutionStatus: 'PENDING' as const,
};

describe('createEngineerResponse', () => {
  it('Mutation 名称与变量结构正确，入参只有 requestId/responseText/resolutionStatus', async () => {
    executeGraphQLMock.mockResolvedValue({ createEngineerResponse: RESPONSE_DTO });

    await createEngineerResponse(RESPONSE_INPUT);

    expect(executeGraphQLMock).toHaveBeenCalledTimes(1);
    const [document, variables] = executeGraphQLMock.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(document).toContain('createEngineerResponse(input: $input)');
    expect(variables).toEqual({ input: RESPONSE_INPUT });
    // 归属账号由后端 Session 派生，前端文档不得声明这类变量（Plan §7.1）
    expect(document).not.toContain('engineerAccountId');
    expect(document).not.toContain('customerAccountId');
  });

  it('成功 DTO 经既有 mapResponseDTO 转换为内部干净模型', async () => {
    executeGraphQLMock.mockResolvedValue({ createEngineerResponse: RESPONSE_DTO });

    await expect(createEngineerResponse(RESPONSE_INPUT)).resolves.toEqual({
      ok: true,
      response: RESPONSE_DTO,
    });
  });

  it.each([
    ['CONFLICT', 'not-accepted', '维修申请尚未接单，请先接单后回复'],
    ['NOT_FOUND', 'not-accessible', '维修申请不存在或不可访问'],
    ['FORBIDDEN', 'insufficient-permission', '仅工程师账号可以回复维修申请'],
    ['BAD_USER_INPUT', 'invalid-input', '回复内容无效，请检查后重试。'],
    ['INTERNAL_SERVER_ERROR', 'response-failed', '处理回复失败，请稍后重试'],
  ] as const)(
    '业务拒绝大类码 %s 映射为 reason=%s，errorCode / errorMessage 缺失时走安全兜底文案',
    async (code, reason, message) => {
      executeGraphQLMock.mockRejectedValue(buildDomainIngressError({ code }));

      await expect(createEngineerResponse(RESPONSE_INPUT)).resolves.toEqual({
        ok: false,
        reason,
        message,
      });
    },
  );

  it('后端暴露 errorMessage 时优先使用后端消息；errorCode 不参与运行时分支（Plan §7.5）', async () => {
    executeGraphQLMock.mockRejectedValue(
      buildDomainIngressError({
        code: 'CONFLICT',
        errorCode: 'REPAIR_REQUEST_NOT_ACCEPTED',
        errorMessage: '维修申请尚未接单，请先接单后回复',
      }),
    );

    await expect(createEngineerResponse(RESPONSE_INPUT)).resolves.toEqual({
      ok: false,
      reason: 'not-accepted',
      message: '维修申请尚未接单，请先接单后回复',
    });
  });

  it('未收录大类码 / UNAUTHENTICATED / 网络错误继续上抛，交共享 GraphQL 与 auth-session 链路', async () => {
    const unknownGraphqlError = buildDomainIngressError({ code: 'GRAPHQL_VALIDATION_FAILED' });
    const authError = new GraphQLIngressError({ type: 'auth', message: 'token invalid' });
    const networkError = new GraphQLIngressError({ type: 'network', message: 'fetch failed' });

    for (const error of [unknownGraphqlError, authError, networkError]) {
      executeGraphQLMock.mockRejectedValueOnce(error);
      await expect(createEngineerResponse(RESPONSE_INPUT)).rejects.toBe(error);
    }
  });
});

/* ------------------------ 内部维修过程 / 结单 / 原件 ------------------------ */

const PROCESS_ENTRY_DTO = {
  id: '101',
  entryUuid: '4f0c5f6a-1111-4111-8111-111111111111',
  requestId: 21,
  operationText: '更换干涉仪镜片',
  testResult: '精度恢复至 1nm',
  occurredAt: null,
  timeSource: 'SERVER',
  fileId: null,
  versionNo: 1,
  createdAt: '2026-09-02T10:00:00.000Z',
};

describe('createRepairProcessEntry', () => {
  it('携带暂存原件时同一 Mutation 提交 fileId/uploadContextId，并映射返回过程', async () => {
    executeGraphQLMock.mockResolvedValue({ createRepairProcessEntry: PROCESS_ENTRY_DTO });

    const result = await createRepairProcessEntry({
      requestId: 21,
      operationText: '更换干涉仪镜片',
      testResult: null,
      occurredAt: null,
      file: { fileId: 'file-1', uploadContextId: 'context-1' },
    });

    const [, variables] = executeGraphQLMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(variables.input).toEqual({
      requestId: 21,
      operationText: '更换干涉仪镜片',
      testResult: null,
      occurredAt: null,
      file: { fileId: 'file-1', uploadContextId: 'context-1' },
    });
    expect(result).toEqual({
      ok: true,
      entry: {
        id: '101',
        entryUuid: '4f0c5f6a-1111-4111-8111-111111111111',
        requestId: 21,
        operationText: '更换干涉仪镜片',
        testResult: '精度恢复至 1nm',
        occurredAt: null,
        timeSource: 'SERVER',
        fileId: null,
        file: null,
        versionNo: 1,
        createdAt: '2026-09-02T10:00:00.000Z',
      },
    });
  });

  it('CONFLICT 大类（版本冲突 / 已结单只读）映射为 conflict 并优先后端消息', async () => {
    executeGraphQLMock.mockRejectedValue(
      buildDomainIngressError({
        code: 'CONFLICT',
        errorMessage: '维修过程已被修改或工单已结单',
      }),
    );

    await expect(
      createRepairProcessEntry({
        requestId: 21,
        operationText: '补记过程',
        testResult: null,
        occurredAt: null,
        file: null,
      }),
    ).resolves.toEqual({
      ok: false,
      reason: 'conflict',
      message: '维修过程已被修改或工单已结单',
    });
  });
});

describe('updateRepairProcessEntry', () => {
  it('编辑入参携带 entryId 与 expectedVersion，且不携带原件', async () => {
    executeGraphQLMock.mockResolvedValue({ updateRepairProcessEntry: PROCESS_ENTRY_DTO });

    await updateRepairProcessEntry({
      requestId: 21,
      entryId: '101',
      expectedVersion: 2,
      operationText: '复核镜片',
      testResult: null,
      occurredAt: '2026-09-02T10:00:00.000Z',
    });

    const [, variables] = executeGraphQLMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(variables.input).toEqual({
      requestId: 21,
      entryId: '101',
      expectedVersion: 2,
      operationText: '复核镜片',
      testResult: null,
      occurredAt: '2026-09-02T10:00:00.000Z',
    });
    expect(variables.input).not.toHaveProperty('file');
  });

  it('编辑无原件补传时携带 fileId 与 uploadContextId', async () => {
    executeGraphQLMock.mockResolvedValue({ updateRepairProcessEntry: PROCESS_ENTRY_DTO });

    await updateRepairProcessEntry({
      requestId: 21,
      entryId: '101',
      expectedVersion: 2,
      operationText: '补传现场照片',
      testResult: null,
      occurredAt: null,
      file: { fileId: 'file-9', uploadContextId: 'context-9' },
    });

    const [, variables] = executeGraphQLMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(variables.input).toEqual({
      requestId: 21,
      entryId: '101',
      expectedVersion: 2,
      operationText: '补传现场照片',
      testResult: null,
      occurredAt: null,
      file: { fileId: 'file-9', uploadContextId: 'context-9' },
    });
  });
});

describe('closeRepairRequest', () => {
  it('成功时返回后端结单事实，不在前端伪造状态', async () => {
    executeGraphQLMock.mockResolvedValue({
      closeRepairRequest: {
        requestId: 21,
        closureStatus: 'CLOSED',
        closedAt: '2026-09-02T12:00:00.000Z',
        closureReason: '已修复',
        handlingResult: 'FIXED',
        handlingStatus: 'COMPLETED',
        handlingEndedAt: '2026-09-02T11:00:00.000Z',
      },
    });

    await expect(
      closeRepairRequest({ requestId: 21, handlingResult: 'FIXED', closureReason: '已修复' }),
    ).resolves.toEqual({
      ok: true,
      closure: {
        requestId: 21,
        closureStatus: 'CLOSED',
        closedAt: '2026-09-02T12:00:00.000Z',
        closureReason: '已修复',
        handlingResult: 'FIXED',
        handlingStatus: 'COMPLETED',
        handlingEndedAt: '2026-09-02T11:00:00.000Z',
      },
    });
  });

  it('CONFLICT（已结单 / 非终结处理结果）映射为 closed', async () => {
    executeGraphQLMock.mockRejectedValue(buildDomainIngressError({ code: 'CONFLICT' }));

    await expect(
      closeRepairRequest({ requestId: 21, handlingResult: 'FIXED', closureReason: null }),
    ).resolves.toEqual({
      ok: false,
      reason: 'closed',
      message: '工单已结单，请刷新后查看最新状态',
    });
  });
});

describe('uploadRepairProcessFile', () => {
  it('以 multipart 提交 businessType=REPAIR_PROCESS，并解包 REST { data } 信封', async () => {
    fetchRestWithAuthRetryMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          fileId: 'file-1',
          uploadContextId: 'context-1',
          originalFilename: 'report.pdf',
          mimeType: 'application/pdf',
          byteSize: 128,
          checksumSha256: 'abc123',
        },
      }),
    } as Response);

    const file = new File(['demo'], 'report.pdf', { type: 'application/pdf' });
    const result = await uploadRepairProcessFile(file);

    expect(fetchRestWithAuthRetryMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchRestWithAuthRetryMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/stored-files');
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get('businessType')).toBe('REPAIR_PROCESS');
    expect(result).toEqual({
      ok: true,
      file: {
        fileId: 'file-1',
        uploadContextId: 'context-1',
        originalFilename: 'report.pdf',
        mimeType: 'application/pdf',
        byteSize: 128,
        checksumSha256: 'abc123',
      },
    });
  });

  it('REST 错误码映射为明确失败原因', async () => {
    fetchRestWithAuthRetryMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({
        data: { code: 'STORED_FILE_UPLOAD_FILE_TOO_LARGE', message: '原件过大' },
      }),
    } as Response);

    await expect(uploadRepairProcessFile(new File(['demo'], 'big.bin'))).resolves.toEqual({
      ok: false,
      reason: 'file-too-large',
      message: '原件过大',
    });
  });
});

describe('downloadRepairProcessFile', () => {
  it('成功时返回 Blob 与 Content-Disposition 文件名', async () => {
    const blob = new Blob(['demo']);
    fetchRestWithAuthRetryMock.mockResolvedValue({
      ok: true,
      blob: async () => blob,
      headers: new Headers({ 'Content-Disposition': 'attachment; filename="report.pdf"' }),
    } as Response);

    await expect(downloadRepairProcessFile('file-1')).resolves.toEqual({
      ok: true,
      blob,
      filename: 'report.pdf',
    });
    expect(fetchRestWithAuthRetryMock).toHaveBeenCalledWith(
      '/api/stored-files/file-1/download',
      {},
    );
  });
});
