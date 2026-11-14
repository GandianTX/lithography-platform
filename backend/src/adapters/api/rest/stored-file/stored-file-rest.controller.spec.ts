// src/adapters/api/rest/stored-file/stored-file-rest.controller.spec.ts

/// <reference types="jest" />
import { Readable } from 'node:stream';

import type { JwtPayload } from '@app-types/jwt.types';
import { STORED_FILE_ERROR } from '@core/common/errors/domain-error';
import { HttpException } from '@nestjs/common';
import type { Request } from 'express';

import { JwtAuthGuard } from '@src/adapters/api/graphql/guards/jwt-auth.guard';
import { RolesGuard } from '@src/adapters/api/graphql/guards/roles.guard';
import type { DownloadStoredFileUsecase } from '@src/usecases/stored-file/download-stored-file.usecase';
import type { GetStoredFileMetadataUsecase } from '@src/usecases/stored-file/get-stored-file-metadata.usecase';
import type { UploadStoredFileUsecase } from '@src/usecases/stored-file/upload-stored-file.usecase';
import { StoredFileRestController } from './stored-file-rest.controller';

const user: JwtPayload = {
  sub: 900001,
  username: 'engineer',
  email: null,
  accessGroup: ['ENGINEER'],
  activeRole: 'ENGINEER' as JwtPayload['activeRole'],
};

const metadataView = {
  fileId: '11111111-1111-4111-8111-111111111111',
  businessType: 'REPAIR_PROCESS',
  originalFilename: '维修记录.pdf',
  mimeType: 'application/pdf',
  byteSize: 10,
  checksumSha256: 'checksum',
  status: 'VALID',
  bindingStatus: 'TEMPORARY',
  businessId: null,
  uploadContextId: '22222222-2222-4222-8222-222222222222',
  verifiedAt: new Date('2026-11-14T00:00:00.000Z'),
  createdAt: new Date('2026-11-14T00:00:00.000Z'),
} as const;

const makeController = () => {
  const uploadUsecase = { execute: jest.fn().mockResolvedValue(metadataView) };
  const metadataUsecase = { execute: jest.fn().mockResolvedValue(metadataView) };
  const downloadUsecase = {
    execute: jest.fn().mockResolvedValue({
      fileId: metadataView.fileId,
      originalFilename: metadataView.originalFilename,
      mimeType: metadataView.mimeType,
      content: Readable.from([Buffer.from('pdf')]),
    }),
  };
  const controller = new StoredFileRestController(
    uploadUsecase as unknown as UploadStoredFileUsecase,
    metadataUsecase as unknown as GetStoredFileMetadataUsecase,
    downloadUsecase as unknown as DownloadStoredFileUsecase,
  );
  return { controller, uploadUsecase, metadataUsecase, downloadUsecase };
};

const guardMetadata = (handler: object): unknown[] =>
  Reflect.getMetadata('__guards__', handler) ?? [];

const roleMetadata = (handler: object): string[] => Reflect.getMetadata('roles', handler) ?? [];

describe('StoredFileRestController', () => {
  it('三个端点均挂载 JwtAuthGuard + RolesGuard（未登录请求在守卫层 401）', () => {
    const prototype = StoredFileRestController.prototype as unknown as Record<string, unknown>;
    for (const method of ['upload', 'getMetadata', 'download']) {
      const handler = prototype[method] as object;
      expect(guardMetadata(handler)).toEqual(expect.arrayContaining([JwtAuthGuard, RolesGuard]));
    }
  });

  it('上传仅工程师角色；元数据/下载为工程师与管理员读角色', () => {
    const prototype = StoredFileRestController.prototype as unknown as Record<string, unknown>;
    expect(roleMetadata(prototype.upload as object)).toEqual(['ENGINEER']);
    expect(roleMetadata(prototype.getMetadata as object)).toEqual(['ENGINEER', 'SUPER_ADMIN']);
    expect(roleMetadata(prototype.download as object)).toEqual(['ENGINEER', 'SUPER_ADMIN']);
  });

  it('缺少 multipart 文件时映射为 400 受控错误', async () => {
    const { controller } = makeController();

    const error = await controller
      .upload(undefined, user, 'REPAIR_PROCESS')
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(HttpException);
    const httpError = error as HttpException;
    expect(httpError.getStatus()).toBe(400);
    expect(httpError.getResponse()).toMatchObject({
      code: STORED_FILE_ERROR.UPLOAD_FILE_MISSING,
    });
  });

  it('元数据传递可信会话、上下文与原文文件名；不自行组装组织', async () => {
    const { controller, metadataUsecase } = makeController();

    await controller.getMetadata(
      metadataView.fileId,
      { query: { uploadContextId: metadataView.uploadContextId } } as unknown as Request,
      user,
    );

    expect(metadataUsecase.execute).toHaveBeenCalledWith({
      session: { accountId: 900001, roles: ['ENGINEER'], activeRole: 'ENGINEER' },
      fileId: metadataView.fileId,
      uploadContextId: metadataView.uploadContextId,
    });
  });

  it('下载封装文件流与 RFC 5987 文件名响应头，不返回存储引用', async () => {
    const { controller, downloadUsecase } = makeController();
    const headers = new Map<string, string>();
    const response = {
      setHeader: (name: string, value: string) => headers.set(name, value),
    };

    await controller.download(
      metadataView.fileId,
      { query: { uploadContextId: metadataView.uploadContextId } } as unknown as Request,
      user,
      response as never,
    );

    expect(downloadUsecase.execute).toHaveBeenCalledWith(
      expect.objectContaining({ uploadContextId: metadataView.uploadContextId }),
    );
    expect(headers.get('Content-Type')).toBe('application/pdf');
    expect(headers.get('Content-Disposition')).toContain("filename*=UTF-8''");
  });
});
