// @vitest-environment jsdom
// src/features/maintenance-report/ui/work-order-summary-ai-section.spec.tsx
//
// 工单总结 AI 评价区块（任务 05 真实会话读侧）：
// - 有候选会话：选择后绑定会话与不可变内容版本；
// - 已保存旧版本：再次选择同一会话仍保留旧版本（追加消息不漂移）；
// - 确认无会话：如实展示，不强制评分；
// - 查询失败：显示「无法确认」并提供重试，不当成无会话；
// - 就绪态上报：loading/failed/confirmedEmpty/ready 逐一上报（核对页据此门禁提交）；
// - 不提供「未使用 AI」强制选项（2026-11-21 需求）；
// - 只读：展示冻结评价，不发起候选查询。

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchAiMock } = vi.hoisted(() => ({ fetchAiMock: vi.fn() }));

vi.mock('../infrastructure/maintenance-report-adapter', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../infrastructure/maintenance-report-adapter')>();
  return { ...actual, fetchWorkOrderSummaryAiConversations: fetchAiMock };
});

import {
  type WorkOrderSummaryAiDraftValue,
  type WorkOrderSummaryAiReadiness,
  WorkOrderSummaryAiSection,
} from './work-order-summary-ai-section';

const CANDIDATE = {
  conversationId: 700001,
  contentVersion: 3,
  lastMessageSeq: 5,
  effectiveReplyCount: 2,
  createdAt: '2026-09-30T00:00:00.000Z',
  completedAt: '2026-10-01T00:00:00.000Z',
};

const SAVED_RECORD = {
  id: 960001,
  sourceType: 'WORK_ORDER_SUMMARY',
  repairRequestId: 955001,
  status: 'SUBMITTED',
  title: null,
  customerFactoryName: '某封测厂',
  equipmentModelId: 300001,
  equipmentModelText: null,
  maintenanceDate: '2026-10-02',
  engineerName: '李工',
  handlingResult: 'FIXED',
  closureReason: null,
  resetResult: 'NORMAL',
  actualCause: null,
  repairActions: null,
  verificationResult: null,
  supplementaryNote: null,
  currentVersionNo: 1,
  updatedAt: '2026-10-03T00:00:00.000Z',
  aiUsage: 'USED',
  aiSourceType: 'AI_CONVERSATION',
  aiSourceId: '700001',
  aiSourceVersion: '2',
  aiScore: 4,
  aiCorrectness: 'CORRECT',
  aiHelpfulness: 3,
  aiNote: '建议被采用',
} as never;

function renderSection(params: {
  value?: WorkOrderSummaryAiDraftValue | null;
  readOnly?: boolean;
  saved?: never | null;
}) {
  const onChange = vi.fn();
  const readiness: WorkOrderSummaryAiReadiness[] = [];
  render(
    <WorkOrderSummaryAiSection
      onReadiness={(next) => readiness.push(next)}
      readOnly={params.readOnly ?? false}
      repairRequestId={955001}
      saved={params.saved ?? null}
      value={params.value ?? null}
      onChange={onChange}
    />,
  );
  return { onChange, readiness };
}

describe('WorkOrderSummaryAiSection', () => {
  beforeEach(() => {
    fetchAiMock.mockReset();
    fetchAiMock.mockResolvedValue([CANDIDATE]);
  });

  afterEach(() => {
    cleanup();
  });

  it('有候选会话：选择后绑定会话与当前不可变版本', async () => {
    const { onChange, readiness } = renderSection({});

    await waitFor(() => {
      expect(screen.getByLabelText('选择评价的 AI 会话')).toBeTruthy();
    });
    expect(readiness).toEqual(['loading', 'ready']);
    fireEvent.mouseDown(screen.getByLabelText('选择评价的 AI 会话'));
    // 会话编号用拼接构造：裸写「井号+编号」会被 lint-colors 误判为十六进制颜色
    fireEvent.click(await screen.findByText(new RegExp('会话 #' + 700001 + ' · 内容版本 v3')));

    expect(onChange).toHaveBeenCalledWith({
      conversationId: 700001,
      contentVersion: 3,
      score: null,
      correctness: null,
      helpfulness: null,
      note: '',
    });
  });

  it('未选择会话时提示必须完成评价（不提供「不使用 AI」选项）', async () => {
    renderSection({});

    await waitFor(() => {
      expect(
        screen.getByText('该工单存在可评价的 AI 辅助排查会话，请选择会话并填写评价后再提交。'),
      ).toBeTruthy();
    });
    expect(screen.queryByText('不使用 AI 评价')).toBeNull();
  });

  it('已保存版本 v2（会话当前 v3）：只改评分/说明不会把范围升级到 v3', async () => {
    const { onChange } = renderSection({
      value: {
        conversationId: 700001,
        contentVersion: 2,
        score: 4,
        correctness: 'CORRECT',
        helpfulness: 3,
        note: '',
      },
    });

    await waitFor(() => {
      // 展示的仍是已冻结的 v2 范围
      expect(
        screen.getByText('评价范围：内容版本 v2，截至第 5 条消息；此后追加的消息不进入本评价。'),
      ).toBeTruthy();
    });

    fireEvent.change(screen.getByLabelText('评价说明（可选）'), {
      target: { value: '现场采用了两条建议' },
    });

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 700001,
        contentVersion: 2,
        score: 4,
        note: '现场采用了两条建议',
      }),
    );
  });

  it('确认无会话：如实展示空状态，不出现评分控件，就绪态为 confirmedEmpty', async () => {
    fetchAiMock.mockResolvedValue([]);
    const { readiness } = renderSection({});

    await waitFor(() => {
      expect(screen.getByText('服务端确认本工单没有可用的 AI 辅助排查会话。')).toBeTruthy();
    });
    expect(readiness).toEqual(['loading', 'confirmedEmpty']);
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('查询失败：显示无法确认并可重试，不当成确认无会话，就绪态为 failed', async () => {
    fetchAiMock.mockRejectedValueOnce(new Error('network down'));
    const { readiness } = renderSection({});

    await waitFor(() => {
      expect(screen.getByText('无法读取 AI 辅助排查会话。')).toBeTruthy();
    });
    expect(readiness).toEqual(['loading', 'failed']);
    expect(
      screen.getByText(
        '当前无法确认是否已有可用会话，因此不会把未评价当作“确认无会话”；可重试后再保存或提交。',
      ),
    ).toBeTruthy();
    expect(screen.queryByText('服务端确认本工单没有可用的 AI 辅助排查会话。')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /重\s*试/ }));
    await waitFor(() => {
      expect(fetchAiMock).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(readiness).toEqual(['loading', 'failed', 'loading', 'ready']);
    });
  });

  it('选中会话后展示评价范围与版本截止点', async () => {
    renderSection({
      value: {
        conversationId: 700001,
        contentVersion: 3,
        score: 5,
        correctness: null,
        helpfulness: null,
        note: '',
      },
    });

    await waitFor(() => {
      expect(
        screen.getByText('评价范围：内容版本 v3，截至第 5 条消息；此后追加的消息不进入本评价。'),
      ).toBeTruthy();
    });
  });

  it('只读已提交：展示冻结的评价组，不查询候选会话、不上报就绪态', () => {
    const { readiness } = renderSection({ readOnly: true, saved: SAVED_RECORD });

    expect(screen.getByText('已冻结评价：来源会话 #' + 700001 + ' · 内容版本 v2')).toBeTruthy();
    expect(screen.getByText('4 / 5')).toBeTruthy();
    expect(screen.getByText('正确')).toBeTruthy();
    expect(screen.getByText('比较有帮助')).toBeTruthy();
    expect(screen.getByText('建议被采用')).toBeTruthy();
    expect(fetchAiMock).not.toHaveBeenCalled();
    expect(readiness).toEqual([]);
  });

  it('只读且未使用 AI：明确说明未使用', () => {
    renderSection({
      readOnly: true,
      saved: { ...(SAVED_RECORD as Record<string, unknown>), aiUsage: 'NOT_USED' } as never,
    });

    expect(screen.getByText('本报告未使用 AI 辅助排查评价。')).toBeTruthy();
    expect(fetchAiMock).not.toHaveBeenCalled();
  });
});
