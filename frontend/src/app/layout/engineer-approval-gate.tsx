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
 * - 首帧即等待：需要判断批准结果的会话（资格成立且会话快照携带申请组织）从第一帧
 *   渲染加载态，确认前不挂载工作台内容，也不发工作台的 GraphQL 读取；
 * - 无申请记录的存量工程师由会话快照的服务端事实（`registrationOrganizationId` 为
 *   null）识别，直接渲染既有内容，不额外发起审批读取——审批读取故障因此不会阻断
 *   存量工程师的日常工作台；
 * - 检查结果与采样时的「账号 + 会话代次」绑定：会话切换、迟到响应、角色或限制变化
 *   都不借用前一会话的结论；
 * - 进入动作重新复核同一账号、同一会话代次的会话快照，并要求 restriction 仍为 NONE、
 *   申请仍为 APPROVED 且仍是同一份申请，才记录一次性展示偏好并导航；
 * - 导航优先回到当前仍授权的站内目标（保留路径与 query），缺失或不安全时回落角色首页；
 *   目标判定复用 auth-session 既有入口策略，不新增第二套 returnTo 解析；
 * - localStorage 只记录「已确认过这份批准结果」的展示偏好，缺失只会多展示一次，
 *   存在也不会放行任何访问；读、写与可用性探测全部容错，批准事实不来自本地存储。
 */

import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Typography } from 'antd';
import { useLocation, useNavigate } from 'react-router';

import { useI18n } from '@/app/providers';

import {
  type AuthSessionIdentity,
  getCurrentAuthSession,
  refreshCurrentAuthSessionIdentity,
  resolveAuthSessionEntryPath,
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

/**
 * 门状态：每个非 `pending` 的结果都绑定产生它的会话身份，渲染前与当前采样比对，
 * 不匹配则回到等待态（绝不把上一会话的结论当作本会话的结论）。
 */
type ApprovalGateState =
  | { status: 'checking'; identity: AuthSessionIdentity }
  | { identity: AuthSessionIdentity; application: MyEngineerRegistrationView; status: 'approved' }
  | { status: 'failed' }
  | { identity: AuthSessionIdentity; status: 'idle' }
  | { status: 'pending' };

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
  const location = useLocation();
  const { t } = useI18n();
  const { session } = useAuthSession();
  const accountId = session?.accountId ?? null;
  const role = session?.role ?? null;
  const restriction = session?.restriction ?? null;
  // 会话快照中的「最新工程师申请目标公司」是服务端事实：为空说明没有申请记录，
  // 该会话没有可展示的批准结果，不需要（也不应）额外发起审批读取。
  const hasRegisteredApplication = session?.registrationOrganizationId != null;
  const isEligible = accountId !== null && role === 'ENGINEER' && restriction === 'NONE';
  const requiresApprovalCheck = isEligible && hasRegisteredApplication;
  const [state, setState] = useState<ApprovalGateState>({ status: 'pending' });
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
      setState({ status: 'pending' });
      return;
    }

    setState({ identity: initiated, status: 'checking' });
    setEnterError(null);

    try {
      // 服务端复核当前限制状态；stale 表示本次响应不代表当前会话。
      // 按计划口径 stale 不回落为「可渲染」，统一进入可重试失败态。
      const outcome = await refreshCurrentAuthSessionIdentity();
      if (!mountedRef.current || seq !== checkSeqRef.current) {
        return;
      }

      if (outcome.status === 'stale') {
        setState({ status: 'failed' });
        return;
      }

      const current = getCurrentAuthSession();
      if (
        !isSameSessionIdentity(sampleCurrentAuthSessionIdentity(), initiated) ||
        current === null ||
        current.restriction !== 'NONE' ||
        current.role !== 'ENGINEER'
      ) {
        setState({ identity: initiated, status: 'idle' });
        return;
      }

      const application = await fetchMyEngineerRegistration();
      if (!mountedRef.current || seq !== checkSeqRef.current) {
        return;
      }

      // 申请读取期间会话已变化（退出重登 / 切换账号）：本次结论不属于当前会话
      if (!isSameSessionIdentity(sampleCurrentAuthSessionIdentity(), initiated)) {
        setState({ identity: initiated, status: 'idle' });
        return;
      }

      if (
        application !== null &&
        application.status === 'APPROVED' &&
        !hasAcknowledgedEngineerApproval(initiated.accountId, application.applicationId)
      ) {
        setState({ application, identity: initiated, status: 'approved' });
        return;
      }

      setState({ identity: initiated, status: 'idle' });
    } catch {
      if (mountedRef.current && seq === checkSeqRef.current) {
        setState({ status: 'failed' });
      }
    }
  }, []);

  useEffect(() => {
    if (!requiresApprovalCheck) {
      // 资格已不成立：作废在途检查；渲染层直接放行既有内容（受限收口由 app-layout 负责）
      checkSeqRef.current += 1;
      return;
    }

    // 放到异步边界启动检查：避免在 effect 体内同步切换状态引发的级联渲染
    const timer = window.setTimeout(() => {
      void runCheck();
    }, 0);

    return () => window.clearTimeout(timer);
    // accountId 变化（切换账号）时重新检查；同一账号的会话代次变化会先经历
    // requiresApprovalCheck 由 false 回到 true（退出重登），同样会触发重新检查。
  }, [accountId, requiresApprovalCheck, runCheck]);

  const currentIdentity = sampleCurrentAuthSessionIdentity();
  // 渲染前核对结果所属会话：身份不匹配时回到等待态，绝不渲染上一会话的批准结果
  const sessionBoundState: ApprovalGateState =
    state.status !== 'pending' &&
    'identity' in state &&
    !isSameSessionIdentity(currentIdentity, state.identity)
      ? { status: 'pending' }
      : state;

  const approvedApplication =
    sessionBoundState.status === 'approved' ? sessionBoundState.application : null;

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
      if (current === null || current.restriction !== 'NONE' || current.role !== 'ENGINEER') {
        setEnterError(t('layout.approval.stillRestricted'));
        return;
      }

      // 以服务端最新申请事实复核资格，不把已展示的快照当作通行许可
      const application = await fetchMyEngineerRegistration();
      if (!isSameSessionIdentity(sampleCurrentAuthSessionIdentity(), initiated)) {
        setEnterError(t('layout.approval.staleSession'));
        return;
      }

      if (
        application === null ||
        application.status !== 'APPROVED' ||
        application.applicationId !== approvedApplication.applicationId
      ) {
        setEnterError(t('layout.approval.stillRestricted'));
        return;
      }

      acknowledgeEngineerApproval(initiated.accountId, application.applicationId);
      setState({ identity: initiated, status: 'idle' });
      // 回到当前仍授权的站内目标（保留 path + query）；缺失或不安全时由既有
      // 入口策略回落到角色首页。这里只是把当前位置交给同一份策略裁决。
      navigate(resolveAuthSessionEntryPath(current, `${location.pathname}${location.search}`), {
        replace: true,
      });
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

  // 资格不成立 / 没有申请记录：沿用既有内容，由 app-layout 收口限制状态
  if (!requiresApprovalCheck) {
    return <>{children}</>;
  }

  if (sessionBoundState.status === 'pending' || sessionBoundState.status === 'checking') {
    return <LoadingState label={t('layout.approval.loading')} />;
  }

  if (sessionBoundState.status === 'failed') {
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
