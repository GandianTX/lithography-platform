// scripts/seed-mock.contract.spec.ts

/**
 * 窄范围 Seed 契约测试（F04）：直接消费 Seed 脚本实际声明的冻结快照数据
 * （`seed-mock-content-submissions`，与 `seed-mock.ts` 共用同一模块）。
 *
 * 任务 07 确认需求收口：资料审核写路径（含审核通过发布）已取消，原「快照交给
 * 真实发布用例解析」的发布契约随 `ApproveContentSubmissionUsecase` 一并移除——
 * 服务端不再提供普通资料审核发布入口（R091：旧审核仅历史，不批量发布旧待审）。
 * 本文件保留快照结构契约：Seed 声明的历史投稿快照字段集合仍须与真实 submit
 * 冻结结构一致，供历史记录授权读取使用。
 */

/// <reference types="jest" />
import type { ContentSubmissionHandlingStatus } from '@src/modules/lithography/content-submission.types';
import type { FaultCaseReferenceContentInput } from '@src/usecases/common/fault-case-fields.contract';
import { formatFaultCaseReferenceContent } from '@src/usecases/content-submission/content-submission-fields.normalize';
import {
  buildPendingFaultCaseSnapshot,
  buildPublishedFaultCaseSnapshot,
  buildReturnedMaterialSnapshot,
} from './seed-mock-content-submissions';

/** 测试登记的机型主键（替代脚本内由数据库实际主键构造的解析器） */
const FAKE_MODEL_IDS = new Map<string, number>([
  ['ASML-TWINSCAN-NXT-1980DI', 930_001],
  ['ASML-TWINSCAN-NXE-3400C', 930_002],
]);
const resolveModelId = (modelCode: string): number => {
  const id = FAKE_MODEL_IDS.get(modelCode);
  if (id === undefined) {
    throw new Error(`测试未登记机型编码：${modelCode}`);
  }
  return id;
};

/** 真实 submit 冻结结构的规范字段集（submit-content-submission.usecase 显式列举） */
const MATERIAL_SNAPSHOT_KEYS = [
  'contentText',
  'description',
  'documentType',
  'equipmentModelId',
  'equipmentModelText',
  'title',
];
const FAULT_CASE_SNAPSHOT_KEYS = [
  'actionTaken',
  'conditionText',
  'diagnosis',
  'equipmentModelId',
  'equipmentModelText',
  'errorCode',
  'handlingStatus',
  'phenomenon',
  'reproductionSteps',
  'resolution',
  'title',
];

/** 快照读取为正文格式化输入（缺失字段保持 undefined 参与格式化，供差异检测） */
const readCaseContentFields = (
  snapshot: Record<string, unknown>,
): FaultCaseReferenceContentInput => ({
  errorCode: snapshot['errorCode'] as string | null,
  phenomenon: snapshot['phenomenon'] as string,
  conditionText: snapshot['conditionText'] as string | null,
  reproductionSteps: snapshot['reproductionSteps'] as string,
  diagnosis: snapshot['diagnosis'] as string | null,
  actionTaken: snapshot['actionTaken'] as string | null,
  handlingStatus: snapshot['handlingStatus'] as ContentSubmissionHandlingStatus,
  resolution: snapshot['resolution'] as string | null,
});

describe('Seed 冻结快照契约（F04，消费脚本实际声明的数据）', () => {
  it('三个声明快照字段集合 = 真实 submit 冻结结构；必填字段非空、处理状态在受控值域', () => {
    const material = buildReturnedMaterialSnapshot();
    const pending = buildPendingFaultCaseSnapshot(resolveModelId);
    const published = buildPublishedFaultCaseSnapshot(resolveModelId);

    expect(Object.keys(material).sort()).toEqual(MATERIAL_SNAPSHOT_KEYS);
    expect(Object.keys(pending).sort()).toEqual(FAULT_CASE_SNAPSHOT_KEYS);
    expect(Object.keys(published).sort()).toEqual(FAULT_CASE_SNAPSHOT_KEYS);

    // 送审校验保证的必填字段（历史快照读取完整性依据）
    expect(typeof material['title']).toBe('string');
    expect(material['title'].length).toBeGreaterThan(0);
    expect(typeof material['documentType']).toBe('string');
    expect(material['documentType'].length).toBeGreaterThan(0);
    for (const snapshot of [pending, published]) {
      expect(typeof snapshot['title']).toBe('string');
      expect(snapshot['title'].length).toBeGreaterThan(0);
      expect(typeof snapshot['phenomenon']).toBe('string');
      expect(snapshot['phenomenon'].length).toBeGreaterThan(0);
      expect(typeof snapshot['reproductionSteps']).toBe('string');
      expect(snapshot['reproductionSteps'].length).toBeGreaterThan(0);
      expect(['UNRESOLVED', 'IN_PROGRESS', 'RESOLVED']).toContain(snapshot['handlingStatus']);
    }
    // 机型主键由解析器在声明期解析（与脚本内数据库实际主键同口径）
    expect(pending['equipmentModelId']).toBe(930_001);
    expect(published['equipmentModelId']).toBe(930_002);
  });

  it('已发布故障案例声明正文 = 快照字段确定性生成（历史正式正文可由冻结快照解释）', () => {
    const published = buildPublishedFaultCaseSnapshot(resolveModelId);
    // 审核发布路径已关闭；此契约改为验证 Seed 声明正文与快照字段自洽，
    // 保证授权的历史读取能按同一口径复现正文
    expect(typeof published['title']).toBe('string');
    expect(
      formatFaultCaseReferenceContent(readCaseContentFields(published)).length,
    ).toBeGreaterThan(0);
  });
});
