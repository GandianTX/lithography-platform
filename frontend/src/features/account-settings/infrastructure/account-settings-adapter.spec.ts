// src/features/account-settings/infrastructure/account-settings-adapter.spec.ts

/**
 * 账号设置 GraphQL adapter（外部技术边界唯一落点）单测。
 *
 * 只 mock 共享 executeGraphQL，验证：
 * - 三个 operation 的文档与变量口径（含资料更新的三态 input 构造）；
 * - 业务拒绝按稳定的 extensions.code 大类映射为显式失败结果，errorMessage 仅作细化；
 * - 未登记大类码 / 缺少 code / 非 ingress 错误继续上抛，交共享 ingress 链路处理；
 * - 改密结果不含任何密码、哈希或令牌字段。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as sharedGraphql from '@/shared/graphql';
import { GraphQLIngressError } from '@/shared/graphql';

import type {
  AccountSettingsProfileFailureReason,
  CustomerCompanySupplementFailureReason,
} from '../application/account-settings.types';

import type { MyAccountSettingsDto } from './account-settings.dto';
import {
  changeMyPassword,
  fetchMyAccountSettings,
  searchManagedCompanies,
  supplementMyCustomerCompany,
  updateMyAccountSettingsProfile,
} from './account-settings-adapter';

vi.mock('@/shared/graphql', async (importOriginal) => {
  const actual = await importOriginal<typeof sharedGraphql>();

  return { ...actual, executeGraphQL: vi.fn() };
});

const executeGraphQLMock = vi.mocked(sharedGraphql.executeGraphQL);

const SETTINGS_DTO: MyAccountSettingsDto = {
  adminLevel: 2,
  companyName: '示例公司',
  contactEmail: 'contact@example.com',
  loginEmail: 'self@example.com',
  loginName: 'self_user',
  nickname: '陈工',
  phone: '13800000000',
  realName: '张三',
  role: 'ENGINEER',
  status: 'ACTIVE',
  trustedCompanyName: '可信公司',
  updatedAt: '2026-01-01T08:00:00.000Z',
};

/** 与 SETTINGS_DTO 等价的内部视图（已归一，无脏值需要 trim） */
const SETTINGS_VIEW = { ...SETTINGS_DTO };

function buildIngressError(options: {
  code?: string;
  errorCode?: string;
  errorMessage?: string;
  withGraphqlErrors?: boolean;
}) {
  const extensions: Record<string, unknown> = {};

  if (options.code !== undefined) {
    extensions.code = options.code;
  }

  if (options.errorCode !== undefined) {
    extensions.errorCode = options.errorCode;
  }

  if (options.errorMessage !== undefined) {
    extensions.errorMessage = options.errorMessage;
  }

  return new GraphQLIngressError({
    type: 'graphql',
    message: '请求处理失败。',
    graphqlErrors:
      options.withGraphqlErrors === false ? [] : [{ message: '请求处理失败。', extensions }],
  });
}

beforeEach(() => {
  executeGraphQLMock.mockReset();
});

describe('fetchMyAccountSettings', () => {
  it('只发一次受保护 query，并把 DTO 映射为 feature 内部视图', async () => {
    executeGraphQLMock.mockResolvedValue({ myAccountSettings: SETTINGS_DTO });

    await expect(fetchMyAccountSettings()).resolves.toEqual(SETTINGS_VIEW);

    expect(executeGraphQLMock).toHaveBeenCalledTimes(1);
    expect(executeGraphQLMock).toHaveBeenCalledWith(
      expect.stringContaining('query MyAccountSettings'),
      {},
    );
    expect(executeGraphQLMock.mock.calls[0]?.[0]).toContain('myAccountSettings');
    expect(executeGraphQLMock.mock.calls[0]?.[0]).toContain('realName');
    expect(executeGraphQLMock.mock.calls[0]?.[0]).toContain('adminLevel');
    expect(executeGraphQLMock.mock.calls[0]?.[0]).toContain('trustedCompanyName');
    expect(executeGraphQLMock.mock.calls[0]?.[0]).not.toContain('accountId');
  });

  it('读取失败原样上抛，由 application 的加载状态机收敛', async () => {
    const error = buildIngressError({ code: 'UNAUTHENTICATED' });
    executeGraphQLMock.mockRejectedValue(error);

    await expect(fetchMyAccountSettings()).rejects.toBe(error);
  });

  it('后端返回未知角色时守卫抛错，不降级成错误展示', async () => {
    executeGraphQLMock.mockResolvedValue({
      myAccountSettings: { ...SETTINGS_DTO, role: 'OPERATOR' },
    });

    await expect(fetchMyAccountSettings()).rejects.toThrow('账号设置返回了无法识别的角色。');
  });
});

describe('updateMyAccountSettingsProfile 三态 input 构造', () => {
  it('realName 三态：undefined 省略（不修改）、null 保留（清空）、字符串原样传递（设置）', async () => {
    executeGraphQLMock.mockResolvedValue({
      updateMyAccountSettings: { isUpdated: true, settings: SETTINGS_DTO },
    });

    await updateMyAccountSettingsProfile({
      contactEmail: 'new-contact@example.com',
      nickname: '新昵称',
      phone: undefined,
      realName: null,
    });

    expect(executeGraphQLMock).toHaveBeenCalledWith(expect.stringContaining('mutation'), {
      input: {
        contactEmail: 'new-contact@example.com',
        nickname: '新昵称',
        realName: null,
      },
    });
    const input = executeGraphQLMock.mock.calls[0]?.[1] as { input: Record<string, unknown> };

    expect(Object.keys(input.input).sort()).toEqual(['contactEmail', 'nickname', 'realName']);
    // 本页不再编辑或提交登录名 / 登录邮箱 / 公司字段
    expect(input.input).not.toHaveProperty('loginName');
    expect(input.input).not.toHaveProperty('loginEmail');
    expect(input.input).not.toHaveProperty('companyName');

    executeGraphQLMock.mockClear();
    await updateMyAccountSettingsProfile({ realName: '  李四  ' });

    expect(executeGraphQLMock).toHaveBeenCalledWith(expect.stringContaining('mutation'), {
      input: { realName: '  李四  ' },
    });

    executeGraphQLMock.mockClear();
    await updateMyAccountSettingsProfile({ nickname: '仅昵称' });

    // undefined 的 realName 键被省略：不修改该字段
    expect(executeGraphQLMock).toHaveBeenCalledWith(expect.stringContaining('mutation'), {
      input: { nickname: '仅昵称' },
    });
  });

  it('草稿全部字段缺省时提交空 input，adapter 不做 trim 或业务裁决', async () => {
    executeGraphQLMock.mockResolvedValue({
      updateMyAccountSettings: { isUpdated: false, settings: SETTINGS_DTO },
    });

    await updateMyAccountSettingsProfile({});

    expect(executeGraphQLMock).toHaveBeenCalledWith(expect.stringContaining('mutation'), {
      input: {},
    });
  });
});

describe('updateMyAccountSettingsProfile 成功', () => {
  it('返回后端权威视图与 isUpdated 标记', async () => {
    executeGraphQLMock.mockResolvedValue({
      updateMyAccountSettings: {
        isUpdated: true,
        settings: { ...SETTINGS_DTO, realName: '李四' },
      },
    });

    await expect(updateMyAccountSettingsProfile({ realName: '李四' })).resolves.toEqual({
      isUpdated: true,
      ok: true,
      settings: { ...SETTINGS_VIEW, realName: '李四' },
    });
  });

  it('后端判定同值（isUpdated=false）时同样回传权威视图', async () => {
    executeGraphQLMock.mockResolvedValue({
      updateMyAccountSettings: { isUpdated: false, settings: SETTINGS_DTO },
    });

    await expect(updateMyAccountSettingsProfile({ nickname: '陈工' })).resolves.toEqual({
      isUpdated: false,
      ok: true,
      settings: SETTINGS_VIEW,
    });
  });
});

describe('updateMyAccountSettingsProfile 业务拒绝映射', () => {
  it.each<[string, AccountSettingsProfileFailureReason, string]>([
    ['BAD_USER_INPUT', 'invalid-input', '输入不符合要求，请检查后重新提交。'],
    ['CONFLICT', 'duplicate-credential', '登录名或登录邮箱已被占用，请更换后重试。'],
    ['FORBIDDEN', 'forbidden', '当前身份无权执行该操作。'],
    ['INTERNAL_SERVER_ERROR', 'update-failed', '操作失败，请稍后重试。'],
  ])('%s 映射为 %s 并使用该原因的兜底文案', async (code, reason, message) => {
    executeGraphQLMock.mockRejectedValue(buildIngressError({ code }));

    await expect(updateMyAccountSettingsProfile({ nickname: '新昵称' })).resolves.toEqual({
      message,
      ok: false,
      reason,
    });
  });

  it('extensions.errorMessage 存在时优先展示后端业务文案，大类码仍决定 reason', async () => {
    executeGraphQLMock.mockRejectedValue(
      buildIngressError({
        code: 'CONFLICT',
        errorCode: 'MY_ACCOUNT_CREDENTIAL_CONFLICT',
        errorMessage: '登录邮箱已被占用',
      }),
    );

    await expect(updateMyAccountSettingsProfile({ realName: '已被占用姓名' })).resolves.toEqual({
      message: '登录邮箱已被占用',
      ok: false,
      reason: 'duplicate-credential',
    });
  });

  it('生产环境可能隐藏 errorMessage，此时回落到按 reason 的兜底文案', async () => {
    executeGraphQLMock.mockRejectedValue(
      buildIngressError({
        code: 'BAD_USER_INPUT',
        errorCode: 'MY_ACCOUNT_LOGIN_CREDENTIAL_BOTH_EMPTY',
      }),
    );

    await expect(updateMyAccountSettingsProfile({ realName: null })).resolves.toEqual({
      message: '输入不符合要求，请检查后重新提交。',
      ok: false,
      reason: 'invalid-input',
    });
  });
});

describe('updateMyAccountSettingsProfile 上抛边界', () => {
  it.each([['UNAUTHENTICATED'], ['NOT_FOUND'], ['OPERATION_UNKNOWN']])(
    '未登记的大类码 %s 原样上抛，交共享 ingress 链路处理',
    async (code) => {
      const error = buildIngressError({ code });
      executeGraphQLMock.mockRejectedValue(error);

      await expect(updateMyAccountSettingsProfile({ nickname: '新昵称' })).rejects.toBe(error);
    },
  );

  it('缺少大类 code（只有 errorCode 细化码）时不当作业务拒绝', async () => {
    const error = buildIngressError({ errorCode: 'MY_ACCOUNT_CREDENTIAL_CONFLICT' });
    executeGraphQLMock.mockRejectedValue(error);

    await expect(updateMyAccountSettingsProfile({ nickname: '新昵称' })).rejects.toBe(error);
  });

  it('网络类 ingress 错误（无 GraphQL 错误明细）原样上抛', async () => {
    const error = new GraphQLIngressError({ type: 'network', message: 'fetch failed' });
    executeGraphQLMock.mockRejectedValue(error);

    await expect(updateMyAccountSettingsProfile({ nickname: '新昵称' })).rejects.toBe(error);
  });

  it('非 ingress 错误原样上抛，不被吞成业务拒绝', async () => {
    const error = new TypeError('unexpected');
    executeGraphQLMock.mockRejectedValue(error);

    await expect(updateMyAccountSettingsProfile({ nickname: '新昵称' })).rejects.toBe(error);
  });
});

describe('changeMyPassword', () => {
  it('入参原样进入 variables，成功只回传后端固定安全提示', async () => {
    executeGraphQLMock.mockResolvedValue({
      changeMyPassword: { isUpdated: true, notice: '密码已更新，请使用新密码重新登录' },
    });

    await expect(
      changeMyPassword({ currentPassword: 'Old#Pass2026', newPassword: 'Str0ng#Pass2026' }),
    ).resolves.toEqual({ notice: '密码已更新，请使用新密码重新登录', ok: true });

    expect(executeGraphQLMock).toHaveBeenCalledWith(
      expect.stringContaining('mutation ChangeMyPassword'),
      { input: { currentPassword: 'Old#Pass2026', newPassword: 'Str0ng#Pass2026' } },
    );
  });

  it('成功结果不携带密码、哈希、令牌或服务端撤销标记', async () => {
    executeGraphQLMock.mockResolvedValue({
      changeMyPassword: { isUpdated: true, notice: '密码已更新，请使用新密码重新登录' },
    });

    const result = await changeMyPassword({
      currentPassword: 'Old#Pass2026',
      newPassword: 'Str0ng#Pass2026',
    });

    expect(Object.keys(result).sort()).toEqual(['notice', 'ok']);
    expect(JSON.stringify(result)).not.toContain('Pass2026');
    expect(JSON.stringify(result)).not.toMatch(/revok|blacklist|撤销|失效|token/i);
  });

  it.each([
    ['BAD_USER_INPUT', 'invalid-input'],
    ['FORBIDDEN', 'forbidden'],
    ['INTERNAL_SERVER_ERROR', 'update-failed'],
  ])('%s 映射为 %s', async (code, reason) => {
    executeGraphQLMock.mockRejectedValue(buildIngressError({ code }));

    const result = await changeMyPassword({
      currentPassword: 'Old#Pass2026',
      newPassword: 'Str0ng#Pass2026',
    });

    expect(result).toMatchObject({ ok: false, reason });
  });

  it('当前密码错误与弱密码同属 BAD_USER_INPUT，优先展示后端文案', async () => {
    executeGraphQLMock.mockRejectedValue(
      buildIngressError({
        code: 'BAD_USER_INPUT',
        errorCode: 'MY_ACCOUNT_CURRENT_PASSWORD_MISMATCH',
        errorMessage: '当前密码不正确',
      }),
    );

    await expect(
      changeMyPassword({ currentPassword: 'wrong', newPassword: 'Str0ng#Pass2026' }),
    ).resolves.toEqual({ message: '当前密码不正确', ok: false, reason: 'invalid-input' });
  });

  it('CONFLICT 不在改密映射表内，原样上抛（改密不把冲突当业务拒绝）', async () => {
    const error = buildIngressError({ code: 'CONFLICT' });
    executeGraphQLMock.mockRejectedValue(error);

    await expect(
      changeMyPassword({ currentPassword: 'Old#Pass2026', newPassword: 'Str0ng#Pass2026' }),
    ).rejects.toBe(error);
  });

  it('认证类失败原样上抛，由共享链路触发会话失效', async () => {
    const error = buildIngressError({ code: 'UNAUTHENTICATED' });
    executeGraphQLMock.mockRejectedValue(error);

    await expect(
      changeMyPassword({ currentPassword: 'Old#Pass2026', newPassword: 'Str0ng#Pass2026' }),
    ).rejects.toBe(error);
  });
});

const COMPANY_PAGE_DTO = {
  items: [
    { id: 11, name: '受管公司甲' },
    { id: 12, name: '受管公司乙' },
  ],
  page: 1,
  pageSize: 20,
  total: 2,
};

describe('searchManagedCompanies', () => {
  it('复用注册入口检索：OFFSET 分页透传、空白关键字整体省略、走 no-cache', async () => {
    executeGraphQLMock.mockResolvedValue({ registrationOrganizationSearch: COMPANY_PAGE_DTO });

    await expect(
      searchManagedCompanies({ keyword: '   ', page: 1, pageSize: 20 }),
    ).resolves.toEqual(COMPANY_PAGE_DTO);

    expect(executeGraphQLMock).toHaveBeenCalledWith(
      expect.stringContaining('query ManagedCompanySearch'),
      {
        pagination: { mode: 'OFFSET', page: 1, pageSize: 20, withTotal: true },
      },
      { fetchPolicy: 'no-cache' },
    );
    const variables = executeGraphQLMock.mock.calls[0]?.[1] as Record<string, unknown>;

    expect(variables).not.toHaveProperty('keyword');
  });

  it('非空关键字去首尾空格后作为 keyword 传递', async () => {
    executeGraphQLMock.mockResolvedValue({ registrationOrganizationSearch: COMPANY_PAGE_DTO });

    await searchManagedCompanies({ keyword: '  甲  ', page: 1, pageSize: 20 });

    expect(executeGraphQLMock).toHaveBeenCalledWith(
      expect.stringContaining('query ManagedCompanySearch'),
      {
        keyword: '甲',
        pagination: { mode: 'OFFSET', page: 1, pageSize: 20, withTotal: true },
      },
      { fetchPolicy: 'no-cache' },
    );
  });

  it('后端省略 page / pageSize / total 时回落到请求参数与 0', async () => {
    executeGraphQLMock.mockResolvedValue({
      registrationOrganizationSearch: { items: [] },
    });

    await expect(searchManagedCompanies({ page: 2, pageSize: 10 })).resolves.toEqual({
      items: [],
      page: 2,
      pageSize: 10,
      total: 0,
    });
  });

  it('检索失败原样上抛，由 application 的检索状态机收敛', async () => {
    const error = buildIngressError({ code: 'UNAUTHENTICATED' });
    executeGraphQLMock.mockRejectedValue(error);

    await expect(searchManagedCompanies({ page: 1, pageSize: 20 })).rejects.toBe(error);
  });
});

describe('supplementMyCustomerCompany 入参构造', () => {
  it('existing 草稿只提交 organizationId，self-filled 草稿只提交 organizationName', async () => {
    executeGraphQLMock.mockResolvedValue({
      supplementMyCustomerCompany: {
        isUpdated: true,
        sameNamedCompanyName: null,
        settings: SETTINGS_DTO,
      },
    });

    await supplementMyCustomerCompany({ kind: 'existing', organizationId: 11 });

    expect(executeGraphQLMock).toHaveBeenCalledWith(
      expect.stringContaining('mutation SupplementMyCustomerCompany'),
      { input: { organizationId: 11 } },
    );

    executeGraphQLMock.mockClear();
    await supplementMyCustomerCompany({ kind: 'self-filled', organizationName: '甲公司' });

    expect(executeGraphQLMock).toHaveBeenCalledWith(
      expect.stringContaining('mutation SupplementMyCustomerCompany'),
      { input: { organizationName: '甲公司' } },
    );
    const input = executeGraphQLMock.mock.calls[0]?.[1] as { input: Record<string, unknown> };

    // 二选一互斥：另一侧字段绝不出现在同一 input 中
    expect(Object.keys(input.input)).toEqual(['organizationName']);
  });
});

describe('supplementMyCustomerCompany 成功', () => {
  it('返回权威视图、isUpdated 与同名提示（可为 null）', async () => {
    executeGraphQLMock.mockResolvedValue({
      supplementMyCustomerCompany: {
        isUpdated: true,
        sameNamedCompanyName: '受管公司甲',
        settings: { ...SETTINGS_DTO, trustedCompanyName: '甲公司' },
      },
    });

    await expect(
      supplementMyCustomerCompany({ kind: 'self-filled', organizationName: '甲公司' }),
    ).resolves.toEqual({
      isUpdated: true,
      ok: true,
      sameNamedCompanyName: '受管公司甲',
      settings: { ...SETTINGS_VIEW, trustedCompanyName: '甲公司' },
    });
  });

  it('幂等命中（isUpdated=false）同样回传权威视图', async () => {
    executeGraphQLMock.mockResolvedValue({
      supplementMyCustomerCompany: {
        isUpdated: false,
        sameNamedCompanyName: null,
        settings: SETTINGS_DTO,
      },
    });

    await expect(
      supplementMyCustomerCompany({ kind: 'existing', organizationId: 11 }),
    ).resolves.toEqual({
      isUpdated: false,
      ok: true,
      sameNamedCompanyName: null,
      settings: SETTINGS_VIEW,
    });
  });
});

describe('supplementMyCustomerCompany 业务拒绝映射', () => {
  it.each<[string, CustomerCompanySupplementFailureReason, string]>([
    ['BAD_USER_INPUT', 'invalid-input', '输入不符合要求，请检查后重新提交。'],
    ['CONFLICT', 'already-bound', '当前账号已有公司归属，不能重复补录或更换。'],
    ['FORBIDDEN', 'forbidden', '当前身份无权执行该操作。'],
    ['INTERNAL_SERVER_ERROR', 'update-failed', '操作失败，请稍后重试。'],
  ])('大类码 %s 映射为 %s 并使用该原因的兜底文案', async (code, reason, message) => {
    executeGraphQLMock.mockRejectedValue(buildIngressError({ code }));

    await expect(
      supplementMyCustomerCompany({ kind: 'existing', organizationId: 11 }),
    ).resolves.toEqual({ message, ok: false, reason });
  });

  it('暴露 errorCode 时细化出「组织不可用」（覆盖同类 BAD_USER_INPUT / INTERNAL_SERVER_ERROR）', async () => {
    executeGraphQLMock.mockRejectedValue(
      buildIngressError({
        code: 'BAD_USER_INPUT',
        errorCode: 'ACCOUNT_ORGANIZATION_NOT_AVAILABLE',
      }),
    );

    await expect(
      supplementMyCustomerCompany({ kind: 'existing', organizationId: 11 }),
    ).resolves.toEqual({
      message: '所选公司不存在、已停用或不具备选择资格。',
      ok: false,
      reason: 'organization-not-available',
    });
  });

  it('暴露细化码时优先于大类码（CONFLICT → invalid-input）', async () => {
    executeGraphQLMock.mockRejectedValue(
      buildIngressError({
        code: 'CONFLICT',
        errorCode: 'MY_ACCOUNT_CUSTOMER_COMPANY_INPUT_INVALID',
      }),
    );

    await expect(
      supplementMyCustomerCompany({ kind: 'self-filled', organizationName: '甲' }),
    ).resolves.toEqual({
      message: '输入不符合要求，请检查后重新提交。',
      ok: false,
      reason: 'invalid-input',
    });
  });

  it('extensions.errorMessage 存在时优先展示后端业务文案，reason 仍由映射决定', async () => {
    executeGraphQLMock.mockRejectedValue(
      buildIngressError({
        code: 'CONFLICT',
        errorCode: 'MY_ACCOUNT_CUSTOMER_COMPANY_ALREADY_BOUND',
        errorMessage: '当前账号已有公司归属',
      }),
    );

    await expect(
      supplementMyCustomerCompany({ kind: 'existing', organizationId: 11 }),
    ).resolves.toEqual({ message: '当前账号已有公司归属', ok: false, reason: 'already-bound' });
  });

  it('生产环境隐藏 errorCode 时回退大类码（CONFLICT 仍为 already-bound）', async () => {
    executeGraphQLMock.mockRejectedValue(buildIngressError({ code: 'CONFLICT' }));

    await expect(
      supplementMyCustomerCompany({ kind: 'existing', organizationId: 11 }),
    ).resolves.toEqual({
      message: '当前账号已有公司归属，不能重复补录或更换。',
      ok: false,
      reason: 'already-bound',
    });
  });
});

describe('supplementMyCustomerCompany 上抛边界', () => {
  it.each([['UNAUTHENTICATED'], ['NOT_FOUND'], ['OPERATION_UNKNOWN']])(
    '未登记的大类码 %s 原样上抛，交共享 ingress 链路处理',
    async (code) => {
      const error = buildIngressError({ code });
      executeGraphQLMock.mockRejectedValue(error);

      await expect(
        supplementMyCustomerCompany({ kind: 'existing', organizationId: 11 }),
      ).rejects.toBe(error);
    },
  );

  it('缺少大类 code（只有 errorCode 细化码）时不当作业务拒绝', async () => {
    const error = buildIngressError({
      errorCode: 'MY_ACCOUNT_CUSTOMER_COMPANY_ALREADY_BOUND',
    });
    executeGraphQLMock.mockRejectedValue(error);

    await expect(
      supplementMyCustomerCompany({ kind: 'existing', organizationId: 11 }),
    ).rejects.toBe(error);
  });

  it('未登记的 errorCode 回退到大类码，不因细化码未知而失效', async () => {
    executeGraphQLMock.mockRejectedValue(
      buildIngressError({ code: 'BAD_USER_INPUT', errorCode: 'SOMETHING_NEW' }),
    );

    await expect(
      supplementMyCustomerCompany({ kind: 'existing', organizationId: 11 }),
    ).resolves.toEqual({
      message: '输入不符合要求，请检查后重新提交。',
      ok: false,
      reason: 'invalid-input',
    });
  });

  it('网络类 ingress 错误与非 ingress 错误均原样上抛', async () => {
    const networkError = new GraphQLIngressError({ type: 'network', message: 'fetch failed' });
    executeGraphQLMock.mockRejectedValueOnce(networkError);

    await expect(
      supplementMyCustomerCompany({ kind: 'existing', organizationId: 11 }),
    ).rejects.toBe(networkError);

    const boom = new TypeError('unexpected');
    executeGraphQLMock.mockRejectedValueOnce(boom);

    await expect(
      supplementMyCustomerCompany({ kind: 'self-filled', organizationName: '甲' }),
    ).rejects.toBe(boom);
  });
});
