// src/pages/engineer-ai/index.tsx

import { useEffect, useMemo } from 'react';
import { Alert, Modal, Select } from 'antd';
import { Link, useBeforeUnload, useBlocker, useSearchParams } from 'react-router';

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
  // 创建在途或结果未知时，卸载会丢失草稿和防重状态。所有站内导航共用此守卫。
  const guardNavigation = workspace.creating || workspace.createUnknown;
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      guardNavigation &&
      (currentLocation.pathname !== nextLocation.pathname ||
        currentLocation.search !== nextLocation.search ||
        currentLocation.hash !== nextLocation.hash),
  );
  useBeforeUnload((event) => {
    if (guardNavigation) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
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

  // V44 原型：场景标题优先显示真实机型（取关联工单的机型），无关联工单时用通用机型标题
  const sceneModelName = useMemo(() => {
    const selectedId = workspace.conversation?.requestId ?? workspace.draftRequestId;
    const matched = workOrders.options.find((option) => option.id === selectedId);
    return matched?.modelName ?? '';
  }, [workspace.conversation?.requestId, workspace.draftRequestId, workOrders.options]);

  return (
    <div className="ai-shell ai-shell--workspace">
      <Modal
        cancelText={t('ai.panel.navigationStay')}
        okText={t('ai.panel.navigationLeave')}
        onCancel={() => blocker.reset?.()}
        onOk={() => blocker.proceed?.()}
        open={blocker.state === 'blocked'}
        title={t('ai.panel.navigationTitle')}
      >
        <p>{t('ai.panel.navigationBody')}</p>
      </Modal>
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
                {/* V44 原型 .ai36-model-header：机型作大标题，流程示意作副标题 */}
                <h2 className="ai-scene-title">
                  {sceneModelName.length > 0 ? sceneModelName : t('ai.scene.modelFallback')}
                </h2>
                <p className="ai-scene-subtitle">{t('ai.scene.label')}</p>
              </div>
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
              />
            </div>
            <div className="ai-scene-footer">
              <AiPartLegend
                displays={displays}
                fromModel={workspace.visualization !== null}
                resultStage={workspace.visualization?.stage ?? null}
              />
              {workspace.visualizationDegraded ? (
                <div className="ai-scene-degraded">
                  <Alert message={t('ai.scene.degradedHint')} showIcon type="warning" />
                </div>
              ) : null}
              {/* V44 原型：手势提示在场景底部右侧（#ai36-gesture） */}
              <p className="ai-scene-gesture" id="ai-geo-gesture">
                {t('ai.scene.gestureHint')}
              </p>
            </div>
          </section>

          <AiConversationPanel
            activeQuestionUuid={workspace.activeQuestionUuid}
            canExportPdf={workspace.conversation !== null}
            conversation={workspace.conversation}
            creating={workspace.creating}
            createUnknown={workspace.createUnknown}
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
            // 未知创建结果：只提供显式确认（继续发送 / 放弃本次），确认前不解除阻断
            onAbandonCreate={workspace.abandonUnknownCreate}
            onContinueCreate={workspace.continueAfterUnknownCreate}
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
