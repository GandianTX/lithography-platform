// src/features/account-settings/application/use-account-settings.ts

/**
 * 账号设置的读取与写命令执行入口（收束在 feature application）。
 *
 * - 读取：挂载即加载；transport / auth 失败收敛为 failed 状态与兜底文案，
 *   UNAUTHENTICATED 的会话失效处理仍由共享 ingress 链路负责；
 * - 写命令（资料更新 / 修改密码 / 公司补录）：各持独立的 in-flight 键；改密只与同类互斥。
 *   资料更新与公司补录同属「个人资料」标签内的写动作，共用一把互斥锁：任一在途时
 *   另一条直接返回 in-flight 且不发起请求——二者的权威视图互不覆盖，也就不存在
 *   「补录成功后又被后发资料的失败/旧视图丢弃」的时序问题；
 * - 陈旧响应防护：与 use-admin-user-list 的 requestSeq 同一口径——**设置视图序号**
 *   只在初始加载 / reload / 资料保存 / 公司补录这几类会改写设置视图的动作发起时推进，
 *   结果回来时序号已推进即整体丢弃。改密不触碰视图序号（不产生设置视图事实，
 *   成功后由页面装配层清理会话并跳转登录页），与资料保存互不阻塞、互不丢弃；
 * - 日志安全边界：命令失败日志只记录 error 对象，不得携带命令入参
 *   （changeMyPassword 的入参是明文密码）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { isGraphQLIngressError } from '@/shared/graphql';
import { translateNow } from '@/shared/i18n';

import {
  changeMyPassword,
  fetchMyAccountSettings,
  supplementMyCustomerCompany,
  updateMyAccountSettingsProfile,
} from '../infrastructure/account-settings-adapter';

import type {
  AccountSettingsProfileDraft,
  AccountSettingsProfileUpdateResult,
  AccountSettingsView,
  ChangeMyPasswordInput,
  ChangeMyPasswordOutcome,
  ChangeMyPasswordResult,
  ChangePasswordSessionIdentity,
  CustomerCompanySupplementDraft,
  CustomerCompanySupplementResult,
} from './account-settings.types';

/** Hook 级可选项：账号身份采样与资料保存成功回调（均由页面装配层注入） */
export type UseAccountSettingsOptions = {
  /**
   * 请求发起前的账号身份采样：页面装配层借此在**发起时**固化「这次保存属于哪个账号」，
   * 供迟到响应做身份裁决。不得在响应返回后重读当前会话账号——那时可能已切换账号，
   * 采到的将是另一个人的身份。
   */
  sampleAccountId?: () => number | null;
  /**
   * 请求发起前的会话代次采样：页面装配层借此在**发起时**固化「这次改密属于哪个会话」，
   * 成功结果携带该身份返回，由页面装配层与当前会话比对后决定是否清理会话。
   * 不得在响应返回后重读——那时可能已退出重登或切换账号。
   */
  sampleSessionIdentity?: () => ChangePasswordSessionIdentity | null;
  /**
   * 资料保存成功且结果未过期时的回调（页面装配层借此把昵称回写会话真源）。
   * 第二参为请求发起前采样的账号 ID（可能为 null：装配层未接入采样），
   * 与权威昵称一起交给窄入口，由 store 与当前会话比对后决定是否落盘。
   */
  onProfileSaved?: (settings: AccountSettingsView, expectedAccountId: number | null) => void;
  /**
   * 是否启用资料读取与写入链路，默认 true。
   *
   * 受限页的强制改密态只允许读取身份与改密，**不得**在进入该分支时加载账号资料；
   * 传 false 时初始加载与 `reload` 都不发起请求（页面装配层据此避免改密前读取其他账号事实）。
   */
  enabled?: boolean;
};

export type AccountSettingsState =
  | { message: string; status: 'failed' }
  | { settings: AccountSettingsView; status: 'ready' }
  | { status: 'loading' };

export type AccountSettingsCommandKey = 'change-password' | 'supplement-company' | 'update-profile';

export type AccountSettingsCommandExecution<T> =
  | { kind: 'ok'; result: T }
  | { kind: 'in-flight' }
  | { kind: 'unhandled-error'; message: string };

function toUnhandledUserMessage(error: unknown): string {
  return isGraphQLIngressError(error) ? error.userMessage : translateNow('account.command.failed');
}

export function useAccountSettings(options: UseAccountSettingsOptions = {}) {
  const { enabled = true, onProfileSaved, sampleAccountId, sampleSessionIdentity } = options;
  const [state, setState] = useState<AccountSettingsState>({ status: 'loading' });
  // 设置视图序号：仅在初始加载 / reload / 资料保存（会改写设置视图的动作）发起时
  // +1，结果回来时不再等于发起值即陈旧；改密不推进它（见文件头注释）
  const viewSeqRef = useRef(0);
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<AccountSettingsCommandKey>>(new Set());
  const pendingKeysRef = useRef<ReadonlySet<AccountSettingsCommandKey>>(new Set());

  const setPending = useCallback((key: AccountSettingsCommandKey, pending: boolean) => {
    const next = new Set(pendingKeysRef.current);

    if (pending) {
      next.add(key);
    } else {
      next.delete(key);
    }

    pendingKeysRef.current = next;
    setPendingKeys(next);
  }, []);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let cancelled = false;

    async function load() {
      viewSeqRef.current += 1;
      const viewSeq = viewSeqRef.current;

      setState({ status: 'loading' });

      try {
        const settings = await fetchMyAccountSettings();

        if (!cancelled && viewSeqRef.current === viewSeq) {
          setState({ settings, status: 'ready' });
        }
      } catch (error) {
        if (!isGraphQLIngressError(error)) {
          // 非 ingress 错误（如 mapper 守卫抛出）原始信息只保留在控制台，
          // 避免收敛文案后线上无法排障
          console.error('账号设置加载出现未分类错误：', error);
        }

        if (!cancelled && viewSeqRef.current === viewSeq) {
          setState({ message: translateNow('account.loadFailedRetry'), status: 'failed' });
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [enabled]);

  /** 按当前事实重新加载（写命令不走本入口：写结果自带权威视图，见 updateProfile） */
  const reload = useCallback(() => {
    if (!enabled) {
      return;
    }

    viewSeqRef.current += 1;
    const viewSeq = viewSeqRef.current;

    setState({ status: 'loading' });

    void fetchMyAccountSettings()
      .then((settings) => {
        if (viewSeqRef.current === viewSeq) {
          setState({ settings, status: 'ready' });
        }
      })
      .catch((error: unknown) => {
        if (!isGraphQLIngressError(error)) {
          console.error('账号设置加载出现未分类错误：', error);
        }

        if (viewSeqRef.current === viewSeq) {
          setState({ message: translateNow('account.loadFailedRetry'), status: 'failed' });
        }
      });
  }, [enabled]);

  /**
   * 资料更新：成功时把 adapter 返回的权威视图写回状态（仅当序列未推进——
   * 期间若用户又发起了别的动作，过期结果不得覆盖新状态），并在结果未过期时
   * 触发 onProfileSaved（页面装配层借此把昵称回写会话真源，侧栏显示随之更新）。
   * 身份口径：expectedAccountId 在**请求发起前**采样固化；响应返回后即使当前
   * 会话已切换成他人，迟到响应携带的仍是发起者的身份，由 store 侧比对拒绝。
   */
  const updateProfile = useCallback(
    async (
      draft: AccountSettingsProfileDraft,
    ): Promise<AccountSettingsCommandExecution<AccountSettingsProfileUpdateResult>> => {
      // 与公司补录共用同一把互斥锁：二者都改写设置视图，交叠会让先完成的权威视图
      // 被后发动作的序号推进丢弃（补录成功回显消失）。交叠期的第二条命令不发出请求。
      if (
        pendingKeysRef.current.has('update-profile') ||
        pendingKeysRef.current.has('supplement-company')
      ) {
        return { kind: 'in-flight' };
      }

      // 请求发起前固化本次保存的账号身份（响应返回后不得重读，见类型注释）
      const expectedAccountId = sampleAccountId?.() ?? null;

      viewSeqRef.current += 1;
      const viewSeq = viewSeqRef.current;
      setPending('update-profile', true);

      try {
        const result = await updateMyAccountSettingsProfile(draft);

        if (result.ok && viewSeqRef.current === viewSeq) {
          setState({ settings: result.settings, status: 'ready' });
          onProfileSaved?.(result.settings, expectedAccountId);
        }

        return { kind: 'ok', result };
      } catch (error) {
        if (!isGraphQLIngressError(error)) {
          console.error('账号设置更新出现未分类错误：', error);
        }

        return { kind: 'unhandled-error', message: toUnhandledUserMessage(error) };
      } finally {
        setPending('update-profile', false);
      }
    },
    [onProfileSaved, sampleAccountId, setPending],
  );

  /**
   * 缺归属客户补录公司：成功时与资料更新同构地推进设置视图序号并写回权威视图
   * （期间若用户又发起别的动作，过期结果不得覆盖新状态）。命令自身不判定
   * 「能否补录」——资格由服务端裁决，前端只把业务拒绝原样透传。
   */
  const supplementCompany = useCallback(
    async (
      draft: CustomerCompanySupplementDraft,
    ): Promise<AccountSettingsCommandExecution<CustomerCompanySupplementResult>> => {
      // 与资料更新共用同一把互斥锁（见 updateProfile）：交叠期的第二条命令不发出请求
      if (
        pendingKeysRef.current.has('supplement-company') ||
        pendingKeysRef.current.has('update-profile')
      ) {
        return { kind: 'in-flight' };
      }

      viewSeqRef.current += 1;
      const viewSeq = viewSeqRef.current;
      setPending('supplement-company', true);

      try {
        const result = await supplementMyCustomerCompany(draft);

        if (result.ok && viewSeqRef.current === viewSeq) {
          setState({ settings: result.settings, status: 'ready' });
        }

        return { kind: 'ok', result };
      } catch (error) {
        if (!isGraphQLIngressError(error)) {
          console.error('公司补录出现未分类错误：', error);
        }

        return { kind: 'unhandled-error', message: toUnhandledUserMessage(error) };
      } finally {
        setPending('supplement-company', false);
      }
    },
    [setPending],
  );

  /** 修改密码：成功结果只回传固定提示与**发起前采样**的会话身份（迟到响应由
   *  页面装配层与当前会话比对裁决），会话收口由页面装配层接线执行。
   *  凭据更新不触发 onProfileSaved：昵称同步只属于资料保存链路。 */
  const updatePassword = useCallback(
    async (
      input: ChangeMyPasswordInput,
    ): Promise<AccountSettingsCommandExecution<ChangeMyPasswordResult>> => {
      if (pendingKeysRef.current.has('change-password')) {
        return { kind: 'in-flight' };
      }

      // 请求发起前固化本次改密的会话身份（响应返回后不得重读，见类型注释）
      const initiatedIdentity = sampleSessionIdentity?.() ?? null;

      // 不触碰设置视图序号：改密不产生设置视图事实，与资料保存互不丢弃（见文件头注释）
      setPending('change-password', true);

      try {
        const result: ChangeMyPasswordOutcome = await changeMyPassword(input);

        if (result.ok) {
          return { kind: 'ok', result: { ...result, initiatedIdentity } };
        }

        return { kind: 'ok', result };
      } catch (error) {
        if (!isGraphQLIngressError(error)) {
          // 安全边界：不得打印命令入参（currentPassword / newPassword 为明文）；
          // ingress 错误对象不含 variables，可安全记录
          console.error('修改密码出现未分类错误：', error);
        }

        return { kind: 'unhandled-error', message: toUnhandledUserMessage(error) };
      } finally {
        setPending('change-password', false);
      }
    },
    [sampleSessionIdentity, setPending],
  );

  const isPending = useCallback(
    (key: AccountSettingsCommandKey) => pendingKeys.has(key),
    [pendingKeys],
  );

  return { isPending, reload, state, supplementCompany, updatePassword, updateProfile };
}
