// src/features/admin-document-database/ui/admin-repair-request-detail-panel.spec.tsx
// @vitest-environment jsdom

/**
 * 管理员独立工单详情分区回归：
 * 基础信息、处理结果、内部过程、客户回复、修订历史与修订入口均可辨识；
 * 结单字段缺失按不可确认展示；附件只提供既有授权下载。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminRepairRequestSummary } from '../infrastructure/admin-document-database.types';
import {
  downloadAdminRepairProcessFile,
  fetchAdminRepairRequestSummary,
} from '../infrastructure/admin-document-database-adapter';

import { AdminRepairRequestDetailPanel } from './admin-repair-request-detail-panel';

vi.mock('../infrastructure/admin-document-database-adapter', async (importOriginal) => {
  type Adapter = typeof import('../infrastructure/admin-document-database-adapter');
  const actual = await importOriginal<Adapter>();

  return {
    ...actual,
    downloadAdminRepairProcessFile: vi.fn(),
    fetchAdminRepairRequestSummary: vi.fn(),
  };
});

const fetchSummaryMock = vi.mocked(fetchAdminRepairRequestSummary);
const downloadMock = vi.mocked(downloadAdminRepairProcessFile);

function buildSummary(
  overrides: Partial<AdminRepairRequestSummary> = {},
): AdminRepairRequestSummary {
  return {
    id: 1,
    requestNo: 'RR-20260901-001',
    customerNickname: '客户甲',
    companyName: '甲公司',
    equipmentModelId: 49,
    equipmentModelCode: 'ASML-TWINSCAN-NXT-1980DI',
    equipmentModelName: 'ASML TWINSCAN NXT:1980Di',
    errorCode: 'E-001',
    faultDescription: '曝光光路异常',
    contentMd: '## 故障描述\n\n曝光光路异常。',
    isAccepted: true,
    acceptedAt: '2026-09-01T09:00:00.000Z',
    acceptedByEngineerNickname: '陈工',
    latestResolutionStatus: 'PENDING',
    createdAt: '2026-09-01T08:00:00.000Z',
    closureStatus: 'CLOSED',
    closedAt: '2026-09-02T09:00:00.000Z',
    closureReason: '已修复',
    handlingResult: 'FIXED',
    handlingStatus: 'COMPLETED',
    currentRevisionNo: 1,
    processEntries: [
      {
        id: '101',
        entryUuid: 'entry-1',
        requestId: 1,
        operationText: '更换干涉仪镜片',
        testResult: '曝光均匀性恢复',
        occurredAt: null,
        timeSource: 'SERVER',
        fileId: 'file-1',
        file: {
          fileId: 'file-1',
          originalFilename: '现场照片.jpg',
          mimeType: 'image/jpeg',
          byteSize: 2048,
          checksumSha256: 'abcdef1234567890',
        },
        versionNo: 2,
        createdAt: '2026-09-01T10:00:00.000Z',
      },
    ],
    responses: [
      {
        id: 201,
        responseText: '已更换镜片，请复测。',
        resolutionStatus: 'RESOLVED',
        engineerNickname: '陈工',
        createdAt: '2026-09-01T11:00:00.000Z',
      },
    ],
    revisions: [
      {
        revisionNo: 1,
        previousVersion: 0,
        reason: '补齐测试事实',
        actorNickname: 'admin',
        createdAt: '2026-09-02T08:00:00.000Z',
      },
    ],
    ...overrides,
  };
}

beforeAll(() => {
  URL.createObjectURL = vi.fn(() => 'blob:mock');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});

beforeEach(() => {
  fetchSummaryMock.mockReset();
  downloadMock.mockReset();
  fetchSummaryMock.mockResolvedValue({ ok: true, detail: buildSummary() });
  downloadMock.mockResolvedValue({
    ok: true,
    blob: new Blob(['demo']),
    filename: '现场照片.jpg',
  });
});

afterEach(() => {
  cleanup();
});

describe(AdminRepairRequestDetailPanel.name, () => {
  it('展示基础信息、处理结果、内部过程、客户回复与修订历史，并提供修订入口', async () => {
    render(<AdminRepairRequestDetailPanel onBack={vi.fn()} requestId={1} />);

    expect(await screen.findByText('工单详情 · RR-20260901-001')).toBeInTheDocument();
    for (const title of ['基础信息', '处理结果', '内部维修过程', '客户可见回复', '版本与修订历史']) {
      expect(screen.getAllByText(title).length).toBeGreaterThan(0);
    }
    expect(screen.getByText('已结单')).toBeInTheDocument();
    expect(screen.getByText('更换干涉仪镜片')).toBeInTheDocument();
    expect(screen.getByText('测试事实：曝光均匀性恢复')).toBeInTheDocument();
    expect(screen.getByText('已更换镜片，请复测。')).toBeInTheDocument();
    expect(screen.getByText('补齐测试事实')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '修订工单' }));
    expect(await screen.findByPlaceholderText('说明本次修订的原因与依据')).toBeInTheDocument();
  });

  it('已绑定原件只提供下载入口，下载调用既有授权接口', async () => {
    render(<AdminRepairRequestDetailPanel requestId={1} />);

    fireEvent.click(await screen.findByRole('button', { name: '下载原件' }));

    await waitFor(() => expect(downloadMock).toHaveBeenCalledWith('file-1'));
  });

  it('明确 null 状态与明确 null 时间（数据库合法未结单）显示未结单', async () => {
    fetchSummaryMock.mockResolvedValue({
      ok: true,
      detail: buildSummary({ closureStatus: null, closedAt: null }),
    });

    render(<AdminRepairRequestDetailPanel requestId={1} />);

    expect(await screen.findByText('未结单')).toBeInTheDocument();
    expect(screen.queryByText('结单状态未知')).toBeNull();
  });

  it('结单状态与时间矛盾时显示不可确认，不推断已结单', async () => {
    fetchSummaryMock.mockResolvedValue({
      ok: true,
      detail: buildSummary({ closureStatus: 'CLOSED', closedAt: null }),
    });

    render(<AdminRepairRequestDetailPanel requestId={1} />);

    expect(await screen.findByText('结单状态未知')).toBeInTheDocument();
    expect(screen.queryByText('已结单')).toBeNull();
    expect(screen.queryByText('未结单')).toBeNull();
  });

  it('缺少 closureStatus 字段时显示不可确认，而不是未结单', async () => {
    const detail = buildSummary();
    delete (detail as Partial<AdminRepairRequestSummary>).closureStatus;
    fetchSummaryMock.mockResolvedValue({ ok: true, detail });

    render(<AdminRepairRequestDetailPanel requestId={1} />);

    expect(await screen.findByText('结单状态未知')).toBeInTheDocument();
    expect(screen.queryByText('未结单')).toBeNull();
  });

  it('详情读取失败展示错误并可重试', async () => {
    fetchSummaryMock.mockResolvedValue({ ok: false, message: '工单不存在或不可查看。' });

    render(<AdminRepairRequestDetailPanel requestId={1} />);

    expect(await screen.findByText('工单不存在或不可查看。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /重\s*试/ })).toBeInTheDocument();
  });
});
