// src/adapters/api/rest/reference-document/reference-document-rest.controller.spec.ts

/// <reference types="jest" />
import { Readable } from 'node:stream';

import { HttpException, StreamableFile } from '@nestjs/common';

import { DomainError, REFERENCE_DOCUMENT_ERROR } from '@core/common/errors/domain-error';
import { ReferenceDocumentRestController } from './reference-document-rest.controller';

/**
 * 任务 07 确认需求收口：旧 POST /api/reference-documents/upload（普通资料文件新增
 * 生产写入口）已关闭，本规格同步移除 upload 用例，仅保留合法的原件授权下载契约。
 */

/** 构造被测 controller：只注入下载用例的 mock——构造函数本身即「不持有存储契约」的证明 */
const makeController = () => {
  const getReferenceDocumentFileUsecase = { execute: jest.fn() };
  const controller = new ReferenceDocumentRestController(getReferenceDocumentFileUsecase as never);

  return { controller, getReferenceDocumentFileUsecase };
};

/** 最小 JwtPayload 形状（mapJwtToUsecaseSession 只取会话相关字段） */
const jwtUser = {
  sub: 900001,
  accessGroup: ['SUPER_ADMIN'],
  activeRole: 'SUPER_ADMIN',
} as never;

describe('ReferenceDocumentRestController（REST 下载边界只解析协议与组装响应）', () => {
  it('下载入口组装响应头并流式返回 Usecase 内容（不感知存储实现与路径）', async () => {
    const { controller, getReferenceDocumentFileUsecase } = makeController();
    getReferenceDocumentFileUsecase.execute.mockResolvedValueOnce({
      documentId: 970002,
      originalFilename: '说明书.pdf',
      mimeType: 'application/pdf',
      content: Readable.from([Buffer.from('pdf-bytes')]),
    });
    const setHeader = jest.fn();
    const response = { setHeader } as never;

    const result = await controller.download(970002, jwtUser, response);

    expect(getReferenceDocumentFileUsecase.execute).toHaveBeenCalledWith({
      session: expect.objectContaining({ accountId: 900001 }),
      documentId: 970002,
    });
    expect(result).toBeInstanceOf(StreamableFile);
    expect(setHeader).toHaveBeenCalledWith('Content-Type', 'application/pdf');
    expect(setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent('说明书.pdf')}`,
    );
  });

  it('下载失败映射受控 REST 错误（不携带服务器路径）', async () => {
    const { controller, getReferenceDocumentFileUsecase } = makeController();
    getReferenceDocumentFileUsecase.execute.mockRejectedValueOnce(
      new DomainError(REFERENCE_DOCUMENT_ERROR.FILE_NOT_AVAILABLE, '参考资料文件不可用'),
    );

    const error = await controller
      .download(970004, jwtUser, { setHeader: jest.fn() } as never)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getResponse()).toMatchObject({
      code: REFERENCE_DOCUMENT_ERROR.FILE_NOT_AVAILABLE,
    });
  });
});
