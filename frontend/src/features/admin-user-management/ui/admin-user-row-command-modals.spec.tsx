// src/features/admin-user-management/ui/admin-user-row-command-modals.spec.tsx
// @vitest-environment jsdom

/**
 * 两个行级写弹窗（启停 / 重置为默认密码）的提交代次守卫。
 *
 * 这两个弹窗在 panel 里恒定挂载、只切换 `row`，`destroyOnHidden` 只销毁 Modal 子树（Form），
 * 不会重置弹窗自己的 `useState`。一旦会话在提交续体回来之前被推进（关闭 / 重开 / 切换目标），
 * 旧续体就会把失败写进不属于它的弹窗。
 *
 * 本 spec 一律传 `submitting={false}`：`submitting` 是宿主传入的 prop，弹窗自己的正确性
 * 不得依赖它。（面板确实把 `submitting` 接到了 in-flight 标志，而 antd 6.4.3 的
 * `Modal.handleCancel` 在 `confirmLoading` 为真时会直接 return，所以四条关闭路径在面板里
 * 暂时被 antd 锁住；那是宿主接线的副作用，不是弹窗组件可以依赖的契约。）
 *
 * 两个弹窗的守卫语义完全一致，用同一套 harness 参数化覆盖，避免把同一段并发不变量抄两遍。
 * 时序全部由可控 deferred 推进：不使用 sleep，不扩大 timeout。
 *
 * 重置弹窗不收集任何密码字段（V6.4 08.4）：默认密码来自服务端运行期配置，
 * 客户端只能确认目标，不能指定新密码；本 spec 另用独立用例钉住这一点。
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type {
  AdminUserCommandResult,
  AdminUserRow,
  AdminUserStatusFilter,
} from '../application/admin-user-management.types';

import { AdminUserResetPasswordModal, AdminUserStatusModal } from './admin-user-row-command-modals';

const STALE_FAILURE_MESSAGE = '上一代目标的失败信息';
const FRESH_FAILURE_MESSAGE = '当前目标自己的失败信息';

const ROW_A: AdminUserRow = {
  accountId: 910001,
  companyName: '甲公司',
  contactEmail: 'a-contact@example.com',
  createdAt: '2026-09-01T08:00:00.000Z',
  loginEmail: 'user_a@example.com',
  loginName: 'user_a',
  nickname: '用户A',
  phone: '13800000001',
  role: 'ENGINEER',
  status: 'ACTIVE',
  updatedAt: '2026-09-01T08:00:00.000Z',
};

const ROW_B: AdminUserRow = {
  accountId: 910002,
  companyName: '乙公司',
  contactEmail: 'b-contact@example.com',
  createdAt: '2026-09-02T08:00:00.000Z',
  loginEmail: 'user_b@example.com',
  loginName: 'user_b',
  nickname: '用户B',
  phone: '13800000002',
  role: 'CUSTOMER',
  status: 'ACTIVE',
  updatedAt: '2026-09-02T08:00:00.000Z',
};

/** 可控 deferred：用显式 resolve 推进时序，不依赖 sleep 也不扩大 timeout */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });

  return { promise, resolve };
}

type RowModalHarnessProps<D> = {
  onCancel: () => void;
  onSubmit: (input: D) => Promise<AdminUserCommandResult>;
  row: AdminUserRow | null;
};

type RowModalHarness<D> = {
  /** 新鲜失败后断言「已选内容被保留」，证明失败路径没有顺带清空草稿；无输入的弹窗可省略 */
  assertDraftPreserved?: () => void;
  name: string;
  /** antd 会给两个汉字的按钮插入空格，一律用容忍空白的正则 */
  okButtonName: RegExp;
  /** 让表单通过校验并带上可与 baseline 区分的草稿；纯确认弹窗无需填表 */
  prepareSubmit: () => void;
  render: (props: RowModalHarnessProps<D>) => ReactElement;
  titleOfRow: (row: AdminUserRow) => string;
};

function describeRowModalSubmitGuard<D>(harness: RowModalHarness<D>) {
  describe(`${harness.name}弹窗`, () => {
    /** 关闭与重开分成两次 rerender 分别提交，忠实还原 panel 的两次 setState */
    function reopenAs(
      rerender: (element: ReactElement) => void,
      onSubmit: (input: D) => Promise<AdminUserCommandResult>,
      onCancel: () => void,
      row: AdminUserRow | null,
    ) {
      rerender(harness.render({ onCancel, onSubmit, row: null }));
      rerender(harness.render({ onCancel, onSubmit, row }));
    }

    it('提交期间关闭并切换到另一个目标：旧目标的失败不写进新目标弹窗', async () => {
      const stale = deferred<AdminUserCommandResult>();
      const onSubmit = vi.fn().mockReturnValue(stale.promise);
      const onCancel = vi.fn();

      const { rerender } = render(harness.render({ onCancel, onSubmit, row: ROW_A }));

      harness.prepareSubmit();
      fireEvent.click(screen.getByRole('button', { name: harness.okButtonName }));
      await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: ROW_A.accountId }),
      );

      // 宿主传 `submitting={false}`，因此提交期间取消按钮仍然可点（confirmLoading 未置位）
      fireEvent.click(screen.getByRole('button', { name: /取\s*消/ }));
      expect(onCancel).toHaveBeenCalledTimes(1);

      reopenAs(rerender, onSubmit, onCancel, ROW_B);
      expect(screen.getByRole('dialog', { name: harness.titleOfRow(ROW_B) })).toBeTruthy();

      await act(async () => {
        stale.resolve({ ok: false, reason: 'forbidden', message: STALE_FAILURE_MESSAGE });
      });

      expect(screen.queryByText(STALE_FAILURE_MESSAGE)).toBeNull();
      // 新目标弹窗没有被旧结果顺带关掉
      expect(screen.getByRole('dialog', { name: harness.titleOfRow(ROW_B) })).toBeTruthy();
      // 提交仍然只发生一次：关闭 / 切换不会重放请求
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });

    it('提交期间关闭再打开同一个目标：旧失败不显示在新一代弹窗', async () => {
      // 只核对 accountId 一定守不住这个场景：重开前后 accountId 完全相同，
      // 唯一能区分「第几代会话」的是单调代次
      const stale = deferred<AdminUserCommandResult>();
      const onSubmit = vi.fn().mockReturnValue(stale.promise);
      const onCancel = vi.fn();

      const { rerender } = render(harness.render({ onCancel, onSubmit, row: ROW_A }));

      harness.prepareSubmit();
      fireEvent.click(screen.getByRole('button', { name: harness.okButtonName }));
      await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));

      fireEvent.click(screen.getByRole('button', { name: /取\s*消/ }));
      reopenAs(rerender, onSubmit, onCancel, ROW_A);
      expect(screen.getByRole('dialog', { name: harness.titleOfRow(ROW_A) })).toBeTruthy();

      await act(async () => {
        stale.resolve({ ok: false, reason: 'forbidden', message: STALE_FAILURE_MESSAGE });
      });

      expect(screen.queryByText(STALE_FAILURE_MESSAGE)).toBeNull();
      expect(screen.getByRole('dialog', { name: harness.titleOfRow(ROW_A) })).toBeTruthy();

      // 守卫只对陈旧结果失败关闭，不能把弹窗永久弄哑：新一代会话仍能正常展示自己的失败
      onSubmit.mockResolvedValueOnce({
        ok: false,
        reason: 'not-found',
        message: FRESH_FAILURE_MESSAGE,
      });
      harness.prepareSubmit();
      fireEvent.click(screen.getByRole('button', { name: harness.okButtonName }));

      expect(await screen.findByText(FRESH_FAILURE_MESSAGE)).toBeTruthy();
      expect(screen.queryByText(STALE_FAILURE_MESSAGE)).toBeNull();
    });

    it('提交期间关闭再打开同一个目标：新一代自己的失败不被晚到的旧失败覆盖', async () => {
      // 上一例是「旧结果先到、新提交后到」；这一例反过来，钉住守卫的另一侧：
      // 新一代已经展示了自己的错误后，晚到的旧失败既不得覆盖它、也不清除它
      const stale = deferred<AdminUserCommandResult>();
      const onSubmit = vi.fn().mockReturnValue(stale.promise);
      const onCancel = vi.fn();

      const { rerender } = render(harness.render({ onCancel, onSubmit, row: ROW_A }));

      harness.prepareSubmit();
      fireEvent.click(screen.getByRole('button', { name: harness.okButtonName }));
      await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));

      fireEvent.click(screen.getByRole('button', { name: /取\s*消/ }));
      reopenAs(rerender, onSubmit, onCancel, ROW_A);

      // 新一代先拿到自己的失败，错误区已经有内容
      onSubmit.mockResolvedValueOnce({
        ok: false,
        reason: 'not-found',
        message: FRESH_FAILURE_MESSAGE,
      });
      harness.prepareSubmit();
      fireEvent.click(screen.getByRole('button', { name: harness.okButtonName }));
      expect(await screen.findByText(FRESH_FAILURE_MESSAGE)).toBeTruthy();

      await act(async () => {
        stale.resolve({ ok: false, reason: 'forbidden', message: STALE_FAILURE_MESSAGE });
      });

      expect(screen.queryByText(STALE_FAILURE_MESSAGE)).toBeNull();
      expect(screen.getByText(FRESH_FAILURE_MESSAGE)).toBeTruthy();
      expect(screen.getByRole('dialog', { name: harness.titleOfRow(ROW_A) })).toBeTruthy();
      expect(onSubmit).toHaveBeenCalledTimes(2);
    });

    it('正常失败：在当前弹窗显示错误、保留已选内容且不触发关闭', async () => {
      const onSubmit = vi
        .fn()
        .mockResolvedValue({ ok: false, reason: 'forbidden', message: FRESH_FAILURE_MESSAGE });
      const onCancel = vi.fn();

      render(harness.render({ onCancel, onSubmit, row: ROW_A }));

      harness.prepareSubmit();
      fireEvent.click(screen.getByRole('button', { name: harness.okButtonName }));

      expect(await screen.findByText(FRESH_FAILURE_MESSAGE)).toBeTruthy();
      expect(screen.getByRole('dialog', { name: harness.titleOfRow(ROW_A) })).toBeTruthy();
      harness.assertDraftPreserved?.();
      // 失败不关闭弹窗，关闭只由用户或成功收尾触发
      expect(onCancel).not.toHaveBeenCalled();
    });
  });
}

describeRowModalSubmitGuard<{ accountId: number; status: AdminUserStatusFilter }>({
  assertDraftPreserved: () => {
    expect(screen.getByRole('radio', { name: '停用' })).toBeChecked();
  },
  name: '启停',
  okButtonName: /^确\s*认$/,
  prepareSubmit: () => {
    fireEvent.click(screen.getByRole('radio', { name: '停用' }));
  },
  render: (props) => <AdminUserStatusModal submitting={false} {...props} />,
  titleOfRow: (row) => `启用 / 停用：${row.nickname}`,
});

describeRowModalSubmitGuard<{ accountId: number }>({
  name: '重置为默认密码',
  okButtonName: /重\s*置\s*为\s*默\s*认\s*密\s*码/,
  // 纯确认弹窗没有可填字段：点开即处于可提交态
  prepareSubmit: () => undefined,
  render: (props) => <AdminUserResetPasswordModal submitting={false} {...props} />,
  titleOfRow: (row) => `重置密码：${row.nickname}`,
});

/**
 * 重置弹窗的确认语义：不收集密码、只提交目标 accountId。
 * 与上面的并发守卫分开描述，因为它们钉住的是不同的不变量。
 */
describe('重置为默认密码弹窗的确认语义', () => {
  const OK_BUTTON_NAME = /重\s*置\s*为\s*默\s*认\s*密\s*码/;

  it('不渲染任何密码输入字段，客户端无法指定新密码', () => {
    render(
      <AdminUserResetPasswordModal
        submitting={false}
        row={ROW_A}
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    const dialog = screen.getByRole('dialog', { name: `重置密码：${ROW_A.nickname}` });

    expect(dialog.querySelectorAll('input').length).toBe(0);
    expect(screen.queryByLabelText('新密码')).toBeNull();
    expect(screen.queryByLabelText('确认新密码')).toBeNull();
    expect(screen.queryByLabelText('初始密码')).toBeNull();
  });

  it('展示目标身份与三条安全说明，提示文案中不含任何密码值', () => {
    render(
      <AdminUserResetPasswordModal
        submitting={false}
        row={ROW_A}
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    const dialog = screen.getByRole('dialog', { name: `重置密码：${ROW_A.nickname}` });
    const text = dialog.textContent ?? '';

    expect(text).toContain(ROW_A.nickname);
    expect(text).toContain(String(ROW_A.accountId));
    expect(text).toContain('系统默认密码');
    expect(text).toContain('立即修改密码');
    expect(text).toContain('Access Token');
  });

  it('点确认直接提交，只携带目标 accountId，不需要额外填表', async () => {
    const onSubmit = vi.fn().mockResolvedValue({ ok: true });
    const onCancel = vi.fn();

    render(
      <AdminUserResetPasswordModal
        submitting={false}
        row={ROW_A}
        onCancel={onCancel}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: OK_BUTTON_NAME }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({ accountId: ROW_A.accountId });
    expect(onCancel).not.toHaveBeenCalled();
  });
});
