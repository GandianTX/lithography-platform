// src/app/layout/engineer-approval-gate.spec.tsx
// @vitest-environment jsdom

/**
 * 批准结果门的装配语义（F3 + G2）：
 * - 展示事实只来自服务端：mySessionIdentity 确认 NONE + myEngineerRegistration 为 APPROVED；
 * - 需要判断批准结果的会话首帧即等待，确认前不挂载工作台内容、不发起工作台业务请求；
 * - 检查结果绑定产生它的「账号 + 会话代次」，迟到 / 被覆盖（stale）与身份变化都不放行；
 * - 新浏览器（无本地偏好）也会展示批准结果与真实公司；
 * - localStorage 只记录「已确认这份结果」的展示偏好，缺失只影响展示次数，不影响访问；
 *   属性读取与写入失败都不得阻断已由服务端确认的继续动作；
 * - 「进入工作台」重新复核同账号同会话代次，stale / 仍受限 / 申请不再是同一份 APPROVED
 *   都不导航；导航目标复用 auth-session 入口策略并保留 path + query；
 * - 无申请记录的存量工程师、非工程师、仍受限会话沿既有路径直接渲染内容。
 */

import { useEffect } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthSessionRestriction } from '@/features/auth-session';
import type { MyEngineerRegistrationView } from '@/features/registration';

import {
  acknowledgeEngineerApproval,
  hasAcknowledgedEngineerApproval,
} from './engineer-approval-notice-storage';

const APPROVED_APPLICATION: MyEngineerRegistrationView = {
  applicationId: 9001,
  organizationId: 4401,
  organizationName: '主组织 A',
  status: 'APPROVED',
  applicationNote: '请审核',
  submittedAt: '2026-11-16T00:00:00.000Z',
  reviewedAt: '2026-11-16T01:00:00.000Z',
  reviewComment: null,
};

const mocks = vi.hoisted(() => ({
  session: {
    current: null as {
      accountId: number;
      registrationOrganizationId: number | null;
      restriction: AuthSessionRestriction;
      role: string;
    } | null,
  },
  location: { current: { pathname: '/engineer', search: '' } },
  epoch: { current: 1 },
  getCurrentSessionMock: vi.fn(),
  navigateMock: vi.fn(),
  refreshIdentityMock: vi.fn(),
  resolveEntryPathMock: vi.fn(),
  sampleIdentityMock: vi.fn(),
  fetchRegistrationMock: vi.fn(),
}));

const workbenchRequestMock = vi.fn();

vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();

  return {
    ...actual,
    useLocation: () => mocks.location.current,
    useNavigate: () => mocks.navigateMock,
  };
});

vi.mock('@/features/auth-session', () => ({
  getCurrentAuthSession: mocks.getCurrentSessionMock,
  refreshCurrentAuthSessionIdentity: mocks.refreshIdentityMock,
  resolveAuthSessionEntryPath: mocks.resolveEntryPathMock,
  sampleCurrentAuthSessionIdentity: mocks.sampleIdentityMock,
  useAuthSession: () => ({
    session: mocks.session.current,
    status: mocks.session.current === null ? 'anonymous' : 'authenticated',
  }),
}));

vi.mock('@/features/registration', () => ({
  fetchMyEngineerRegistration: mocks.fetchRegistrationMock,
}));

import { EngineerApprovalGate } from './engineer-approval-gate';

function sessionFor(
  accountId: number,
  restriction: AuthSessionRestriction,
  registrationOrganizationId: number | null = APPROVED_APPLICATION.organizationId,
) {
  return { accountId, registrationOrganizationId, restriction, role: 'ENGINEER' };
}

function renderGate() {
  return render(
    <EngineerApprovalGate>
      <WorkbenchProbe />
    </EngineerApprovalGate>,
  );
}

/**
 * 工作台替身：挂载即发出一条「工单请求」，用于断言受门控制的内容在确认前
 * 既不挂载、也不产生任何业务请求。
 */
function WorkbenchProbe() {
  useEffect(() => {
    workbenchRequestMock();
  }, []);

  return <div>工作台内容</div>;
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

describe('EngineerApprovalGate', () => {
  beforeEach(() => {
    window.localStorage.clear();
    mocks.session.current = sessionFor(1, 'NONE');
    mocks.location.current = { pathname: '/engineer', search: '' };
    mocks.epoch.current = 1;
    workbenchRequestMock.mockReset();
    mocks.getCurrentSessionMock.mockReset();
    mocks.getCurrentSessionMock.mockImplementation(() => mocks.session.current);
    mocks.navigateMock.mockReset();
    mocks.refreshIdentityMock.mockReset().mockResolvedValue({ status: 'unchanged' });
    // 回跳目标由 auth-session 入口策略裁决：这里按「站点内目标原样保留」的真实语义
    // 回传 candidate，缺省时回落到角色首页，用测试锁定门只做委托而不自建解析器。
    mocks.resolveEntryPathMock
      .mockReset()
      .mockImplementation((_session: unknown, candidate?: unknown) =>
        typeof candidate === 'string' && candidate !== '' ? candidate : '/home/ENGINEER',
      );
    mocks.sampleIdentityMock
      .mockReset()
      .mockImplementation(() => ({ accountId: 1, epoch: mocks.epoch.current }));
    mocks.fetchRegistrationMock.mockReset().mockResolvedValue(APPROVED_APPLICATION);
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it('新浏览器首次登录已批准账号：先展示批准结果与真实公司，不挂载工作台内容', async () => {
    renderGate();

    await waitFor(() => {
      expect(screen.getByText('申请已通过，权限已开通')).toBeInTheDocument();
    });
    expect(screen.getByText('主组织 A')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '进入工作台' })).toBeInTheDocument();
    expect(screen.queryByText('工作台内容')).toBeNull();
    expect(workbenchRequestMock).not.toHaveBeenCalled();
  });

  it('确认前不挂载工作台、不发起业务请求；批准结果未返回时保持等待态', async () => {
    const identity = createDeferred<{ status: 'unchanged' }>();
    mocks.refreshIdentityMock.mockReturnValue(identity.promise);
    renderGate();

    // 首帧：等待态，工作台未挂载、零业务请求
    expect(screen.getByText('正在确认审核结果…')).toBeInTheDocument();
    expect(screen.queryByText('工作台内容')).toBeNull();
    expect(workbenchRequestMock).not.toHaveBeenCalled();
    expect(mocks.fetchRegistrationMock).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(mocks.refreshIdentityMock).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByText('工作台内容')).toBeNull();
    expect(workbenchRequestMock).not.toHaveBeenCalled();

    identity.resolve({ status: 'unchanged' });

    await waitFor(() => {
      expect(screen.getByText('申请已通过，权限已开通')).toBeInTheDocument();
    });
    expect(mocks.fetchRegistrationMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('工作台内容')).toBeNull();
    expect(workbenchRequestMock).not.toHaveBeenCalled();
  });

  it('进入工作台：复核成功且资格与申请仍成立时记录展示偏好并导航', async () => {
    renderGate();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '进入工作台' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: '进入工作台' }));

    await waitFor(() => {
      expect(mocks.navigateMock).toHaveBeenCalledWith('/engineer', { replace: true });
    });
    expect(mocks.resolveEntryPathMock).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 1, role: 'ENGINEER' }),
      '/engineer',
    );

    // 导航断言完成时子内容可能尚未提交：独立等待工作台探针的 Effect 落地，
    // 再断言业务请求恰好一次（避免把「还未执行」误判成「未重复」）。
    await waitFor(() => {
      expect(screen.getByText('工作台内容')).toBeInTheDocument();
      expect(workbenchRequestMock).toHaveBeenCalledTimes(1);
    });
    expect(workbenchRequestMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('申请已通过，权限已开通')).toBeNull();
  });

  it('回跳保留仍授权的站内目标与 query 参数', async () => {
    mocks.location.current = { pathname: '/engineer/repair-requests', search: '?scope=MINE' };
    renderGate();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '进入工作台' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: '进入工作台' }));

    await waitFor(() => {
      expect(mocks.navigateMock).toHaveBeenCalledWith('/engineer/repair-requests?scope=MINE', {
        replace: true,
      });
    });
    expect(mocks.resolveEntryPathMock).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 1, role: 'ENGINEER' }),
      '/engineer/repair-requests?scope=MINE',
    );
  });

  it('回跳目标由 auth-session 入口策略裁决：策略回退首页时使用首页', async () => {
    mocks.location.current = { pathname: '/engineer/repair-requests', search: '?scope=MINE' };
    mocks.resolveEntryPathMock.mockReturnValue('/engineer');
    renderGate();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '进入工作台' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: '进入工作台' }));

    await waitFor(() => {
      expect(mocks.navigateMock).toHaveBeenCalledWith('/engineer', { replace: true });
    });
  });

  it('已确认过的批准结果刷新后直接进入工作台，不再阻塞', async () => {
    acknowledgeEngineerApproval(1, APPROVED_APPLICATION.applicationId);
    renderGate();

    await waitFor(() => {
      expect(screen.getByText('工作台内容')).toBeInTheDocument();
    });
    expect(screen.queryByText('申请已通过，权限已开通')).toBeNull();
  });

  it('无申请记录的存量工程师直接进入工作台，不依赖额外审批读取', () => {
    mocks.session.current = sessionFor(1, 'NONE', null);
    renderGate();

    expect(screen.getByText('工作台内容')).toBeInTheDocument();
    expect(workbenchRequestMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('申请已通过，权限已开通')).toBeNull();
    // 会话快照已确认没有申请记录：不发起审批读取，审批接口故障不会阻断存量工程师
    expect(mocks.refreshIdentityMock).not.toHaveBeenCalled();
    expect(mocks.fetchRegistrationMock).not.toHaveBeenCalled();
  });

  it('有申请记录但申请不是 APPROVED 时不展示批准结果', async () => {
    mocks.fetchRegistrationMock.mockResolvedValue({
      ...APPROVED_APPLICATION,
      status: 'PENDING',
    });
    renderGate();

    await waitFor(() => {
      expect(screen.getByText('工作台内容')).toBeInTheDocument();
    });
    expect(screen.queryByText('申请已通过，权限已开通')).toBeNull();
  });

  it('受限会话与非工程师会话不发起批准检查，直接渲染既有内容', () => {
    mocks.session.current = sessionFor(1, 'ENGINEER_PENDING');
    const pending = renderGate();

    expect(screen.getByText('工作台内容')).toBeInTheDocument();
    expect(mocks.fetchRegistrationMock).not.toHaveBeenCalled();
    pending.unmount();

    mocks.session.current = {
      accountId: 2,
      registrationOrganizationId: null,
      restriction: 'NONE',
      role: 'CUSTOMER',
    };
    renderGate();

    expect(screen.getByText('工作台内容')).toBeInTheDocument();
    expect(mocks.fetchRegistrationMock).not.toHaveBeenCalled();
  });

  it('服务端复核返回 stale（迟到 / 被覆盖）时不放行，进入可重试失败态', async () => {
    mocks.refreshIdentityMock.mockResolvedValue({ status: 'stale' });
    renderGate();

    await waitFor(() => {
      expect(screen.getByText('无法获取审核结果，请稍后重试。')).toBeInTheDocument();
    });
    expect(screen.queryByText('工作台内容')).toBeNull();
    expect(workbenchRequestMock).not.toHaveBeenCalled();
    expect(mocks.fetchRegistrationMock).not.toHaveBeenCalled();
  });

  it('申请读取期间会话已切换（会话代次变化）时不借用前一结论', async () => {
    mocks.fetchRegistrationMock.mockImplementation(async () => {
      mocks.epoch.current = 2;
      return APPROVED_APPLICATION;
    });
    renderGate();

    await waitFor(() => {
      expect(mocks.fetchRegistrationMock).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.getByText('正在确认审核结果…')).toBeInTheDocument();
    });
    expect(screen.queryByText('工作台内容')).toBeNull();
    expect(screen.queryByText('申请已通过，权限已开通')).toBeNull();
    expect(workbenchRequestMock).not.toHaveBeenCalled();
  });

  it('加载失败展示可重试错误态，重试成功后展示批准结果', async () => {
    mocks.fetchRegistrationMock
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(APPROVED_APPLICATION);
    renderGate();

    await waitFor(() => {
      expect(screen.getByText('无法获取审核结果，请稍后重试。')).toBeInTheDocument();
    });
    expect(screen.queryByText('工作台内容')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /重\s*试/ }));

    await waitFor(() => {
      expect(screen.getByText('申请已通过，权限已开通')).toBeInTheDocument();
    });
  });

  it('进入时复核结果为 stale：不导航、不写展示偏好', async () => {
    mocks.refreshIdentityMock
      .mockResolvedValueOnce({ status: 'unchanged' })
      .mockResolvedValueOnce({ status: 'stale' });
    renderGate();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '进入工作台' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: '进入工作台' }));

    await waitFor(() => {
      expect(screen.getByText('当前会话已变化，请刷新页面或重新登录后重试。')).toBeInTheDocument();
    });
    expect(mocks.navigateMock).not.toHaveBeenCalled();

    // 未写偏好：重新挂载仍会展示结果
    cleanup();
    renderGate();
    await waitFor(() => {
      expect(screen.getByText('申请已通过，权限已开通')).toBeInTheDocument();
    });
  });

  it('进入时服务端已撤销资格：不导航、不写展示偏好', async () => {
    renderGate();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '进入工作台' })).toBeInTheDocument();
    });

    // 点击前资格被撤销：复核把 restriction 写回当前会话（真实环境由 app-layout
    // 收口到受限页，门本身不再渲染结果）
    mocks.refreshIdentityMock.mockImplementationOnce(async () => {
      mocks.session.current = sessionFor(1, 'ENGINEER_INACTIVE');
      return { status: 'applied' as const };
    });

    fireEvent.click(screen.getByRole('button', { name: '进入工作台' }));

    await waitFor(() => {
      expect(screen.getByText('工作台内容')).toBeInTheDocument();
    });
    expect(mocks.navigateMock).not.toHaveBeenCalled();
    expect(hasAcknowledgedEngineerApproval(1, APPROVED_APPLICATION.applicationId)).toBe(false);
  });

  it('进入时申请已不再是 APPROVED：不导航', async () => {
    mocks.fetchRegistrationMock
      .mockResolvedValueOnce(APPROVED_APPLICATION)
      .mockResolvedValueOnce({ ...APPROVED_APPLICATION, status: 'REJECTED' });
    renderGate();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '进入工作台' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: '进入工作台' }));

    await waitFor(() => {
      expect(
        screen.getByText('当前身份尚未确认开通，仍保持受限访问，请稍后重试。'),
      ).toBeInTheDocument();
    });
    expect(mocks.navigateMock).not.toHaveBeenCalled();
  });

  it('进入时申请已换成另一份 APPROVED：不导航', async () => {
    mocks.fetchRegistrationMock
      .mockResolvedValueOnce(APPROVED_APPLICATION)
      .mockResolvedValueOnce({ ...APPROVED_APPLICATION, applicationId: 9002 });
    renderGate();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '进入工作台' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: '进入工作台' }));

    await waitFor(() => {
      expect(
        screen.getByText('当前身份尚未确认开通，仍保持受限访问，请稍后重试。'),
      ).toBeInTheDocument();
    });
    expect(mocks.navigateMock).not.toHaveBeenCalled();
    expect(hasAcknowledgedEngineerApproval(1, APPROVED_APPLICATION.applicationId)).toBe(false);
  });

  it('localStorage 属性读取被浏览器策略拒绝：不崩溃，仍按服务端事实进入工作台', async () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError');
      },
    });

    try {
      renderGate();
      await waitFor(() => {
        expect(screen.getByRole('button', { name: '进入工作台' })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: '进入工作台' }));

      await waitFor(() => {
        expect(screen.getByText('工作台内容')).toBeInTheDocument();
      });
      expect(mocks.navigateMock).toHaveBeenCalledWith('/engineer', { replace: true });
    } finally {
      if (original) {
        Object.defineProperty(window, 'localStorage', original);
      }
    }
  });

  it('写入展示偏好失败：不阻断已由服务端确认的进入工作台', async () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });

    try {
      renderGate();
      await waitFor(() => {
        expect(screen.getByRole('button', { name: '进入工作台' })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: '进入工作台' }));

      await waitFor(() => {
        expect(screen.getByText('工作台内容')).toBeInTheDocument();
      });
      expect(mocks.navigateMock).toHaveBeenCalledWith('/engineer', { replace: true });
    } finally {
      setItemSpy.mockRestore();
    }
  });

  it('进入时复核请求失败：不导航并提示校验失败', async () => {
    mocks.refreshIdentityMock
      .mockResolvedValueOnce({ status: 'unchanged' })
      .mockRejectedValueOnce(new Error('network'));
    renderGate();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '进入工作台' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: '进入工作台' }));

    await waitFor(() => {
      expect(screen.getByText('身份校验失败，请稍后重试。')).toBeInTheDocument();
    });
    expect(mocks.navigateMock).not.toHaveBeenCalled();
  });
});
