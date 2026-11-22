// src/features/reference-document/infrastructure/reference-document-mock-adapter.spec.ts

import { beforeEach, describe, expect, it } from 'vitest';

import { resetReferenceDocumentMockState } from './reference-document-mock-adapter';
import {
  adminDeleteReferenceDocument,
  correctReferenceDocumentOwnership,
  deleteReferenceDocument,
  downloadReferenceDocumentFile,
  fetchReferenceDocument,
  fetchReferenceDocuments,
  offlineReferenceDocument,
  reviseReferenceDocument,
  updateReferenceDocumentCase,
} from './reference-document-mock-adapter';

/**
 * Mock 数据访问层契约测试：钉住与后端一致的业务口径
 * （排序 / 筛选 / 分页 / 统一 NOT_FOUND 防探测 / PATCH 语义 / 软删不幂等）。
 */

beforeEach(() => {
  resetReferenceDocumentMockState();
});

describe('fetchReferenceDocuments', () => {
  it('仅返回未软删条目，按 createdAt DESC + id DESC 排序并分页', async () => {
    const page1 = await fetchReferenceDocuments({ page: 1, pageSize: 10 });

    // 种子 970004 已软删不可见；可见 = 种子 6 未删 + 案例 970031 + 24 批量 = 30
    expect(page1.total).toBe(30);
    expect(page1.items).toHaveLength(10);
    // 最新创建时间在前（案例 970031 为最新）
    expect(page1.items[0].createdAt >= page1.items[1].createdAt).toBe(true);
    expect(page1.items[0].id).toBe(970031);
    expect(page1.items.some((item) => item.id === 970004)).toBe(false);

    const page3 = await fetchReferenceDocuments({ page: 3, pageSize: 10 });

    expect(page3.items).toHaveLength(10);
    // 最早种子 970001 按时间序排在末页末尾
    expect(page3.items[page3.items.length - 1].id).toBe(970001);
  });

  it('标题模糊搜索 / 类型等值 / 型号等值筛选可组合', async () => {
    const byKeyword = await fetchReferenceDocuments(
      { page: 1, pageSize: 20 },
      { titleKeyword: '错误代码手册' },
    );

    expect(byKeyword.items.every((item) => item.title.includes('错误代码手册'))).toBe(true);
    expect(byKeyword.items.some((item) => item.id === 970001)).toBe(true);

    const byType = await fetchReferenceDocuments(
      { page: 1, pageSize: 50 },
      { documentType: 'SAFETY_STANDARD' },
    );

    expect(byType.items.every((item) => item.documentType === 'SAFETY_STANDARD')).toBe(true);

    const byModel = await fetchReferenceDocuments(
      { page: 1, pageSize: 50 },
      { equipmentModelId: 51 },
    );

    expect(byModel.items.every((item) => item.equipmentModelId === 51)).toBe(true);
    expect(byModel.total).toBeGreaterThan(0);

    const combined = await fetchReferenceDocuments(
      { page: 1, pageSize: 50 },
      { titleKeyword: 'Mock', equipmentModelId: 51 },
    );

    expect(
      combined.items.every((item) => item.title.includes('Mock') && item.equipmentModelId === 51),
    ).toBe(true);
  });

  it('列表项携带组织名 / 入库方式 / 案例处理状态；普通资料案例字段为空', async () => {
    const page = await fetchReferenceDocuments({ page: 1, pageSize: 50 });

    const caseItem = page.items.find((item) => item.id === 970031);
    const normalItem = page.items.find((item) => item.id === 970002);

    expect(caseItem).toMatchObject({
      documentType: 'FAULT_CASE',
      organizationName: '甲方默认组织',
      ingestMethod: 'REVIEWED_SUBMISSION',
      caseHandlingStatus: 'RESOLVED',
      equipmentModelText: null,
    });
    expect(normalItem).toMatchObject({
      organizationName: '甲方默认组织',
      ingestMethod: 'ADMIN_DIRECT',
      caseHandlingStatus: null,
    });
  });

  it('caseHandlingStatus 等值筛选仅命中案例资料', async () => {
    const resolved = await fetchReferenceDocuments(
      { page: 1, pageSize: 50 },
      { caseHandlingStatus: 'RESOLVED' },
    );

    expect(resolved.total).toBe(1);
    expect(resolved.items.map((item) => item.id)).toEqual([970031]);

    const unresolved = await fetchReferenceDocuments(
      { page: 1, pageSize: 50 },
      { caseHandlingStatus: 'UNRESOLVED' },
    );

    expect(unresolved.total).toBe(0);
  });
});

describe('fetchReferenceDocument', () => {
  it('详情返回完整元数据与文本内容，不含软删标志', async () => {
    const result = await fetchReferenceDocument(970002);

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.detail).toMatchObject({
        id: 970002,
        title: 'NXE:3400C 光源维护指南（Mock）',
        equipmentModelId: 51,
        originalFilename: 'nxe-3400c-source-guide-mock.pdf',
        mimeType: 'application/pdf',
      });
      expect(result.detail.contentText).toContain('光源维护指南');
      expect('deprecated' in result.detail).toBe(false);
    }
  });

  it('不存在与已软删统一 not-found（防探测，不区分原因）', async () => {
    const missing = await fetchReferenceDocument(999999);
    const softDeleted = await fetchReferenceDocument(970004);

    expect(missing).toMatchObject({ ok: false, reason: 'not-found' });
    expect(softDeleted).toMatchObject({ ok: false, reason: 'not-found' });
    expect(missing.ok ? '' : missing.message).toBe(softDeleted.ok ? '' : softDeleted.message);
  });

  it('案例资料详情携带 caseDetail；普通资料 caseDetail 为空（前端需兼容可空）', async () => {
    const caseResult = await fetchReferenceDocument(970031);
    const normalResult = await fetchReferenceDocument(970002);

    expect(caseResult.ok).toBe(true);
    expect(normalResult.ok).toBe(true);

    if (caseResult.ok && normalResult.ok) {
      expect(caseResult.detail.caseDetail).toMatchObject({
        errorCode: 'E-STAGE-301',
        handlingStatus: 'RESOLVED',
        phenomenon: '曝光工位反复报干涉仪信号丢失，复位后短时恢复。',
        resolution: '清洁与重标定后连续 500 片无复现。',
      });
      // 详情与后端 Detail DTO 同形：不含 caseHandlingStatus（S7 真机样例核验；案例状态经 caseDetail 表达）
      expect(caseResult.detail).not.toHaveProperty('caseHandlingStatus');
      expect(caseResult.detail.contentText).toContain('处理状态：已解决');
      expect(normalResult.detail.caseDetail).toBeNull();
      expect(normalResult.detail).not.toHaveProperty('caseHandlingStatus');
    }
  });
});

describe('updateReferenceDocumentCase（案例专属更正）', () => {
  it('成功更正：明细合并、正文重新生成、处理状态同步', async () => {
    const result = await updateReferenceDocumentCase(970031, {
      handlingStatus: 'IN_PROGRESS',
      resolution: null,
      actionTaken: '更换干涉仪光学头并复测。',
    });

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.id).toBe(970031);
      expect(result.updatedAt).toBeTruthy();
    }

    const detail = await fetchReferenceDocument(970031);

    expect(detail.ok).toBe(true);

    if (detail.ok) {
      expect(detail.detail.caseDetail).toMatchObject({
        handlingStatus: 'IN_PROGRESS',
        resolution: null,
        actionTaken: '更换干涉仪光学头并复测。',
        // undefined 字段保持原值
        phenomenon: '曝光工位反复报干涉仪信号丢失，复位后短时恢复。',
      });
      expect(detail.detail).not.toHaveProperty('caseHandlingStatus');
      // 正文由明细重新生成（与明细不脱节）
      expect(detail.detail.contentText).toContain('处理状态：处理中');
      expect(detail.detail.contentText).not.toContain('处理结果');
    }
  });

  it('空补丁 / 非案例资料 / 不存在统一拒绝口径', async () => {
    await expect(updateReferenceDocumentCase(970031, {})).resolves.toMatchObject({
      ok: false,
      reason: 'invalid-input',
    });
    // 非案例资料 invalid-input（后端口径，不是 not-found）
    await expect(updateReferenceDocumentCase(970002, { phenomenon: 'x' })).resolves.toMatchObject({
      ok: false,
      reason: 'invalid-input',
    });
    await expect(updateReferenceDocumentCase(999999, { phenomenon: 'x' })).resolves.toMatchObject({
      ok: false,
      reason: 'not-found',
    });
    await expect(updateReferenceDocumentCase(970004, { phenomenon: 'x' })).resolves.toMatchObject({
      ok: false,
      reason: 'not-found',
    });
  });

  it('必填清空 / 已解决必填结果 / 机型互斥与存在性拒绝', async () => {
    await expect(updateReferenceDocumentCase(970031, { phenomenon: null })).resolves.toMatchObject({
      ok: false,
      reason: 'invalid-input',
    });
    await expect(updateReferenceDocumentCase(970031, { title: '  ' })).resolves.toMatchObject({
      ok: false,
      reason: 'invalid-input',
    });
    await expect(
      updateReferenceDocumentCase(970031, { handlingStatus: null }),
    ).resolves.toMatchObject({ ok: false, reason: 'invalid-input' });
    await expect(
      updateReferenceDocumentCase(970031, { handlingStatus: 'RESOLVED', resolution: null }),
    ).resolves.toMatchObject({ ok: false, reason: 'invalid-input' });
    // 机型互斥：案例现值 equipmentModelId=49，仅设置机型文字即冲突（合并后最终态判定）
    await expect(
      updateReferenceDocumentCase(970031, { equipmentModelText: 'ASML XT:1900i' }),
    ).resolves.toMatchObject({ ok: false, reason: 'invalid-input' });
    // 变更机型时校验存在
    await expect(
      updateReferenceDocumentCase(970031, { equipmentModelId: 999999 }),
    ).resolves.toMatchObject({ ok: false, reason: 'model-not-found' });
  });

  it('替换机型需同一补丁清空一侧并设置另一侧', async () => {
    const result = await updateReferenceDocumentCase(970031, {
      equipmentModelId: null,
      equipmentModelText: 'ASML XT:1900i（手填）',
    });

    expect(result).toMatchObject({ ok: true, id: 970031 });

    const detail = await fetchReferenceDocument(970031);

    expect(detail.ok).toBe(true);

    if (detail.ok) {
      expect(detail.detail.equipmentModelId).toBeNull();
      expect(detail.detail.equipmentModelName).toBeNull();
      expect(detail.detail.equipmentModelText).toBe('ASML XT:1900i（手填）');
    }
  });
});

describe('deleteReferenceDocument', () => {
  it('软删后列表与详情不可见', async () => {
    const result = await deleteReferenceDocument(970003, 1);

    expect(result).toMatchObject({ ok: true });
    await expect(fetchReferenceDocument(970003)).resolves.toMatchObject({
      ok: false,
      reason: 'not-found',
    });

    const page = await fetchReferenceDocuments({ page: 1, pageSize: 50 });

    expect(page.items.some((item) => item.id === 970003)).toBe(false);
  });

  it('重复软删不幂等：统一 not-found（区别于维修申请的后端口径）', async () => {
    await deleteReferenceDocument(970003, 1);

    await expect(deleteReferenceDocument(970003, 1)).resolves.toMatchObject({
      ok: false,
      reason: 'not-found',
    });
    await expect(deleteReferenceDocument(999999, 1)).resolves.toMatchObject({
      ok: false,
      reason: 'not-found',
    });
  });
});

describe('downloadReferenceDocumentFile（REST 同签名模拟）', () => {
  it('文件资料返回合成字节与原始文件名', async () => {
    const result = await downloadReferenceDocumentFile(970002);

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.filename).toBe('nxe-3400c-source-guide-mock.pdf');
      expect(result.blob.size).toBeGreaterThan(0);
    }
  });

  it('纯文本资料 file-not-available；不存在与已软删统一 not-found', async () => {
    await expect(downloadReferenceDocumentFile(970005)).resolves.toMatchObject({
      ok: false,
      reason: 'file-not-available',
    });
    // 有文件名但无存储引用的行（970001）同样不承诺可下载
    await expect(downloadReferenceDocumentFile(970001)).resolves.toMatchObject({
      ok: false,
      reason: 'file-not-available',
    });
    await expect(downloadReferenceDocumentFile(999999)).resolves.toMatchObject({
      ok: false,
      reason: 'not-found',
    });
    await expect(downloadReferenceDocumentFile(970004)).resolves.toMatchObject({
      ok: false,
      reason: 'not-found',
    });
  });
});

describe('reviseReferenceDocument（任务 07 R058 管理修订 · Mock）', () => {
  it('修订标题成功并推进生效版本；expected_version 过期拒绝', async () => {
    await expect(
      reviseReferenceDocument(970002, 1, { title: '改名后的维护指南' }, '勘误'),
    ).resolves.toEqual({ ok: true, id: 970002, revisionNo: 2 });

    await expect(
      reviseReferenceDocument(970002, 1, { title: '旧版本覆盖' }, 'r'),
    ).resolves.toMatchObject({ ok: false, reason: 'version-conflict' });
  });

  it('FAULT_CASE 正文修订拒绝（须走案例更正）；正文清空无文件拒绝；原因缺失拒绝', async () => {
    await expect(
      reviseReferenceDocument(970031, 1, { contentText: 'x' }, 'r'),
    ).resolves.toMatchObject({ ok: false, reason: 'invalid-input' });
    await expect(
      reviseReferenceDocument(970001, 1, { contentText: null }, 'r'),
    ).resolves.toMatchObject({ ok: false, reason: 'invalid-input' });
    await expect(reviseReferenceDocument(970002, 1, { title: 'x' }, '   ')).resolves.toMatchObject({
      ok: false,
      reason: 'invalid-input',
    });
  });
});

describe('offlineReferenceDocument（任务 07 R059 下架 · Mock）', () => {
  it('下架后列表与详情统一不可见（防探测口径），版本推进', async () => {
    await expect(offlineReferenceDocument(970002, 1, '重复条目')).resolves.toEqual({
      ok: true,
      id: 970002,
      revisionNo: 2,
    });

    await expect(fetchReferenceDocument(970002)).resolves.toMatchObject({
      ok: false,
      reason: 'not-found',
    });
    const page = await fetchReferenceDocuments({ page: 1, pageSize: 50 });

    expect(page.items.some((item) => item.id === 970002)).toBe(false);
  });
});

describe('adminDeleteReferenceDocument（任务 07 R060 管理删除 · Mock）', () => {
  it('管理删除软删后统一不可见', async () => {
    await expect(adminDeleteReferenceDocument(970003, 1, '违规内容')).resolves.toMatchObject({
      ok: true,
    });
    await expect(fetchReferenceDocument(970003)).resolves.toMatchObject({
      ok: false,
      reason: 'not-found',
    });
  });
});

describe('correctReferenceDocumentOwnership（任务 07 R061-02 归属更正 · Mock）', () => {
  it('更正成功推进版本；未提交字段拒绝；版本过期拒绝', async () => {
    await expect(
      correctReferenceDocumentOwnership(970002, 1, {
        verificationReason: '核实为原公司同事上传',
        ownerOrganizationId: 910001,
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      correctReferenceDocumentOwnership(970001, 1, { verificationReason: 'r' }),
    ).resolves.toMatchObject({ ok: false, reason: 'invalid-input' });
    await expect(
      correctReferenceDocumentOwnership(970001, 99, {
        verificationReason: 'r',
        ownerOrganizationId: 910001,
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'version-conflict' });
  });
});
