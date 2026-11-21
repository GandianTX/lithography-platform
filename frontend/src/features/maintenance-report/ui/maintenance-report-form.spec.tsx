// @vitest-environment jsdom
// src/features/maintenance-report/ui/maintenance-report-form.spec.tsx
//
// 2026-11-20 需求调整：单页纵向表单——全部分区同屏、右侧目录只改变查看位置；
// 滚动/跳转/预览都不触发保存；只有显式点「保存草稿」才回调。
// 2026-11-21 需求调整：页内不再内嵌预览区域与目录预览项；「查看预览」按钮用
// 弹窗展示当前输入——开/关弹窗是纯本地状态，不调用保存/提交等任何写回调。

import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createEmptyReportForm } from '../model/report-form';

import { MaintenanceReportFormView } from './maintenance-report-form';

function renderForm(overrides: { onSaveDraft?: () => void } = {}) {
  const onSaveDraft = overrides.onSaveDraft ?? vi.fn();
  render(
    <MaintenanceReportFormView
      canEdit
      form={createEmptyReportForm('李工')}
      issues={[]}
      models={[]}
      saveError={null}
      saveMessage={null}
      saving={false}
      onChange={vi.fn()}
      onConfirmDiscardBranch={() => true}
      onSaveDraft={onSaveDraft}
    />,
  );
  return { onSaveDraft };
}

describe('MaintenanceReportFormView（单页纵向填写）', () => {
  beforeAll(() => {
    // jsdom 未实现 scrollIntoView：目录点击只做位置锚定
    Object.defineProperty(window.HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('单页渲染全部分区且不再内嵌预览；渲染与滚动不触发保存', () => {
    const { onSaveDraft } = renderForm();

    for (const title of ['基本信息', '初始故障与复位', '排查步骤', '维修结果与说明']) {
      expect(screen.getAllByText(title).length).toBeGreaterThan(0);
    }
    // 2026-11-21：预览改为弹窗——填写页不再出现内嵌预览标题，只出现「查看预览」按钮
    expect(screen.queryByText('预览（不保存、不提交）')).toBeNull();
    expect(screen.getAllByRole('button', { name: '查看预览' }).length).toBeGreaterThan(0);

    fireEvent.scroll(window);
    expect(onSaveDraft).not.toHaveBeenCalled();
  });

  it('右侧目录不再包含预览项与预览说明；点击分区跳转不触发保存', () => {
    const { onSaveDraft } = renderForm();

    // 窄屏断点下目录容器为 display:none（设计如此）：jsdom 中需包含隐藏元素查询
    const tocButton = screen.getByRole('button', { name: '排查步骤', hidden: true });
    fireEvent.click(tocButton);

    expect(window.HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
    expect(onSaveDraft).not.toHaveBeenCalled();
    // 目录只剩四个分区，不出现「预览」目录项与「预览只读取当前输入…」说明
    expect(screen.queryByRole('button', { name: '预览', hidden: true })).toBeNull();
    expect(screen.queryByText(/预览只读取当前输入/)).toBeNull();
  });

  it('显式点击「保存草稿」才回调一次', () => {
    const { onSaveDraft } = renderForm();

    // 单页形态在页首与页尾各有一个保存按钮：点击其一仅回调一次
    fireEvent.click(screen.getAllByRole('button', { name: '保存草稿' })[0] as HTMLElement);

    expect(onSaveDraft).toHaveBeenCalledTimes(1);
  });

  it('查看预览弹窗展示当前输入；关闭后输入保留且不触发保存', () => {
    const onSaveDraft = vi.fn();
    // 受控父组件：模拟页面层持有表单状态（onChange 回写后重渲染）
    function Host() {
      const [form, setForm] = useState(createEmptyReportForm('李工'));
      return (
        <MaintenanceReportFormView
          canEdit
          form={form}
          issues={[]}
          models={[]}
          saveError={null}
          saveMessage={null}
          saving={false}
          onChange={setForm}
          onConfirmDiscardBranch={() => true}
          onSaveDraft={onSaveDraft}
        />
      );
    }
    render(<Host />);

    fireEvent.change(screen.getByLabelText('客户厂家'), {
      target: { value: '某封测厂' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: '查看预览' })[0] as HTMLElement);

    // 弹窗内出现当前输入（预览与基本信息区各一处），且不触发保存
    expect(screen.getAllByText('某封测厂').length).toBeGreaterThan(0);
    expect(onSaveDraft).not.toHaveBeenCalled();

    // antd 会在两个汉字按钮文案中插入空格（“取 消”）
    fireEvent.click(screen.getAllByRole('button', { name: /取\s*消/ })[0] as HTMLElement);

    // 关闭后表单输入仍在（受控值不被预览消费或清空）
    expect(screen.getAllByText('某封测厂').length).toBeGreaterThan(0);
    expect(onSaveDraft).not.toHaveBeenCalled();
  });

  it('不可编辑时只读展示且不提供保存按钮', () => {
    render(
      <MaintenanceReportFormView
        canEdit={false}
        form={createEmptyReportForm('李工')}
        issues={[]}
        models={[]}
        saveError={null}
        saveMessage={null}
        saving={false}
        onChange={vi.fn()}
        onConfirmDiscardBranch={() => true}
        onSaveDraft={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: '保存草稿' })).toBeNull();
    expect(screen.getAllByText('当前报告不可编辑').length).toBeGreaterThan(0);
  });
});
