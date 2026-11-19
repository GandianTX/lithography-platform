// src/features/repair-request/ui/engineer-repair-request-detail-panel.tsx

/**
 * 工程师维修申请详情面板。
 *
 * - 唯一业务入口是 feature application 的编排 hook；
 *   UI 不触碰 adapter，不解析 Apollo 原始错误；
 * - 展示申请编号、客户昵称/公司、设备型号、错误码、提交时间、接单视角状态、
 *   接单工程师与接单时间、结单事实（状态/时间/原因）、处理结果与状态、
 *   最后回复状态、故障描述、contentMd、结构化内部维修记录与客户可见回复时间线；
 * - 结单状态/时间/原因与处理结果/状态始终展示：未结单显示「未结单」、
 *   未处理显示「未记录」，不把处理状态终结推断成已结单，也不只在结单后出现；
 * - 就绪内容顺序：申请事实 → 故障描述/补充说明 → 原始报修/AI 分析 →
 *   结构化维修记录 → 旧维修历史（只读，仅有旧过程时出现）→
 *   客户可见回复（含追加回复表单）→ 接单 → 结单专区 → 返回入口；
 *   页面最底部为接单工程师可见的「版本与修订历史」；
 * - 操作可见性由「后端视角状态 + 会话单值业务角色」共同精确控制（三态 + 角色）：
 *   AVAILABLE + 精确 ENGINEER → 接单；MINE + 精确 ENGINEER → 回复；
 *   TAKEN_BY_OTHER → 只读；SUPER_ADMIN（非精确工程师写身份）→ 只读；
 *   视角状态缺失（防腐兜底，正常不可达）→ 失败关闭只读，不出现任何写入口；
 *   接单前 Popconfirm 确认，进行中按钮 loading，application 层 ref 锁兜底
 *   防止并行 Mutation；
 * - 接单成功后详情由 Mutation 返回值原子更新（不切骨架屏，不闪现），
 *   页面以 Alert 明确展示已由当前工程师接单；
 * - 接单反馈（已由本人接单 / 申请已被接单 / 其他失败）用内联 Alert，
 *   与既有反馈先例一致，不引入全局 toast；
 * - 接单冲突/结果不确定后由 application 重查详情：
 *   重查结果带出真实接单工程师与接单时间，不做乐观伪造；
 *   冲突反馈优先于通用不可访问反馈，避免掩盖冲突事实；
 * - 回复区域（MINE + 精确 ENGINEER 时展示）：正文 TextArea、PENDING/RESOLVED
 *   状态选择与提交按钮；未接单/他人接单时不提供回复入口；
 *   提交中（含收敛重查中）禁用输入控件并 loading，连点由 application 锁兜底；
 *   成功（含不确定结果收敛成功）后清空草稿并重置状态选择，
 *   失败/不确定未收敛时草稿保留，用户无需重新输入；
 *   不确定结果的收敛重查是静默重查（不切骨架屏、表单不卸载），
 *   反馈中的「重新加载详情」入口也走静默重查，避免草稿丢失；
 *   回复时间线与最新处理状态全部由 application 原子更新，UI 不维护回复数组；
 * - 回复反馈（成功 / 未接单 / 不可访问 / 无权限 / 输入非法 / 系统失败 /
 *   结果不确定）用内联 Alert，结果不确定时附重新加载入口，
 *   不引入全局 toast；
 * - 统一不可访问反馈引导返回工程师列表，不泄露申请归属；
 * - 就绪状态渲染一张主申请 DataCard；结构化维修记录是唯一的维修录入入口，
 *   旧内部维修过程只以只读历史展示（有 processEntries 才出现），客户可见回复保持独立；
 *   页面最底部追加只读版本历史卡片；
 * - 维修记录草稿门禁：维修记录分区上报「未保存变更 / 写入未落定」，
 *   结单区在打开确认与最终提交前拦截，保留输入且不发出结单请求；
 * - 详情就绪后始终提供「返回维修申请列表」入口（与接单状态、查看者角色无关），
 *   且固定前往列表路径，保证从地址栏直达详情页也能稳定返回；该入口固定在主卡片底部；
 * - 附件不属于维修申请功能：不渲染附件区域，也不渲染「暂无附件」类占位；
 * - 本仓库无 markdown 渲染依赖，contentMd 按保留换行的纯文本展示；
 * - 故障描述、补充说明、回复正文与只读/空态提示统一取应用正文基准 text-sm
 *   （裸 div 不写字号会落到浏览器默认 16px，与同页 14px 正文层级不一致）。
 */

import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { Alert, Button, Descriptions, Form, Input, Popconfirm, Select, Timeline } from 'antd';
import { useNavigate } from 'react-router';

import { type MessageKey, useI18n } from '@/shared/i18n';
import { DataCard } from '@/shared/ui/data-card';
import { ErrorState } from '@/shared/ui/error-state';
import { formatDateTimeText } from '@/shared/ui/format-date-time';
import { LoadingState } from '@/shared/ui/loading-state';
import {
  type RepairHandlingResultValue,
  type RepairHandlingStatusValue,
  resolveRepairClosureState,
} from '@/shared/ui/repair-request-status-labels';

import { isEngineerResponseTextOverCapacity } from '../application/engineer-response-text-capacity';
import {
  MAINTENANCE_DRAFT_GUARD_IDLE,
  type MaintenanceDraftGuardState,
} from '../application/repair-request-closure-draft-guard';
import { isEngineerRepairRequestEnded } from '../application/repair-request-ended';
import { useEngineerRepairRequestDetailFlow } from '../application/use-engineer-repair-request-detail-flow';
import type {
  AcceptRepairRequestResult,
  CreateEngineerResponseInput,
  CreateEngineerResponseResult,
  EngineerResolutionStatusValue,
} from '../infrastructure/engineer-repair-request.types';
import { RESOLUTION_STATUS_LABELS } from '../infrastructure/repair-request-read.types';

import {
  EngineerRepairAiAnalysisSection,
  EngineerRepairIntakeSection,
} from './engineer-repair-intake-analysis-section';
import { EngineerRepairLegacyProcessSection } from './engineer-repair-legacy-process-section';
import { EngineerRepairMaintenanceSection } from './engineer-repair-maintenance-section';
import { EngineerRepairCloseSection } from './engineer-repair-process-section';
import { ENGINEER_REPAIR_REQUEST_LIST_PATH } from './engineer-repair-request-paths';
import { EngineerRepairVersionHistory } from './engineer-repair-version-history';
import { AcceptanceViewStatusTag, ResolutionTag } from './repair-request-status-tags';

/** 结单/处理枚举 → 词条键：展示文案随界面语言切换，不复制第二套全称 */
const HANDLING_RESULT_LABEL_KEYS: Record<RepairHandlingResultValue, MessageKey> = {
  FIXED: 'status.handlingResult.FIXED',
  PART_PURCHASED: 'status.handlingResult.PART_PURCHASED',
  PROVIDE_PLAN_SELF_EXECUTE: 'status.handlingResult.PROVIDE_PLAN_SELF_EXECUTE',
  INTERRUPTED: 'status.handlingResult.INTERRUPTED',
  UNREPAIRABLE: 'status.handlingResult.UNREPAIRABLE',
};

const HANDLING_STATUS_LABEL_KEYS: Record<RepairHandlingStatusValue, MessageKey> = {
  IN_PROGRESS: 'status.handlingStatus.IN_PROGRESS',
  COMPLETED: 'status.handlingStatus.COMPLETED',
  UNRESOLVED: 'status.handlingStatus.UNRESOLVED',
};

function AcceptFeedbackAlert({ result }: { result: AcceptRepairRequestResult | null }) {
  const { t } = useI18n();

  if (!result) {
    return null;
  }

  if (result.ok) {
    return <Alert showIcon title={t('engineerDetail.acceptSuccess')} type="success" />;
  }

  if (result.reason === 'already-accepted') {
    return <Alert showIcon title={result.message} type="warning" />;
  }

  return <Alert showIcon title={result.message} type="error" />;
}

/**
 * 回复反馈（内联 Alert，与接单反馈先例一致）。
 * response-failed 是结果不确定态：Mutation 可能已在服务端生效，
 * 除展示后端失败文案外，附重新加载入口引导用户检查回复时间线，
 * 绝不自动重发 Mutation。
 * reloading 为真表示收敛重查进行中：入口按钮禁用，
 * 避免自动静默重查期间叠加并行手动重查。
 */
function CreateResponseFeedbackAlert({
  result,
  onReload,
  reloading,
}: {
  result: CreateEngineerResponseResult | null;
  onReload: () => void;
  reloading: boolean;
}) {
  const { t } = useI18n();

  if (!result) {
    return null;
  }

  if (result.ok) {
    return <Alert showIcon title={t('engineerDetail.replySuccess')} type="success" />;
  }

  if (result.reason === 'not-accepted') {
    return <Alert showIcon title={result.message} type="warning" />;
  }

  if (result.reason === 'response-failed') {
    return (
      <Alert
        action={
          <Button disabled={reloading} onClick={onReload} size="small">
            {t('engineerDetail.reloadDetail')}
          </Button>
        }
        description={t('engineerDetail.replyUncertain')}
        showIcon
        title={result.message}
        type="error"
      />
    );
  }

  return <Alert showIcon title={result.message} type="error" />;
}

type EngineerResponseFormValues = {
  responseText: string;
  resolutionStatus: EngineerResolutionStatusValue;
};

/**
 * 回复表单（纯 UI 草稿，表单状态留在 ui 层，遵循 stable-clean 草稿归属规则）。
 *
 * - 正文/状态只做必填交互校验；空白语义与状态值域仍由后端收敛，
 *   UI 不自行虚构长度上限与默认状态以外的语义；
 * - PENDING 仅作为 UI 初始选择，提交始终显式传值，不依赖后端默认值；
 * - submitting 为真表示「提交中或不确定结果收敛重查中」，
 *   期间禁用输入控件并 loading，保证表单不卸载、无重复提交窗口；
 * - 成功（含不确定结果收敛成功）后清空草稿并重置状态选择为初始值；
 *   失败/不确定未收敛时草稿保留，用户无需重新输入。
 */
function EngineerResponseForm({
  requestId,
  submitting,
  lastResult,
  onSubmit,
  onReload,
}: {
  requestId: number;
  submitting: boolean;
  lastResult: CreateEngineerResponseResult | null;
  onSubmit: (input: CreateEngineerResponseInput) => void;
  onReload: () => void;
}) {
  const { t } = useI18n();
  const [form] = Form.useForm<EngineerResponseFormValues>();
  const resolutionStatusOptions = (
    Object.keys(RESOLUTION_STATUS_LABELS) as EngineerResolutionStatusValue[]
  ).map((value) => ({ value, label: t(`status.resolution.${value}`) }));

  useEffect(() => {
    if (lastResult?.ok) {
      form.resetFields();
    }
  }, [form, lastResult]);

  return (
    <Form
      form={form}
      initialValues={{ resolutionStatus: 'PENDING' }}
      layout="vertical"
      onFinish={(values) =>
        onSubmit({
          requestId,
          resolutionStatus: values.resolutionStatus,
          responseText: values.responseText,
        })
      }
    >
      {lastResult !== null && (
        <div className="mb-4">
          {/* submitting 含收敛重查中（面板传 submitting || reconciling），
              自动静默重查期间禁用手动重查入口，不叠加并行请求 */}
          <CreateResponseFeedbackAlert
            onReload={onReload}
            reloading={submitting}
            result={lastResult}
          />
        </div>
      )}
      <Form.Item
        label={t('engineerDetail.responseLabel')}
        name="responseText"
        rules={[
          { message: t('engineerDetail.responseRequired'), required: true, whitespace: true },
          {
            // 容量策略来自 application（UI 不复制 TextEncoder 实现）：
            // 超出 MySQL TEXT 的 UTF-8 字节容量时提交前拦截，不发 Mutation、草稿保留。
            validator: (_rule, value: string) =>
              !value || !isEngineerResponseTextOverCapacity(value)
                ? Promise.resolve()
                : Promise.reject(new Error(t('engineerDetail.responseTooLong'))),
          },
        ]}
      >
        <Input.TextArea
          disabled={submitting}
          placeholder={t('engineerDetail.responsePlaceholder')}
          rows={4}
        />
      </Form.Item>
      <Form.Item
        label={t('engineerDetail.resolutionStatus')}
        name="resolutionStatus"
        rules={[{ required: true, message: t('engineerDetail.resolutionRequired') }]}
      >
        <Select disabled={submitting} options={resolutionStatusOptions} />
      </Form.Item>
      <Button htmlType="submit" loading={submitting} type="primary">
        {t('engineerDetail.submitReply')}
      </Button>
    </Form>
  );
}

/**
 * 卡片内分区（负责人单卡片计划 P1）：细分隔线 + 小标题 + 统一间距，
 * 让故障描述 / 补充说明 / 回复时间线 / 操作区收进同一张申请卡片后仍保留层次。
 * 正文基准仍取应用 text-sm（与故障描述、回复正文、只读提示同口径）；
 * 只负责视觉分区，不承载任何权限或数据判断。
 */
function PanelSection({ children, title }: { children: ReactNode; title: string }) {
  return (
    <section className="mt-5 border-t border-border pt-4">
      <h4 className="mb-3 font-medium text-sm">{title}</h4>
      {children}
    </section>
  );
}

/**
 * canHandleAsEngineer 由页面层基于会话单值业务角色判定（读权限继承不等于写权限：
 * 非精确 ENGINEER 可查看详情但不可接单/回复），面板只消费布尔结果，
 * 不自行读取会话或维护第二份角色状态。
 * 接单与回复共用同一精确 ENGINEER 写身份，本布尔同时控制两个提交入口。
 */
export function EngineerRepairRequestDetailPanel({
  requestId,
  canHandleAsEngineer,
  scopeKey,
}: {
  requestId: number | null;
  canHandleAsEngineer: boolean;
  scopeKey?: string;
}) {
  const navigate = useNavigate();
  const scopeKeyValue = scopeKey ?? 'default';
  const { t } = useI18n();
  const {
    state,
    accepting,
    lastAcceptResult,
    accept,
    submitting,
    reconciling,
    lastCreateResponseResult,
    createResponse,
    canWriteRequest,
    reload,
    confirmResponseResult,
    closureBarrier,
    markClosureSucceeded,
    markClosureReadbackSucceeded,
  } = useEngineerRepairRequestDetailFlow(requestId, scopeKeyValue);

  /**
   * 维修记录草稿门禁：维修记录分区上报「未保存变更 / 写入未落定」，
   * 结单区据此在打开确认与发请求前拦截。
   * 状态随身携带作用域键：换工单/换会话后旧实例的上报不再被信任（失败关闭为「可结单」，
   * 因为新工单的维修记录分区会立即上报自己的真实状态）。
   */
  const draftScopeKey = `${String(requestId)}:${scopeKeyValue}`;
  const [maintenanceDraft, setMaintenanceDraft] = useState<{
    scopeKey: string;
    state: MaintenanceDraftGuardState;
  }>({ scopeKey: draftScopeKey, state: MAINTENANCE_DRAFT_GUARD_IDLE });
  const handleMaintenanceDraftGuardChange = useCallback(
    (next: MaintenanceDraftGuardState) => {
      setMaintenanceDraft((previous) =>
        previous.scopeKey === draftScopeKey &&
        previous.state.hasUnsavedChanges === next.hasUnsavedChanges &&
        previous.state.writePending === next.writePending
          ? previous
          : { scopeKey: draftScopeKey, state: next },
      );
    },
    [draftScopeKey],
  );
  const maintenanceDraftState =
    maintenanceDraft.scopeKey === draftScopeKey
      ? maintenanceDraft.state
      : MAINTENANCE_DRAFT_GUARD_IDLE;

  if (state.status === 'loading') {
    return (
      <DataCard>
        <LoadingState label={t('engineerDetail.loading')} />
      </DataCard>
    );
  }

  if (state.status === 'failed') {
    return (
      <DataCard>
        <div className="flex flex-col gap-4">
          {/*
           * 接单反馈优先于不可访问/加载失败反馈：接单冲突后重查可能落入
           * not-accessible（申请已被接走，当前工程师不再可读），
           * 若只展示通用文案，用户无法得知申请已被接单。
           */}
          <AcceptFeedbackAlert result={lastAcceptResult} />

          {state.reason === 'not-accessible' ? (
            <ErrorState
              action={
                <Button onClick={() => navigate(ENGINEER_REPAIR_REQUEST_LIST_PATH)} type="primary">
                  {t('engineerDetail.backToList')}
                </Button>
              }
              title={state.message}
            />
          ) : (
            <ErrorState
              action={
                <Button onClick={() => void reload()} size="small">
                  {t('common.retry')}
                </Button>
              }
              title={state.message}
            />
          )}
        </div>
      </DataCard>
    );
  }

  const detail = state.detail;
  const viewStatus = detail.acceptanceViewStatus;
  // 结单或处理终结后，内部过程与回复统一只读（结单与回复互相独立，但都受同一结束边界约束）
  const isClosed = isEngineerRepairRequestEnded(detail);
  // 结单 mutation 已明确成功但回读未确认时，本地屏障先于服务端详情接管只读；
  // 只有回读被采用且确认已结束时屏障才撤销，再由服务端结束事实继续控制只读。
  const writeBlocked = isClosed || closureBarrier;
  const showInternalProcess = viewStatus === 'MINE';
  // 操作可见性 = 后端视角状态（事实）× 会话单值业务角色（写身份），失败关闭：
  // 视角缺失或 TAKEN_BY_OTHER 一律只读；AVAILABLE/MINE 还需精确 ENGINEER 才出现写入口
  const canAccept = viewStatus === 'AVAILABLE' && canHandleAsEngineer;
  const canReply = viewStatus === 'MINE' && canHandleAsEngineer && !writeBlocked;
  const readOnlyHint =
    viewStatus === 'MINE' && writeBlocked
      ? '工单已结单，内部维修过程与回复均为只读。'
      : !canAccept && !canReply
        ? !canHandleAsEngineer
          ? t('engineerDetail.readOnlyEngineer')
          : viewStatus === 'TAKEN_BY_OTHER'
            ? t('engineerDetail.readOnlyTaken')
            : viewStatus === null
              ? t('engineerDetail.readOnlyUnknown')
              : null
        : null;

  // 结单展示由 closureStatus + closedAt 联合判定（处理状态终结不得推断为已结单）；
  // 结单 Mutation 已成功但回读未确认时，用「待刷新确认」表达本地屏障，不编造结单时间/原因。
  // 字段缺失、非法时间或状态与时间矛盾不得写成「已结单」或「未结单」，按不可确认展示。
  // 只读屏障仍由 isEngineerRepairRequestEnded 按服务端结束事实控制，不随展示判定放宽。
  const closureState = resolveRepairClosureState(detail.closureStatus, detail.closedAt);
  const closureStatusText =
    closureState === 'CLOSED'
      ? t('engineerDetail.closureStatus.CLOSED')
      : closureBarrier
        ? t('engineerDetail.closureStatus.PENDING_CONFIRM')
        : closureState === 'OPEN'
          ? t('engineerDetail.closureStatus.OPEN')
          : t('engineerDetail.closureStatus.UNKNOWN');
  const handlingResultText = detail.handlingResult
    ? t(HANDLING_RESULT_LABEL_KEYS[detail.handlingResult])
    : t('engineerDetail.notRecorded');
  const handlingStatusText = detail.handlingStatus
    ? t(HANDLING_STATUS_LABEL_KEYS[detail.handlingStatus])
    : t('engineerDetail.notRecorded');

  return (
    <div className="flex flex-col gap-4">
      <DataCard title={t('engineerDetail.infoCard')}>
        <Descriptions
          bordered
          column={{ lg: 2, md: 1, sm: 1, xs: 1 }}
          items={[
            { children: detail.requestNo, key: 'requestNo', label: t('engineerDetail.requestNo') },
            {
              children: detail.customerNickname ?? '—',
              key: 'customerNickname',
              label: t('engineerDetail.customerNickname'),
            },
            {
              children: detail.customerCompanyName ?? '—',
              key: 'customerCompanyName',
              label: t('engineerDetail.customerCompany'),
            },
            {
              children: `${detail.equipmentModel.modelName}（${detail.equipmentModel.modelCode}）`,
              key: 'equipmentModel',
              label: t('engineerDetail.model'),
            },
            { children: detail.errorCode, key: 'errorCode', label: t('engineerDetail.errorCode') },
            {
              children: formatDateTimeText(detail.createdAt),
              key: 'createdAt',
              label: t('engineerDetail.submittedAt'),
            },
            {
              children: <AcceptanceViewStatusTag viewStatus={viewStatus} />,
              key: 'acceptanceViewStatus',
              label: t('engineerDetail.acceptanceStatus'),
            },
            {
              children: detail.acceptedEngineerNickname ?? '—',
              key: 'acceptedEngineerNickname',
              label: t('engineerDetail.acceptedEngineer'),
            },
            {
              children: detail.acceptedAt ? formatDateTimeText(detail.acceptedAt) : '—',
              key: 'acceptedAt',
              label: t('engineerDetail.acceptedAt'),
            },
            {
              children: <ResolutionTag status={detail.latestResolutionStatus} />,
              key: 'latestResolutionStatus',
              label: t('engineerDetail.latestResolution'),
            },
            {
              children: closureStatusText,
              key: 'closureStatus',
              label: t('engineerDetail.closureStatusLabel'),
            },
            {
              children:
                closureState === 'CLOSED' && detail.closedAt
                  ? formatDateTimeText(detail.closedAt)
                  : '—',
              key: 'closedAt',
              label: t('engineerDetail.closedAtLabel'),
            },
            {
              children: closureState === 'CLOSED' ? (detail.closureReason ?? '—') : '—',
              key: 'closureReason',
              label: t('engineerDetail.closureReasonLabel'),
            },
            {
              children: handlingResultText,
              key: 'handlingResult',
              label: t('engineerDetail.handlingResultLabel'),
            },
            {
              children: handlingStatusText,
              key: 'handlingStatus',
              label: t('engineerDetail.handlingStatusLabel'),
            },
          ]}
          size="small"
        />

        <PanelSection title={t('engineerDetail.faultDescription')}>
          <div className="text-sm whitespace-pre-wrap">{detail.faultDescription}</div>
        </PanelSection>

        {detail.contentMd ? (
          <PanelSection title={t('engineerDetail.supplement')}>
            <div className="text-sm whitespace-pre-wrap">{detail.contentMd}</div>
          </PanelSection>
        ) : null}

        {/*
         * 分区顺序（任务 04 本轮调整）：客户原始报修 → 首次 AI 分析 → 结构化内部维修记录
         * → 旧维修历史（只读）→ 客户可见回复。原始报修与 AI 原文只读，不提供编辑控件；
         * 旧内部维修过程的写入口已移除，只读历史见下方独立区块；
         * 维修记录与旧历史均仅在接单工程师本人视角出现。
         */}
        <EngineerRepairIntakeSection intake={detail.intake ?? null} />
        <EngineerRepairAiAnalysisSection analysis={detail.intake?.analysis ?? null} />

        {showInternalProcess ? (
          <EngineerRepairMaintenanceSection
            canWrite={canReply && !writeBlocked && (detail.canEditMaintenance ?? false)}
            detail={detail}
            key={`maintenance:${scopeKeyValue}:${detail.id}`}
            onDraftGuardChange={handleMaintenanceDraftGuardChange}
            readOnly={writeBlocked || !(detail.canEditMaintenance ?? false)}
            reload={reload}
            requestId={detail.id}
            scopeKey={scopeKeyValue}
            writeEligible={canWriteRequest}
          />
        ) : null}

        {/*
         * 旧版内部维修过程（repair_process_entry）只保留只读历史：
         * 不重新挂载旧编辑入口，不提供新增/编辑/改绑/删除，仅展示与授权下载。
         * 数据来自详情响应已有的 processEntries（后端只对接单工程师本人返回）。
         */}
        {showInternalProcess && detail.processEntries.length > 0 ? (
          <PanelSection title={t('engineerDetail.legacyProcessTitle')}>
            <EngineerRepairLegacyProcessSection processEntries={detail.processEntries} />
          </PanelSection>
        ) : null}
        <PanelSection title={t('engineerDetail.customerVisibleReplies')}>
          {detail.responses.length > 0 ? (
            <Timeline
              items={detail.responses.map((response) => ({
                children: (
                  <div className="flex flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{response.engineerNickname}</span>
                      <ResolutionTag status={response.resolutionStatus} />
                      <span className="text-text-secondary text-xs">
                        {formatDateTimeText(response.createdAt)}
                      </span>
                    </div>
                    <div className="text-sm whitespace-pre-wrap">{response.responseText}</div>
                  </div>
                ),
                key: response.id,
              }))}
            />
          ) : (
            <div className="text-sm text-text-secondary">{t('engineerDetail.noResponses')}</div>
          )}

          {canReply ? (
            <div className="mt-4 flex flex-col gap-2 border-t border-border pt-4">
              <div className="font-medium text-sm">追加处理回复</div>
              <EngineerResponseForm
                key={`response:${scopeKeyValue}`}
                lastResult={lastCreateResponseResult}
                onReload={() => void confirmResponseResult()}
                onSubmit={(input) => void createResponse(input)}
                requestId={detail.id}
                submitting={submitting || reconciling}
              />
            </div>
          ) : null}
        </PanelSection>

        {canAccept ? (
          <PanelSection title="接单">
            <div className="flex flex-col gap-4">
              <AcceptFeedbackAlert result={lastAcceptResult} />
              <div className="flex flex-col gap-2">
                <div>
                  <Popconfirm
                    cancelText={t('common.cancel')}
                    description={t('engineerDetail.acceptConfirmDescription')}
                    okText={t('engineerDetail.acceptConfirmOk')}
                    onConfirm={() => void accept()}
                    title={t('engineerDetail.acceptConfirmTitle')}
                  >
                    <Button loading={accepting} type="primary">
                      {t('engineerDetail.accept')}
                    </Button>
                  </Popconfirm>
                </div>
                <div className="text-sm text-text-secondary">{t('engineerDetail.replyFirst')}</div>
              </div>
            </div>
          </PanelSection>
        ) : null}

        {/*
         * 只读/操作说明：接单成功后保留接单反馈；
         * 精确 ENGINEER 结单后给出只读原因；非精确工程师写身份提示使用工程师账号。
         */}
        {!canAccept && (lastAcceptResult || readOnlyHint) ? (
          <PanelSection title={t('engineerDetail.handlingNotes')}>
            <div className="flex flex-col gap-3">
              <AcceptFeedbackAlert result={lastAcceptResult} />
              {readOnlyHint ? (
                <div className="text-sm text-text-secondary">{readOnlyHint}</div>
              ) : null}
            </div>
          </PanelSection>
        ) : null}

        {showInternalProcess && canHandleAsEngineer && !isClosed ? (
          <EngineerRepairCloseSection
            canWrite={canHandleAsEngineer}
            closedByMutation={closureBarrier}
            key={`close:${scopeKeyValue}`}
            maintenanceDraft={maintenanceDraftState}
            maintenanceVersionNo={detail.maintenance?.versionNo ?? null}
            onCloseReadbackSucceeded={markClosureReadbackSucceeded}
            onCloseSucceeded={markClosureSucceeded}
            reload={reload}
            requestId={detail.id}
            scopeKey={scopeKeyValue}
            writeEligible={canWriteRequest}
          />
        ) : null}

        {/*
         * 卡片底部常驻返回入口：不依赖接单状态与查看者角色，
         * 固定前往列表路径（不用 navigate(-1)），从地址栏直达详情页也能稳定返回。
         */}
        <div className="mt-5 border-t border-border pt-4">
          <Button onClick={() => navigate(ENGINEER_REPAIR_REQUEST_LIST_PATH)}>
            {t('engineerDetail.backToList')}
          </Button>
        </div>
      </DataCard>

      {/*
       * 页面最底部「版本与修订历史」：只对当前接单工程师展示；
       * 仅调用工程师侧只读查询，失败不影响上方工单详情与当前维修记录。
       */}
      {showInternalProcess ? <EngineerRepairVersionHistory requestId={detail.id} /> : null}
    </div>
  );
}
