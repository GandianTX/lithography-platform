// src/features/reference-document/infrastructure/reference-document-mock-adapter.spec.ts

import { beforeEach, describe, expect, it } from 'vitest';

import { REFERENCE_DOCUMENT_UPLOAD_EXTENSION_MIME } from './reference-document.types';
import { resetReferenceDocumentMockState } from './reference-document-mock-adapter';
import {
  createReferenceDocument,
  createReferenceDocumentWithFile,
  deleteReferenceDocument,
  downloadReferenceDocumentFile,
  fetchReferenceDocument,
  fetchReferenceDocuments,
  updateReferenceDocument,
  updateReferenceDocumentCase,
} from './reference-document-mock-adapter';

/**
 * Mock 数据访问层契约测试：钉住与后端一致的业务口径
 * （排序 / 筛选 / 分页 / 统一 NOT_FOUND 防探测 / PATCH 语义 / 软删不幂等）。
 */

const VALID_INPUT = {
  title: '新资料',
  documentType: 'CHECKLIST',
  equipmentModelId: null,
  description: null,
  contentText: '正文内容',
};

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

describe('createReferenceDocument', () => {
  it('创建成功返回新 ID，列表可见且昵称由「后端」富集', async () => {
    const result = await createReferenceDocument(VALID_INPUT);

    expect(result.ok).toBe(true);

    if (result.ok) {
      const detail = await fetchReferenceDocument(result.id);

      expect(detail.ok).toBe(true);

      const page = await fetchReferenceDocuments({ page: 1, pageSize: 1 });

      // 新创建时间最新，排在第一
      expect(page.items[0].id).toBe(result.id);
      expect(page.items[0].creatorNickname).toBe('系统管理员');
    }
  });

  it.each([
    ['标题空白', { ...VALID_INPUT, title: '   ' }],
    ['标题超长', { ...VALID_INPUT, title: '长'.repeat(256) }],
    ['类型空白', { ...VALID_INPUT, documentType: '' }],
    ['类型超长', { ...VALID_INPUT, documentType: 'A'.repeat(101) }],
    ['文本内容空白', { ...VALID_INPUT, contentText: ' \n ' }],
  ])('%s 拒绝为 invalid-input', async (_name, input) => {
    const result = await createReferenceDocument(input);

    expect(result).toMatchObject({ ok: false, reason: 'invalid-input' });
  });

  it('型号不存在拒绝为 model-not-found', async () => {
    const result = await createReferenceDocument({ ...VALID_INPUT, equipmentModelId: 123456 });

    expect(result).toMatchObject({ ok: false, reason: 'model-not-found' });
  });
});

describe('updateReferenceDocument', () => {
  it('PATCH 语义：undefined 保持原值，null 清空型号与说明', async () => {
    const result = await updateReferenceDocument(970002, {
      title: '改名后的维护指南',
      equipmentModelId: null,
      description: null,
    });

    expect(result).toMatchObject({ ok: true, id: 970002 });

    const detail = await fetchReferenceDocument(970002);

    expect(detail.ok).toBe(true);

    if (detail.ok) {
      // undefined 字段保持原值
      expect(detail.detail.documentType).toBe('MAINTENANCE_GUIDE');
      expect(detail.detail.contentText).toContain('光源维护指南');
      // 显式 null 清空
      expect(detail.detail.equipmentModelId).toBeNull();
      expect(detail.detail.equipmentModelName).toBeNull();
      expect(detail.detail.description).toBeNull();
      expect(detail.detail.title).toBe('改名后的维护指南');
    }
  });

  it('必填字段显式 null / 型号不存在拒绝；无存储引用资料清空正文拒绝', async () => {
    await expect(updateReferenceDocument(970001, { title: null })).resolves.toMatchObject({
      ok: false,
      reason: 'invalid-input',
    });
    await expect(updateReferenceDocument(970001, { documentType: null })).resolves.toMatchObject({
      ok: false,
      reason: 'invalid-input',
    });
    // 纯文本资料（无存储元数据）清空正文仍拒绝，与后端双空防御同口径
    await expect(updateReferenceDocument(970005, { contentText: '  ' })).resolves.toMatchObject({
      ok: false,
      reason: 'invalid-input',
    });
    // 有文件名但无存储引用（970001）：后端按存储引用判定，清空正文同样拒绝
    await expect(updateReferenceDocument(970001, { contentText: '  ' })).resolves.toMatchObject({
      ok: false,
      reason: 'invalid-input',
    });
    await expect(
      updateReferenceDocument(970001, { equipmentModelId: 999999 }),
    ).resolves.toMatchObject({ ok: false, reason: 'model-not-found' });
  });

  it('已有文件的资料允许清空正文（编辑防御放宽，与后端同口径）', async () => {
    await expect(updateReferenceDocument(970002, { contentText: '  ' })).resolves.toMatchObject({
      ok: true,
      id: 970002,
    });

    const detail = await fetchReferenceDocument(970002);

    expect(detail.ok).toBe(true);

    if (detail.ok) {
      expect(detail.detail.contentText).toBeNull();
      expect(detail.detail.originalFilename).not.toBeNull();
      expect(detail.detail.hasFile).toBe(true);
    }
  });

  it('不存在 / 已软删统一 not-found', async () => {
    await expect(updateReferenceDocument(999999, { title: 'x' })).resolves.toMatchObject({
      ok: false,
      reason: 'not-found',
    });
    await expect(updateReferenceDocument(970004, { title: 'x' })).resolves.toMatchObject({
      ok: false,
      reason: 'not-found',
    });
  });

  it('案例保护：FAULT_CASE 通用编辑不得改类型 / 正文，普通资料转案例拒绝', async () => {
    await expect(
      updateReferenceDocument(970031, { documentType: 'ERROR_CODE_MANUAL' }),
    ).resolves.toMatchObject({ ok: false, reason: 'invalid-input' });

    await expect(
      updateReferenceDocument(970031, { contentText: '改写正文' }),
    ).resolves.toMatchObject({ ok: false, reason: 'invalid-input' });

    // 普通资料不能借此转为 FAULT_CASE（类型保留值只能来自投稿发布）
    await expect(
      updateReferenceDocument(970002, { documentType: 'FAULT_CASE' }),
    ).resolves.toMatchObject({ ok: false, reason: 'invalid-input' });

    // 拒绝为终态：案例资料未被改动
    const detail = await fetchReferenceDocument(970031);

    expect(detail.ok).toBe(true);

    if (detail.ok) {
      expect(detail.detail.documentType).toBe('FAULT_CASE');
      expect(detail.detail.contentText).toContain('处理状态：已解决');
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
    const result = await deleteReferenceDocument(970003);

    expect(result).toMatchObject({ ok: true });
    await expect(fetchReferenceDocument(970003)).resolves.toMatchObject({
      ok: false,
      reason: 'not-found',
    });

    const page = await fetchReferenceDocuments({ page: 1, pageSize: 50 });

    expect(page.items.some((item) => item.id === 970003)).toBe(false);
  });

  it('重复软删不幂等：统一 not-found（区别于维修申请的后端口径）', async () => {
    await deleteReferenceDocument(970003);

    await expect(deleteReferenceDocument(970003)).resolves.toMatchObject({
      ok: false,
      reason: 'not-found',
    });
    await expect(deleteReferenceDocument(999999)).resolves.toMatchObject({
      ok: false,
      reason: 'not-found',
    });
  });
});

describe('createReferenceDocumentWithFile（REST 同签名模拟）', () => {
  const VALID_FILE_INPUT = {
    title: '文件资料',
    documentType: 'MAINTENANCE_GUIDE',
    equipmentModelId: null,
    description: null,
    contentText: null,
    file: new File(['bytes'], 'machine-manual.pdf', { type: 'application/pdf' }),
  };

  it('仅文件创建成功：落库存储元数据，正文为空；contentText 并存时同时保留', async () => {
    const fileOnly = await createReferenceDocumentWithFile(VALID_FILE_INPUT);

    expect(fileOnly).toMatchObject({ ok: true });

    if (fileOnly.ok) {
      const detail = await fetchReferenceDocument(fileOnly.id);

      expect(detail.ok).toBe(true);

      if (detail.ok) {
        expect(detail.detail.originalFilename).toBe('machine-manual.pdf');
        expect(detail.detail.mimeType).toBe('application/pdf');
        expect(detail.detail.contentText).toBeNull();
      }
    }

    const withText = await createReferenceDocumentWithFile({
      ...VALID_FILE_INPUT,
      title: '图文并存资料',
      contentText: '补充正文',
    });

    expect(withText).toMatchObject({ ok: true });

    if (withText.ok) {
      const detail = await fetchReferenceDocument(withText.id);

      if (detail.ok) {
        expect(detail.detail.contentText).toBe('补充正文');
      }
    }
  });

  it.each([
    ['标题空白', { ...VALID_FILE_INPUT, title: ' ' }],
    ['白名单外扩展名', { ...VALID_FILE_INPUT, file: new File(['x'], 'virus.exe') }],
    ['无扩展名', { ...VALID_FILE_INPUT, file: new File(['x'], 'no-extension') }],
    ['型号不存在', { ...VALID_FILE_INPUT, equipmentModelId: 999999 }],
  ])('%s 拒绝', async (_name, input) => {
    const result = await createReferenceDocumentWithFile(input);

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(['invalid-input', 'file-type-not-allowed', 'model-not-found']).toContain(
        result.reason,
      );
    }
  });
});

/**
 * 上传策略同源契约：扩展名白名单的唯一定义在 reference-document.types
 * （表单由此派生即时提示，Mock 由此取 MIME）。
 *
 * 断言「表内全量被接受 + 表外一律拒绝」，使「允许类型变化」只需改一处常量：
 * 若有人在任一消费方另写一份白名单，本组用例会因表内/表外集合不一致而失败，
 * 而不是靠默认环境下的等值断言自证。
 */
describe('上传扩展名策略与 Mock 文件通道同源', () => {
  it.each(Object.entries(REFERENCE_DOCUMENT_UPLOAD_EXTENSION_MIME))(
    '策略表内的 .%s 被接受，并按表回填 MIME %s',
    async (extension, mimeType) => {
      const result = await createReferenceDocumentWithFile({
        title: `扩展名契约 ${extension}`,
        documentType: 'MAINTENANCE_GUIDE',
        equipmentModelId: null,
        description: null,
        contentText: null,
        file: new File(['bytes'], `sample.${extension}`, { type: 'application/octet-stream' }),
      });

      expect(result.ok).toBe(true);

      if (result.ok) {
        const detail = await fetchReferenceDocument(result.id);

        expect(detail.ok).toBe(true);

        if (detail.ok) {
          expect(detail.detail.mimeType).toBe(mimeType);
        }
      }
    },
  );

  it.each(['exe', 'sh', 'zip', ''])(
    '策略表外的 .%s 一律拒绝为 file-type-not-allowed',
    async (extension) => {
      const result = await createReferenceDocumentWithFile({
        title: '表外扩展名',
        documentType: 'MAINTENANCE_GUIDE',
        equipmentModelId: null,
        description: null,
        contentText: null,
        file: new File(['bytes'], extension ? `sample.${extension}` : 'sample', {
          type: 'application/octet-stream',
        }),
      });

      expect(result).toEqual({
        ok: false,
        reason: 'file-type-not-allowed',
        message: '不允许上传该类型的文件。',
      });
    },
  );
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
