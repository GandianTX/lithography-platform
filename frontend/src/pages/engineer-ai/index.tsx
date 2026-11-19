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
        <label className="flex items-center gap-2 text-xs text-text-secondary">
          <span>{t('ai.page.stageLabel')}</span>
          <div className="w-56">
            <Select
              onChange={(value: string) =>
                workspace.setStage(value === '' ? null : Number(value))
              }
              options={stageOptions}
              value={workspace.stage === null ? '' : String(workspace.stage)}
            />
          </div>
        </label>
      </header>

      <div className="ai-workspace-grid">
        <section aria-label={t('ai.scene.label')} className="ai-scene">
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
          draft={workspace.draft}
          errorMessage={workspace.errorMessage}
          exporting={workspace.exporting}
          generating={workspace.generating}
          linkedRequestId={linkedRequestId}
          noticeMessage={workspace.noticeMessage}
          onDraftChange={workspace.setDraft}
          onExportPdf={() => void workspace.exportConversationPdf()}
          onNewChat={() => {
            const requestId = linkedRequestId;
            setLinkedRequestId(null);
            void workspace.createConversation(requestId);
          }}
          onOpenHistory={() => setHistoryOpen(true)}
          onRetry={() => void workspace.retryCurrentTurn()}
          onSubmit={() => void workspace.submitQuestion(workspace.draft)}
          onWorkOrderChange={setLinkedRequestId}
          retrying={workspace.retrying}
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
        onClose={() => setHistoryOpen(false)}
        onSelect={(conversationId) => {
          setHistoryOpen(false);
          setLinkedRequestId(null);
          void workspace.selectConversation(conversationId);
        }}
        open={historyOpen}
        selectedId={workspace.selectedId}
      />
    </div>
  );
}
