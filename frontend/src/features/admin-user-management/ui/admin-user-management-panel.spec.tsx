// src/features/admin-user-management/ui/admin-user-management-panel.spec.tsx
// @vitest-environment jsdom

/**
 * 面板侧弹窗会话代次守卫（双层守卫的外层）。
 *
 * 弹窗侧的 `useStaleSubmitGuard` 只能保护弹窗自己的错误区；「关闭弹窗」这个动作归属面板，
 * 一旦认错会话就会出现 A 的成功关掉 B、或者关掉「切换走的同一个 A」。
 * 只核对 accountId 守不住后者——切走再切回来 accountId 完全相同，
 * 唯一能区分第几代会话的是单调代次。
 *
 * 走真实的 `useAdminUserList` / `useAdminUserCommands`（含 in-flight 锁与成功 reload），
 * 只替换最外层的 GraphQL adapter；时序全部由可控 deferred 推进，不使用 sleep。
 * 仅对最重的「切走再切回 A」用例给足单测预算：它要在 jsdom 里挂载多个 antd Modal
 *（A → B → A），单测全量并发时本身就会逼近默认 5s 上限，属于渲染成本而非等待缺陷，
 * 因此该用例显式声明预算，不整体放宽 testTimeout。
 *
 * 关于驱动方式：面板把 `submitting` 接到了 `commands.isPending(key)`，而 antd 6.4.3 的
 * `Modal.handleCancel` 在 `confirmLoading` 为真时直接 `return`（取消按钮、X、遮罩、Esc 共用它），
 * 所以「提交期间点取消关闭弹窗」在面板里不会发生，本 spec 不伪造这条路径。
 * 会话代次守卫针对的是**会话被推进**这件事本身，与推进来源无关，
 * 因此改用面板自己的行入口推进会话（A → B、A → B → A），
 * 覆盖守卫真正要保证的不变量：续体回来时代次已变 ⇒ 不得关闭当前弹窗、不得写错误区。
 *
 * 「关闭后重新打开同一个弹窗」这条推进来源在本 spec 里不可达（同一个 antd 门禁），
 * 同理 antd `Button` 在 loading 期间会直接吞掉 click，而在途提交把 OK 按钮置为 loading，
 * 所以「新一代弹窗已有错误 + 旧结果晚到」也无法在这里驱动；
 * 两者由弹窗组件层的 spec 以 `submitting={false}` 覆盖。
 * 本 spec 用可达的「切走再切回同一个 accountId」等价推进会话，并钉住另一侧一致性：
 * 会话身份没变的重入**不得**推进代次，否则在途提交会被误判成陈旧。
 *
 * 关于「旧请求在 B 的 commit / layout effect 之前完成」这个窗口：它对外层不成立，
 * 也不靠 `useLayoutEffect` 的时序来排除。`openRowDialog` 是**先**同步改 ref
 * （`dialogSession.advance(key)`）**再** `setRow(row)`，代次在 React 开始渲染 B 之前就已推进，
 * 而「关闭 B」这个决定完全由外层代次作出（该同步性由 `use-dialog-session-seq.spec.ts` 直测钉住）。
 * 弹窗侧错误区另有两道与此窗口无关的保护：render 阶段的「按 props 调整 state」在同一次 render
 * 里就清掉上一代错误；而 discrete 事件的 render + commit + layout effect 在事件处理器内同步跑完，
 * 外部续体（微任务）无法插入其间。所以「commit 之前」这一半在测试里不可构造，
 * 现有 A → B 用例覆盖的已是能构造出的最早时刻——续体在切换提交完成之后立即运行。
 */

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { message } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getGraphQLClient, GraphQLIngressError } from '@/shared/graphql';

import type {
  AdminBoundLevelTwoAdmin,
  AdminUserCommandResult,
  AdminUserListPage,
  AdminUserPasswordResetResult,
  AdminUserRow,
} from '../application/admin-user-management.types';
import * as adminUserAdapter from '../infrastructure/admin-user-adapter';

import { AdminUserManagementPanel } from './admin-user-management-panel';

vi.mock('../infrastructure/admin-user-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof adminUserAdapter>();

  return {
    ...actual,
    adminResetLevelTwoAdminCredential: vi.fn(),
    adminResetUserPasswordToDefault: vi.fn(),
    adminSetUserStatus: vi.fn(),
    fetchAdminBoundLevelTwoAdmins: vi.fn(),
    fetchAdminUsers: vi.fn(),
  };
});

const fetchUsersMock = vi.mocked(adminUserAdapter.fetchAdminUsers);
const setStatusMock = vi.mocked(adminUserAdapter.adminSetUserStatus);
const resetPasswordMock = vi.mocked(adminUserAdapter.adminResetUserPasswordToDefault);
const fetchBoundAdminsMock = vi.mocked(adminUserAdapter.fetchAdminBoundLevelTwoAdmins);
const resetLevelTwoMock = vi.mocked(adminUserAdapter.adminResetLevelTwoAdminCredential);

/** 后端固定安全提示由 adapter 返回，面板逐字透传，密码本身不出现在任何反馈中 */
const RESET_NOTICE = '密码已重置为系统默认密码，请提示用户下次登录后立即修改。';
const STALE_FAILURE_MESSAGE = '上一代目标的失败信息';
const BUSINESS_FAILURE_MESSAGE = '后端返回的业务失败信息';

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

/**
 * 按标题文本反查弹窗容器，不用 `getByRole('dialog', { name })`。
 *
 * 测试环境下 `@rc-component/util` 的 `useId` 恒返回 `'test-id'`，于是面板工具条上的 Select
 * 与 rc-dialog 的标题元素共用同一个 `id`；`aria-labelledby` 会解析到文档里第一个同 id 元素
 * （工具条 Select，值为空），弹窗的 accessible name 因此恒为空串，按 name 取不到。
 * 标题元素带 `.ant-modal-title`，限定 selector 后可以精确命中且不撞到工具条上的同名按钮。
 */
function queryDialog(title: string): HTMLElement | null {
  const titleNode = screen.queryByText(title, { selector: '.ant-modal-title' });

  return (titleNode?.closest('[role="dialog"]') as HTMLElement | null) ?? null;
}

function getDialog(title: string): HTMLElement {
  const dialog = queryDialog(title);

  if (dialog === null) {
    throw new Error(`未找到标题为「${title}」的弹窗`);
  }

  return dialog;
}

/**
 * 弹窗是否仍处于打开态。
 *
 * 不能用「DOM 消失」判定：jsdom 不派发 `transitionend`，rc-motion 的离场永远停在
 * `ant-zoom-leave-*` 中间态，`destroyOnHidden` 要等 `afterClose` 才生效，
 * 关闭后的弹窗 DOM 与标题文本都会原地滞留。改用 rc-motion 的状态 class：
 * `open` 翻转为 false 的同一次提交里容器就会带上 `-leave`，同步且确定。
 */
function isDialogOpen(title: string): boolean {
  const dialog = queryDialog(title);

  return dialog !== null && !dialog.className.includes('-leave');
}

function makePage(): AdminUserListPage {
  return { items: [ROW_A, ROW_B], page: 1, pageSize: 10, total: 2 };
}

async function renderPanel(adminLevel: number | null = 1) {
  render(<AdminUserManagementPanel adminLevel={adminLevel} />);

  await screen.findByText(ROW_A.nickname);
  await screen.findByText(ROW_B.nickname);
}

/** 表格行内的写入口：按昵称定位行，避免命中其它行的同名按钮 */
function clickRowAction(nickname: string, actionName: RegExp) {
  const row = screen.getByText(nickname).closest('tr') as HTMLElement;

  fireEvent.click(within(row).getByRole('button', { name: actionName }));
}

function clickDialogButton(dialog: HTMLElement, name: RegExp) {
  fireEvent.click(within(dialog).getByRole('button', { name }));
}

/**
 * 两个行级弹窗的面板侧守卫用例参数化：会话代次与 accountId 双重核对的代码路径同构，
 * 但每个弹窗各有一条独立代次，逐个覆盖才能抓住「用错了 key」这类接线错误。
 */
type RowDialogCase = {
  actionName: RegExp;
  /** 该弹窗对应的 adapter 调用次数：用于确认请求已发出，再推进会话时序 */
  adapterCallCount: () => number;
  /** 断言新鲜成功的反馈措辞（不含目标，因为当前弹窗就是提交目标） */
  assertFreshSuccessFeedback: () => void;
  /** 断言陈旧成功的反馈点名了实际提交的目标，不会被误读成当前弹窗的结果 */
  assertStaleSuccessFeedback: () => void;
  /** 新鲜失败后断言「当前弹窗仍停留在目标本身」，证明失败路径没有改写会话身份 */
  assertDraftPreserved: (dialog: HTMLElement) => void;
  dialogTitleOf: (nickname: string) => string;
  name: string;
  okButtonName: RegExp;
  /** 让弹窗进入可提交态；纯确认弹窗无需填表 */
  prepareSubmit: (dialog: HTMLElement) => void;
  /** 让 adapter 停在 in-flight，返回稍后 resolve 成功的把手 */
  stubPendingSuccess: () => { resolve: () => Promise<void> };
  stubResolvedFailure: (failureMessage: string) => void;
  stubResolvedSuccess: () => void;
};

const ROW_DIALOG_CASES: RowDialogCase[] = [
  {
    actionName: /启\s*停/,
    adapterCallCount: () => setStatusMock.mock.calls.length,
    assertDraftPreserved: (dialog) => {
      expect(within(dialog).getByRole('radio', { name: '停用' })).toBeChecked();
    },
    assertFreshSuccessFeedback: () => {
      expect(message.success).toHaveBeenCalledWith('状态已修改。');
    },
    assertStaleSuccessFeedback: () => {
      expect(message.success).toHaveBeenCalledWith('「用户A」的状态已修改。');
      expect(message.success).not.toHaveBeenCalledWith('状态已修改。');
    },
    dialogTitleOf: (nickname) => `启用 / 停用：${nickname}`,
    name: '启停',
    okButtonName: /^确\s*认$/,
    prepareSubmit: (dialog) => {
      fireEvent.click(within(dialog).getByRole('radio', { name: '停用' }));
    },
    stubPendingSuccess: () => {
      const pending = deferred<AdminUserCommandResult>();
      setStatusMock.mockReturnValue(pending.promise);

      return {
        resolve: async () => {
          await act(async () => {
            pending.resolve({ ok: true });
          });
        },
      };
    },
    stubResolvedFailure: (failureMessage) => {
      setStatusMock.mockResolvedValue({
        ok: false,
        reason: 'status-conflict',
        message: failureMessage,
      });
    },
    stubResolvedSuccess: () => {
      setStatusMock.mockResolvedValue({ ok: true });
    },
  },
  {
    actionName: /重\s*置\s*密\s*码/,
    adapterCallCount: () => resetPasswordMock.mock.calls.length,
    assertDraftPreserved: (dialog) => {
      // 确认弹窗没有可填字段：失败后仍停留在同一个目标说明上
      const text = dialog.textContent ?? '';
      expect(text).toContain(ROW_A.nickname);
      expect(text).toContain(String(ROW_A.accountId));
    },
    assertFreshSuccessFeedback: () => {
      expect(message.success).toHaveBeenCalledWith(RESET_NOTICE, 6);
    },
    // 后端固定安全提示本身不含目标身份，陈旧成功也逐字沿用，因此与新鲜成功同一句；
    // 关键在于它绝不描述当前弹窗目标，也就不会误导
    assertStaleSuccessFeedback: () => {
      expect(message.success).toHaveBeenCalledWith(RESET_NOTICE, 6);
      expect(message.success).toHaveBeenCalledTimes(1);
    },
    dialogTitleOf: (nickname) => `重置密码：${nickname}`,
    name: '重置为默认密码',
    okButtonName: /重\s*置\s*为\s*默\s*认\s*密\s*码/,
    // 纯确认弹窗：点开即处于可提交态，不收集任何密码字段
    prepareSubmit: () => undefined,
    stubPendingSuccess: () => {
      const pending = deferred<AdminUserPasswordResetResult>();
      resetPasswordMock.mockReturnValue(pending.promise);

      return {
        resolve: async () => {
          await act(async () => {
            pending.resolve({ ok: true, notice: RESET_NOTICE });
          });
        },
      };
    },
    stubResolvedFailure: (failureMessage) => {
      resetPasswordMock.mockResolvedValue({
        ok: false,
        reason: 'reset-failed',
        message: failureMessage,
      });
    },
    stubResolvedSuccess: () => {
      resetPasswordMock.mockResolvedValue({ ok: true, notice: RESET_NOTICE });
    },
  },
];

describe('管理员用户管理面板的弹窗会话代次守卫', () => {
  beforeEach(() => {
    // message 是 antd 模块级单例，spyOn 跨用例复用同一 mock，需清空历史避免串扰
    vi.spyOn(message, 'success')
      .mockImplementation(() => undefined as never)
      .mockClear();
    fetchUsersMock.mockReset();
    fetchUsersMock.mockResolvedValue(makePage());
    setStatusMock.mockReset();
    resetPasswordMock.mockReset();
  });

  it.each(ROW_DIALOG_CASES)(
    '$name：提交进行中把目标从 A 切到 B，A 的成功晚到不关闭 B，且反馈点名实际提交的 A',
    async (testCase) => {
      // 「旧请求在 B 的 commit / layout effect 之前完成」这个窗口对外层不成立：
      // 面板先同步 advance（改 ref）再 setRow，代次早于 React 渲染 B 就已生效。
      // 完整论证见文件头；同步性本身由 use-dialog-session-seq.spec.ts 直测，不靠时序假设。
      const pending = testCase.stubPendingSuccess();
      await renderPanel();

      clickRowAction(ROW_A.nickname, testCase.actionName);
      const dialogOfA = getDialog(testCase.dialogTitleOf(ROW_A.nickname));
      testCase.prepareSubmit(dialogOfA);
      clickDialogButton(dialogOfA, testCase.okButtonName);
      await waitFor(() => expect(testCase.adapterCallCount()).toBe(1));

      clickRowAction(ROW_B.nickname, testCase.actionName);
      expect(isDialogOpen(testCase.dialogTitleOf(ROW_B.nickname))).toBe(true);
      expect(queryDialog(testCase.dialogTitleOf(ROW_A.nickname))).toBeNull();

      await pending.resolve();

      // A 的成功不得关掉 B：B 的弹窗仍在，标题也仍是 B
      expect(isDialogOpen(testCase.dialogTitleOf(ROW_B.nickname))).toBe(true);
      testCase.assertStaleSuccessFeedback();
      // 数据库变更确实发生，reload 照常执行
      await waitFor(() => expect(fetchUsersMock.mock.calls.length).toBeGreaterThanOrEqual(2));
    },
    // 长交互用例（多轮弹窗 + 挂起 Promise）：全量并发跑偶发 5s 抖动，显式放宽到 15s
    15_000,
  );

  it.each(ROW_DIALOG_CASES)(
    '$name：提交进行中把目标切到 B 再切回 A，A 的旧成功不关闭新一代 A 弹窗',
    async (testCase) => {
      // 这一条才真正隔离会话代次：切走再切回后 accountId 完全相同，
      // 只核对 accountId 的实现一定会把新一代 A 弹窗关掉
      const pending = testCase.stubPendingSuccess();
      await renderPanel();

      clickRowAction(ROW_A.nickname, testCase.actionName);
      const staleDialog = getDialog(testCase.dialogTitleOf(ROW_A.nickname));
      testCase.prepareSubmit(staleDialog);
      clickDialogButton(staleDialog, testCase.okButtonName);
      await waitFor(() => expect(testCase.adapterCallCount()).toBe(1));

      clickRowAction(ROW_B.nickname, testCase.actionName);
      clickRowAction(ROW_A.nickname, testCase.actionName);
      expect(isDialogOpen(testCase.dialogTitleOf(ROW_A.nickname))).toBe(true);

      await pending.resolve();

      expect(isDialogOpen(testCase.dialogTitleOf(ROW_A.nickname))).toBe(true);
      testCase.assertStaleSuccessFeedback();
    },
    15_000,
  );

  it.each(ROW_DIALOG_CASES)('$name：正常成功关闭弹窗、给出成功反馈并刷新列表', async (testCase) => {
    testCase.stubResolvedSuccess();
    await renderPanel();

    clickRowAction(ROW_A.nickname, testCase.actionName);
    const dialog = getDialog(testCase.dialogTitleOf(ROW_A.nickname));
    testCase.prepareSubmit(dialog);
    clickDialogButton(dialog, testCase.okButtonName);

    await waitFor(() => expect(testCase.adapterCallCount()).toBe(1));
    await waitFor(() => expect(isDialogOpen(testCase.dialogTitleOf(ROW_A.nickname))).toBe(false));
    testCase.assertFreshSuccessFeedback();
    await waitFor(() => expect(fetchUsersMock.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it.each(ROW_DIALOG_CASES)(
    '$name：正常失败在当前弹窗显示后端业务错误原文、保留当前目标且不刷新列表',
    async (testCase) => {
      // 面板此前把 kind === 'ok' 且 result.ok === false 的业务失败塌缩成空 message，
      // 弹窗因此什么都不显示；这里逐个钉住业务失败必须带原文回到弹窗
      testCase.stubResolvedFailure(BUSINESS_FAILURE_MESSAGE);
      await renderPanel();

      clickRowAction(ROW_A.nickname, testCase.actionName);
      const dialog = getDialog(testCase.dialogTitleOf(ROW_A.nickname));
      testCase.prepareSubmit(dialog);
      clickDialogButton(dialog, testCase.okButtonName);

      expect(await within(dialog).findByText(BUSINESS_FAILURE_MESSAGE)).toBeTruthy();
      // 失败不关闭弹窗，关闭只由用户或成功收尾触发
      expect(isDialogOpen(testCase.dialogTitleOf(ROW_A.nickname))).toBe(true);
      testCase.assertDraftPreserved(dialog);
      expect(message.success).not.toHaveBeenCalled();
      // 业务失败不刷新列表，避免把用户正在查看的 baseline 悄悄换掉
      expect(fetchUsersMock).toHaveBeenCalledTimes(1);
    },
  );

  it('重置为默认密码：提交进行中把目标切到 B，A 的失败晚到不污染 B 的错误区', async () => {
    const pending = deferred<AdminUserPasswordResetResult>();
    resetPasswordMock.mockReturnValue(pending.promise);
    await renderPanel();

    clickRowAction(ROW_A.nickname, /重\s*置\s*密\s*码/);
    const dialogOfA = getDialog('重置密码：用户A');
    clickDialogButton(dialogOfA, /重\s*置\s*为\s*默\s*认\s*密\s*码/);
    await waitFor(() => expect(resetPasswordMock).toHaveBeenCalledTimes(1));

    clickRowAction(ROW_B.nickname, /重\s*置\s*密\s*码/);
    const dialogOfB = getDialog('重置密码：用户B');

    await act(async () => {
      pending.resolve({ ok: false, reason: 'reset-failed', message: STALE_FAILURE_MESSAGE });
    });

    expect(screen.queryByText(STALE_FAILURE_MESSAGE)).toBeNull();
    expect(dialogOfB.textContent).not.toContain(STALE_FAILURE_MESSAGE);
    // B 的弹窗既没被旧结果关掉，也没被写进旧错误
    expect(isDialogOpen('重置密码：用户B')).toBe(true);
    expect(message.success).not.toHaveBeenCalled();
  });

  it('重置为默认密码：提交进行中重入同一个目标不推进会话代次，成功续体仍能正常收尾', async () => {
    // 目标 accountId 未变 = 同一次会话仍在继续：面板不得推进代次，
    // 否则一次重入就会让在途提交被误判成陈旧，弹窗留在原地而反馈已发
    const pending = deferred<AdminUserPasswordResetResult>();
    resetPasswordMock.mockReturnValue(pending.promise);
    await renderPanel();

    clickRowAction(ROW_A.nickname, /重\s*置\s*密\s*码/);
    const dialog = getDialog('重置密码：用户A');
    clickDialogButton(dialog, /重\s*置\s*为\s*默\s*认\s*密\s*码/);
    await waitFor(() => expect(resetPasswordMock).toHaveBeenCalledTimes(1));

    clickRowAction(ROW_A.nickname, /重\s*置\s*密\s*码/);
    expect(isDialogOpen('重置密码：用户A')).toBe(true);

    await act(async () => {
      pending.resolve({ ok: true, notice: RESET_NOTICE });
    });

    expect(message.success).toHaveBeenCalledWith(RESET_NOTICE, 6);
    await waitFor(() => expect(isDialogOpen('重置密码：用户A')).toBe(false));
    await waitFor(() => expect(fetchUsersMock.mock.calls.length).toBeGreaterThanOrEqual(2));
  });
});

/**
 * 面板这一层的查询语义、可见范围提示与只读表现必须有钉住它的用例：筛选或翻页要下发后端
 * 并回到第 1 页，空/失败态要真的走公共容器且重试能再次发请求，页面只开放 V6.4 允许的动作。
 * 这里只驱动 UI，断言落在 adapter 收到的查询对象与 DOM 上，不改动业务/权限实现，
 * 也不重复文件上半部分已覆盖的弹窗会话代次守卫。
 */
describe('管理员用户管理面板的列表查询与只读表现', () => {
  beforeEach(() => {
    vi.spyOn(message, 'success')
      .mockImplementation(() => undefined as never)
      .mockClear();
    fetchUsersMock.mockReset();
    fetchUsersMock.mockResolvedValue(makePage());
  });

  /** 工具条上的 Select 没有可访问名，用占位文案定位它的容器，再取容器内的 combobox。 */
  async function selectToolbarOption(placeholder: string, optionLabel: string) {
    const select = screen.getByText(placeholder).closest('.ant-select') as HTMLElement;
    fireEvent.mouseDown(within(select).getByRole('combobox'));

    const dropdown = await waitFor(() => {
      const opened = document.querySelector(
        '.ant-select-dropdown:not(.ant-select-dropdown-hidden)',
      );

      if (opened === null) {
        throw new Error(`「${placeholder}」下拉未展开`);
      }

      return opened as HTMLElement;
    });
    fireEvent.click(within(dropdown).getByText(optionLabel));
  }

  it('主搜索在防抖到期后把去空白的关键字下发后端并把页码回到第 1 页', async () => {
    await renderPanel();

    fireEvent.change(screen.getByPlaceholderText('搜索登录名 / 登录邮箱 / 昵称'), {
      target: { value: '  user_a  ' },
    });

    await waitFor(() => {
      expect(fetchUsersMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ keyword: 'user_a', page: 1 }),
      );
    });
  });

  it('连续输入只在防抖到期后发一次搜索请求，不逐字符请求后端', async () => {
    await renderPanel();
    const input = screen.getByPlaceholderText('搜索登录名 / 登录邮箱 / 昵称');
    const baseline = fetchUsersMock.mock.calls.length;

    fireEvent.change(input, { target: { value: 'u' } });
    fireEvent.change(input, { target: { value: 'us' } });
    fireEvent.change(input, { target: { value: 'user' } });

    await waitFor(() => {
      expect(fetchUsersMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ keyword: 'user', page: 1 }),
      );
    });
    expect(fetchUsersMock.mock.calls.length - baseline).toBe(1);
  });

  /**
   * 精确筛选条件收在展开区：先点「筛选」开关再操作。
   * 开关沿用工程师维修申请列表的公共 ToolbarButton，展开态以 aria-expanded 表达。
   */
  function openFilterPanel() {
    fireEvent.click(screen.getByRole('button', { name: '筛选' }));
    expect(screen.getByRole('button', { name: '筛选' })).toHaveAttribute('aria-expanded', 'true');
  }

  it('角色筛选把单值角色下发后端并把页码回到第 1 页', async () => {
    await renderPanel();
    openFilterPanel();

    await selectToolbarOption('角色筛选', '工程师');

    await waitFor(() => {
      expect(fetchUsersMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ page: 1, role: 'ENGINEER' }),
      );
    });
  });

  it('角色筛选只提供普通用户值域，不提供管理员角色', async () => {
    await renderPanel();
    openFilterPanel();

    const select = screen.getByText('角色筛选').closest('.ant-select') as HTMLElement;
    fireEvent.mouseDown(within(select).getByRole('combobox'));

    const dropdown = await waitFor(() => {
      const opened = document.querySelector(
        '.ant-select-dropdown:not(.ant-select-dropdown-hidden)',
      );

      if (opened === null) {
        throw new Error('角色筛选下拉未展开');
      }

      return opened as HTMLElement;
    });

    const labels = Array.from(dropdown.querySelectorAll('.ant-select-item-option')).map((node) =>
      (node.textContent ?? '').trim(),
    );

    expect(labels).toEqual(['工程师', '客户']);
    expect(labels).not.toContain('超级管理员');
  });

  it('状态筛选把单值状态下发后端并把页码回到第 1 页', async () => {
    await renderPanel();
    openFilterPanel();

    await selectToolbarOption('状态筛选', '停用');

    await waitFor(() => {
      expect(fetchUsersMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ page: 1, status: 'INACTIVE' }),
      );
    });
  });

  it('翻页把新页码下发后端，不重置当前筛选域', async () => {
    fetchUsersMock.mockResolvedValue({ items: [ROW_A, ROW_B], page: 1, pageSize: 10, total: 25 });
    await renderPanel();

    fireEvent.click(screen.getByTitle('2'));

    await waitFor(() => {
      expect(fetchUsersMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ keyword: null, page: 2, role: null, status: null }),
      );
    });
  });

  it('列表就绪但无数据时渲染公共空态，且不渲染表格', async () => {
    fetchUsersMock.mockResolvedValue({ items: [], page: 1, pageSize: 10, total: 0 });
    render(<AdminUserManagementPanel adminLevel={1} />);

    await waitFor(() => {
      expect(document.querySelector('.empty-state')).not.toBeNull();
    });
    expect(screen.getByText('暂无用户数据。')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('列表加载失败时渲染公共失败态，重试入口重新发起查询并恢复列表', async () => {
    fetchUsersMock.mockRejectedValueOnce(
      new GraphQLIngressError({ message: 'load failed', type: 'network' }),
    );
    render(<AdminUserManagementPanel adminLevel={1} />);

    await waitFor(() => {
      expect(document.querySelector('.error-state')).not.toBeNull();
    });
    expect(screen.getByText('网络连接异常，请稍后重试。')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /重\s*试/ }));

    await screen.findByText(ROW_A.nickname);
    expect(document.querySelector('.error-state')).toBeNull();
  });

  it('页面不提供创建、资料编辑、删除与改角色入口，行操作只剩启停与重置密码', async () => {
    await renderPanel();

    expect(screen.queryByRole('button', { name: /创\s*建\s*用\s*户/ })).toBeNull();

    const row = screen.getByText(ROW_A.nickname).closest('tr') as HTMLElement;
    const labels = within(row)
      .getAllByRole('button')
      .map((button) => (button.textContent ?? '').replace(/\s+/g, ''));

    expect(labels).toContain('启停');
    expect(labels).toContain('重置密码');
    expect(labels).not.toContain('编辑资料');
    expect(labels).not.toContain('删除');
    expect(labels.some((label) => label.includes('角色'))).toBe(false);
  });

  it('一级管理员看到「全部公司」范围提示', async () => {
    await renderPanel(1);

    expect(screen.getByText('当前账号可查看并管理全部公司的普通用户账号。')).toBeInTheDocument();
  });

  it('二级管理员看到「本公司」范围提示', async () => {
    await renderPanel(2);

    expect(screen.getByText('当前账号仅可查看并管理本公司的普通用户账号。')).toBeInTheDocument();
  });

  it('会话等级缺失时不承诺任何范围，交由服务端判定', async () => {
    await renderPanel(null);

    expect(screen.getByText('当前账号的管理范围以服务端判定为准。')).toBeInTheDocument();
  });

  it('SUPER_ADMIN 行保持只读：两个写入口全部禁用且不提供角色编辑入口', async () => {
    const superAdminRow: AdminUserRow = {
      ...ROW_A,
      accountId: 910003,
      loginName: 'user_root',
      nickname: '超管',
      role: 'SUPER_ADMIN',
    };
    fetchUsersMock.mockResolvedValue({
      items: [superAdminRow],
      page: 1,
      pageSize: 10,
      total: 1,
    });
    render(<AdminUserManagementPanel adminLevel={1} />);

    const row = (await screen.findByText('超管')).closest('tr') as HTMLElement;

    // 只读行的写入口被 Tooltip 包裹：按可访问名做角色查询会退化成对整棵子树的
    // 可见性/样式计算，在这里慢到秒级。改为一次取出行内按钮再按可见文案定位，
    // 断言仍然落在 disabled 属性与入口存在性上，不依赖 class 名。
    const rowButtons = within(row).getAllByRole('button');

    function rowButton(label: string) {
      const button = rowButtons.find(
        (candidate) => (candidate.textContent ?? '').replace(/\s+/g, '') === label,
      );

      if (button === undefined) {
        throw new Error(`行内未找到「${label}」按钮`);
      }

      return button;
    }

    expect(rowButton('启停')).toBeDisabled();
    expect(rowButton('重置密码')).toBeDisabled();
    expect(rowButtons.some((candidate) => (candidate.textContent ?? '').includes('编辑资料'))).toBe(
      false,
    );
    expect(rowButtons.some((candidate) => (candidate.textContent ?? '').includes('角色'))).toBe(
      false,
    );
  });
});

/**
 * 「联系方式」区块：完整值提示 + 整块复制。
 *
 * 复制只读取列表**已经返回**的行内字段并写系统剪贴板：不发起任何请求、不打开任何弹窗，
 * 也不复制账号 ID / 公司 / 角色 / 状态。jsdom 不提供 navigator.clipboard，按下述桩显式安装。
 */
describe('管理员用户管理面板的联系方式区块（完整值提示与整块复制）', () => {
  const clipboardWrites: string[] = [];
  // 参数被实现使用（记录写入内容），断言直接落在写入文本上
  const writeTextMock = vi.fn(async (text: string) => {
    clipboardWrites.push(text);
  });

  /** null = 模拟剪贴板 API 缺失（非安全上下文 / 旧浏览器 / 未授权环境） */
  function installClipboard(writeText: ((text: string) => Promise<void>) | null) {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: writeText === null ? undefined : { writeText },
    });
  }

  const TRUNCATED_LOGIN_EMAIL = 'login-address-way-too-long-for-the-column@example.com';
  const TRUNCATED_CONTACT_EMAIL = 'contact-address-way-too-long-for-the-column@example.com';
  const COPY_LOGIN_EMAIL = 'copy-me@example.com';
  const COPY_LOGIN_NAME = 'copy_me';

  const TRUNCATED_ROW: AdminUserRow = {
    ...ROW_A,
    accountId: 910004,
    contactEmail: TRUNCATED_CONTACT_EMAIL,
    loginEmail: TRUNCATED_LOGIN_EMAIL,
    nickname: '长文本用户',
    phone: null,
  };

  const COPY_ROW: AdminUserRow = {
    ...ROW_A,
    accountId: 910005,
    contactEmail: '   ',
    loginEmail: COPY_LOGIN_EMAIL,
    loginName: COPY_LOGIN_NAME,
    nickname: '复制目标',
    phone: null,
  };

  function renderSingleRow(row: AdminUserRow) {
    fetchUsersMock.mockResolvedValue({ items: [row], page: 1, pageSize: 10, total: 1 });

    return render(<AdminUserManagementPanel adminLevel={1} />);
  }

  /** Tooltip 浮层渲染在 body 层 portal 里，按浮层文本断言（触发元素自身也是完整文本） */
  function tooltipTexts(): string[] {
    return Array.from(document.querySelectorAll('.ant-tooltip')).map(
      (node) => node.textContent ?? '',
    );
  }

  beforeEach(() => {
    vi.spyOn(message, 'success')
      .mockImplementation(() => undefined as never)
      .mockClear();
    vi.spyOn(message, 'error')
      .mockImplementation(() => undefined as never)
      .mockClear();
    fetchUsersMock.mockReset();
    fetchUsersMock.mockResolvedValue(makePage());
    clipboardWrites.length = 0;
    writeTextMock.mockClear();
    writeTextMock.mockImplementation(async (text: string) => {
      clipboardWrites.push(text);
    });
    installClipboard(writeTextMock);
  });

  afterEach(() => {
    installClipboard(null);
  });

  it('被省略的联系方式悬停或键盘聚焦时用现有 Tooltip 展示完整值', async () => {
    renderSingleRow(TRUNCATED_ROW);
    await screen.findByText(TRUNCATED_ROW.nickname);

    fireEvent.mouseEnter(screen.getByText(TRUNCATED_LOGIN_EMAIL));

    await waitFor(() => expect(tooltipTexts()).toContain(TRUNCATED_LOGIN_EMAIL));

    // 默认 trigger 只有 hover，键盘聚焦要能看到完整值必须显式包含 focus
    fireEvent.focus(screen.getByText(TRUNCATED_CONTACT_EMAIL));

    await waitFor(() => expect(tooltipTexts()).toContain(TRUNCATED_CONTACT_EMAIL));
  });

  it('空值只渲染占位符：不挂 Tooltip，悬停也不产生空提示', async () => {
    renderSingleRow(TRUNCATED_ROW);
    await screen.findByText(TRUNCATED_ROW.nickname);

    const placeholderLine = screen.getByText('电话：—');

    expect(placeholderLine.querySelector('.admin-user-contact-value')).toBeNull();
    fireEvent.mouseEnter(placeholderLine);

    expect(tooltipTexts().some((text) => text === '—')).toBe(false);
  });

  it('点击联系方式区块复制本行非空基本信息：字段顺序固定、空字段整行省略、不含权限范围外数据', async () => {
    renderSingleRow(COPY_ROW);
    await screen.findByText(COPY_ROW.nickname);

    const block = screen.getByRole('button', { name: `复制「${COPY_ROW.nickname}」的用户信息` });
    const baselineFetches = fetchUsersMock.mock.calls.length;

    fireEvent.click(block);

    await waitFor(() => expect(clipboardWrites).toHaveLength(1));
    expect(clipboardWrites[0]).toBe(
      [
        `用户名：${COPY_ROW.nickname}`,
        `登录名：${COPY_LOGIN_NAME}`,
        `登录邮箱：${COPY_LOGIN_EMAIL}`,
      ].join('\n'),
    );
    // 空字段（联系邮箱为纯空白、电话为 null）整行省略
    expect(clipboardWrites[0]).not.toContain('联系邮箱');
    expect(clipboardWrites[0]).not.toContain('电话');
    // 账号 ID / 所属公司 / 角色 / 状态不属于复制范围
    expect(clipboardWrites[0]).not.toContain('910005');
    expect(clipboardWrites[0]).not.toContain('甲公司');
    expect(clipboardWrites[0]).not.toContain('工程师');

    await waitFor(() => expect(message.success).toHaveBeenCalledWith('用户信息已复制。'));
    expect(message.error).not.toHaveBeenCalled();

    // 复制不发起任何请求，也不打开任何弹窗（不触发整行操作）
    expect(fetchUsersMock.mock.calls.length).toBe(baselineFetches);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('点击区块内的文字（事件冒泡到区块）同样只复制一次', async () => {
    renderSingleRow(COPY_ROW);
    await screen.findByText(COPY_ROW.nickname);

    fireEvent.click(screen.getByText(COPY_LOGIN_EMAIL));

    await waitFor(() => expect(clipboardWrites).toHaveLength(1));
    expect(clipboardWrites[0]).toContain(`用户名：${COPY_ROW.nickname}`);
  });

  it('剪贴板不可用或写入失败都明确提示失败，不静默显示成功', async () => {
    renderSingleRow(COPY_ROW);
    await screen.findByText(COPY_ROW.nickname);

    const block = screen.getByRole('button', { name: `复制「${COPY_ROW.nickname}」的用户信息` });

    // 1) 剪贴板 API 缺失
    installClipboard(null);
    fireEvent.click(block);

    await waitFor(() =>
      expect(message.error).toHaveBeenCalledWith('用户信息复制失败，请手动选择文本复制。'),
    );
    expect(message.success).not.toHaveBeenCalled();
    expect(clipboardWrites).toHaveLength(0);

    // 2) 写入被拒绝
    vi.mocked(message.error).mockClear();
    writeTextMock.mockRejectedValue(new Error('clipboard denied'));
    installClipboard(writeTextMock);
    fireEvent.click(block);

    await waitFor(() => expect(vi.mocked(message.error)).toHaveBeenCalledTimes(1));
    expect(message.success).not.toHaveBeenCalled();
  });

  it('区块可键盘聚焦，Enter / Space 复制，其他按键不复制', async () => {
    renderSingleRow(COPY_ROW);
    await screen.findByText(COPY_ROW.nickname);

    const block = screen.getByRole('button', { name: `复制「${COPY_ROW.nickname}」的用户信息` });
    const baselineFetches = fetchUsersMock.mock.calls.length;

    block.focus();
    expect(block).toHaveFocus();

    fireEvent.keyDown(block, { key: 'a' });
    expect(clipboardWrites).toHaveLength(0);

    fireEvent.keyDown(block, { key: 'Enter' });
    await waitFor(() => expect(clipboardWrites).toHaveLength(1));

    fireEvent.keyDown(block, { key: ' ' });
    await waitFor(() => expect(clipboardWrites).toHaveLength(2));

    expect(fetchUsersMock.mock.calls.length).toBe(baselineFetches);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});

/**
 * 一级专用「二级管理员凭据」入口。
 *
 * 凭据只允许出现在「本次成功」的展示态：关闭、重新挂载（等价刷新）后都不可再查；
 * 口令不进入 Web Storage / Apollo 缓存 / 错误日志。二级与等级缺失不渲染入口，
 * 与服务端独立拒绝越权调用构成两层防线。
 */
describe('管理员用户管理面板的二级管理员凭据入口', () => {
  const BOUND_ADMIN: AdminBoundLevelTwoAdmin = {
    accountDisabled: false,
    accountId: 920001,
    companyName: '甲公司',
    companyStatus: 'ACTIVE',
    loginName: 'orgadmin_501',
    nickname: '甲公司管理员',
    organizationCode: 'ADMIN_ORG_501',
    organizationId: 501,
  };

  const LEVEL_TWO_PASSWORD = 'Temp-LevelTwo-Only-1';

  const REASON_PLACEHOLDER = '例如：管理员遗忘密码，经电话核实后重置';

  beforeEach(() => {
    vi.spyOn(message, 'success')
      .mockImplementation(() => undefined as never)
      .mockClear();
    fetchUsersMock.mockReset();
    fetchUsersMock.mockResolvedValue(makePage());
    fetchBoundAdminsMock.mockReset();
    fetchBoundAdminsMock.mockResolvedValue({
      items: [BOUND_ADMIN],
      page: 1,
      pageSize: 8,
      total: 1,
    });
    resetLevelTwoMock.mockReset();
  });

  /** 打开入口并等到候选表就绪（候选来自一级专用窄查询，与普通用户列表无关） */
  async function openSelectDialog(): Promise<HTMLElement> {
    fireEvent.click(screen.getByRole('button', { name: '二级管理员凭据' }));

    const dialog = await waitFor(() => {
      const opened = queryDialog('选择已绑定的二级管理员');

      if (opened === null) {
        throw new Error('凭据弹窗未打开');
      }

      return opened;
    });

    return dialog;
  }

  async function openConfirmDialog(): Promise<HTMLElement> {
    const selectDialog = await openSelectDialog();

    await within(selectDialog).findByText(BOUND_ADMIN.companyName);
    fireEvent.click(within(selectDialog).getByRole('button', { name: /选\s*择/ }));

    return getDialog('核对目标与重置原因');
  }

  it.each([
    { level: 1, visible: true },
    { level: 2, visible: false },
    { level: null, visible: false },
  ])('管理等级 $level 时入口可见性为 $visible', async ({ level, visible }) => {
    await renderPanel(level);

    const entry = screen.queryByRole('button', { name: '二级管理员凭据' });

    if (visible) {
      expect(entry).toBeInTheDocument();
      return;
    }

    expect(entry).toBeNull();
    // 入口不渲染就没有候选查询：二级与等级缺失不会误打一级专用读面
    expect(fetchBoundAdminsMock).not.toHaveBeenCalled();
  });

  it('重置原因为空白时拦截提交，不调用重置命令', async () => {
    await renderPanel(1);
    const dialog = await openConfirmDialog();

    fireEvent.change(within(dialog).getByPlaceholderText(REASON_PLACEHOLDER), {
      target: { value: '   ' },
    });
    clickDialogButton(dialog, /确认重置/);

    expect(await within(dialog).findByText('请填写重置原因。')).toBeTruthy();
    expect(resetLevelTwoMock).not.toHaveBeenCalled();
    // 仍停在核对步骤，不会因为空原因直接关闭会话
    expect(isDialogOpen('核对目标与重置原因')).toBe(true);
  }, 15_000);

  it('成功只在当次弹窗展示一次口令，关闭与重新挂载后均不可再查且不落持久层', async () => {
    resetLevelTwoMock.mockResolvedValue({
      ok: true,
      credential: {
        adminAccountId: BOUND_ADMIN.accountId,
        loginName: BOUND_ADMIN.loginName,
        mustChangePassword: true,
        nickname: BOUND_ADMIN.nickname,
        organizationId: BOUND_ADMIN.organizationId,
        temporaryPassword: LEVEL_TWO_PASSWORD,
      },
    });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const view = render(<AdminUserManagementPanel adminLevel={1} />);

    await screen.findByText(ROW_A.nickname);
    const dialog = await openConfirmDialog();
    fireEvent.change(within(dialog).getByPlaceholderText(REASON_PLACEHOLDER), {
      target: { value: '  管理员遗忘密码  ' },
    });
    clickDialogButton(dialog, /确认重置/);

    const credentialDialog = await waitFor(() => {
      const opened = queryDialog('二级管理员临时密码');

      if (opened === null) {
        throw new Error('未进入凭据展示态');
      }

      return opened;
    });

    expect(within(credentialDialog).getByDisplayValue(LEVEL_TWO_PASSWORD)).toBeInTheDocument();
    // 原因 trim 后才进入命令，审计里不会出现两侧空白
    expect(resetLevelTwoMock).toHaveBeenCalledWith({
      adminAccountId: BOUND_ADMIN.accountId,
      organizationId: BOUND_ADMIN.organizationId,
      reason: '管理员遗忘密码',
    });
    expect(message.success).toHaveBeenCalledWith('二级管理员临时密码已重置。');
    // 口令不得进入任何持久层或缓存
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain(LEVEL_TWO_PASSWORD);
    expect(JSON.stringify({ ...window.localStorage })).not.toContain(LEVEL_TWO_PASSWORD);
    expect(JSON.stringify(getGraphQLClient().cache.extract())).not.toContain(LEVEL_TWO_PASSWORD);

    clickDialogButton(credentialDialog, /我已记录并关闭/);
    await waitFor(() => expect(isDialogOpen('二级管理员临时密码')).toBe(false));

    view.unmount();
    expect(document.body.textContent).not.toContain(LEVEL_TWO_PASSWORD);

    // 重新挂载等价刷新：入口回到选择步骤，旧口令无法再次查看
    render(<AdminUserManagementPanel adminLevel={1} />);
    await screen.findByText(ROW_A.nickname);
    await openSelectDialog();
    expect(document.body.textContent).not.toContain(LEVEL_TWO_PASSWORD);
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain(LEVEL_TWO_PASSWORD);
    expect(JSON.stringify({ ...window.localStorage })).not.toContain(LEVEL_TWO_PASSWORD);
    expect(consoleErrorSpy.mock.calls.flat().map(String).join(' ')).not.toContain(
      LEVEL_TWO_PASSWORD,
    );

    consoleErrorSpy.mockRestore();
  }, 15_000);

  it('业务失败停在核对步骤并展示后端原文，不展示口令也不给成功反馈', async () => {
    resetLevelTwoMock.mockResolvedValue({
      ok: false,
      reason: 'status-conflict',
      message: BUSINESS_FAILURE_MESSAGE,
    });
    await renderPanel(1);
    const dialog = await openConfirmDialog();

    fireEvent.change(within(dialog).getByPlaceholderText(REASON_PLACEHOLDER), {
      target: { value: '管理员遗忘密码' },
    });
    clickDialogButton(dialog, /确认重置/);

    expect(await within(dialog).findByText(BUSINESS_FAILURE_MESSAGE)).toBeTruthy();
    expect(isDialogOpen('核对目标与重置原因')).toBe(true);
    expect(message.success).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(LEVEL_TWO_PASSWORD);
  });
});
