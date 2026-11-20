// src/pages/engineer-ai/index.tsx

import { useMemo, useState } from 'react';
import { Alert, Empty, Select } from 'antd';

import {
  AI_STAGE_DEFINITIONS,
  AiConversationPanel,
  AiHistoryDrawer,
  AiPartLegend,
  LithoWorkflowCanvas,
  resolveAiPartDisplays,
  useAiDiagnosisWorkspace,
} from '@/features/ai-conversation';

import { useI18n } from '@/shared/i18n';

export function EngineerAiPage() {
  const { t } = useI18n();
  const workspace = useAiDiagnosisWorkspace();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [linkedRequestId, setLinkedRequestId] = useState<number | null>(null);

  const displays = useMemo(
    () =>
      resolveAiPartDisplays({
        visualization: workspace.visualization,
        fallbackStage: workspace.stage,
      }),
    [workspace.stage, workspace.visualization],
  );

  const focusPartId = useMemo(() => {
    const warning = Object.entries(displays).find(([, display]) => display === 'WARNING');
    return warning === undefined ? null : warning[0];
  }, [displays]);

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

  return (
    <div className="ai-workspace">
      <header className="ai-workspace-header">
        <div>
          <h1 className="m-0 text-lg font-semibold text-text-primary">{t('ai.page.title')}</h1>
          <p className="m-0 text-xs text-text-secondary">{t('ai.page.subtitle')}</p>
        </div>
      </header>

      <div className="ai-workspace-grid">
        <section aria-label={t('ai.scene.label')} className="ai-scene">
          {/* V44：场景头部承载流程标题与维修阶段选择（不是页面级工具条） */}
          <header className="ai-scene-header">
            <div>
              <h2 className="m-0 text-sm font-semibold text-text-primary">{t('ai.scene.label')}</h2>
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
          conversation={workspace.conversation}
          creating={workspace.creating}
          draft={workspace.draft}
          errorMessage={workspace.errorMessage}
          exporting={workspace.exporting}
          generating={workspace.generating}
          linkedRequestId={linkedRequestId}
          noticeMessage={workspace.noticeMessage}
          onDraftChange={workspace.setDraft}
          onExportPdf={() => void workspace.exportConversationPdf()}
          onNewChat={() => {
            // U05：已绑定会话时「新建」表示另起一段，不继承上一段工单；
            // 尚未创建成功时保留用户待选，失败后可直接重试
            const keepSelection = workspace.conversation === null;
            const requestId = keepSelection ? linkedRequestId : null;
            if (!keepSelection) {
              setLinkedRequestId(null);
            }
            void workspace.createConversation(requestId);
          }}
          onOpenHistory={() => setHistoryOpen(true)}
          onRefreshTurn={() => void workspace.refreshCurrentTurn()}
          onRetry={() => void workspace.retryCurrentTurn()}
          onRetryTurn={(questionUuid) => void workspace.retryTurn(questionUuid)}
          onSubmit={() => void workspace.submitQuestion(workspace.draft)}
          onWorkOrderChange={setLinkedRequestId}
          retrying={workspace.retrying}
          retryingQuestionUuid={workspace.retryingQuestionUuid}
          submitting={workspace.submitting}
        />
      </div>

      {workspace.conversation === null && linkedRequestId !== null ? (
        <div className="ai-work-order-hint">
          <Empty description={t('ai.page.linkedHint')} />
        </div>
      ) : null}

      <AiHistoryDrawer
        conversations={workspace.conversations}
        loading={workspace.loading}
        loadingMore={workspace.loadingMore}
        onLoadMore={() => void workspace.loadMoreConversations()}
        onClose={() => setHistoryOpen(false)}
        onSelect={(conversationId) => {
          setHistoryOpen(false);
          setLinkedRequestId(null);
          void workspace.selectConversation(conversationId);
        }}
        open={historyOpen}
        selectedId={workspace.selectedId}
        total={workspace.conversationsTotal}
      />
    </div>
  );
}
