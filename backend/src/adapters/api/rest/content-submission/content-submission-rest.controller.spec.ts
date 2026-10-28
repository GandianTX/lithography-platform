// src/adapters/api/rest/content-submission/content-submission-rest.controller.spec.ts

/// <reference types="jest" />
import { Readable } from 'node:stream';

import { HttpException, StreamableFile } from '@nestjs/common';

import {
  CONTENT_SUBMISSION_ERROR,
  DomainError,
  ORGANIZATION_ERROR,
} from '@core/common/errors/domain-error';
import { resolveRestStatus } from '@core/common/errors/rest-error-status';
import { ContentSubmissionRestController } from './content-submission-rest.controller';

/** 构造被测 controller：只注入三个用例的 mock——构造函数本身即「不持有存储契约」的证明 */
const makeController = () => {
  const uploadAttachmentUsecase = { execute: jest.fn() };
  const removeAttachmentUsecase = { execute: jest.fn() };
  const downloadAttachmentUsecase = { execute: jest.fn() };
  const controller = new ContentSubmissionRestController(
    uploadAttachmentUsecase as never,
    removeAttachmentUsecase as never,
    downloadAttachmentUsecase as never,
  );

  return {
    controller,
    uploadAttachmentUsecase,
    removeAttachmentUsecase,
    downloadAttachmentUsecase,
  };
};

/** 最小 JwtPayload 形状（mapJwtToUsecaseSession 只取会话相关字段） */
const jwtUser = {
  sub: 900001,
  accessGroup: ['ENGINEER'],
  activeRole: 'ENGINEER',
} as never;

const validFile = {
  buffer: Buffer.from('file-bytes'),
  originalname: '操作手册.pdf',
};

describe('ContentSubmissionRestController（REST 边界只解析协议与组装响应）', () => {
  describe('uploadAttachment', () => {
    it('上传入口只组装命令并调用上传 Usecase（业务规则与存储编排全部下沉）', async () => {
      const { controller, uploadAttachmentUsecase } = makeController();
      uploadAttachmentUsecase.execute.mockResolvedValueOnce({
        attachmentId: 980001,
        originalFilename: '操作手册.pdf',
        mimeType: 'application/pdf',
        byteSize: 10,
      });

      const result = await controller.uploadAttachment(970001, validFile, jwtUser);

      expect(result).toEqual({
        attachmentId: 980001,
        originalFilename: '操作手册.pdf',
        mimeType: 'application/pdf',
        byteSize: 10,
      });
      expect(uploadAttachmentUsecase.execute).toHaveBeenCalledTimes(1);
      expect(uploadAttachmentUsecase.execute).toHaveBeenCalledWith({
        session: expect.objectContaining({ accountId: 900001 }),
        submissionId: 970001,
        file: {
          buffer: validFile.buffer,
          originalFilename: '操作手册.pdf',
        },
      });
    });

    it('latin1 误码文件名在协议层还原（业务层收到的已是正确 UTF-8）', async () => {
      const { controller, uploadAttachmentUsecase } = makeController();
      uploadAttachmentUsecase.execute.mockResolvedValueOnce({ attachmentId: 980002 });

      const mojibake = Buffer.from('中文图纸.pdf', 'utf8').toString('latin1');
      await controller.uploadAttachment(970001, { ...validFile, originalname: mojibake }, jwtUser);

      expect(uploadAttachmentUsecase.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          file: expect.objectContaining({ originalFilename: '中文图纸.pdf' }),
        }),
      );
    });

    it('展示清洗：路径剥离（basename）与控制字符剔除，仅作展示用途', async () => {
      const { controller, uploadAttachmentUsecase } = makeController();
      uploadAttachmentUsecase.execute.mockResolvedValueOnce({ attachmentId: 980003 });

      await controller.uploadAttachment(
        970001,
        { ...validFile, originalname: 'X/操作\u0000手册.pdf' },
        jwtUser,
      );

      expect(uploadAttachmentUsecase.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          file: expect.objectContaining({ originalFilename: '操作手册.pdf' }),
        }),
      );
    });

    it('multipart 文件缺失：UPLOAD_FILE_MISSING（协议层防御）', async () => {
      const { controller, uploadAttachmentUsecase } = makeController();

      await expect(controller.uploadAttachment(970001, null, jwtUser)).rejects.toMatchObject({
        code: CONTENT_SUBMISSION_ERROR.UPLOAD_FILE_MISSING,
      });
      expect(uploadAttachmentUsecase.execute).not.toHaveBeenCalled();
    });

    it('Usecase 抛 DomainError：由本类映射为 REST 统一错误体 HttpException', async () => {
      const { controller, uploadAttachmentUsecase } = makeController();
      uploadAttachmentUsecase.execute.mockRejectedValueOnce(
        new DomainError(CONTENT_SUBMISSION_ERROR.UPLOAD_FILE_TOO_LARGE, '上传文件超过大小限制'),
      );

      const error = (await controller
        .uploadAttachment(970001, validFile, jwtUser)
        .catch((caught: unknown) => caught)) as HttpException;

      expect(error).toBeInstanceOf(HttpException);
      expect(error.getStatus()).toBe(
        resolveRestStatus(CONTENT_SUBMISSION_ERROR.UPLOAD_FILE_TOO_LARGE),
      );
      expect(error.getResponse()).toMatchObject({
        code: CONTENT_SUBMISSION_ERROR.UPLOAD_FILE_TOO_LARGE,
      });
    });

    it('组织成员事实缺失（已认证的权限类拒绝）：ORGANIZATION_NO_ACTIVE_MEMBERSHIP 映射 403，不得兜底 500', async () => {
      const { controller, uploadAttachmentUsecase } = makeController();
      uploadAttachmentUsecase.execute.mockRejectedValueOnce(
        new DomainError(ORGANIZATION_ERROR.NO_ACTIVE_MEMBERSHIP, '无有效组织成员关系'),
      );

      const error = (await controller
        .uploadAttachment(970001, validFile, jwtUser)
        .catch((caught: unknown) => caught)) as HttpException;

      expect(error).toBeInstanceOf(HttpException);
      // 与 GraphQL FORBIDDEN 同语义：REST 必须渲染 403 而非兜底 500
      expect(error.getStatus()).toBe(403);
      expect(error.getResponse()).toMatchObject({
        code: ORGANIZATION_ERROR.NO_ACTIVE_MEMBERSHIP,
      });
    });
  });

  describe('removeAttachment', () => {
    it('移除入口只组装命令并调用移除 Usecase，空响应（204 语义）', async () => {
      const { controller, removeAttachmentUsecase } = makeController();
      removeAttachmentUsecase.execute.mockResolvedValueOnce(undefined);

      await expect(controller.removeAttachment(970001, jwtUser)).resolves.toBeUndefined();
      expect(removeAttachmentUsecase.execute).toHaveBeenCalledWith({
        session: expect.objectContaining({ accountId: 900001 }),
        submissionId: 970001,
      });
    });

    it('STATE_NOT_EDITABLE 映射为 409 统一错误体', async () => {
      const { controller, removeAttachmentUsecase } = makeController();
      removeAttachmentUsecase.execute.mockRejectedValueOnce(
        new DomainError(CONTENT_SUBMISSION_ERROR.STATE_NOT_EDITABLE, '当前状态的投稿不可编辑'),
      );

      const error = (await controller
        .removeAttachment(970001, jwtUser)
        .catch((caught: unknown) => caught)) as HttpException;

      expect(error).toBeInstanceOf(HttpException);
      expect(error.getStatus()).toBe(
        resolveRestStatus(CONTENT_SUBMISSION_ERROR.STATE_NOT_EDITABLE),
      );
      expect(error.getResponse()).toMatchObject({
        code: CONTENT_SUBMISSION_ERROR.STATE_NOT_EDITABLE,
      });
    });
  });

  describe('downloadAttachment', () => {
    it('下载入口组装响应头并流式返回 Usecase 内容（不感知存储实现与路径）', async () => {
      const { controller, downloadAttachmentUsecase } = makeController();
      downloadAttachmentUsecase.execute.mockResolvedValueOnce({
        attachmentId: 980001,
        originalFilename: '中文图纸.pdf',
        mimeType: 'application/pdf',
        content: Readable.from([Buffer.from('pdf-bytes')]),
      });
      const setHeader = jest.fn();
      const response = { setHeader } as never;

      const result = await controller.downloadAttachment(970001, 980001, jwtUser, response);

      expect(downloadAttachmentUsecase.execute).toHaveBeenCalledWith({
        session: expect.objectContaining({ accountId: 900001 }),
        submissionId: 970001,
        attachmentId: 980001,
      });
      expect(result).toBeInstanceOf(StreamableFile);
      // MIME 取自 DB（usecase 返回），文件名按 RFC 5987 编码
      expect(setHeader).toHaveBeenCalledWith('Content-Type', 'application/pdf');
      expect(setHeader).toHaveBeenCalledWith(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent('中文图纸.pdf')}`,
      );
    });

    it('Usecase 抛 DomainError：映射错误体且不写任何下载响应头', async () => {
      const { controller, downloadAttachmentUsecase } = makeController();
      downloadAttachmentUsecase.execute.mockRejectedValueOnce(
        new DomainError(CONTENT_SUBMISSION_ERROR.NOT_FOUND, '投稿附件不存在或不可访问'),
      );
      const setHeader = jest.fn();
      const response = { setHeader } as never;

      const error = (await controller
        .downloadAttachment(970001, 980999, jwtUser, response)
        .catch((caught: unknown) => caught)) as HttpException;

      expect(error).toBeInstanceOf(HttpException);
      expect(error.getStatus()).toBe(resolveRestStatus(CONTENT_SUBMISSION_ERROR.NOT_FOUND));
      expect(error.getResponse()).toMatchObject({ code: CONTENT_SUBMISSION_ERROR.NOT_FOUND });
      expect(setHeader).not.toHaveBeenCalled();
    });
  });
});
