// src/pages/engineer-ai/index.tsx

import { useEffect, useMemo } from 'react';
import { Alert, Select, Tag } from 'antd';
import { Link, useSearchParams } from 'react-router';

import {
  AI_STAGE_DEFINITIONS,
  AiConversationPanel,
  AiPartLegend,
  LithoWorkflowCanvas,
  pickAiFaultFocusPart,
  resolveAiPartDisplays,
  useAiDiagnosisWorkspace,
} from '@/features/ai-conversation';
import { useEngineerWorkOrderOptions } from '@/features/repair-request';

import { useI18n } from '@/shared/i18n';

export function EngineerAiPage() {
  const { t } = useI18n();
  const workspace = useAiDiagnosisWorkspace();
  const workOrders = useEngineerWorkOrderOptions();
  const [searchParams, setSearchParams] = useSearchParams();

  // 问答记录 →「查看对话」以 ?conversation=<id> 进入；同一页面内可变
  const requestedConversationId = Number(searchParams.get('conversation') ?? '');
  const { selectConversation } = workspace;
  useEffect(() => {
    if (!Number.isInteger(requestedConversationId) || requestedConversationId <= 0) {
      return;
    }
    // 不在外部做「只选一次」的记忆：开发态一次挂载会跑两遍 effect，
    // 首轮请求会被卸载清理作废，必须让第二遍重新发起才能落到真实选中态。
    void selectConversation(requestedConversationId);
  }, [requestedConversationId, selectConversation]);

  const displays = useMemo(
    () =>
      resolveAiPartDisplays({
        visualization: workspace.visualization,
        fallbackStage: workspace.stage,
      }),
    [workspace.stage, workspace.visualization],
  );

  // S3：主故障目标按服务端返回顺序取第一个 WARNING（其余 WARNING 仍留在图例）
  const focusPartId = useMemo(
    () => pickAiFaultFocusPart(workspace.visualization),
    [workspace.visualization],
  );

  // S3：故障短卡只放可展示的简短描述，详情仍在对话正文里
  const faultDescription = useMemo(() => {
    const turns = workspace.conversation?.turns ?? [];
    const active =
      turns.find((turn) => turn.questionUuid === workspace.activeQuestionUuid) ??
      turns[turns.length - 1];
    const text = active?.answer?.text ?? null;
    if (text === null) {
      return null;
    }
    // 短卡只放简短摘要（详情仍在对话正文里）
    return text.length > 80 ? `${text.slice(0, 80)}…` : text;
  }, [workspace.activeQuestionUuid, workspace.conversation]);

  // S3：动效身份 = 轮次 + 部件；换轮或换部件必须重启动效
  const faultIdentity = useMemo(
    () =>
      focusPartId === null ? null : `${workspace.activeQuestionUuid ?? 'none'}:${focusPartId}`,
    [focusPartId, workspace.activeQuestionUuid],
  );

  const stageOptions = useMemo(
    () => [
      { label: t('ai.stage.all'), value: '' },
      ...AI_STAGE_DEFINITIONS.map((stage) => ({
        label: `${stage.stage} · ${t(stage.section === 'UPPER' ? 'ai.stage.upper' : 'ai.stage.lower')} · ${t(stage.labelKey)}`,
        value: String(stage.stage),
      })),
    ],
    [t],
  );

  const workOrderOptions = useMemo(
    () => workOrders.options.map((option) => ({ id: option.id, label: option.label })),
    [workOrders.options],
  );

  return (
    <div className="ai-shell ai-shell--workspace">
      {/* 任务局部顶栏：AI 对话 / 问答记录，两页都可直接访问、各自呈现当前态 */}
      <header className="ai-shell-header">
        <h1 className="ai-shell-title">{t('ai.shell.title')}</h1>
        <nav aria-label={t('ai.shell.navLabel')} className="ai-shell-nav">
          <Link aria-current="page" className="ai-shell-tab" to="/engineer/ai">
            {t('ai.shell.navChat')}
          </Link>
          <Link className="ai-shell-tab" to="/engineer/ai/history">
            {t('ai.shell.navHistory')}
          </Link>
        </nav>
      </header>

      <div className="ai-workspace">
        <div className="ai-workspace-grid">
          <section aria-label={t('ai.scene.label')} className="ai-scene">
            {/* V44：场景头部承载流程标题与维修阶段选择（不是页面级工具条） */}
            <header className="ai-scene-header">
              <div>
                <h2 className="m-0 text-sm font-semibold text-text-primary">
                  {t('ai.scene.label')}
                </h2>
              </div>
              {workspace.visualization?.stage != null ? (
                <span className="ai-scene-stage-tag">
                  <Tag>
                    {t('ai.scene.resultStage', { stage: String(workspace.visualization.stage) })}
                  </Tag>
                </span>
              ) : null}
              <label className="ai-scene-stage">
                <span>{t('ai.page.stageLabel')}</span>
                <Select
                  onChange={(value: string) =>
                    workspace.setStage(value === '' ? null : Number(value))
                  }
                  options={stageOptions}
                  size="small"
                  value={workspace.stage === null ? '' : String(workspace.stage)}
                />
              </label>
            </header>
            <div className="ai-scene-canvas">
              <LithoWorkflowCanvas
                ariaLabel={t('ai.scene.canvasLabel')}
                displays={displays}
                faultDescription={faultDescription}
                faultIdentity={faultIdentity}
                focusPartId={focusPartId}
                gestureHint={t('ai.scene.gestureHint')}
              />
            </div>
            <div className="ai-scene-footer">
              <AiPartLegend displays={displays} fromModel={workspace.visualization !== null} />
              {workspace.visualizationDegraded ? (
                <div className="mt-2">
                  <Alert message={t('ai.scene.degradedHint')} showIcon type="warning" />
                </div>
              ) : null}
            </div>
          </section>

          <AiConversationPanel
            activeQuestionUuid={workspace.activeQuestionUuid}
            canExportPdf={workspace.conversation !== null}
            conversation={workspace.conversation}
            creating={workspace.creating}
            draft={workspace.draft}
            errorMessage={workspace.errorMessage}
            exporting={workspace.exporting}
            generating={workspace.generating}
            noticeMessage={workspace.noticeMessage}
            onDraftChange={workspace.setDraft}
            onExportPdf={() => void workspace.exportConversationPdf()}
            onLoadMoreWorkOrders={workOrders.loadMore}
            onNewChat={() => {
              // S1：新建只回空草稿，不创建空会话、不继承上一段工单
              if (searchParams.has('conversation')) {
                setSearchParams({}, { replace: true });
              }
              workspace.startNewDraft();
            }}
            onRefreshTurn={() => void workspace.refreshCurrentTurn()}
            onReloadWorkOrders={workOrders.reload}
            onRetryTurn={(questionUuid) => void workspace.retryTurn(questionUuid)}
            onSubmit={() => void workspace.submitQuestion(workspace.draft)}
            onWorkOrderChange={workspace.setDraftRequestId}
            retrying={workspace.retrying}
            submitting={workspace.submitting}
            workOrderId={workspace.draftRequestId}
            workOrderMessage={workOrders.message}
            workOrderStatus={workOrders.status}
            workOrders={workOrderOptions}
          />
        </div>
      </div>
    </div>
  );
}

export { EngineerAiHistoryPage } from './history';
