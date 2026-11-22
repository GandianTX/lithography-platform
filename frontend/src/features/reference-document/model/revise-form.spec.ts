// src/features/reference-document/model/revise-form.spec.ts
//
// 任务 07 管理修订表单模型契约回归（离线纯函数）。
//
// 2026-11-22 契约修复回归：提交载荷 steps 曾携带 stepNo，而后端
// input ReferenceDocumentStructuredStepInput 不接受该字段（服务端按
// 数组序自动生成），导致独立修订页每次保存都被 GraphQL 变量校验以
// BAD_USER_INPUT 拒绝。本规格钉住「提交步骤键集 = 后端 input 白名单」，
// 并覆盖多步骤保序、步骤新故障关联与结果归一。
//
// 边界说明：本规格只能钉住前端载荷的键集与语义；载荷能否通过真实
// GraphQL schema 变量校验由后端契约规格
// backend/src/usecases/reference-document/revise-reference-document-structured
// .input-contract.spec.ts 以生成的 schema SDL 实测，两侧共同构成契约回归。
import { describe, expect, it } from 'vitest';

import type { ReferenceDocumentStructuredContent } from '../infrastructure/reference-document.types';

import { createReviseEditorValue, toStructuredRevisePayload } from './revise-form';

const SAMPLE_STRUCTURED: ReferenceDocumentStructuredContent = {
  schemaVersion: 1,
  maintenanceDate: '2026-11-22',
  maintenanceEngineerName: '开发工程师 A',
  customerFactoryName: 'R3厂家标记-原始值',
  equipmentModelText: null,
  resetResult: 'NORMAL',
  faults: [
    {
      branchKind: 'INITIAL',
      stepCode: null,
      phaseCode: 'PHASE_02',
      mainError: null,
      unitError: null,
      source: null,
      errorType: null,
      gpibStatus: null,
      faultStatus: null,
      description: '初始故障（测试）',
      action: null,
    },
  ],
  steps: [
    {
      stepCode: 'STEP-1',
      stepNo: 1,
      phaseCode: 'PHASE_01',
      errorCode: null,
      partName: null,
      actionText: '检查（测试）',
      resultCode: 'RESOLVED',
    },
    {
      stepCode: 'STEP-2',
      stepNo: 2,
      phaseCode: 'PHASE_04',
      errorCode: null,
      partName: null,
      actionText: '更换（测试）',
      resultCode: 'RESOLVED',
    },
    {
      stepCode: 'STEP-3',
      stepNo: 3,
      phaseCode: null,
      errorCode: null,
      partName: null,
      actionText: '复测（测试）',
      resultCode: 'NEW_FAULT',
    },
  ],
  handlingResult: 'FIXED',
  closureReason: null,
  actualCause: null,
  repairActions: null,
  verificationResult: null,
  supplementaryNote: null,
};

/** 后端 input ReferenceDocumentStructuredStepInput 的完整字段白名单 */
const BACKEND_STEP_INPUT_KEYS = [
  'actionText',
  'errorCode',
  'partName',
  'phaseCode',
  'resultCode',
  'stepCode',
] as const;

describe('toStructuredRevisePayload（管理修订提交载荷契约）', () => {
  it('步骤载荷键集与后端 input 白名单完全一致：不含 stepNo，多余键会被 GraphQL 变量校验拒绝', () => {
    const form = {
      title: 't',
      description: '',
      customerFactoryName: 'R3厂家标记-修订值',
      editor: createReviseEditorValue(SAMPLE_STRUCTURED),
      handlingResult: 'FIXED',
      closureReason: '',
      actualCause: '',
      repairActions: '',
      verificationResult: '',
      equipmentModelId: 2,
    };
    const payload = toStructuredRevisePayload(form);
    for (const step of payload.steps) {
      expect(Object.keys(step).sort()).toEqual([...BACKEND_STEP_INPUT_KEYS].sort());
      expect('stepNo' in step).toBe(false);
    }
  });

  it('多步骤保序：提交数组顺序与编辑器顺序一致，无 stepNo 字段', () => {
    const editor = createReviseEditorValue(SAMPLE_STRUCTURED);
    const form = {
      title: 't',
      description: '',
      customerFactoryName: '厂',
      editor,
      handlingResult: 'FIXED',
      closureReason: '',
      actualCause: '',
      repairActions: '',
      verificationResult: '',
      equipmentModelId: null,
    };
    const payload = toStructuredRevisePayload(form);
    expect(payload.steps.map((step) => step.stepCode)).toEqual(['STEP-1', 'STEP-2', 'STEP-3']);
    // 服务端按数组序生成 stepNo（index+1），前端不提交任何序号
    expect(payload.steps.every((step) => !('stepNo' in step))).toBe(true);
  });

  it('步骤新故障面板按 stepCode 稳定关联（调序不改关联），结果空值归一 UNRESOLVED', () => {
    const editor = createReviseEditorValue(SAMPLE_STRUCTURED);
    // 编辑器为 NEW_FAULT 步骤自动生成空面板；填充描述使其进入有效面板集合
    const step3 = editor.steps.find((step) => step.stepCode === 'STEP-3');
    expect(step3).toBeDefined();
    const step3Panel = editor.panels.find(
      (panel) => panel.panelType === 'STEP_NEW_FAULT' && panel.stepKey === step3!.key,
    );
    expect(step3Panel).toBeDefined();
    step3Panel!.description = '步骤新故障（测试）';
    const form = {
      title: 't',
      description: '',
      customerFactoryName: '厂',
      editor,
      handlingResult: 'FIXED',
      closureReason: '',
      actualCause: '',
      repairActions: '',
      verificationResult: '',
      equipmentModelId: null,
    };
    const payload = toStructuredRevisePayload(form);
    const stepPanels = payload.faults.filter((fault) => fault.branchKind === 'STEP_NEW_FAULT');
    expect(stepPanels).toHaveLength(1);
    expect(stepPanels[0]?.stepCode).toBe('STEP-3');
    expect(payload.steps.find((step) => step.stepCode === 'STEP-3')?.resultCode).toBe('NEW_FAULT');
    // 空结果字符串归一为 UNRESOLVED（其余步骤不受影响）
    editor.steps[0]!.resultCode = '';
    const normalized = toStructuredRevisePayload(form);
    expect(normalized.steps.find((step) => step.stepCode === 'STEP-1')?.resultCode).toBe(
      'UNRESOLVED',
    );
  });
});
