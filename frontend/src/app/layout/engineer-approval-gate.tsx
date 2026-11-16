// src/app/layout/engineer-approval-gate.tsx

/**
 * 工程师本人批准结果门：在工作台内容挂载前，用服务端事实确认本次登录的批准结果。
 *
 * 背景（F3）：旧实现依赖「浏览器曾见过受限态」的 localStorage 标记，导致新浏览器 /
 * 直接登录的已批准账号看不到批准结果；且 app-layout 的既有收口会先跳到 /engineer，
 * 用户先看到工作台再看到一次性提示。
 *
 * 现在的口径：
 * - 展示事实只来自服务端：`mySessionIdentity`（restriction 已确认为 NONE）+
 *   `myEngineerRegistration`（本人最新申请为 APPROVED，含真实目标公司）；
 * - 检查期间渲染加载态，不挂载工作台内容；确认批准结果后展示结果页与「进入工作台」；
 * - 进入动作重新复核同一账号、同一会话代次的会话快照，并要求 restriction 仍为 NONE、
 *   申请仍为 APPROVED，才记录一次性展示偏好并导航；
 * - localStorage 只记录「已确认过这份批准结果」的展示偏好，缺失只会多展示一次，
 *   存在也不会放行任何访问；批准事实不来自本地存储。
 * - 无申请记录的存量工程师、非工程师角色、仍受限会话都沿既有路径直接渲染内容。
 */

import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Typography } from 'antd';
import { useNavigate } from 'react-router';

import { useI18n } from '@/app/providers';

import {
  type AuthSessionIdentity,
  getCurrentAuthSession,
  refreshCurrentAuthSessionIdentity,
  resolveAuthSessionHomePath,
  sampleCurrentAuthSessionIdentity,
  useAuthSession,
} from '@/features/auth-session';
import {
  fetchMyEngineerRegistration,
  type MyEngineerRegistrationView,
} from '@/features/registration';

import { PrimaryButton } from '@/shared/ui/buttons';
import { DataCard } from '@/shared/ui/data-card';
import { ErrorState } from '@/shared/ui/error-state';
import { LoadingState } from '@/shared/ui/loading-state';
import { PageHeader } from '@/shared/ui/page-header';

import {
  acknowledgeEngineerApproval,
  hasAcknowledgedEngineerApproval,
} from './engineer-approval-notice-storage';

type ApprovalGateState =
  | { status: 'checking' }
  | { application: MyEngineerRegistrationView; status: 'approved' }
  | { status: 'failed' }
  | { status: 'idle' };

type EngineerApprovalGateProps = {
  children: ReactNode;
};

function isSameSessionIdentity(
  current: AuthSessionIdentity | null,
  initiated: AuthSessionIdentity,
): boolean {
  return (
    current !== null &&
    current.accountId === initiated.accountId &&
    current.epoch === initiated.epoch
  );
}

export function EngineerApprovalGate({ children }: EngineerApprovalGateProps) {
  const navigate = useNavigate();
  const { t } = useI18n();
  const { session } = useAuthSession();
  const accountId = session?.accountId ?? null;
  const role = session?.role ?? null;
  const restriction = session?.restriction ?? null;
  const isEligible = accountId !== null && role === 'ENGINEER' && restriction === 'NONE';
  const [state, setState] = useState<ApprovalGateState>({ status: 'idle' });
  const [isEntering, setIsEntering] = useState(false);
  const [enterError, setEnterError] = useState<string | null>(null);
  const checkSeqRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      checkSeqRef.current += 1;
    };
  }, []);

  const runCheck = useCallback(async (): Promise<void> => {
    const initiated = sampleCurrentAuthSessionIdentity();
    const seq = checkSeqRef.current + 1;
    checkSeqRef.current = seq;

    if (!initiated) {
      setState({ status: 'idle' });
      return;
    }

    setState({ status: 'checking' });
    setEnterError(null);

    try {
      // 服务端复核当前限制状态；stale 表示本次响应不代表当前会话，不得据此展示结果
      const outcome = await refreshCurrentAuthSessionIdentity();
      if (!mountedRef.current || seq !== checkSeqRef.current) {
        return;
      }

      if (outcome.status === 'stale') {
        setState({ status: 'idle' });
        return;
      }

      const current = getCurrentAuthSession();
      if (
        !isSameSessionIdentity(sampleCurrentAuthSessionIdentity(), initiated) ||
        current === null ||
        current.restriction !== 'NONE' ||
        current.role !== 'ENGINEER'
      ) {
        setState({ status: 'idle' });
        return;
      }

      const application = await fetchMyEngineerRegistration();
      if (!mountedRef.current || seq !== checkSeqRef.current) {
        return;
      }

      // 申请读取期间会话已变化（退出重登 / 切换账号）：本次结论不属于当前会话
      if (!isSameSessionIdentity(sampleCurrentAuthSessionIdentity(), initiated)) {
        setState({ status: 'idle' });
        return;
      }

      if (
        application !== null &&
        application.status === 'APPROVED' &&
        !hasAcknowledgedEngineerApproval(initiated.accountId, application.applicationId)
      ) {
        setState({ application, status: 'approved' });
        return;
      }

      setState({ status: 'idle' });
    } catch {
      if (mountedRef.current && seq === checkSeqRef.current) {
        setState({ status: 'failed' });
      }
    }
  }, []);

  useEffect(() => {
    if (!isEligible) {
      // 资格已不成立：作废在途检查；渲染层直接放行既有内容（受限收口由 app-layout 负责）
      checkSeqRef.current += 1;
      return;
    }

    // 放到异步边界启动检查：避免在 effect 体内同步切换状态引发的级联渲染
    const timer = window.setTimeout(() => {
      void runCheck();
    }, 0);

    return () => window.clearTimeout(timer);
  }, [isEligible, runCheck]);

  const approvedApplication = state.status === 'approved' ? state.application : null;

  async function handleEnterWorkspace(): Promise<void> {
    if (approvedApplication === null) {
      return;
    }

    const initiated = sampleCurrentAuthSessionIdentity();
    if (!initiated) {
      setEnterError(t('layout.approval.staleSession'));
      return;
    }

    setIsEntering(true);
    setEnterError(null);

    try {
      const outcome = await refreshCurrentAuthSessionIdentity();
      if (!mountedRef.current) {
        return;
      }

      // stale：本次复核未描述当前会话（并发刷新覆盖 / 迟到 / 身份已变化）
      if (outcome.status === 'stale') {
        setEnterError(t('layout.approval.staleSession'));
        return;
      }

      const current = getCurrentAuthSession();
      if (current === null || current.restriction !== 'NONE') {
        setEnterError(t('layout.approval.stillRestricted'));
        return;
      }

      // 以服务端最新申请事实复核资格，不把已展示的快照当作通行许可
      const application = await fetchMyEngineerRegistration();
      if (!isSameSessionIdentity(sampleCurrentAuthSessionIdentity(), initiated)) {
        setEnterError(t('layout.approval.staleSession'));
        return;
      }

      if (application === null || application.status !== 'APPROVED') {
        setEnterError(t('layout.approval.stillRestricted'));
        return;
      }

      acknowledgeEngineerApproval(initiated.accountId, application.applicationId);
      setState({ status: 'idle' });
      navigate(resolveAuthSessionHomePath(current.role), { replace: true });
    } catch {
      if (mountedRef.current) {
        setEnterError(t('layout.approval.verifyFailed'));
      }
    } finally {
      if (mountedRef.current) {
        setIsEntering(false);
      }
    }
  }

  // 资格不再成立时（被撤资格 / 变为受限会话）沿用既有内容，由 app-layout 收口
  if (!isEligible) {
    return <>{children}</>;
  }

  if (state.status === 'checking') {
    return <LoadingState label={t('layout.approval.loading')} />;
  }

  if (state.status === 'failed') {
    return (
      <ErrorState
        action={<PrimaryButton onClick={() => void runCheck()}>{t('common.retry')}</PrimaryButton>}
        description={t('layout.approval.loadFailed')}
        title={t('layout.approval.title')}
      />
    );
  }

  if (approvedApplication === null) {
    return <>{children}</>;
  }

  return (
    <div className="page-stack">
      <PageHeader
        description={t('layout.approval.description')}
        eyebrow="Approval Result"
        title={t('layout.approval.title')}
      />

      <DataCard title={t('layout.approval.companyLabel')}>
        <Typography.Text>
          {approvedApplication.organizationName ??
            t('layout.approval.companyFallback', { id: approvedApplication.organizationId })}
        </Typography.Text>
      </DataCard>

      {enterError ? <Alert description={enterError} showIcon type="error" /> : null}

      <div className="page-action-row">
        <PrimaryButton loading={isEntering} onClick={() => void handleEnterWorkspace()}>
          {t('layout.approval.enter')}
        </PrimaryButton>
      </div>
    </div>
  );
}
