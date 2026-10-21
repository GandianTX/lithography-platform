// src/modules/lithography/reference-document.service.spec.ts

import { REFERENCE_DOCUMENT_ERROR } from '@core/common/errors/domain-error';
import { ReferenceDocumentService } from './reference-document.service';

const makeRepo = () => ({
  create: jest.fn((value: unknown) => value),
  save: jest.fn(),
  update: jest.fn(),
});

describe('ReferenceDocumentService', () => {
  it('插入显式落初始状态：deprecated=false；本组织归属与入库方式透传落库', async () => {
    const repo = makeRepo();
    repo.save.mockResolvedValue({ id: 970101 });
    const service = new ReferenceDocumentService(repo as never);

    const result = await service.insertDocument({
      title: '新资料',
      documentType: 'MANUAL',
      equipmentModelId: null,
      description: null,
      contentText: '内容',
      originalFilename: null,
      mimeType: null,
      storageBackend: null,
      storageReference: null,
      createdByAccountId: 900001,
      ownerOrganizationId: 910001,
      ingestMethod: 'ADMIN_DIRECT',
    });

    expect(result).toEqual({ id: 970101 });
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '新资料',
        createdByAccountId: 900001,
        ownerOrganizationId: 910001,
        ingestMethod: 'ADMIN_DIRECT',
        deprecated: false,
        originalFilename: null,
        mimeType: null,
        storageBackend: null,
        storageReference: null,
      }),
    );
  });

  it('插入落库失败包装为 CREATION_FAILED，details 不携带原始数据库错误', async () => {
    const repo = makeRepo();
    repo.save.mockRejectedValue(new Error("ER_?_TABLE 'reference_document' doesn't exist"));
    const service = new ReferenceDocumentService(repo as never);

    await expect(
      service.insertDocument({
        title: '机密输入内容',
        documentType: 'MANUAL',
        equipmentModelId: null,
        description: null,
        contentText: '内容',
        originalFilename: null,
        mimeType: null,
        storageBackend: null,
        storageReference: null,
        createdByAccountId: 900001,
        ownerOrganizationId: 910001,
        ingestMethod: 'ADMIN_DIRECT',
      }),
    ).rejects.toMatchObject({
      code: REFERENCE_DOCUMENT_ERROR.CREATION_FAILED,
      details: { title: '机密输入内容' },
    });
  });

  it('编辑条件更新命中（affected=1）返回资料 ID', async () => {
    const repo = makeRepo();
    repo.update.mockResolvedValue({ affected: 1 });
    const service = new ReferenceDocumentService(repo as never);

    await expect(
      service.updateDocument({
        documentId: 970001,
        title: '新标题',
        documentType: 'MANUAL',
        equipmentModelId: null,
        description: null,
        contentText: '内容',
      }),
    ).resolves.toEqual({ id: 970001 });
    // 条件更新必须含 deprecated = 0，已软删行不可被编辑穿透
    expect(repo.update).toHaveBeenCalledWith(
      { id: 970001, deprecated: false },
      expect.objectContaining({ title: '新标题' }),
    );
  });

  it('编辑未命中（不存在或已软删）统一 NOT_FOUND，不泄露删除状态', async () => {
    const repo = makeRepo();
    repo.update.mockResolvedValue({ affected: 0 });
    const service = new ReferenceDocumentService(repo as never);

    await expect(
      service.updateDocument({
        documentId: 999999,
        title: 'x',
        documentType: 'MANUAL',
        equipmentModelId: null,
        description: null,
        contentText: '内容',
      }),
    ).rejects.toMatchObject({
      code: REFERENCE_DOCUMENT_ERROR.NOT_FOUND,
      details: { id: 999999 },
    });
  });

  it('编辑落库失败包装为 UPDATE_FAILED（cause 保留原始异常）', async () => {
    const repo = makeRepo();
    repo.update.mockRejectedValue(new Error('db down'));
    const service = new ReferenceDocumentService(repo as never);

    await expect(
      service.updateDocument({
        documentId: 970001,
        title: 'x',
        documentType: 'MANUAL',
        equipmentModelId: null,
        description: null,
        contentText: '内容',
      }),
    ).rejects.toMatchObject({ code: REFERENCE_DOCUMENT_ERROR.UPDATE_FAILED });
  });

  it('软删除条件更新命中返回 DELETED；deleted_at 与 deprecated 同语句写入', async () => {
    const repo = makeRepo();
    repo.update.mockResolvedValue({ affected: 1 });
    const service = new ReferenceDocumentService(repo as never);

    await expect(service.softDeleteDocument({ documentId: 970001 })).resolves.toEqual({
      kind: 'DELETED',
      id: 970001,
    });
    expect(repo.update).toHaveBeenCalledWith(
      { id: 970001, deprecated: false },
      { deprecated: true, deletedAt: expect.any(Function) },
    );
  });

  it('软删除未命中（不存在或已软删）统一 NOT_FOUND 状态事实，不执行物理 DELETE', async () => {
    const repo = makeRepo();
    repo.update.mockResolvedValue({ affected: 0 });
    const service = new ReferenceDocumentService(repo as never);

    await expect(service.softDeleteDocument({ documentId: 999999 })).resolves.toEqual({
      kind: 'NOT_FOUND',
      id: 999999,
    });
    expect(repo.update).toHaveBeenCalledTimes(1);
  });

  it('软删除落库失败包装为 DELETION_FAILED', async () => {
    const repo = makeRepo();
    repo.update.mockRejectedValue(new Error('db down'));
    const service = new ReferenceDocumentService(repo as never);

    await expect(service.softDeleteDocument({ documentId: 970001 })).rejects.toMatchObject({
      code: REFERENCE_DOCUMENT_ERROR.DELETION_FAILED,
      details: { id: 970001 },
    });
  });
});
