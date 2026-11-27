// src/features/reference-document/ui/reference-document-revise-panel.spec.tsx
// @vitest-environment jsdom

/**
 * 独立管理修订面板单测（任务 07）。
 *
 * 覆盖本轮确认需求 五（离线测试）：
 * - 一级读取现有结构化内容 → 编辑初值预填（故障/复位/步骤/维修结果）；
 * - 管理修订原因必填：空白原因不发 mutation；
 * - 页面取消不保存：不发出任何请求；
 * - 保存失败保留用户输入（失败后表单值仍在）；
 * - 结构化保存载荷为全量值语义（分支面板/步骤稳定编码/维修结果）；
 * - 扁平模式（普通资料/旧扁平修订）：正文修订走既有修订语义；
 * - 非一级管理员：仅提示无权限，不渲染编辑表单。
 */

import { type ReactElement } from 'react';
import { act, fireEvent, render as rtlRender, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MessageFeedbackProvider } from '@/shared/ui/message-feedback';

import type { ReferenceDocumentEditableContent } from '../infrastructure/reference-document.types';
import * as referenceDocumentAdapter from '../infrastructure/reference-document-adapter';

import type { ReferenceDocumentViewer } from './reference-document-detail-panel';
import { ReferenceDocumentRevisePanel } from './reference-document-revise-panel';

function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: MessageFeedbackProvider });
}

vi.mock('../infrastructure/reference-document-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof referenceDocumentAdapter>();

  return {
    ...actual,
    fetchReferenceDocumentEditableContent: vi.fn(),
    fetchReferenceEquipmentModels: vi.fn(),
    reviseReferenceDocument: vi.fn(),
    reviseReferenceDocumentStructured: vi.fn(),
  };
});

vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();

  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

const navigateMock = vi.fn();
const fetchEditableMock = vi.mocked(referenceDocumentAdapter.fetchReferenceDocumentEditableContent);
const reviseStructuredMock = vi.mocked(referenceDocumentAdapter.reviseReferenceDocumentStructured);
const reviseFlatMock = vi.mocked(referenceDocumentAdapter.reviseReferenceDocument);

const structuredContentFixture: ReferenceDocumentEditableContent = {
  documentId: 970100,
  title: '光刻机 Z 轴异常处理报告',
  description: '说明',
  documentType: 'MAINTENANCE_GUIDE',
  expectedVersion: 2,
  sourceKind: 'INDEPENDENT_REPORT',
  mode: 'STRUCTURED',
  equipmentModelId: 94,
  equipmentModelName: 'DEV-LITHO-A',
  structured: {
    schemaVersion: 1,
    maintenanceDate: '2026-09-30',
    maintenanceEngineerName: '工程师甲',
    customerFactoryName: '某晶圆厂',
    equipmentModelText: 'DEV-LITHO-A',
    resetResult: 'SAME_FAULT',
    faults: [
      {
        branchKind: 'INITIAL',
        stepCode: null,
        phaseCode: 'PHASE_02',
        mainError: 'Z AXIS OVER LIMIT',
        unitError: 'Z1',
        source: 'MOTION',
        errorType: 'SERVO',
        gpibStatus: 'IDLE',
        faultStatus: 'ACTIVE',
        description: 'Z 轴超限报警',
        action: '停机检查',
      },
    ],
    steps: [
      {
        stepCode: 'step-a',
        stepNo: 1,
        phaseCode: 'PHASE_03',
        errorCode: 'E-100',
        partName: 'Z 轴电机',
        actionText: '检查电机接线',
        resultCode: 'RESOLVED',
      },
    ],
    handlingResult: 'INTERRUPTED',
    closureReason: '备件未到货',
    actualCause: '接线松动',
    repairActions: null,
    verificationResult: '上电验证通过',
    supplementaryNote: '后续跟进',
  },
  contentText: null,
  faultCaseProtected: false,
};

const flatContentFixture: ReferenceDocumentEditableContent = {
  documentId: 970101,
  title: '普通维护手册',
  description: null,
  documentType: 'MAINTENANCE_GUIDE',
  expectedVersion: 1,
  sourceKind: 'MATERIAL',
  mode: 'FLAT',
  equipmentModelId: null,
  equipmentModelName: null,
  structured: null,
  contentText: '普通资料正文',
  faultCaseProtected: false,
};

const levelOneViewer: ReferenceDocumentViewer = { role: 'SUPER_ADMIN', adminLevel: 1 };

const fetchModelsMock = vi.mocked(referenceDocumentAdapter.fetchReferenceEquipmentModels);

beforeEach(() => {
  fetchEditableMock.mockReset();
  reviseStructuredMock.mockReset();
  reviseFlatMock.mockReset();
  navigateMock.mockReset();
  fetchModelsMock.mockReset();
  fetchModelsMock.mockResolvedValue([
    { id: 94, modelCode: 'MC-A', modelName: 'DEV-LITHO-A' },
    { id: 95, modelCode: 'MC-B', modelName: 'DEV-LITHO-B' },
  ]);
});

describe('ReferenceDocumentRevisePanel（结构化模式）', () => {
  it('读取现有结构化内容作为编辑初值：故障/复位/步骤/维修结果预填', async () => {
    fetchEditableMock.mockResolvedValue({ ok: true, content: structuredContentFixture });

    render(<ReferenceDocumentRevisePanel documentId={970100} viewer={levelOneViewer} />);

    expect(await screen.findByText('管理修订：光刻机 Z 轴异常处理报告')).toBeTruthy();
    // 编辑器预填（基本信息 + 故障面板 + 步骤）
    expect(screen.getByDisplayValue('2026-09-30')).toBeTruthy();
    expect(screen.getByDisplayValue('工程师甲')).toBeTruthy();
    expect(screen.getByDisplayValue('Z 轴超限报警')).toBeTruthy();
    expect(screen.getByDisplayValue('检查电机接线')).toBeTruthy();
    // 维修结果字段预填
    expect(screen.getByDisplayValue('备件未到货')).toBeTruthy();
    expect(screen.getByDisplayValue('接线松动')).toBeTruthy();
    expect(screen.getByDisplayValue('上电验证通过')).toBeTruthy();
    // 厂家文本可编辑（本轮确认需求），机型改选控件与说明呈现
    expect(screen.getByDisplayValue('某晶圆厂')).toBeTruthy();
    expect(screen.getByLabelText('选择适用机型')).toBeTruthy();
    expect(screen.getByText(/只能改选已有且启用的机型/)).toBeTruthy();
    // 中断结果带原因输入（条件渲染）
    expect(screen.getByDisplayValue('备件未到货')).toBeTruthy();
  });

  it('管理修订原因必填：空白原因不发 mutation', async () => {
    fetchEditableMock.mockResolvedValue({ ok: true, content: structuredContentFixture });

    render(<ReferenceDocumentRevisePanel documentId={970100} viewer={levelOneViewer} />);

    fireEvent.click(await screen.findByRole('button', { name: '保存管理修订' }));

    expect(await screen.findByText('管理修订原因必填，请填写后再提交。')).toBeTruthy();
    expect(reviseStructuredMock).not.toHaveBeenCalled();
  });

  it('保存：提交全量结构化载荷（分支面板/稳定编码/维修结果）并返回资料详情', async () => {
    fetchEditableMock.mockResolvedValue({ ok: true, content: structuredContentFixture });
    reviseStructuredMock.mockResolvedValue({ ok: true, id: 970100, revisionNo: 3 });

    render(<ReferenceDocumentRevisePanel documentId={970100} viewer={levelOneViewer} />);

    fireEvent.change(await screen.findByPlaceholderText('管理修订原因（必填，不超过 500 字）'), {
      target: { value: '勘误故障描述' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存管理修订' }));

    await waitFor(() => {
      expect(reviseStructuredMock).toHaveBeenCalledTimes(1);
    });
    const [id, input] = reviseStructuredMock.mock.calls[0];
    expect(id).toBe(970100);
    expect(input.expectedVersion).toBe(2);
    expect(input.reason).toBe('勘误故障描述');
    expect(input.structured).toMatchObject({
      schemaVersion: 1,
      maintenanceDate: '2026-09-30',
      maintenanceEngineerName: '工程师甲',
      customerFactoryName: '某晶圆厂',
      resetResult: 'SAME_FAULT',
      handlingResult: 'INTERRUPTED',
      closureReason: '备件未到货',
      verificationResult: '上电验证通过',
    });
    // 未改机型：不提交 equipmentModelId（undefined = 保持原关联）
    expect(input.equipmentModelId).toBeUndefined();
    expect(input.structured!.faults).toHaveLength(1);
    expect(input.structured!.faults[0]).toMatchObject({
      branchKind: 'INITIAL',
      mainError: 'Z AXIS OVER LIMIT',
      description: 'Z 轴超限报警',
    });
    expect(input.structured!.steps).toHaveLength(1);
    // 契约修复回归：提交载荷不得携带 stepNo（后端按数组序自动生成，
    // input ReferenceDocumentStructuredStepInput 无该字段，多传会被变量校验拒绝）
    expect(input.structured!.steps[0]).toMatchObject({
      stepCode: 'step-a',
      actionText: '检查电机接线',
      resultCode: 'RESOLVED',
    });
    expect('stepNo' in input.structured!.steps[0]!).toBe(false);
    expect(await screen.findByText('管理修订已保存，生效版本已更新。')).toBeTruthy();
    expect(navigateMock).toHaveBeenCalledWith('/reference-documents/970100');
  });

  it('厂家与机型：修改厂家文本、改选机型 B 时载荷分别携带对应字段', async () => {
    fetchEditableMock.mockResolvedValue({ ok: true, content: structuredContentFixture });
    reviseStructuredMock.mockResolvedValue({ ok: true, id: 970100, revisionNo: 3 });

    render(<ReferenceDocumentRevisePanel documentId={970100} viewer={levelOneViewer} />);

    // 厂家文本预填自当前生效来源，可编辑
    const factoryInput = await screen.findByDisplayValue('某晶圆厂');
    fireEvent.change(factoryInput, { target: { value: '更名后的新厂家' } });
    // 机型改选 A → B（候选来自列表筛选同一查询，仅启用型号；下拉经 portal 渲染）
    await act(async () => {
      fireEvent.mouseDown(screen.getByLabelText('选择适用机型'));
    });
    // 型号 option label 为「modelName（modelCode）」组合格式，按子串匹配
    fireEvent.click(await screen.findByText(/DEV-LITHO-B/));
    fireEvent.change(screen.getByPlaceholderText('管理修订原因（必填，不超过 500 字）'), {
      target: { value: '更正厂家与机型' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存管理修订' }));

    await waitFor(() => {
      expect(reviseStructuredMock).toHaveBeenCalledTimes(1);
    });
    const [, input] = reviseStructuredMock.mock.calls[0];
    expect(input.structured!.customerFactoryName).toBe('更名后的新厂家');
    expect(input.equipmentModelId).toBe(95);
    expect(await screen.findByText('管理修订已保存，生效版本已更新。')).toBeTruthy();
  });

  it('保存失败：提示后端消息，保留全部用户输入', async () => {
    fetchEditableMock.mockResolvedValue({ ok: true, content: structuredContentFixture });
    reviseStructuredMock.mockResolvedValue({
      ok: false,
      reason: 'version-conflict',
      message: '资料版本已更新，请重新读取当前版本后重试。',
    });

    render(<ReferenceDocumentRevisePanel documentId={970100} viewer={levelOneViewer} />);

    fireEvent.change(await screen.findByPlaceholderText('管理修订原因（必填，不超过 500 字）'), {
      target: { value: '勘误' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存管理修订' }));

    expect(
      await screen.findByText('资料版本已更新，请返回资料详情重新进入管理修订。'),
    ).toBeTruthy();
    // 失败后输入保留（不重置表单）
    expect(screen.getByDisplayValue('2026-09-30')).toBeTruthy();
    expect(screen.getByDisplayValue('Z 轴超限报警')).toBeTruthy();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('取消：只返回资料详情，不发出任何请求', async () => {
    fetchEditableMock.mockResolvedValue({ ok: true, content: structuredContentFixture });

    render(<ReferenceDocumentRevisePanel documentId={970100} viewer={levelOneViewer} />);

    fireEvent.click(await screen.findByRole('button', { name: '返回资料详情' }));

    expect(navigateMock).toHaveBeenCalledWith('/reference-documents/970100');
    expect(reviseStructuredMock).not.toHaveBeenCalled();
  });
});

describe('ReferenceDocumentRevisePanel（扁平模式）', () => {
  it('普通资料：正文修订走既有修订语义；结构化报告编辑器不渲染', async () => {
    fetchEditableMock.mockResolvedValue({ ok: true, content: flatContentFixture });
    reviseFlatMock.mockResolvedValue({ ok: true, id: 970101, revisionNo: 2 });

    render(<ReferenceDocumentRevisePanel documentId={970101} viewer={levelOneViewer} />);

    expect(await screen.findByText('管理修订（正文）：普通维护手册')).toBeTruthy();
    expect(screen.queryByText('结构化报告内容')).toBeNull();
    expect(screen.getByDisplayValue('普通资料正文')).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText('管理修订原因（必填，不超过 500 字）'), {
      target: { value: '更正正文' },
    });
    fireEvent.click(screen.getByRole('button', { name: '提交修订' }));

    await waitFor(() => {
      // 扁平模式预填字段非空即随补丁提交（标题未改动时为原值，等价幂等）
      expect(reviseFlatMock).toHaveBeenCalledWith(
        970101,
        1,
        { title: '普通维护手册', contentText: '普通资料正文' },
        '更正正文',
      );
    });
    expect(await screen.findByText('管理修订已保存，生效版本已更新。')).toBeTruthy();
  });
});

describe('ReferenceDocumentRevisePanel（权限与加载）', () => {
  it('非一级管理员：仅提示无权限，不渲染编辑表单、不发起请求', () => {
    render(
      <ReferenceDocumentRevisePanel
        documentId={970100}
        viewer={{ role: 'SUPER_ADMIN', adminLevel: 2 }}
      />,
    );

    expect(screen.getByText('仅一级管理员可以管理修订正式资料。')).toBeTruthy();
    expect(fetchEditableMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '保存管理修订' })).toBeNull();
  });

  it('加载失败：展示后端消息并提供重试与返回', async () => {
    fetchEditableMock.mockResolvedValue({
      ok: false,
      reason: 'not-found',
      message: '历史维修记录不存在或不可访问。',
    });

    render(<ReferenceDocumentRevisePanel documentId={999999} viewer={levelOneViewer} />);

    expect(await screen.findByText('历史维修记录不存在或不可访问。')).toBeTruthy();
    // AntD 两字按钮渲染为「重 试」，用正则匹配可访问名
    expect(screen.getByRole('button', { name: /重\s*试/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: '返回资料详情' })).toBeTruthy();
  });

  it('FAULT_CASE 保护：展示正文保护提示（扁平模式不提供结构化改造）', async () => {
    fetchEditableMock.mockResolvedValue({
      ok: true,
      content: { ...flatContentFixture, faultCaseProtected: true },
    });

    render(<ReferenceDocumentRevisePanel documentId={970101} viewer={levelOneViewer} />);

    expect(
      await screen.findByText('案例资料正文不可通过管理修订修改，请使用案例更正接口。'),
    ).toBeTruthy();
  });
});
