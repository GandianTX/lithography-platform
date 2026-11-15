// src/pages/engineer-repair-request-detail/index.tsx

/**
 * 工程师维修申请详情页：只装配，不含业务请求。
 *
 * - 路由参数解析是页面层对 URL 的窄职责：非正整数 ID 归一为 null，
 *   feature 对 null 走静态统一不可访问反馈，不产生 GraphQL 请求；
 * - 接单/回复可见性由页面层基于会话单值业务角色判定后以布尔传入：
 *   读权限继承不等于写权限，仅精确 ENGINEER 展示接单与回复提交入口；
 * - key 随路由参数强制隔离：参数直接变化时重建面板实例，
 *   上一申请的接单反馈/流程状态不带到下一申请；
 * - scopeKey 取「账号 + 会话代次」的窄身份：同一工单的结单本地只读事实
 *   只在该身份/会话内复用，换账号或同账号新会话不会继承旧会话事实；
 * - 详情展示、接单流程与反馈全部来自 feature 公开 barrel；
 * - 路由由 app/router 注册并复用 protectedRouteLoader。
 */

import { useParams } from 'react-router';

import { sampleCurrentAuthSessionIdentity, useAuthSession } from '@/features/auth-session';
import { EngineerRepairRequestDetailPanel } from '@/features/repair-request';

import { useI18n } from '@/shared/i18n';
import { PageHeader } from '@/shared/ui/page-header';

function parseRequestId(raw: string | undefined): number | null {
  if (!raw) {
    return null;
  }

  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function EngineerRepairRequestDetailPage() {
  const { requestId } = useParams<{ requestId: string }>();
  const { t } = useI18n();
  const { session, status } = useAuthSession();
  const parsedRequestId = parseRequestId(requestId);
  // 请求外的窄身份（不含凭据）：账号 + 会话代次，随 auth-session 生命周期变化。
  const sessionIdentity = sampleCurrentAuthSessionIdentity();
  const sessionScopeKey = sessionIdentity
    ? `${sessionIdentity.accountId}:${sessionIdentity.epoch}`
    : 'anonymous';

  // session.role 是后端登录角色决策产出的单值业务角色；
  // SUPER_ADMIN 继承的是读权限，不展示接单/回复提交入口（后端守卫 + usecase 双重拦截仍在）。
  // canHandleAsEngineer 表达接单与回复共用的精确 ENGINEER 写身份，同时控制两个提交入口。
  const canHandleAsEngineer = status === 'authenticated' && session.role === 'ENGINEER';

  return (
    <div className="page-stack">
      <PageHeader
        description={t('engineer.detailDescription')}
        eyebrow="Repair Request Detail"
        title={t('engineer.detailTitle')}
      />
      <EngineerRepairRequestDetailPanel
        canHandleAsEngineer={canHandleAsEngineer}
        key={parsedRequestId === null ? 'invalid' : `${sessionScopeKey}:${parsedRequestId}`}
        requestId={parsedRequestId}
        scopeKey={sessionScopeKey}
      />
    </div>
  );
}
