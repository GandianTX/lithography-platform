// src/features/ai-conversation/ui/ai-part-legend.tsx
// 部件图例（任务 05 · S3）
//
// 只呈现 HIGHLIGHT / WARNING 两种需要关注的部件（NORMAL 无提示、HIDDEN 不绘制）；
// 颜色由 index.css 的语义类提供，组件内不写死色值。

import { useI18n } from '@/shared/i18n';

import { pickAiHighlightedParts } from '../domain/ai-visualization';
import { AI_PART_GEOMETRIES } from '../domain/litho-geometry';
import type { AiPartDisplay } from '../infrastructure/ai-conversation.types';

export type AiPartLegendProps = {
  readonly displays: Record<string, AiPartDisplay>;
  /** 是否为模型标记结果（false 表示只是阶段参考图） */
  readonly fromModel: boolean;
};

function findLabelKey(partId: string) {
  return AI_PART_GEOMETRIES.find((part) => part.partId === partId)?.labelKey ?? null;
}

export function AiPartLegend({ displays, fromModel }: AiPartLegendProps) {
  const { t } = useI18n();
  const parts = pickAiHighlightedParts(displays);
  if (parts.length === 0) {
    return null;
  }

  return (
    <ul
      aria-label={t('ai.legend.label')}
      className="ai-part-legend m-0 list-none p-0"
    >
      <li className="text-xs text-text-secondary">
        {fromModel ? t('ai.legend.aiHighlights') : t('ai.legend.relatedParts')}
      </li>
      {parts.map((part) => {
        const labelKey = findLabelKey(part.partId);
        const label = labelKey === null ? part.partId : t(labelKey);
        return (
          <li
            className={
              part.display === 'WARNING'
                ? 'ai-part-chip ai-part-chip--warning'
                : 'ai-part-chip'
            }
            key={part.partId}
          >
            {part.display === 'WARNING'
              ? t('ai.legend.attention', { name: label })
              : label}
          </li>
        );
      })}
    </ul>
  );
}
