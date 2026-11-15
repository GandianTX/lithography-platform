// src/features/admin-company-management/application/use-admin-company-commands.spec.ts

/**
 * 公司档案写命令 hook 测试：
 * - 成功后统一刷新当前列表游标；业务失败与未处理异常不刷新；
 * - 同类命令 in-flight 时拒绝重复提交；
 * - transport 类未处理失败收敛为 unhandled-error 并附共享 ingress 文案。
 */

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GraphQLIngressError } from '@/shared/graphql';

import * as adapter from '../infrastructure/admin-company-adapter';

import { useAdminCompanyCommands } from './use-admin-company-commands';

vi.mock('../infrastructure/admin-company-adapter', () => ({
  adminCreateCompany: vi.fn(),
  adminUpdateCompany: vi.fn(),
}));

const createMock = vi.mocked(adapter.adminCreateCompany);
const updateMock = vi.mocked(adapter.adminUpdateCompany);

const COMPANY = {
  organizationId: 501,
  organizationCode: 'ADMIN_ORG_501',
  name: '甲公司',
  shortName: null,
  contactName: null,
  contactPhone: '13800000001',
  contactEmail: null,
  address: null,
  remark: null,
  isServiceProvider: false,
  isManagedCompany: true,
  kind: 'CLIENT',
  status: 'ACTIVE',
  createdAt: '2026-11-01T08:00:00.000Z',
  updatedAt: '2026-11-01T08:00:00.000Z',
} as const;

const CREATE_DRAFT = {
  name: '甲公司',
  contactPhone: '13800000001',
  shortName: '',
  contactName: '',
  contactEmail: '',
  address: '',
  remark: '',
  isServiceProvider: false,
};

beforeEach(() => {
  createMock.mockReset();
  updateMock.mockReset();
});

describe('useAdminCompanyCommands', () => {
  it('新增成功后刷新列表并透传显式结果', async () => {
    const reload = vi.fn();
    createMock.mockResolvedValue({ ok: true, organization: COMPANY });
    const { result } = renderHook(() => useAdminCompanyCommands(reload));

    let execution: Awaited<ReturnType<typeof result.current.createCompany>> | undefined;
    await act(async () => {
      execution = await result.current.createCompany(CREATE_DRAFT);
    });

    expect(execution).toEqual({ kind: 'ok', result: { ok: true, organization: COMPANY } });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(result.current.isPending('create')).toBe(false);
  });

  it('业务失败不刷新列表，结果原样透传给弹窗', async () => {
    const reload = vi.fn();
    updateMock.mockResolvedValue({ ok: false, reason: 'invalid-input', message: '输入不合法' });
    const { result } = renderHook(() => useAdminCompanyCommands(reload));

    let execution: Awaited<ReturnType<typeof result.current.updateCompany>> | undefined;
    await act(async () => {
      execution = await result.current.updateCompany({ organizationId: 501, name: '新名' });
    });

    expect(execution).toEqual({
      kind: 'ok',
      result: { ok: false, reason: 'invalid-input', message: '输入不合法' },
    });
    expect(reload).not.toHaveBeenCalled();
  });

  it('同类命令 in-flight 时拒绝重复提交，不重复调用 adapter', async () => {
    const reload = vi.fn();
    let resolveCreate!: (value: unknown) => void;
    createMock.mockReturnValue(
      new Promise((resolve) => {
        resolveCreate = resolve;
      }) as never,
    );
    const { result } = renderHook(() => useAdminCompanyCommands(reload));

    let first: Promise<unknown> | undefined;
    act(() => {
      first = result.current.createCompany(CREATE_DRAFT);
    });

    await act(async () => {
      const duplicate = await result.current.createCompany(CREATE_DRAFT);
      expect(duplicate).toEqual({ kind: 'in-flight' });
    });

    await act(async () => {
      resolveCreate({ ok: true, organization: COMPANY });
      await first;
    });

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('transport 类失败收敛为 unhandled-error，不刷新列表', async () => {
    const reload = vi.fn();
    updateMock.mockRejectedValue(new GraphQLIngressError({ type: 'network', message: 'offline' }));
    const { result } = renderHook(() => useAdminCompanyCommands(reload));

    let execution: Awaited<ReturnType<typeof result.current.updateCompany>> | undefined;
    await act(async () => {
      execution = await result.current.updateCompany({ organizationId: 501, name: '新名' });
    });

    expect(execution).toEqual({
      kind: 'unhandled-error',
      message: '网络连接异常，请稍后重试。',
    });
    expect(reload).not.toHaveBeenCalled();
  });
});
