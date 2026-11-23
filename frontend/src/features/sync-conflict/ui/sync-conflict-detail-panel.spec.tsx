// src/features/sync-conflict/ui/sync-conflict-detail-panel.spec.tsx
// @vitest-environment jsdom

/**
 * 冲突详情面板定向测试（任务 09 S2.3 ＋ R066 只读采用口径）。
 *
 * 守住：
 * - 已删除／下架／冻结：不给"使用云端／保留本地"入口，并说明原因；
 * - 已结单（只读）：**允许"使用云端"**（只读采用：只对齐视图，不改历史、不给写入权），
 *   但"保留本地"仍然禁用（不改只读业务历史）；
 * - 可写内容三个动作齐备，裁决动作原样下传服务端，并带上**用户实际看到的云端版本**；
 * - 差异条目按服务端给出的路径与两侧值展示；
 * - 来源页入口：取不到本机 ID 时不提供跳转。
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SyncConflictDetail } from '../infrastructure/sync-conflict.types';
import * as syncConflictAdapter from '../infrastructure/sync-conflict-adapter';

import { SyncConflictDetailPanel } from './sync-conflict-detail-panel';

vi.mock('../infrastructure/sync-conflict-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof syncConflictAdapter>();

  return {
    ...actual,
    fetchSyncConflictDetail: vi.fn(),
    resolveSyncConflict: vi.fn(),
  };
});

const fetchDetailMock = vi.mocked(syncConflictAdapter.fetchSyncConflictDetail);
const resolveMock = vi.mocked(syncConflictAdapter.resolveSyncConflict);

const makeDetail = (overrides: Partial<SyncConflictDetail> = {}): SyncConflictDetail => ({
  conflictId: 'conflict-1',
  recordUuid: 'record-uuid-1',
  organizationId: 4,
  resourceType: 'REPAIR_REQUEST',
  versionNo: 2,
  localVersion: 2,
  cloudVersion: 3,
  displayedCloudVersion: 3,
  decision: null,
  status: 'PENDING',
  localSnapshot: '{"content_md":"本地"}',
  cloudSnapshot: '{"content_md":"云端"}',
  conflictReason: '云端版本更新',
  diff: {
    entries: [{ path: 'content_md', kind: 'DIFFERENT', localValue: '本地', cloudValue: '云端' }],
    truncated: false,
    invalid: false,
  },
  sourceRecordId: 880001,
  sourceReadOnly: false,
  sourceReadOnlyReason: null,
  canAdoptCloud: true,
  adoptionReadOnly: false,
  confirmedByAccountId: null,
  confirmedAt: null,
  createdAt: '2026-11-22T00:00:00.000Z',
  ...overrides,
});

const renderPanel = () =>
  render(
    <MemoryRouter>
      <SyncConflictDetailPanel conflictId="conflict-1" />
    </MemoryRouter>,
  );

describe('冲突详情面板', () => {
  beforeEach(() => {
    fetchDetailMock.mockReset();
    resolveMock.mockReset();
    resolveMock.mockResolvedValue({
      outcome: 'resolved',
      conflict: makeDetail(),
    });
  });

  it('展示版本、差异与来源页入口', async () => {
    fetchDetailMock.mockResolvedValue(makeDetail());

    renderPanel();

    await waitFor(() => {
      expect(screen.getByText('content_md')).toBeTruthy();
    });
    expect(screen.getByText('云端版本更新')).toBeTruthy();
    expect(screen.getByText('本地')).toBeTruthy();
    expect(screen.getByText('云端')).toBeTruthy();
    expect(screen.getByText('打开来源记录')).toBeTruthy();
  });

  it('只读内容（已删除／下架／冻结）：不给恢复入口，并说明原因', async () => {
    fetchDetailMock.mockResolvedValue(
      makeDetail({
        sourceReadOnly: true,
        sourceReadOnlyReason: 'SOURCE_FROZEN',
        canAdoptCloud: false,
      }),
    );

    renderPanel();

    await waitFor(() => {
      expect(screen.getByText('打开来源记录')).toBeTruthy();
    });
    const cloudButton = screen.getByRole('button', { name: '使用云端' });
    const localButton = screen.getByRole('button', { name: '保留本地' });
    expect((cloudButton as HTMLButtonElement).disabled).toBe(true);
    expect((localButton as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('来源记录正在处理中，内容已冻结')).toBeTruthy();
  });

  // R066：已结单（结单后只读）允许**只读采用**云端视图：
  // "使用云端"可用，"保留本地"仍禁用（不改只读业务历史）。
  it('已结单只读来源：允许"使用云端"（只读采用），"保留本地"仍禁用', async () => {
    fetchDetailMock.mockResolvedValue(
      makeDetail({
        sourceReadOnly: true,
        sourceReadOnlyReason: 'SOURCE_CLOSED',
        canAdoptCloud: true,
        adoptionReadOnly: true,
      }),
    );

    renderPanel();

    await waitFor(() => {
      expect(screen.getByText('打开来源记录')).toBeTruthy();
    });
    const cloudButton = screen.getByRole('button', { name: '使用云端' }) as HTMLButtonElement;
    const localButton = screen.getByRole('button', { name: '保留本地' }) as HTMLButtonElement;
    expect(cloudButton.disabled).toBe(false);
    expect(localButton.disabled).toBe(true);
    expect(
      screen.getByText(
        '来源记录已结单（只读），仍可采用云端视图：只对齐本机视图，不改动已结单业务历史，也不因此获得写入权。',
      ),
    ).toBeTruthy();
  });

  it('可写内容：裁决动作原样下传服务端', async () => {
    fetchDetailMock.mockResolvedValue(makeDetail());

    renderPanel();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '使用云端' })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: '使用云端' }));

    const confirmButton = await waitFor(() => {
      const button = document.querySelector<HTMLButtonElement>(
        '.ant-popconfirm-buttons .ant-btn-primary',
      );
      expect(button).not.toBeNull();

      return button as HTMLButtonElement;
    });
    fireEvent.click(confirmButton);

    await waitFor(() => {
      // 带上**用户实际看到**的云端版本：服务端据此复核云端是否已变化（R067）
      expect(resolveMock).toHaveBeenCalledWith('conflict-1', 'CLOUD', 3);
    });
  });

  it('取不到来源记录时：不提供来源页跳转', async () => {
    fetchDetailMock.mockResolvedValue(makeDetail({ sourceRecordId: null }));

    renderPanel();

    await waitFor(() => {
      expect(screen.getByText('来源记录已不可用，无法跳转')).toBeTruthy();
    });
    expect(screen.queryByText('打开来源记录')).toBeNull();
  });

  it('快照无法解析：如实说明不能比较', async () => {
    fetchDetailMock.mockResolvedValue(
      makeDetail({ diff: { entries: [], truncated: false, invalid: true } }),
    );

    renderPanel();

    await waitFor(() => {
      expect(screen.getByText('快照内容无法解析，暂时不能比较差异。')).toBeTruthy();
    });
  });
});
