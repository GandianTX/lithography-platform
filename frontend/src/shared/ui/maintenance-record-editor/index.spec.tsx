// src/shared/ui/maintenance-record-editor/index.spec.tsx

// @vitest-environment jsdom

/**
 * 共享维修记录编辑器：仅证明任务 06 既有用法（不传 engineerNameReadOnly）仍可编辑姓名，
 * 任务 04 工单场景显式传 engineerNameReadOnly 时才锁定姓名。
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MaintenanceRecordEditor } from './index';
import { createMaintenanceEditorValue } from './model';

function editorValue(engineerName = '李工') {
  return createMaintenanceEditorValue({
    maintenanceDate: null,
    engineerName,
    resetResult: null,
    supplementaryNote: null,
    attachment: null,
    steps: [],
    panels: [],
  });
}

describe('MaintenanceRecordEditor 姓名输入', () => {
  afterEach(() => {
    cleanup();
  });

  it('默认（任务 06 既有用法）：姓名可编辑，输入回传给调用方', () => {
    const onChange = vi.fn();
    render(<MaintenanceRecordEditor onChange={onChange} value={editorValue('李工')} />);

    const input = screen.getByLabelText(/维修工程师/) as HTMLInputElement;
    expect(input.disabled).toBe(false);
    fireEvent.change(input, { target: { value: '王工' } });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toMatchObject({ engineerName: '王工' });
  });

  it('工单场景显式 engineerNameReadOnly：姓名只读但其他字段仍可编辑', () => {
    const onChange = vi.fn();
    render(
      <MaintenanceRecordEditor
        engineerNameReadOnly
        onChange={onChange}
        value={editorValue('李工')}
      />,
    );

    const input = screen.getByLabelText(/维修工程师/) as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(input.value).toBe('李工');

    fireEvent.change(screen.getByPlaceholderText('补充其他维修事实、备件或后续建议…'), {
      target: { value: '仍可编辑的补充说明' },
    });
    expect(onChange).toHaveBeenCalled();
  });
});

describe('MaintenanceRecordEditor 分步表单复用（任务 06）', () => {
  afterEach(() => {
    cleanup();
  });

  it('visibleSections 只渲染指定分区，其余分区不参与交互', () => {
    render(
      <MaintenanceRecordEditor
        onChange={vi.fn()}
        value={editorValue()}
        visibleSections={['steps']}
      />,
    );

    expect(screen.getByText('排查步骤')).toBeTruthy();
    expect(screen.queryByText('基本信息')).toBeNull();
    expect(screen.queryByText('初始故障')).toBeNull();
    expect(screen.queryByText('复位结果')).toBeNull();
    expect(screen.queryByText('补充说明')).toBeNull();
  });

  it('不传 visibleSections 时保持原有全部分区（任务 04 行为不变）', () => {
    render(<MaintenanceRecordEditor onChange={vi.fn()} value={editorValue()} />);

    expect(screen.getByText('基本信息')).toBeTruthy();
    expect(screen.getByText('补充说明')).toBeTruthy();
  });
});
