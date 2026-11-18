// src/features/repair-request/ui/repair-request-status-tags.tsx

import type { MessageKey } from '@/shared/i18n';
import { useI18n } from '@/shared/i18n';
import {
  type RepairHandlingResultValue,
  resolveRepairClosureState,
} from '@/shared/ui/repair-request-status-labels';
import { StatusPill, type StatusPillTone } from '@/shared/ui/status-pill';

import type {
  EngineerRepairAcceptanceViewStatus,
  EngineerResolutionStatusValue,
} from '../infrastructure/engineer-repair-request.types';

/**
 * 维修申请切片内接单/处理状态胶囊的唯一实现（列表、详情与首页共用），
 * 保证多处视觉语义一致，不在多个文件里各写一份。
 *
 * 视觉统一消费 PR1 公共 StatusPill（状态胶囊），不另造标签样式：
 * 待接单/处理中为待办语义（warn），已由本人接单/已解决为完成语义（ok），
 * 他人已接单为事实分类（neutral）。
 *
 * 视角标签按后端 RepairRequestAcceptanceViewStatus 表达事实分类：
 * AVAILABLE 仅表示未接单事实，不代表当前会话可接单；
 * 可接单/可回复能力由详情/列表操作区按会话单值业务角色另行控制。
 */
const VIEW_STATUS_META: Record<
  EngineerRepairAcceptanceViewStatus,
  { labelKey: MessageKey; tone: StatusPillTone }
> = {
  AVAILABLE: { labelKey: 'engineerDetail.viewStatus.AVAILABLE', tone: 'warn' },
  MINE: { labelKey: 'engineerDetail.viewStatus.MINE', tone: 'ok' },
  TAKEN_BY_OTHER: { labelKey: 'engineerDetail.viewStatus.TAKEN_BY_OTHER', tone: 'neutral' },
};

export function AcceptanceViewStatusTag({
  viewStatus,
}: {
  viewStatus: EngineerRepairAcceptanceViewStatus | null;
}) {
  const { t } = useI18n();

  if (!viewStatus) {
    // 视角状态缺失（后端保证工程师入口非空，此处为防腐兜底）：按未接单事实展示
    return <StatusPill tone="warn">{t('engineerDetail.viewStatus.AVAILABLE')}</StatusPill>;
  }
  const meta = VIEW_STATUS_META[viewStatus];
  return <StatusPill tone={meta.tone}>{t(meta.labelKey)}</StatusPill>;
}

export function ResolutionTag({ status }: { status: EngineerResolutionStatusValue | null }) {
  const { t } = useI18n();

  if (!status) {
    return <span>{t('engineerDetail.noReply')}</span>;
  }
  return (
    <StatusPill tone={status === 'RESOLVED' ? 'ok' : 'warn'}>
      {t(`status.resolution.${status}`)}
    </StatusPill>
  );
}

/**
 * 结单事实标签：由 closureStatus 与 closedAt 联合判定（共用 resolveRepairClosureState）。
 * 处理状态终结（COMPLETED / UNRESOLVED）不得推断为已结单。
 * 已结单且处理结果为「中断」时合并展示「已结单 · 维修中断」，
 * 避免主状态仍被误读为进行中。
 * 显式未结单（OPEN/null + null）显示「未结单」；
 * 字段缺失、非法值或状态与时间矛盾显示不可确认。
 */
export function ClosureStatusTag({
  closureStatus,
  closedAt,
  handlingResult,
}: {
  closureStatus: string | null | undefined;
  closedAt: string | null | undefined;
  handlingResult: RepairHandlingResultValue | null | undefined;
}) {
  const closureState = resolveRepairClosureState(closureStatus, closedAt);
  if (closureState === 'UNKNOWN') {
    return <StatusPill tone="neutral">结单状态未知</StatusPill>;
  }
  if (closureState === 'OPEN') {
    return <StatusPill tone="warn">未结单</StatusPill>;
  }

  const interrupted = handlingResult === 'INTERRUPTED';
  return <StatusPill tone="ok">{interrupted ? '已结单 · 维修中断' : '已结单'}</StatusPill>;
}
