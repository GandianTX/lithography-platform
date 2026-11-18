// src/features/admin-company-management/infrastructure/admin-company-adapter.spec.ts

/**
 * 公司档案 adapter 契约测试：
 * - GraphQL 变量只下发调用方实际提供的筛选（null 表示不筛选，不发显式 null）；
 * - 原始 DTO 经 mapper 归一后才进入 feature 模型，未知枚举失败关闭；
 * - 业务拒绝按稳定大类码映射为显式失败结果，transport / auth 类失败原样上抛。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GraphQLIngressError } from '@/shared/graphql';

import {
  adminCreateCompany,
  adminReissueLevelTwoCredential,
  adminUpdateCompany,
  checkAdminCompanyNameExists,
  fetchAdminCompanies,
  fetchAdminCompanyAdminBinding,
  fetchAdminCompanyDetail,
  fetchAdminCompanyNames,
} from './admin-company-adapter';

const { executeGraphQLMock } = vi.hoisted(() => ({ executeGraphQLMock: vi.fn() }));

vi.mock('@/shared/graphql', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/graphql')>();

  return { ...actual, executeGraphQL: executeGraphQLMock };
});

function buildDto(overrides: Record<string, unknown> = {}) {
  return {
    id: 501,
    organizationCode: 'ADMIN_ORG_501',
    name: '甲公司',
    shortName: '甲',
    contactName: '张三',
    contactPhone: '13800000001',
    contactEmail: 'contact@example.com',
    address: '上海',
    remark: '备注',
    isServiceProvider: true,
    isManagedCompany: true,
    kind: 'CLIENT',
    status: 'ACTIVE',
    createdAt: '2026-11-01T08:00:00.000Z',
    updatedAt: '2026-11-02T08:00:00.000Z',
    ...overrides,
  };
}

function graphqlError(code: string, errorMessage?: string, errorCode?: string) {
  return new GraphQLIngressError({
    type: 'graphql',
    message: 'graphql error',
    graphqlErrors: [
      {
        message: errorMessage ?? code,
        extensions: {
          code,
          ...(errorMessage ? { errorMessage } : {}),
          ...(errorCode ? { errorCode } : {}),
        },
      },
    ],
  });
}

beforeEach(() => {
  executeGraphQLMock.mockReset();
});

describe('fetchAdminCompanies', () => {
  it('下发分页与已提供的筛选，映射为完整列表页', async () => {
    executeGraphQLMock.mockResolvedValue({
      adminOrganizationList: { items: [buildDto()], page: 2, pageSize: 10, total: 11 },
    });

    const page = await fetchAdminCompanies({
      keyword: '甲',
      page: 2,
      pageSize: 10,
      status: 'ACTIVE',
      isServiceProvider: false,
    });

    expect(executeGraphQLMock).toHaveBeenCalledWith(
      expect.stringContaining('adminOrganizationList'),
      {
        pagination: { mode: 'OFFSET', page: 2, pageSize: 10, withTotal: true },
        keyword: '甲',
        status: 'ACTIVE',
        isServiceProvider: false,
      },
    );
    expect(page).toMatchObject({ kind: 'full', page: 2, pageSize: 10, total: 11 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      organizationId: 501,
      organizationCode: 'ADMIN_ORG_501',
      kind: 'CLIENT',
      status: 'ACTIVE',
    });
  });

  it('未提供的筛选不进入变量（null 与「不筛选」同义）', async () => {
    executeGraphQLMock.mockResolvedValue({
      adminOrganizationList: { items: [], page: 1, pageSize: 10, total: 0 },
    });

    await fetchAdminCompanies({
      keyword: null,
      page: 1,
      pageSize: 10,
      status: null,
      isServiceProvider: null,
    });

    const [, variables] = executeGraphQLMock.mock.calls[0];

    expect(variables).toEqual({
      pagination: { mode: 'OFFSET', page: 1, pageSize: 10, withTotal: true },
    });
  });

  it('未知状态值失败关闭，不把脏值降级成错误展示', async () => {
    executeGraphQLMock.mockResolvedValue({
      adminOrganizationList: {
        items: [buildDto({ status: 'ARCHIVED' })],
        page: 1,
        pageSize: 10,
        total: 1,
      },
    });

    await expect(
      fetchAdminCompanies({
        keyword: null,
        page: 1,
        pageSize: 10,
        status: null,
        isServiceProvider: null,
      }),
    ).rejects.toThrow('无法识别的状态');
  });
});

describe('fetchAdminCompanyNames', () => {
  it('只请求最小名称字段并映射名称页', async () => {
    executeGraphQLMock.mockResolvedValue({
      adminOrganizationNameList: {
        items: [{ id: 7, name: '乙公司' }],
        page: 1,
        pageSize: 10,
        total: 1,
      },
    });

    const page = await fetchAdminCompanyNames({
      keyword: null,
      page: 1,
      pageSize: 10,
      status: null,
      isServiceProvider: null,
    });

    expect(executeGraphQLMock).toHaveBeenCalledWith(
      expect.stringContaining('adminOrganizationNameList'),
      {
        pagination: { mode: 'OFFSET', page: 1, pageSize: 10, withTotal: true },
      },
    );
    expect(page).toEqual({
      kind: 'name',
      items: [{ id: 7, name: '乙公司' }],
      page: 1,
      pageSize: 10,
      total: 1,
    });
  });
});

describe('fetchAdminCompanyDetail', () => {
  it('成功时返回完整档案', async () => {
    executeGraphQLMock.mockResolvedValue({ adminOrganizationDetail: buildDto() });

    const result = await fetchAdminCompanyDetail(501);

    expect(executeGraphQLMock).toHaveBeenCalledWith(
      expect.stringContaining('adminOrganizationDetail'),
      {
        organizationId: 501,
      },
    );
    expect(result).toMatchObject({ ok: true, organization: { organizationId: 501 } });
  });

  it('NOT_FOUND 映射为 not-found 并保留后端业务文案', async () => {
    executeGraphQLMock.mockRejectedValue(graphqlError('NOT_FOUND', '目标公司不存在'));

    const result = await fetchAdminCompanyDetail(999);

    expect(result).toEqual({ ok: false, reason: 'not-found', message: '目标公司不存在' });
  });

  it('transport 类失败原样上抛，由共享 ingress 链路处理', async () => {
    const error = new GraphQLIngressError({ type: 'network', message: 'offline' });
    executeGraphQLMock.mockRejectedValue(error);

    await expect(fetchAdminCompanyDetail(501)).rejects.toBe(error);
  });
});

describe('adminCreateCompany', () => {
  const submissionKey = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

  it('使用 adminProvisionCompany 并携带提交标识，必填字段 trim、可选空串转 null', async () => {
    executeGraphQLMock.mockResolvedValue({
      adminProvisionCompany: {
        organization: buildDto({ status: 'DISABLED' }),
        provisionedAdmin: {
          accountId: 901,
          loginName: 'orgadmin_abcdef0123456789abcd',
          nickname: '甲公司',
          mustChangePassword: true,
        },
        submission: { submissionId: 77, replayed: false },
        temporaryPassword: 'Temp-Stub-Abcd-1',
      },
    });

    const result = await adminCreateCompany(
      {
        name: '  甲公司  ',
        contactPhone: ' 13800000001 ',
        shortName: '',
        contactName: ' 张三 ',
        contactEmail: '',
        address: ' 上海 ',
        remark: '',
        status: 'DISABLED',
        isServiceProvider: true,
      },
      submissionKey,
    );

    expect(executeGraphQLMock).toHaveBeenCalledWith(
      expect.stringContaining('adminProvisionCompany'),
      {
        input: {
          name: '甲公司',
          contactPhone: '13800000001',
          shortName: null,
          contactName: '张三',
          contactEmail: null,
          address: '上海',
          remark: null,
          status: 'DISABLED',
          isServiceProvider: true,
          submissionKey,
        },
      },
    );
    // 首次成功必须取回一次性口令；回放恒为 null 由后端保证
    expect(executeGraphQLMock.mock.calls[0][0]).toContain('temporaryPassword');
    expect(result).toMatchObject({
      ok: true,
      organization: { organizationId: 501 },
      temporaryPassword: 'Temp-Stub-Abcd-1',
    });
  });

  it('BAD_USER_INPUT 映射为 invalid-input', async () => {
    executeGraphQLMock.mockRejectedValue(graphqlError('BAD_USER_INPUT'));

    const result = await adminCreateCompany(
      {
        name: '甲公司',
        contactPhone: '13800000001',
        shortName: '',
        contactName: '',
        contactEmail: '',
        address: '',
        remark: '',
        status: 'ACTIVE',
        isServiceProvider: false,
      },
      submissionKey,
    );

    expect(result).toEqual({
      ok: false,
      reason: 'invalid-input',
      message: '输入不符合要求，请检查后重新提交。',
    });
  });

  it('同标识改内容（CONFLICT + SUBMISSION_CONFLICT 细分码）映射为 submission-conflict', async () => {
    executeGraphQLMock.mockRejectedValue(
      graphqlError(
        'CONFLICT',
        '提交内容与已提交记录不一致',
        'ORGANIZATION_MANAGEMENT_SUBMISSION_CONFLICT',
      ),
    );

    const result = await adminCreateCompany(
      {
        name: '甲公司',
        contactPhone: '13800000001',
        shortName: '',
        contactName: '',
        contactEmail: '',
        address: '',
        remark: '',
        status: 'ACTIVE',
        isServiceProvider: false,
      },
      submissionKey,
    );

    expect(result).toEqual({
      ok: false,
      reason: 'submission-conflict',
      message: '提交内容与已提交记录不一致',
    });
  });

  it('缺少开通结果时按内部失败处理而不是返回假成功', async () => {
    executeGraphQLMock.mockResolvedValue({});

    await expect(
      adminCreateCompany(
        {
          name: '甲公司',
          contactPhone: '13800000001',
          shortName: '',
          contactName: '',
          contactEmail: '',
          address: '',
          remark: '',
          status: 'ACTIVE',
          isServiceProvider: false,
        },
        submissionKey,
      ),
    ).rejects.toThrow('未返回落库结果');
  });
});

describe('adminUpdateCompany', () => {
  it('只提交发生变化的键，null 表示明确清空', async () => {
    executeGraphQLMock.mockResolvedValue({
      adminUpdateOrganization: buildDto({ status: 'DISABLED' }),
    });

    const result = await adminUpdateCompany({
      organizationId: 501,
      name: ' 新名称 ',
      shortName: null,
      status: 'DISABLED',
    });

    const [, variables] = executeGraphQLMock.mock.calls[0];

    expect(variables).toEqual({
      input: { organizationId: 501, name: '新名称', shortName: null, status: 'DISABLED' },
    });
    expect(result).toMatchObject({ ok: true, organization: { status: 'DISABLED' } });
  });

  it('CONFLICT 映射为 duplicate-code', async () => {
    executeGraphQLMock.mockRejectedValue(graphqlError('CONFLICT', '编号冲突'));

    const result = await adminUpdateCompany({ organizationId: 501, name: '新名称' });

    expect(result).toEqual({ ok: false, reason: 'duplicate-code', message: '编号冲突' });
  });

  it('落库结果缺失时按内部失败处理而不是返回假成功', async () => {
    executeGraphQLMock.mockResolvedValue({});

    await expect(adminUpdateCompany({ organizationId: 501, name: '新名称' })).rejects.toThrow(
      '未返回落库结果',
    );
  });
});

describe('checkAdminCompanyNameExists', () => {
  it('新增不传排除主键，避免把 null 当作筛选值下发', async () => {
    executeGraphQLMock.mockResolvedValue({ adminOrganizationNameExists: true });

    await expect(checkAdminCompanyNameExists({ name: '甲公司' })).resolves.toBe(true);

    expect(executeGraphQLMock).toHaveBeenCalledWith(
      expect.stringContaining('adminOrganizationNameExists'),
      {
        name: '甲公司',
      },
    );
  });

  it('编辑按自身主键排除自己', async () => {
    executeGraphQLMock.mockResolvedValue({ adminOrganizationNameExists: false });

    await expect(
      checkAdminCompanyNameExists({ name: '甲公司', excludeOrganizationId: 501 }),
    ).resolves.toBe(false);

    expect(executeGraphQLMock).toHaveBeenCalledWith(
      expect.stringContaining('adminOrganizationNameExists'),
      {
        name: '甲公司',
        excludeOrganizationId: 501,
      },
    );
  });

  it('缺少布尔结果时按未命中处理，不把 undefined 当作命中', async () => {
    executeGraphQLMock.mockResolvedValue({});

    await expect(checkAdminCompanyNameExists({ name: '甲公司' })).resolves.toBe(false);
  });
});

describe('fetchAdminCompanyAdminBinding', () => {
  it('按公司主键查询并映射绑定事实（无凭据字段）', async () => {
    executeGraphQLMock.mockResolvedValue({
      adminCompanyAdminBinding: {
        organizationId: 501,
        organizationCode: 'ADMIN_ORG_501',
        companyName: '甲公司',
        isManagedCompany: true,
        companyStatus: 'ACTIVE',
        status: 'BOUND',
        reason: null,
        boundAccountId: 9001,
        boundLoginNameMasked: 'adm***01',
        candidateCount: 1,
        accountDisabled: false,
      },
    });

    const result = await fetchAdminCompanyAdminBinding(501);

    expect(executeGraphQLMock).toHaveBeenCalledWith(
      expect.stringContaining('adminCompanyAdminBinding'),
      { organizationId: 501 },
    );
    expect(result).toEqual({
      ok: true,
      binding: {
        organizationId: 501,
        organizationCode: 'ADMIN_ORG_501',
        companyName: '甲公司',
        isManagedCompany: true,
        companyStatus: 'ACTIVE',
        status: 'BOUND',
        reason: null,
        boundAccountId: 9001,
        boundLoginNameMasked: 'adm***01',
        candidateCount: 1,
        accountDisabled: false,
      },
    });
  });

  it('绑定状态取值不在四态内时失败关闭，不降级成错误展示', async () => {
    executeGraphQLMock.mockResolvedValue({
      adminCompanyAdminBinding: {
        organizationId: 501,
        organizationCode: 'ADMIN_ORG_501',
        companyName: '甲公司',
        isManagedCompany: true,
        companyStatus: 'ACTIVE',
        status: 'UNKNOWN_STATE',
        reason: null,
        boundAccountId: null,
        boundLoginNameMasked: null,
        candidateCount: 0,
        accountDisabled: false,
      },
    });

    await expect(fetchAdminCompanyAdminBinding(501)).rejects.toThrow(
      '公司绑定数据返回了无法识别的状态。',
    );
  });

  it('缺少查询结果时上抛，不返回假绑定', async () => {
    executeGraphQLMock.mockResolvedValue({});

    await expect(fetchAdminCompanyAdminBinding(501)).rejects.toThrow('未返回结果');
  });
});

describe('adminReissueLevelTwoCredential', () => {
  it('只下发公司主键并返回本次新口令', async () => {
    executeGraphQLMock.mockResolvedValue({
      adminReissueCompanyAdminCredential: {
        organizationId: 501,
        adminAccountId: 9001,
        loginName: 'orgadmin_abcdef0123456789abcd',
        nickname: '甲公司',
        mustChangePassword: true,
        temporaryPassword: 'Temp-Stub-Abcd-2',
      },
    });

    const result = await adminReissueLevelTwoCredential(501);

    expect(executeGraphQLMock).toHaveBeenCalledWith(
      expect.stringContaining('adminReissueCompanyAdminCredential'),
      { input: { organizationId: 501 } },
    );
    expect(result).toMatchObject({
      ok: true,
      organizationId: 501,
      adminAccountId: 9001,
      temporaryPassword: 'Temp-Stub-Abcd-2',
    });
  });

  it('CREDENTIAL_REISSUE_NOT_ALLOWED 映射为 credential-not-allowed', async () => {
    executeGraphQLMock.mockRejectedValue(
      graphqlError(
        'CONFLICT',
        '该管理员已完成首次改密，不能补发临时密码；如需重新开通请使用重置',
        'ORGANIZATION_MANAGEMENT_CREDENTIAL_REISSUE_NOT_ALLOWED',
      ),
    );

    const result = await adminReissueLevelTwoCredential(501);

    expect(result).toEqual({
      ok: false,
      reason: 'credential-not-allowed',
      message: '该管理员已完成首次改密，不能补发临时密码；如需重新开通请使用重置',
    });
  });

  it('ADMIN_BINDING_REQUIRED 映射为 credential-conflict', async () => {
    executeGraphQLMock.mockRejectedValue(
      graphqlError(
        'CONFLICT',
        '目标公司尚未绑定二级管理员',
        'ORGANIZATION_MANAGEMENT_ADMIN_BINDING_REQUIRED',
      ),
    );

    const result = await adminReissueLevelTwoCredential(501);

    expect(result).toEqual({
      ok: false,
      reason: 'credential-conflict',
      message: '目标公司尚未绑定二级管理员',
    });
  });

  it('响应缺少口令时映射失败上抛，不把空口令当成功', async () => {
    executeGraphQLMock.mockResolvedValue({
      adminReissueCompanyAdminCredential: {
        organizationId: 501,
        adminAccountId: 9001,
        loginName: 'orgadmin_abcdef0123456789abcd',
        nickname: '甲公司',
        mustChangePassword: true,
        temporaryPassword: '',
      },
    });

    await expect(adminReissueLevelTwoCredential(501)).rejects.toThrow('缺少临时密码');
  });
});
