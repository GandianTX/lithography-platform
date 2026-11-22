// src/features/my-records/ui/my-record-sync-status.spec.tsx

/**
 * 同步状态展示逻辑定向测试（任务 07 预留）。
 *
 * 用测试替身覆盖待上传（PENDING）、上传中（UPLOADING）、失败（FAILED）、
 * 已同步（SYNCED）与冲突（CONFLICT）；并验证：
 * - 不从保存成功推断「已同步」（NOT_CONNECTED/UNKNOWN 各自如实展示）；
 * - 「处理冲突」入口只在 CONFLICT + 有效冲突标识 + 任务 09 授权 + 已接入路由
 *   动作同时满足时渲染；本轮无已接入路由，不出现占位跳转。
 */

import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import type { MyRecordSyncStatusView } from '../infrastructure/my-records.types';

import { canOfferConflictResolution } from './my-record-labels';
import { MyRecordSyncStatusBadge } from './my-record-sync-status';

const makeView = (overrides: Partial<MyRecordSyncStatusView> = {}): MyRecordSyncStatusView => ({
  status: 'NOT_CONNECTED',
  message: null,
  conflictId: null,
  canResolveConflict: false,
  ...overrides,
});

const renderBadge = (view: MyRecordSyncStatusView, conflictAction?: ReactNode) =>
  render(<MyRecordSyncStatusBadge view={view} conflictAction={conflictAction} />);

describe('MyRecordSyncStatusBadge', () => {
  it('任务 09 未接入：如实展示「未接入同步」，不显示已同步', () => {
    renderBadge(makeView());

    expect(screen.getByText('未接入同步')).toBeTruthy();
    expect(screen.queryByText('已同步')).toBeNull();
  });

  it('映射缺失或查询失败：如实展示「同步状态未知」', () => {
    renderBadge(makeView({ status: 'UNKNOWN' }));

    expect(screen.getByText('同步状态未知')).toBeTruthy();
    expect(screen.queryByText('已同步')).toBeNull();
  });

  it('待上传 / 上传中 / 失败：各自如实展示', () => {
    renderBadge(makeView({ status: 'PENDING' }));
    expect(screen.getByText('待上传')).toBeTruthy();
    renderBadge(makeView({ status: 'UPLOADING' }));
    expect(screen.getByText('上传中')).toBeTruthy();
    renderBadge(makeView({ status: 'FAILED', message: '上传失败，请稍后重试' }));
    expect(screen.getByText('上传失败')).toBeTruthy();
  });

  it('已同步：仅在提供方给出 SYNCED 展示值时显示', () => {
    renderBadge(makeView({ status: 'SYNCED' }));

    expect(screen.getByText('已同步')).toBeTruthy();
  });

  it('冲突：展示「存在冲突」，message 作为标签提示', () => {
    renderBadge(
      makeView({
        status: 'CONFLICT',
        message: '本机与云端版本不一致',
        conflictId: 'b096c692-7556-4564-a4f8-2e2fb78b3880',
        canResolveConflict: true,
      }),
    );

    const tag = screen.getByText('存在冲突');
    expect(tag.getAttribute('title')).toBe('本机与云端版本不一致');
  });

  it('冲突且已接入路由：渲染调用方传入的处理动作', () => {
    renderBadge(
      makeView({
        status: 'CONFLICT',
        conflictId: 'b096c692-7556-4564-a4f8-2e2fb78b3880',
        canResolveConflict: true,
      }),
      <button type="button">处理冲突</button>,
    );

    expect(screen.getByText('处理冲突').getAttribute('type')).toBe('button');
  });

  it('缺一不可：无冲突标识 / 未授权 / 未传路由动作时，不渲染处理入口', () => {
    const action = <button type="button">处理冲突</button>;

    renderBadge(
      makeView({ status: 'CONFLICT', conflictId: null, canResolveConflict: true }),
      action,
    );
    expect(screen.queryByText('处理冲突')).toBeNull();

    renderBadge(
      makeView({
        status: 'CONFLICT',
        conflictId: 'b096c692-7556-4564-a4f8-2e2fb78b3880',
        canResolveConflict: false,
      }),
      action,
    );
    expect(screen.queryByText('处理冲突')).toBeNull();

    // 本轮无已接入路由：即便条件满足也不传 action，不放占位跳转
    renderBadge(
      makeView({
        status: 'CONFLICT',
        conflictId: 'b096c692-7556-4564-a4f8-2e2fb78b3880',
        canResolveConflict: true,
      }),
    );
    expect(screen.queryByText('处理冲突')).toBeNull();
  });
});

describe('canOfferConflictResolution', () => {
  it('仅 CONFLICT + 有效冲突标识 + 任务 09 授权时为 true', () => {
    expect(
      canOfferConflictResolution(
        makeView({
          status: 'CONFLICT',
          conflictId: 'b096c692-7556-4564-a4f8-2e2fb78b3880',
          canResolveConflict: true,
        }),
      ),
    ).toBe(true);

    expect(
      canOfferConflictResolution(
        makeView({ status: 'CONFLICT', conflictId: null, canResolveConflict: true }),
      ),
    ).toBe(false);
    expect(
      canOfferConflictResolution(
        makeView({
          status: 'SYNCED',
          conflictId: 'b096c692-7556-4564-a4f8-2e2fb78b3880',
          canResolveConflict: true,
        }),
      ),
    ).toBe(false);
    expect(
      canOfferConflictResolution(
        makeView({
          status: 'CONFLICT',
          conflictId: 'b096c692-7556-4564-a4f8-2e2fb78b3880',
          canResolveConflict: false,
        }),
      ),
    ).toBe(false);
  });
});
