// src/features/reference-document/reference-document-adapter.spec.ts

/**
 * 参考资料库真实 GraphQL adapter 单测。
 *
 * vi.mock 保留真实错误类，只替换 executeGraphQL；断言错误映射走
 * extensions.code 大类码主信号 + extensions.errorCode 可选细化，
 * 并覆盖生产环境隐藏 errorCode / errorMessage 的退化场景
 * （契约见 backend/docs/api/graphql-error-contract-current.md）。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as sharedGraphql from '@/shared/graphql';
import { GraphQLIngressError } from '@/shared/graphql';

// adapter 单测直接面向 concrete adapter 模块：创建写 adapter 已按 review P2-3 从 barrel 收敛
// （改由 useReferenceDocumentCreate 在 feature 内装配），经公共出口取会被公开面裁剪挡住。
import {
  createReferenceDocument,
  deleteReferenceDocument,
  fetchReferenceDocument,
  fetchReferenceDocuments,
  fetchReferenceEquipmentModels,
  updateReferenceDocument,
  updateReferenceDocumentCase,
} from './infrastructure/reference-document-adapter';

vi.mock('@/shared/graphql', async (importOriginal) => {
  const actual = await importOriginal<typeof sharedGraphql>();

  return {
    ...actual,
    executeGraphQL: vi.fn(),
  };
});

const executeGraphQLMock = vi.mocked(sharedGraphql.executeGraphQL);

function buildDomainIngressError(options: {
  code: string;
  errorCode?: string;
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
          ...(options.errorCode ? { errorCode: options.errorCode } : {}),
          ...(options.errorMessage ? { errorMessage: options.errorMessage } : {}),
        },
      },
    ],
  });
}

beforeEach(() => {
  executeGraphQLMock.mockReset();
});

describe('fetchReferenceEquipmentModels', () => {
  it('返回后端给出的型号列表', async () => {
    executeGraphQLMock.mockResolvedValue({
      equipmentModels: [{ id: 49, modelCode: 'ASML-TWINSCAN-NXT-1980DI', modelName: '型号A' }],
    });

    await expect(fetchReferenceEquipmentModels()).resolves.toEqual([
      { id: 49, modelCode: 'ASML-TWINSCAN-NXT-1980DI', modelName: '型号A' },
    ]);
  });

  it('transport 失败时上抛 GraphQLIngressError', async () => {
    const networkError = new GraphQLIngressError({ type: 'network', message: 'fetch failed' });
    executeGraphQLMock.mockRejectedValue(networkError);

    await expect(fetchReferenceEquipmentModels()).rejects.toBe(networkError);
  });
});

describe('fetchReferenceDocuments', () => {
  const listPage = {
    items: [
      {
        id: 970001,
        title: '错误代码手册（Mock）',
        documentType: 'ERROR_CODE_MANUAL',
        equipmentModelId: 49,
        equipmentModelName: 'ASML TWINSCAN NXT:1980Di',
        equipmentModelText: null,
        description: null,
        originalFilename: null,
        organizationName: '甲方默认组织',
        ingestMethod: 'ADMIN_DIRECT',
        caseHandlingStatus: null,
        creatorNickname: '系统管理员',
        createdAt: '2026-08-01T08:00:00.000Z',
      },
    ],
    total: 1,
    page: 1,
    pageSize: 10,
  };

  it('无筛选时只传分页变量，不携带 filter', async () => {
    executeGraphQLMock.mockResolvedValue({ referenceDocuments: listPage });

    await expect(fetchReferenceDocuments({ page: 1, pageSize: 10 })).resolves.toEqual(listPage);
    expect(executeGraphQLMock).toHaveBeenCalledWith(expect.stringContaining('referenceDocuments'), {
      pagination: { mode: 'OFFSET', page: 1, pageSize: 10, withTotal: true },
    });
  });

  it('筛选变量按契约字段映射：titleKeyword → title，空搜索词视为无筛选', async () => {
    executeGraphQLMock.mockResolvedValue({ referenceDocuments: listPage });

    await fetchReferenceDocuments(
      { page: 2, pageSize: 10 },
      {
        titleKeyword: '  手册  ',
        documentType: 'CHECKLIST',
        equipmentModelId: 49,
        caseHandlingStatus: 'RESOLVED',
      },
    );

    expect(executeGraphQLMock).toHaveBeenLastCalledWith(expect.any(String), {
      pagination: { mode: 'OFFSET', page: 2, pageSize: 10, withTotal: true },
      filter: {
        title: '手册',
        documentType: 'CHECKLIST',
        equipmentModelId: 49,
        caseHandlingStatus: 'RESOLVED',
      },
    });

    await fetchReferenceDocuments({ page: 1, pageSize: 10 }, { titleKeyword: '   ' });

    expect(executeGraphQLMock).toHaveBeenLastCalledWith(expect.any(String), {
      pagination: { mode: 'OFFSET', page: 1, pageSize: 10, withTotal: true },
    });
  });

  it('后端 total 可空字段缺失时兜底为 0', async () => {
    executeGraphQLMock.mockResolvedValue({
      referenceDocuments: { ...listPage, total: null },
    });

    await expect(fetchReferenceDocuments({ page: 1, pageSize: 10 })).resolves.toEqual({
      ...listPage,
      total: 0,
    });
  });

  it('transport 失败时上抛 GraphQLIngressError', async () => {
    const networkError = new GraphQLIngressError({ type: 'network', message: 'fetch failed' });
    executeGraphQLMock.mockRejectedValue(networkError);

    await expect(fetchReferenceDocuments({ page: 1, pageSize: 10 })).rejects.toBe(networkError);
  });
});

describe('fetchReferenceDocument', () => {
  const detail = {
    id: 970002,
    title: '光源维护指南',
    documentType: 'MAINTENANCE_GUIDE',
    equipmentModelId: 51,
    equipmentModelName: 'ASML TWINSCAN NXE:3400C',
    equipmentModelText: null,
    description: null,
    originalFilename: null,
    mimeType: null,
    contentText: '# 正文',
    organizationName: '甲方默认组织',
    ingestMethod: 'ADMIN_DIRECT',
    caseDetail: null,
    creatorNickname: '陈工',
    createdAt: '2026-08-02T09:30:00.000Z',
    updatedAt: '2026-08-05T14:00:00.000Z',
  };

  it('成功返回完整详情', async () => {
    executeGraphQLMock.mockResolvedValue({ referenceDocument: detail });

    await expect(fetchReferenceDocument(970002)).resolves.toEqual({ ok: true, detail });
  });

  it('案例资料详情携带 caseDetail；普通资料 caseDetail 为 null（可空兼容）', async () => {
    const caseDetail = {
      errorCode: 'E-STAGE-301',
      handlingStatus: 'RESOLVED',
      phenomenon: '干涉仪信号丢失',
      conditionText: null,
      reproductionSteps: '复现步骤',
      diagnosis: null,
      actionTaken: null,
      resolution: '已修复',
    };
    executeGraphQLMock.mockResolvedValue({
      referenceDocument: { ...detail, id: 970031, caseDetail },
    });

    const result = await fetchReferenceDocument(970031);

    expect(result).toMatchObject({ ok: true });

    if (result.ok) {
      // 案例明细原样穿透（adapter 不推断不裁剪）；普通资料的 null 由上方详情用例钉住。
      // 详情不含 caseHandlingStatus（后端 Detail DTO 无此字段，S7 真机样例核验）
      expect(result.detail.caseDetail).toEqual(caseDetail);
      expect(result.detail).not.toHaveProperty('caseHandlingStatus');
    }
  });

  it('NOT_FOUND（不存在/已软删统一口径）归并 not-found；errorMessage 优先', async () => {
    const error = buildDomainIngressError({
      code: 'NOT_FOUND',
      errorCode: 'REFERENCE_DOCUMENT_NOT_FOUND',
      errorMessage: '参考资料不存在或不可查看。',
    });
    executeGraphQLMock.mockRejectedValue(error);

    await expect(fetchReferenceDocument(970004)).resolves.toEqual({
      ok: false,
      reason: 'not-found',
      message: '参考资料不存在或不可查看。',
    });
  });

  it('生产隐藏 errorCode/errorMessage 时仍按大类码归并并落兜底文案', async () => {
    executeGraphQLMock.mockRejectedValue(buildDomainIngressError({ code: 'NOT_FOUND' }));

    await expect(fetchReferenceDocument(999999)).resolves.toEqual({
      ok: false,
      reason: 'not-found',
      message: '参考资料不存在或不可查看。',
    });
  });

  it('FORBIDDEN（守卫拒绝）同详情读取既有契约归并 not-found', async () => {
    executeGraphQLMock.mockRejectedValue(
      buildDomainIngressError({ code: 'FORBIDDEN', errorCode: 'ACCESS_DENIED' }),
    );

    await expect(fetchReferenceDocument(970001)).resolves.toMatchObject({
      ok: false,
      reason: 'not-found',
    });
  });

  it('transport 失败不归并为业务拒绝，仍上抛', async () => {
    const networkError = new GraphQLIngressError({ type: 'network', message: 'fetch failed' });
    executeGraphQLMock.mockRejectedValue(networkError);

    await expect(fetchReferenceDocument(970002)).rejects.toBe(networkError);
  });
});

describe('createReferenceDocument', () => {
  const input = {
    title: '新资料',
    documentType: 'CHECKLIST',
    equipmentModelId: null,
    description: null,
    contentText: '正文',
  };

  it('创建成功返回新资料 ID', async () => {
    executeGraphQLMock.mockResolvedValue({ createReferenceDocument: { id: 970031 } });

    await expect(createReferenceDocument(input)).resolves.toEqual({ ok: true, id: 970031 });
    expect(executeGraphQLMock).toHaveBeenCalledWith(
      expect.stringContaining('createReferenceDocument'),
      { input },
    );
  });

  it.each([
    [
      'NOT_FOUND + 型号不存在',
      { code: 'NOT_FOUND', errorCode: 'REFERENCE_DOCUMENT_EQUIPMENT_MODEL_NOT_FOUND' },
      'model-not-found',
      '所选设备型号不存在，请重新选择。',
    ],
    [
      'BAD_USER_INPUT + 非法参数',
      { code: 'BAD_USER_INPUT', errorCode: 'REFERENCE_DOCUMENT_INVALID_PARAMS' },
      'invalid-input',
      '输入不符合要求，请检查后重新提交。',
    ],
    [
      '生产隐藏 errorCode 的大类码退化',
      { code: 'BAD_USER_INPUT' },
      'invalid-input',
      '输入不符合要求，请检查后重新提交。',
    ],
    [
      '落库失败（系统侧）',
      { code: 'INTERNAL_SERVER_ERROR', errorCode: 'REFERENCE_DOCUMENT_CREATION_FAILED' },
      'creation-failed',
      '参考资料创建失败，请稍后重试。',
    ],
  ])('%s → %s', async (_name, extensions, reason, fallback) => {
    const withMessage = buildDomainIngressError({ ...extensions, errorMessage: '后端业务消息' });
    executeGraphQLMock.mockRejectedValueOnce(withMessage);

    // errorMessage 存在时优先展示后端业务消息
    await expect(createReferenceDocument(input)).resolves.toEqual({
      ok: false,
      reason,
      message: '后端业务消息',
    });

    const withoutMessage = buildDomainIngressError(extensions);
    executeGraphQLMock.mockRejectedValueOnce(withoutMessage);

    // errorMessage 缺失时落前端兜底文案
    await expect(createReferenceDocument(input)).resolves.toEqual({
      ok: false,
      reason,
      message: fallback,
    });
  });

  it('未映射的大类码（如守卫 FORBIDDEN）不吞为业务拒绝，仍上抛', async () => {
    const forbidden = buildDomainIngressError({ code: 'FORBIDDEN', errorCode: 'ACCESS_DENIED' });
    executeGraphQLMock.mockRejectedValue(forbidden);

    await expect(createReferenceDocument(input)).rejects.toBe(forbidden);
  });

  it('transport 失败时上抛 GraphQLIngressError', async () => {
    const networkError = new GraphQLIngressError({ type: 'network', message: 'fetch failed' });
    executeGraphQLMock.mockRejectedValue(networkError);

    await expect(createReferenceDocument(input)).rejects.toBe(networkError);
  });
});

describe('updateReferenceDocument', () => {
  const patch = { title: '改名后的标题' };

  it('编辑成功返回资料 ID', async () => {
    executeGraphQLMock.mockResolvedValue({ updateReferenceDocument: { id: 970002 } });

    await expect(updateReferenceDocument(970002, patch)).resolves.toEqual({ ok: true, id: 970002 });
    expect(executeGraphQLMock).toHaveBeenCalledWith(
      expect.stringContaining('updateReferenceDocument'),
      { id: 970002, input: patch },
    );
  });

  it.each([
    [
      'NOT_FOUND（资料不存在/已软删）',
      { code: 'NOT_FOUND', errorCode: 'REFERENCE_DOCUMENT_NOT_FOUND' },
      'not-found',
    ],
    [
      'NOT_FOUND 细化为型号不存在',
      { code: 'NOT_FOUND', errorCode: 'REFERENCE_DOCUMENT_EQUIPMENT_MODEL_NOT_FOUND' },
      'model-not-found',
    ],
    ['生产隐藏 errorCode 时大类码退化为 not-found（不误判）', { code: 'NOT_FOUND' }, 'not-found'],
    [
      'BAD_USER_INPUT（必填显式 null / 超长）',
      { code: 'BAD_USER_INPUT', errorCode: 'REFERENCE_DOCUMENT_INVALID_PARAMS' },
      'invalid-input',
    ],
    [
      '落库失败（系统侧）',
      { code: 'INTERNAL_SERVER_ERROR', errorCode: 'REFERENCE_DOCUMENT_UPDATE_FAILED' },
      'update-failed',
    ],
  ])('%s → %s', async (_name, extensions, reason) => {
    executeGraphQLMock.mockRejectedValue(buildDomainIngressError(extensions));

    await expect(updateReferenceDocument(970002, patch)).resolves.toMatchObject({
      ok: false,
      reason,
    });
  });

  it('transport 失败时上抛 GraphQLIngressError', async () => {
    const networkError = new GraphQLIngressError({ type: 'network', message: 'fetch failed' });
    executeGraphQLMock.mockRejectedValue(networkError);

    await expect(updateReferenceDocument(970002, patch)).rejects.toBe(networkError);
  });
});

describe('deleteReferenceDocument', () => {
  it('软删成功返回 ok（本模块软删不幂等，重复删走 NOT_FOUND 拒绝）', async () => {
    executeGraphQLMock.mockResolvedValue({ softDeleteReferenceDocument: { id: 970002 } });

    await expect(deleteReferenceDocument(970002)).resolves.toEqual({ ok: true });
    expect(executeGraphQLMock).toHaveBeenCalledWith(
      expect.stringContaining('softDeleteReferenceDocument'),
      { id: 970002 },
    );
  });

  it.each([
    ['NOT_FOUND（不存在/已软删统一防探测口径）', { code: 'NOT_FOUND' }, 'not-found'],
    [
      '落库失败（系统侧）',
      { code: 'INTERNAL_SERVER_ERROR', errorCode: 'REFERENCE_DOCUMENT_DELETION_FAILED' },
      'delete-failed',
    ],
  ])('%s → %s', async (_name, extensions, reason) => {
    executeGraphQLMock.mockRejectedValue(buildDomainIngressError(extensions));

    await expect(deleteReferenceDocument(970002)).resolves.toMatchObject({
      ok: false,
      reason,
    });
  });

  it('transport 失败时上抛 GraphQLIngressError', async () => {
    const networkError = new GraphQLIngressError({ type: 'network', message: 'fetch failed' });
    executeGraphQLMock.mockRejectedValue(networkError);

    await expect(deleteReferenceDocument(970002)).rejects.toBe(networkError);
  });
});

describe('updateReferenceDocumentCase', () => {
  const patch = { handlingStatus: 'IN_PROGRESS' as const };

  it('更正成功返回资料 ID 与最新更新时间', async () => {
    executeGraphQLMock.mockResolvedValue({
      updateReferenceDocumentCase: { id: 970031, updatedAt: '2026-08-28T12:00:00.000Z' },
    });

    await expect(updateReferenceDocumentCase(970031, patch)).resolves.toEqual({
      ok: true,
      id: 970031,
      updatedAt: '2026-08-28T12:00:00.000Z',
    });
    expect(executeGraphQLMock).toHaveBeenCalledWith(
      expect.stringContaining('updateReferenceDocumentCase'),
      { id: 970031, input: patch },
    );
  });

  it.each([
    [
      'NOT_FOUND（不存在/已软删/跨组织统一防探测）',
      { code: 'NOT_FOUND', errorCode: 'REFERENCE_DOCUMENT_NOT_FOUND' },
      'not-found',
    ],
    [
      'NOT_FOUND 细化为型号不存在',
      { code: 'NOT_FOUND', errorCode: 'REFERENCE_DOCUMENT_EQUIPMENT_MODEL_NOT_FOUND' },
      'model-not-found',
    ],
    ['生产隐藏 errorCode 时大类码退化为 not-found（不误判）', { code: 'NOT_FOUND' }, 'not-found'],
    [
      'BAD_USER_INPUT（非案例资料/必填/互斥，后端口径不是 not-found）',
      { code: 'BAD_USER_INPUT', errorCode: 'REFERENCE_DOCUMENT_INVALID_PARAMS' },
      'invalid-input',
    ],
    [
      '落库失败 / 明细缺失（系统侧）',
      { code: 'INTERNAL_SERVER_ERROR', errorCode: 'REFERENCE_DOCUMENT_UPDATE_FAILED' },
      'update-failed',
    ],
  ])('%s → %s', async (_name, extensions, reason) => {
    executeGraphQLMock.mockRejectedValue(buildDomainIngressError(extensions));

    await expect(updateReferenceDocumentCase(970031, patch)).resolves.toMatchObject({
      ok: false,
      reason,
    });
  });

  it('FORBIDDEN（守卫拒绝）不吞为业务拒绝，仍上抛', async () => {
    const forbidden = buildDomainIngressError({ code: 'FORBIDDEN', errorCode: 'ACCESS_DENIED' });
    executeGraphQLMock.mockRejectedValue(forbidden);

    await expect(updateReferenceDocumentCase(970031, patch)).rejects.toBe(forbidden);
  });

  it('transport 失败时上抛 GraphQLIngressError', async () => {
    const networkError = new GraphQLIngressError({ type: 'network', message: 'fetch failed' });
    executeGraphQLMock.mockRejectedValue(networkError);

    await expect(updateReferenceDocumentCase(970031, patch)).rejects.toBe(networkError);
  });
});
