// src/features/admin-operation-records/ui/operation-records-table.spec.tsx
// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { createTranslator, I18nContext } from '@/shared/i18n';

import type { OperationRecordItem } from '../infrastructure/admin-operation-records.types';

import { OperationRecordsTable } from './operation-records-table';

/**
 * 关键操作记录七列只读表单测（任务 10 S3.1／S3.2）。
 *
 * 重点锁定：七列表头、操作/结果/目标类型的本地化、detail 白名单摘要拼装、
 * 空 detail 与未知目标类型的兜底显示（不翻译、不放行）、以及只读边界（无按钮/链接）。
 */

const baseItem: OperationRecordItem = {
  eventId: 'event-1',
  occurredAt: '2026-11-19T10:00:00.000Z',
  actorAdminLevel: 1,
  actorNickname: '管理员甲',
  organizationId: 2,
  organizationName: '开发联调公司 A',
  operation: 'ADMIN_DELETE_DOCUMENT',
  targetType: 'REFERENCE_DOCUMENT',
  targetId: 'doc-1001',
  result: 'SUCCEEDED',
  detail: {
    reason: '重复上传，管理员删除',
    stage: null,
    changedFields: null,
    attemptNo: null,
    beforeOrganizationName: null,
    afterOrganizationName: null,
  },
};

function renderItem(overrides: Partial<OperationRecordItem> = {}): OperationRecordItem {
  return { ...baseItem, ...overrides };
}

function renderTable(items: OperationRecordItem[]) {
  const value = {
    language: 'zh-CN' as const,
    setLanguage: () => {},
    t: createTranslator('zh-CN'),
  };
  return render(
    <I18nContext.Provider value={value}>
      <OperationRecordsTable items={items} />
    </I18nContext.Provider>,
  );
}

afterEach(() => {
  cleanup();
});

describe('OperationRecordsTable', () => {
  it('渲染七列中文表头', () => {
    renderTable([baseItem]);

    for (const header of [
      '时间',
      '操作者',
      '所属公司',
      '操作类型',
      '目标',
      '实际结果',
      '必要说明',
    ]) {
      // scroll.x 会让 AntD 渲染隐藏测量表，表头文本可能重复出现
      expect(screen.getAllByText(header).length).toBeGreaterThan(0);
    }
  });

  it('操作、结果与目标类型按中文本地化，摘要显示原因', () => {
    renderTable([baseItem]);

    expect(screen.getByText('管理员删除正式资料')).toBeInTheDocument();
    expect(screen.getByText('成功')).toBeInTheDocument();
    expect(screen.getByText('历史维修记录')).toBeInTheDocument();
    expect(screen.getByText('doc-1001')).toBeInTheDocument();
    expect(screen.getByText('重复上传，管理员删除')).toBeInTheDocument();
    expect(screen.getByText('开发联调公司 A')).toBeInTheDocument();
    expect(screen.getByText('一级管理员')).toBeInTheDocument();
  });

  it('归属更正摘要拼装阶段、变更字段与前后公司名', () => {
    renderTable([
      renderItem({
        eventId: 'event-2',
        targetId: 'doc-1002',
        operation: 'CORRECT_DOCUMENT_OWNERSHIP',
        result: 'FAILED',
        actorAdminLevel: 2,
        detail: {
          reason: '目标公司校验失败',
          stage: 'VERIFY',
          changedFields: ['ownerOrganizationId'],
          attemptNo: 2,
          beforeOrganizationName: '开发联调公司 A',
          afterOrganizationName: '开发联调公司 B',
        },
      }),
    ]);

    expect(screen.getByText('更改资料上传者和公司归属')).toBeInTheDocument();
    expect(screen.getByText('失败')).toBeInTheDocument();
    expect(screen.getByText('二级管理员')).toBeInTheDocument();
    expect(screen.getByText('阶段：VERIFY')).toBeInTheDocument();
    expect(screen.getByText('变更字段：所属公司')).toBeInTheDocument();
    expect(screen.getByText('第 2 次尝试')).toBeInTheDocument();
    expect(screen.getByText('开发联调公司 A → 开发联调公司 B')).toBeInTheDocument();
  });

  it('变更字段名按当前语言显示可读名称，未登记字段原样展示', () => {
    renderTable([
      renderItem({
        eventId: 'event-4',
        detail: {
          reason: '上传者与上传时公司核实',
          stage: null,
          changedFields: ['createdByAccountId', 'ownerOrganizationId', 'someNewField'],
          attemptNo: null,
          beforeOrganizationName: null,
          afterOrganizationName: null,
        },
      }),
    ]);

    expect(screen.getByText('变更字段：上传者, 所属公司, someNewField')).toBeInTheDocument();
  });

  it('DENIED 显示已拒绝；空摘要与空公司显示占位符', () => {
    renderTable([
      renderItem({
        eventId: 'event-3',
        targetId: 'restore-1',
        operation: 'RESTORE_LOCAL_BUSINESS',
        targetType: 'BACKUP_RESTORE_RUN',
        result: 'DENIED',
        organizationId: null,
        organizationName: null,
        detail: null,
      }),
    ]);

    expect(screen.getByText('使用备份包恢复本机业务')).toBeInTheDocument();
    expect(screen.getByText('已拒绝')).toBeInTheDocument();
    expect(screen.getByText('恢复运行')).toBeInTheDocument();

    const dashCells = screen.getAllByText('—');
    expect(dashCells.length).toBeGreaterThanOrEqual(2);
  });

  it('未知目标类型原样显示标识，不做兜底翻译', () => {
    renderTable([renderItem({ targetType: 'SOME_NEW_TYPE' })]);

    expect(screen.getByText('SOME_NEW_TYPE')).toBeInTheDocument();
  });

  it('操作者昵称缺失时按当前语言渲染占位，不回落中文硬编码', () => {
    renderTable([renderItem({ actorNickname: null })]);

    expect(screen.getByText('未知管理员')).toBeInTheDocument();
    expect(screen.queryByText('管理员甲')).not.toBeInTheDocument();
  });

  it('只读边界：整表不出现任何按钮或链接，也无操作列', () => {
    renderTable([baseItem]);

    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });
});
