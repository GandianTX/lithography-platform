// src/features/repair-request/repair-request-adapter.spec.ts

import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as sharedGraphql from '@/shared/graphql';
import { GraphQLIngressError } from '@/shared/graphql';

import {
  createRepairRequest,
  deleteMyRepairRequest,
  fetchEquipmentModels,
  fetchMyRepairRequest,
  fetchMyRepairRequests,
} from './infrastructure/repair-request-adapter';

vi.mock('@/shared/graphql', async (importOriginal) => {
  const actual = await importOriginal<typeof sharedGraphql>();

  return {
    ...actual,
    executeGraphQL: vi.fn(),
  };
});

const executeGraphQLMock = vi.mocked(sharedGraphql.executeGraphQL);

const REPAIR_REQUEST_RECORD = {
  id: 1,
  requestNo: 'RR20260826000000ABC123',
  equipmentModelId: 21,
  errorCode: 'E-2001',
  faultDescription: '双工件台干涉仪报错',
  createdAt: '2026-08-26T00:00:00.000Z',
  isAccepted: false,
};

function buildDomainIngressError(options: {
  code: string;
  errorCode: string;
  errorMessage?: string;
}) {
  return new GraphQLIngressError({
    type: 'graphql',
    message: options.errorMessage ?? '请求处理失败。',
    graphqlErrors: [
      {
        message: options.errorMessage ?? '请求处理失败。',
        extensions: {
          code: options.code,
          errorCode: options.errorCode,
          ...(options.errorMessage ? { errorMessage: options.errorMessage } : {}),
        },
      },
    ],
  });
}

beforeEach(() => {
  executeGraphQLMock.mockReset();
});

describe('fetchEquipmentModels', () => {
  it('返回后端给出的型号列表', async () => {
    executeGraphQLMock.mockResolvedValue({
      equipmentModels: [{ id: 12, modelCode: 'LITHO-A', modelName: '型号A' }],
    });

    await expect(fetchEquipmentModels()).resolves.toEqual([
      { id: 12, modelCode: 'LITHO-A', modelName: '型号A' },
    ]);
  });

  it('transport 失败时上抛 GraphQLIngressError', async () => {
    const networkError = new GraphQLIngressError({ type: 'network', message: 'fetch failed' });
    executeGraphQLMock.mockRejectedValue(networkError);

    await expect(fetchEquipmentModels()).rejects.toBe(networkError);
  });
});

describe('createRepairRequest', () => {
  const input = { equipmentModelId: 21, errorCode: 'E-2001', faultDescription: '报错描述' };

  it('创建成功返回完整申请记录', async () => {
    executeGraphQLMock.mockResolvedValue({ createRepairRequest: REPAIR_REQUEST_RECORD });

    await expect(createRepairRequest(input)).resolves.toEqual({
      ok: true,
      repairRequest: REPAIR_REQUEST_RECORD,
    });
    expect(executeGraphQLMock).toHaveBeenCalledWith(
      expect.stringContaining('createRepairRequest'),
      { input },
    );
  });

  it.each([
    [
      'NOT_FOUND',
      'REPAIR_REQUEST_EQUIPMENT_MODEL_NOT_FOUND',
      'model-not-found',
      '所选设备型号不存在。',
    ],
    [
      'BAD_USER_INPUT',
      'REPAIR_REQUEST_EQUIPMENT_MODEL_DISABLED',
      'model-disabled',
      '所选设备型号已停用。',
    ],
    [
      'BAD_USER_INPUT',
      'REPAIR_REQUEST_INVALID_PARAMS',
      'invalid-input',
      '错误码不能超过 100 个字符。',
    ],
    [
      'BAD_USER_INPUT',
      'INPUT_NORMALIZE_REQUIRED_TEXT_EMPTY',
      'invalid-input',
      '设备错误码不能为空。',
    ],
    [
      'INTERNAL_SERVER_ERROR',
      'REPAIR_REQUEST_CREATION_FAILED',
      'creation-failed',
      '维修申请保存失败。',
    ],
  ])(
    '业务拒绝大类码 %s（errorCode=%s）映射为 reason=%s 且优先使用后端消息',
    async (code, errorCode, reason, errorMessage) => {
      executeGraphQLMock.mockRejectedValue(
        buildDomainIngressError({ errorCode, code, errorMessage }),
      );

      await expect(createRepairRequest(input)).resolves.toEqual({
        ok: false,
        reason,
        message: errorMessage,
      });
    },
  );

  it.each([
    ['NOT_FOUND', 'model-not-found', '所选设备型号不存在，请重新选择。'],
    ['BAD_USER_INPUT', 'invalid-input', '输入不符合要求，请检查后重新提交。'],
    ['INTERNAL_SERVER_ERROR', 'creation-failed', '维修申请创建失败，请稍后重试。'],
  ])(
    '生产环境省略 errorCode 时，仅凭大类码 %s 仍能映射并走兜底文案',
    async (code, reason, message) => {
      executeGraphQLMock.mockRejectedValue(buildDomainIngressError({ code, errorCode: '' }));

      await expect(createRepairRequest(input)).resolves.toEqual({ ok: false, reason, message });
    },
  );

  it('后端未提供业务消息时使用前端兜底文案', async () => {
    executeGraphQLMock.mockRejectedValue(
      buildDomainIngressError({
        errorCode: 'REPAIR_REQUEST_CREATION_FAILED',
        code: 'INTERNAL_SERVER_ERROR',
      }),
    );

    await expect(createRepairRequest(input)).resolves.toEqual({
      ok: false,
      reason: 'creation-failed',
      message: '维修申请创建失败，请稍后重试。',
    });
  });

  it('errorCode 未收录细化表时回退到大类码映射（新增后端码不击穿前端）', async () => {
    executeGraphQLMock.mockRejectedValue(
      buildDomainIngressError({
        code: 'BAD_USER_INPUT',
        errorCode: 'REPAIR_REQUEST_FUTURE_CODE',
        errorMessage: '后端新增的业务拒绝消息。',
      }),
    );

    await expect(createRepairRequest(input)).resolves.toEqual({
      ok: false,
      reason: 'invalid-input',
      message: '后端新增的业务拒绝消息。',
    });
  });

  it('errorMessage 为空白时视同未提供，走前端兜底文案', async () => {
    executeGraphQLMock.mockRejectedValue(
      buildDomainIngressError({
        code: 'NOT_FOUND',
        errorCode: 'REPAIR_REQUEST_EQUIPMENT_MODEL_NOT_FOUND',
        errorMessage: '   ',
      }),
    );

    await expect(createRepairRequest(input)).resolves.toEqual({
      ok: false,
      reason: 'model-not-found',
      message: '所选设备型号不存在，请重新选择。',
    });
  });

  it('存在多条 GraphQL 错误时仅以首条为映射依据', async () => {
    const domainError = buildDomainIngressError({
      code: 'NOT_FOUND',
      errorCode: 'REPAIR_REQUEST_EQUIPMENT_MODEL_NOT_FOUND',
    });
    const mappedError = buildDomainIngressError({
      code: 'BAD_USER_INPUT',
      errorCode: 'REPAIR_REQUEST_INVALID_PARAMS',
    });
    executeGraphQLMock.mockRejectedValue(
      new GraphQLIngressError({
        type: 'graphql',
        message: 'multiple errors',
        graphqlErrors: [...domainError.graphqlErrors!, ...mappedError.graphqlErrors!],
      }),
    );

    await expect(createRepairRequest(input)).resolves.toMatchObject({
      ok: false,
      reason: 'model-not-found',
    });
  });

  it('非业务拒绝大类码（如 GRAPHQL_VALIDATION_FAILED）上抛原始错误，不误判为业务拒绝', async () => {
    const unknownError = buildDomainIngressError({
      errorCode: 'SOME_UNKNOWN_CODE',
      code: 'GRAPHQL_VALIDATION_FAILED',
    });
    executeGraphQLMock.mockRejectedValue(unknownError);

    await expect(createRepairRequest(input)).rejects.toBe(unknownError);
  });

  // S4 归属门禁：本 mutation 内 FORBIDDEN 的唯一业务来源是客户归属缺失 / 不可用。
  // 生产按契约隐藏 errorCode 时无法细分，统一引导「先补录公司」，不新增错误通道。
  it('FORBIDDEN 大类码归为「需先补录公司」，优先展示后端文案', async () => {
    const forbiddenError = buildDomainIngressError({
      code: 'FORBIDDEN',
      errorCode: 'INSUFFICIENT_PERMISSIONS',
      errorMessage: '权限不足',
    });
    executeGraphQLMock.mockRejectedValue(forbiddenError);

    await expect(createRepairRequest(input)).resolves.toEqual({
      message: '权限不足',
      ok: false,
      reason: 'company-required',
    });
  });

  it('FORBIDDEN 且后端隐藏 errorCode 时回落固定补录引导文案', async () => {
    executeGraphQLMock.mockRejectedValue(
      new GraphQLIngressError({
        type: 'graphql',
        message: '请求处理失败。',
        graphqlErrors: [{ message: '请求处理失败。', extensions: { code: 'FORBIDDEN' } }],
      }),
    );

    await expect(createRepairRequest(input)).resolves.toEqual({
      message: '请先在账号设置中补充公司信息后再提交维修申请。',
      ok: false,
      reason: 'company-required',
    });
  });

  it('暴露 errorCode 时区分归属不可用（company-unavailable）', async () => {
    executeGraphQLMock.mockRejectedValue(
      buildDomainIngressError({
        code: 'FORBIDDEN',
        errorCode: 'REPAIR_REQUEST_CUSTOMER_COMPANY_UNAVAILABLE',
      }),
    );

    await expect(createRepairRequest(input)).resolves.toEqual({
      message: '所属公司当前不可用，请联系管理员处理后再提交维修申请。',
      ok: false,
      reason: 'company-unavailable',
    });
  });

  it('auth 失败上抛原始错误，不吞为业务拒绝', async () => {
    const authError = new GraphQLIngressError({ type: 'auth', message: 'token invalid' });
    executeGraphQLMock.mockRejectedValue(authError);

    await expect(createRepairRequest(input)).rejects.toBe(authError);
  });
});

// ---- 客户侧读模型与删除（PR #C 阶段三 T-03） ----

const MY_REPAIR_REQUEST_LIST_ITEM = {
  id: 920001,
  requestNo: 'RR20260901000000ABC001',
  errorCode: 'E-1001',
  createdAt: '2026-09-01T01:00:00.000Z',
  isAccepted: false,
  acceptedAt: null,
  latestResolutionStatus: null,
  equipmentModel: { id: 21, modelCode: 'LITHO-A', modelName: '型号A' },
};

const MY_REPAIR_REQUEST_DETAIL = {
  ...MY_REPAIR_REQUEST_LIST_ITEM,
  faultDescription: '双工件台干涉仪报错',
  contentMd: '# 故障报告',
  responses: [
    {
      id: 1,
      engineerNickname: '工程师甲',
      resolutionStatus: 'PENDING',
      responseText: '已受理，排查中',
      createdAt: '2026-09-01T02:00:00.000Z',
    },
  ],
};

describe('fetchMyRepairRequests', () => {
  it('成功返回分页页，分页变量内部补齐 OFFSET 模式与 withTotal', async () => {
    executeGraphQLMock.mockResolvedValue({
      myRepairRequests: { items: [], total: 0, page: 2, pageSize: 10 },
    });

    await expect(fetchMyRepairRequests({ page: 2, pageSize: 10 })).resolves.toEqual({
      items: [],
      total: 0,
      page: 2,
      pageSize: 10,
    });
    expect(executeGraphQLMock).toHaveBeenCalledWith(expect.stringContaining('myRepairRequests'), {
      pagination: { mode: 'OFFSET', page: 2, pageSize: 10, withTotal: true },
    });
  });

  it('返回后端逐字段透传的列表项（含机型与末条处理状态）', async () => {
    executeGraphQLMock.mockResolvedValue({
      myRepairRequests: { items: [MY_REPAIR_REQUEST_LIST_ITEM], total: 1, page: 1, pageSize: 10 },
    });

    await expect(fetchMyRepairRequests({ page: 1, pageSize: 10 })).resolves.toEqual({
      items: [MY_REPAIR_REQUEST_LIST_ITEM],
      total: 1,
      page: 1,
      pageSize: 10,
    });
  });

  it('transport 失败上抛 GraphQLIngressError（列表无 domain failure 显式结果）', async () => {
    const networkError = new GraphQLIngressError({ type: 'network', message: 'fetch failed' });
    executeGraphQLMock.mockRejectedValue(networkError);

    await expect(fetchMyRepairRequests({ page: 1, pageSize: 10 })).rejects.toBe(networkError);
  });

  it('domain failure（如守卫 FORBIDDEN/INSUFFICIENT_PERMISSIONS）上抛，列表无显式失败结果', async () => {
    const forbiddenError = buildDomainIngressError({
      code: 'FORBIDDEN',
      errorCode: 'INSUFFICIENT_PERMISSIONS',
      errorMessage: '权限不足',
    });
    executeGraphQLMock.mockRejectedValue(forbiddenError);

    await expect(fetchMyRepairRequests({ page: 1, pageSize: 10 })).rejects.toBe(forbiddenError);
  });
});

describe('fetchMyRepairRequest', () => {
  it('成功返回详情（含回复时间线）', async () => {
    executeGraphQLMock.mockResolvedValue({ myRepairRequest: MY_REPAIR_REQUEST_DETAIL });

    await expect(fetchMyRepairRequest(920001)).resolves.toEqual({
      ok: true,
      detail: MY_REPAIR_REQUEST_DETAIL,
    });
    expect(executeGraphQLMock).toHaveBeenCalledWith(expect.stringContaining('myRepairRequest'), {
      id: 920001,
    });
  });

  it('NOT_FOUND 统一归并为 not-found 防探测拒绝，透传后端 errorMessage', async () => {
    executeGraphQLMock.mockRejectedValue(
      buildDomainIngressError({
        code: 'NOT_FOUND',
        errorCode: 'REPAIR_REQUEST_NOT_FOUND',
        errorMessage: '维修申请不存在或不可查看',
      }),
    );

    await expect(fetchMyRepairRequest(920001)).resolves.toEqual({
      ok: false,
      reason: 'not-found',
      message: '维修申请不存在或不可查看',
    });
  });

  it('NOT_FOUND 且后端隐藏 errorMessage 时用前端兜底文案', async () => {
    executeGraphQLMock.mockRejectedValue(
      buildDomainIngressError({ code: 'NOT_FOUND', errorCode: 'REPAIR_REQUEST_NOT_FOUND' }),
    );

    await expect(fetchMyRepairRequest(920001)).resolves.toMatchObject({
      ok: false,
      reason: 'not-found',
      message: '维修申请不存在或不可查看。',
    });
  });

  it('FORBIDDEN/ACCESS_DENIED（详情读取既有契约，防探测文案）也归并为 not-found', async () => {
    executeGraphQLMock.mockRejectedValue(
      buildDomainIngressError({
        code: 'FORBIDDEN',
        errorCode: 'ACCESS_DENIED',
        errorMessage: '维修申请不存在或不可查看',
      }),
    );

    await expect(fetchMyRepairRequest(920002)).resolves.toEqual({
      ok: false,
      reason: 'not-found',
      message: '维修申请不存在或不可查看',
    });
  });

  it('非 not-found 类失败（如 auth UNAUTHENTICATED）不归并，上抛原始错误走失效链路', async () => {
    const unauthenticatedError = buildDomainIngressError({
      code: 'UNAUTHENTICATED',
      errorCode: 'JWT_AUTHENTICATION_FAILED',
      errorMessage: '登录状态已失效',
    });
    executeGraphQLMock.mockRejectedValue(unauthenticatedError);

    await expect(fetchMyRepairRequest(920001)).rejects.toBe(unauthenticatedError);
  });

  it('transport 失败上抛 GraphQLIngressError（详情仅归并 not-found 类域拒绝）', async () => {
    const networkError = new GraphQLIngressError({ type: 'network', message: 'fetch failed' });
    executeGraphQLMock.mockRejectedValue(networkError);

    await expect(fetchMyRepairRequest(920001)).rejects.toBe(networkError);
  });
});

describe('deleteMyRepairRequest', () => {
  it('删除成功返回 ok: true，透传申请 ID 变量', async () => {
    executeGraphQLMock.mockResolvedValue({
      deleteMyRepairRequest: { id: 920001, requestNo: 'RR20260901000000ABC001' },
    });

    await expect(deleteMyRepairRequest(920001)).resolves.toEqual({ ok: true });
    expect(executeGraphQLMock).toHaveBeenCalledWith(
      expect.stringContaining('deleteMyRepairRequest'),
      { id: 920001 },
    );
  });

  it.each([
    ['NOT_FOUND', 'not-found', '维修申请不存在或不可删除。'],
    ['CONFLICT', 'already-accepted', '该申请已被工程师接单，不能删除。'],
    ['FORBIDDEN', 'forbidden', '仅客户账号可以删除维修申请。'],
    ['BAD_USER_INPUT', 'invalid-input', '维修申请参数无效，请刷新后重试。'],
    ['INTERNAL_SERVER_ERROR', 'delete-failed', '维修申请删除失败，请稍后重试。'],
  ] as const)(
    '大类码 %s 映射为 %s，后端隐藏 errorMessage 时用兜底文案',
    async (code, reason, fallback) => {
      executeGraphQLMock.mockRejectedValue(
        buildDomainIngressError({ code, errorCode: 'SOME_BUSINESS_CODE' }),
      );

      await expect(deleteMyRepairRequest(920001)).resolves.toEqual({
        ok: false,
        reason,
        message: fallback,
      });
    },
  );

  it('后端暴露 errorMessage 时透传为业务消息（不取顶层通用 message）', async () => {
    executeGraphQLMock.mockRejectedValue(
      buildDomainIngressError({
        code: 'CONFLICT',
        errorCode: 'REPAIR_REQUEST_ALREADY_ACCEPTED',
        errorMessage: '已接单的维修申请不能删除',
      }),
    );

    await expect(deleteMyRepairRequest(920001)).resolves.toEqual({
      ok: false,
      reason: 'already-accepted',
      message: '已接单的维修申请不能删除',
    });
  });

  it('未知大类码（如 GRAPHQL_VALIDATION_FAILED）上抛原始错误，不误归为业务拒绝', async () => {
    const unknownError = buildDomainIngressError({
      code: 'GRAPHQL_VALIDATION_FAILED',
      errorCode: 'SOME_VALIDATION_CODE',
    });
    executeGraphQLMock.mockRejectedValue(unknownError);

    await expect(deleteMyRepairRequest(920001)).rejects.toBe(unknownError);
  });

  it('transport 失败上抛 GraphQLIngressError，不吞为业务拒绝', async () => {
    const networkError = new GraphQLIngressError({ type: 'network', message: 'fetch failed' });
    executeGraphQLMock.mockRejectedValue(networkError);

    await expect(deleteMyRepairRequest(920001)).rejects.toBe(networkError);
  });

  it('auth 失败上抛原始错误（复用 createGraphQLAuthFailureHandler 失效链路，T-06）', async () => {
    const authError = new GraphQLIngressError({ type: 'auth', message: 'token invalid' });
    executeGraphQLMock.mockRejectedValue(authError);

    await expect(deleteMyRepairRequest(920001)).rejects.toBe(authError);
  });
});
