// src/features/my-records/ui/my-record-detail-panel.spec.tsx
// @vitest-environment jsdom

/**
 * 本人记录详情只读单测（任务 07）。
 *
 * 守住：正式记录只读展示（审核记录 / 附件元数据）、草稿续填直达任务 06 真实路由
 * （独立历史记录→编辑器、工单总结→只读核对页）、已正式提交/管理员无入口、
 * 他人/跨公司/不存在统一 not-found、已发布成品入口。
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MyRecordDetail } from '../infrastructure/my-records.types';
import * as myRecordsAdapter from '../infrastructure/my-records-adapter';

import { MyRecordDetailPanel } from './my-record-detail-panel';

vi.mock('../infrastructure/my-records-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof myRecordsAdapter>();

  return { ...actual, fetchMyRecord: vi.fn() };
});

vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();

  return { ...actual, useNavigate: () => navigateMock };
});

const navigateMock = vi.fn();
const fetchMyRecordMock = vi.mocked(myRecordsAdapter.fetchMyRecord);

function buildDetail(overrides: Partial<MyRecordDetail> = {}): MyRecordDetail {
  return {
    report: {
      id: 960001,
      sourceType: 'HISTORICAL_CASE',
      repairRequestId: null,
      title: '光刻机 Z 轴异常处理',
      customerFactoryName: '某晶圆厂',
      equipmentModelId: 94,
      equipmentModelText: null,
      maintenanceDate: '2026-09-30',
      maintenanceEngineerName: '工程师甲',
      status: 'APPROVED',
      currentVersionNo: 2,
      lastSubmittedAt: '2026-10-01T00:00:00.000Z',
      lastReviewedAt: '2026-10-02T00:00:00.000Z',
      aiUsage: 'NOT_USED',
      aiScore: null,
      aiCorrectness: null,
      aiHelpfulness: null,
      aiNote: null,
      createdAt: '2026-09-30T00:00:00.000Z',
      updatedAt: '2026-10-02T00:00:00.000Z',
    },
    alarms: [
      {
        alarmIndex: 1,
        alarmCode: '0123',
        alarmDescription: 'Z 轴超限',
        phaseCode: 'OCCURRENCE',
        resetResult: 'RESET_SUCCESS',
      },
    ],
    steps: [
      {
        stepNo: 1,
        stepCode: 'S1',
        phaseCode: 'ANALYSIS',
        partName: 'Z 轴电机',
        actionText: '检查电机接线',
        resultText: '接线松动',
        newAlarmCode: null,
        isValidNewBranch: false,
      },
    ],
    currentAttachments: [
      {
        id: 970001,
        originalFilename: 'report.pdf',
        mimeType: 'application/pdf',
        byteSize: 2048,
        description: '维修原件',
        sortOrder: 0,
        status: 'CURRENT',
      },
    ],
    latestReturnComment: null,
    currentVersion: {
      id: 990001,
      versionNo: 2,
      changeKind: 'SUBMIT',
      changeReason: '首次提交',
      schemaVersion: 1,
      submittedAt: '2026-10-01T00:00:00.000Z',
    },
    currentVersionAttachments: [],
    currentReview: {
      id: 980001,
      versionId: 990001,
      decision: 'APPROVE',
      comment: '内容完整',
      reviewedAt: '2026-10-02T00:00:00.000Z',
    },
    reviewHistory: [
      {
        id: 980001,
        versionId: 990001,
        decision: 'APPROVE',
        comment: '内容完整',
        reviewedAt: '2026-10-02T00:00:00.000Z',
      },
    ],
    canEdit: false,
    equipmentModelName: 'ASML TWINSCAN NXT:1980Di',
    publishedDocumentId: null,
    syncStatus: {
      status: 'NOT_CONNECTED',
      message: null,
      conflictId: null,
      canResolveConflict: false,
    },
    ...overrides,
  };
}

beforeEach(() => {
  fetchMyRecordMock.mockReset();
  navigateMock.mockReset();
});

describe('MyRecordDetailPanel', () => {
  it('正式记录：只读展示元数据、冻结版本与审核记录', async () => {
    fetchMyRecordMock.mockResolvedValue({ ok: true, detail: buildDetail() });

    render(<MyRecordDetailPanel recordId={960001} />);

    expect(await screen.findByText('光刻机 Z 轴异常处理')).toBeTruthy();
    expect(screen.getByText('某晶圆厂')).toBeTruthy();
    expect(screen.getByText('v2')).toBeTruthy();
    expect(screen.getByText('内容完整')).toBeTruthy();
    expect(screen.getByText('report.pdf')).toBeTruthy();
    // 只读：不出现任何编辑/提交按钮
    expect(screen.queryByRole('button', { name: /继续填写/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /保存/ })).toBeNull();
  });

  it('独立历史记录草稿：续填按钮直达任务 06 报告编辑器（同一报告 id）', async () => {
    fetchMyRecordMock.mockResolvedValue({
      ok: true,
      detail: buildDetail({
        report: { ...buildDetail().report, status: 'DRAFT', currentVersionNo: 0 },
        currentVersion: null,
        currentReview: null,
        reviewHistory: [],
        canEdit: true,
      }),
    });

    render(<MyRecordDetailPanel activeRole="ENGINEER" recordId={960001} />);

    expect(await screen.findByText(/该记录尚未完成/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '继续填写' }));
    expect(navigateMock).toHaveBeenCalledWith('/engineer/maintenance-records/960001');
  });

  it('工单总结草稿：续填按钮直达任务 06 只读核对页（参数为来源工单 id）', async () => {
    fetchMyRecordMock.mockResolvedValue({
      ok: true,
      detail: buildDetail({
        report: {
          ...buildDetail().report,
          status: 'DRAFT',
          currentVersionNo: 0,
          sourceType: 'WORK_ORDER_SUMMARY',
          repairRequestId: 950001,
        },
        currentVersion: null,
        currentReview: null,
        reviewHistory: [],
        canEdit: true,
      }),
    });

    render(<MyRecordDetailPanel activeRole="ENGINEER" recordId={960001} />);

    expect(await screen.findByText(/该记录尚未完成/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '继续核对' }));
    expect(navigateMock).toHaveBeenCalledWith('/engineer/work-order-summaries/950001');
  });

  it('管理员身份：草稿详情不提供续填入口（不伪造跳转）', async () => {
    fetchMyRecordMock.mockResolvedValue({
      ok: true,
      detail: buildDetail({
        report: { ...buildDetail().report, status: 'DRAFT', currentVersionNo: 0 },
        currentVersion: null,
        currentReview: null,
        reviewHistory: [],
        canEdit: true,
      }),
    });

    render(<MyRecordDetailPanel activeRole="SUPER_ADMIN" recordId={960001} />);

    expect(await screen.findByText(/该记录尚未完成/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '继续填写' })).toBeNull();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('后端 canEdit=false：草稿提示区不提供续填按钮（服务端事实优先于本地状态推断）', async () => {
    fetchMyRecordMock.mockResolvedValue({
      ok: true,
      detail: buildDetail({
        report: { ...buildDetail().report, status: 'RETURNED', currentVersionNo: 0 },
        canEdit: false,
      }),
    });

    render(<MyRecordDetailPanel activeRole="ENGINEER" recordId={960001} />);

    expect(await screen.findByText(/该记录尚未完成/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '继续填写' })).toBeNull();
    expect(screen.queryByRole('button', { name: '继续核对' })).toBeNull();
  });

  it('工单总结来源：展示来源标签与来源工单标识', async () => {
    fetchMyRecordMock.mockResolvedValue({
      ok: true,
      detail: buildDetail({
        report: {
          ...buildDetail().report,
          sourceType: 'WORK_ORDER_SUMMARY',
          repairRequestId: 950001,
        },
      }),
    });

    render(<MyRecordDetailPanel recordId={960001} />);

    expect(await screen.findByText('工单总结')).toBeTruthy();
    expect(screen.getByText('工单 #' + 950001)).toBeTruthy();
  });

  it('独立历史记录：不渲染来源工单行', async () => {
    fetchMyRecordMock.mockResolvedValue({ ok: true, detail: buildDetail() });

    render(<MyRecordDetailPanel recordId={960001} />);

    expect(await screen.findByText('独立历史报告')).toBeTruthy();
    expect(screen.queryByText(/^工单 #/)).toBeNull();
  });

  it('有 AI 评价：展示评分/准确性/帮助性/说明等接口实际提供的字段', async () => {
    fetchMyRecordMock.mockResolvedValue({
      ok: true,
      detail: buildDetail({
        report: {
          ...buildDetail().report,
          aiUsage: 'USED',
          aiScore: 4,
          aiCorrectness: 'CORRECT',
          aiHelpfulness: 5,
          aiNote: 'AI 提示检查光源模块',
        },
      }),
    });

    render(<MyRecordDetailPanel recordId={960001} />);

    expect(await screen.findByText('AI 评分')).toBeTruthy();
    expect(screen.getByText('4')).toBeTruthy();
    expect(screen.getByText('CORRECT')).toBeTruthy();
    expect(screen.getByText('5')).toBeTruthy();
    expect(screen.getByText('AI 提示检查光源模块')).toBeTruthy();
  });

  it('无 AI 评价：null/缺字段不渲染，不误显示成评分 0', async () => {
    fetchMyRecordMock.mockResolvedValue({ ok: true, detail: buildDetail() });

    render(<MyRecordDetailPanel recordId={960001} />);

    expect(await screen.findByText('NOT_USED')).toBeTruthy();
    expect(screen.queryByText('AI 评分')).toBeNull();
    expect(screen.queryByText('AI 准确性')).toBeNull();
    expect(screen.queryByText('AI 帮助性')).toBeNull();
    expect(screen.queryByText('AI 说明')).toBeNull();
    expect(screen.queryByText(/评分 0/)).toBeNull();
  });

  it('已发布成品：跳转参考资料详情', async () => {
    fetchMyRecordMock.mockResolvedValue({
      ok: true,
      detail: buildDetail({ publishedDocumentId: 970001 }),
    });

    render(<MyRecordDetailPanel recordId={960001} />);
    fireEvent.click(await screen.findByRole('button', { name: '查看正式资料' }));

    expect(navigateMock).toHaveBeenCalledWith('/reference-documents/970001');
  });

  it('他人/跨公司/不存在：统一 not-found，不泄露记录字段', async () => {
    fetchMyRecordMock.mockResolvedValue({
      ok: false,
      reason: 'not-found',
      message: '该记录不存在或不可查看。',
    });

    render(<MyRecordDetailPanel recordId={960001} />);

    expect(await screen.findByText('该记录不存在或不可查看。')).toBeTruthy();
    expect(screen.queryByText('光刻机 Z 轴异常处理')).toBeNull();
  });

  it('非法记录 ID：不发起请求，直接 not-found', async () => {
    render(<MyRecordDetailPanel recordId={null} />);

    expect(await screen.findByText('记录不存在或不可查看。')).toBeTruthy();
    expect(fetchMyRecordMock).not.toHaveBeenCalled();
  });
});
