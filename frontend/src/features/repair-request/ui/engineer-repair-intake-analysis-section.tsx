// src/features/repair-request/ui/engineer-repair-intake-analysis-section.tsx

/**
 * 客户原始报修 / 首次 AI 分析只读分区（任务 04）。
 *
 * - 展示 intake 原始故障描述、客户原件（授权下载）与首次 AI 分析结果；
 * - AI 原文仅只读展示，不提供编辑、重跑或覆盖入口；
 * - 原件下载失败内联提示，不引入全局 toast。
 */

import { useState } from 'react';
import { Alert, Button, Tag } from 'antd';

import { type MessageKey, useI18n } from '@/shared/i18n';
import { triggerBrowserDownload } from '@/shared/ui/download-blob';
import { formatDateTimeText } from '@/shared/ui/format-date-time';

import { useRepairOriginalDownload } from '../application/use-repair-original-download';
import type {
  EngineerRepairIntake,
  EngineerRepairIntakeAnalysis,
} from '../infrastructure/engineer-repair-request.types';

const AI_STATUS_LABEL_KEYS: Record<string, MessageKey> = {
  RUNNING: 'engineerDetail.aiStatus.RUNNING',
  SUCCEEDED: 'engineerDetail.aiStatus.SUCCEEDED',
  FAILED: 'engineerDetail.aiStatus.FAILED',
};

const AI_STATUS_TONES: Record<string, 'processing' | 'success' | 'error'> = {
  RUNNING: 'processing',
  SUCCEEDED: 'success',
  FAILED: 'error',
};

function SectionTitle({ children }: { children: string }) {
  return <h4 className="mb-3 font-medium text-sm">{children}</h4>;
}

export function EngineerRepairIntakeSection({ intake }: { intake: EngineerRepairIntake | null }) {
  const { t } = useI18n();
  const { downloadingFileId, error, download, clearError } = useRepairOriginalDownload();
  const [localError, setLocalError] = useState<string | null>(null);

  const handleDownload = async (fileId: string) => {
    setLocalError(null);
    clearError();
    try {
      const result = await download(fileId);
      if (result?.ok) {
        triggerBrowserDownload(result.blob, result.filename);
      }
    } catch {
      setLocalError(t('engineerDetail.downloadFailed'));
    }
  };

  return (
    <section className="mt-5 border-t border-border pt-4">
      <SectionTitle>{t('engineerDetail.intakeSection')}</SectionTitle>
      {intake === null ? (
        <div className="text-sm text-text-secondary">{t('engineerDetail.intakeEmpty')}</div>
      ) : (
        <div className="flex flex-col gap-3">
          <div>
            <div className="text-text-secondary text-xs">
              {t('engineerDetail.intakeOriginalFault')}
            </div>
            <div className="text-sm whitespace-pre-wrap">
              {intake.faultDescription ?? t('engineerDetail.intakeNoDescription')}
            </div>
          </div>
          <div>
            <div className="text-text-secondary text-xs">
              {t('engineerDetail.intakeCustomerFile')}
            </div>
            {intake.customerFile ? (
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <span className="text-sm">{intake.customerFile.originalFilename}</span>
                <span className="text-text-secondary text-xs">
                  {intake.customerFile.byteSize} B
                </span>
                <Button
                  loading={downloadingFileId === intake.customerFile.fileId}
                  onClick={() => void handleDownload(intake.customerFile!.fileId)}
                  size="small"
                >
                  {t('maintenance.attachmentDownload')}
                </Button>
              </div>
            ) : (
              <div className="text-sm text-text-secondary">{t('engineerDetail.intakeNoFile')}</div>
            )}
          </div>
          {(error ?? localError) ? (
            <Alert showIcon title={error ?? localError ?? ''} type="error" />
          ) : null}
        </div>
      )}
    </section>
  );
}

export function EngineerRepairAiAnalysisSection({
  analysis,
}: {
  analysis: EngineerRepairIntakeAnalysis | null;
}) {
  const { t } = useI18n();

  return (
    <section className="mt-5 border-t border-border pt-4">
      <SectionTitle>{t('engineerDetail.aiSection')}</SectionTitle>
      {analysis === null ? (
        <div className="text-sm text-text-secondary">{t('engineerDetail.aiEmpty')}</div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <div className="flex items-center gap-2">
              <span className="text-text-secondary text-xs">{t('engineerDetail.aiStatus')}</span>
              {AI_STATUS_LABEL_KEYS[analysis.status] ? (
                <Tag color={AI_STATUS_TONES[analysis.status] ?? 'default'}>
                  {t(AI_STATUS_LABEL_KEYS[analysis.status])}
                </Tag>
              ) : (
                <Tag>{analysis.status}</Tag>
              )}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-text-secondary text-xs">
                {t('engineerDetail.aiGeneration')}
              </span>
              <span>
                {t('engineerDetail.aiGenerationValue', { generation: analysis.generation })}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-text-secondary text-xs">
                {t('engineerDetail.aiFinishedAt')}
              </span>
              <span>{analysis.finishedAt ? formatDateTimeText(analysis.finishedAt) : '—'}</span>
            </div>
          </div>
          {analysis.failureReason ? (
            <div>
              <div className="text-text-secondary text-xs">{t('engineerDetail.aiFailure')}</div>
              <div className="text-sm whitespace-pre-wrap">{analysis.failureReason}</div>
            </div>
          ) : null}
          <div>
            <div className="text-text-secondary text-xs">{t('engineerDetail.aiOutput')}</div>
            <div className="text-sm whitespace-pre-wrap">
              {analysis.outputText ?? t('engineerDetail.aiNoOutput')}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
