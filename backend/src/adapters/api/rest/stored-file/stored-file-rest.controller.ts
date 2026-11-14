// src/adapters/api/rest/stored-file/stored-file-rest.controller.ts

import { mapJwtToUsecaseSession } from '@app-types/auth/session.types';
import { JwtPayload } from '@app-types/jwt.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import { DomainError, STORED_FILE_ERROR } from '@core/common/errors/domain-error';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';

import { currentUser } from '@src/adapters/api/graphql/decorators/current-user.decorator';
import { Roles } from '@src/adapters/api/graphql/decorators/roles.decorator';
import { JwtAuthGuard } from '@src/adapters/api/graphql/guards/jwt-auth.guard';
import { RolesGuard } from '@src/adapters/api/graphql/guards/roles.guard';
import type { StoredFileMetadataView } from '@src/modules/lithography/lithography.types';
import { DownloadStoredFileUsecase } from '@src/usecases/stored-file/download-stored-file.usecase';
import { GetStoredFileMetadataUsecase } from '@src/usecases/stored-file/get-stored-file-metadata.usecase';
import { UploadStoredFileUsecase } from '@src/usecases/stored-file/upload-stored-file.usecase';
import type { UploadedStoredFileView } from '@src/usecases/stored-file/stored-file.types';

import {
  UPLOAD_HARD_LIMIT_BYTES,
  applyDownloadHeaders,
  decodeUtf8FileName,
  sanitizeOriginalFilename,
  toRestError,
  toUploadedFilePayload,
} from '../shared/upload-boundary.util';

/**
 * 共用业务原件 REST 边界（任务 11 / R062-01..03）。
 *
 * 只做 multipart 协议解析、Session 映射、调用 Usecase 与响应封装：
 * - 上传前授权（账号/可信公司/精确工程师/用途）、大小与内容类型、SHA-256、
 *   存储与暂存登记全部归 usecase 单一真源；
 * - 元数据与下载的访问授权归 StoredFileQueryService（暂存归属或正式业务关联）；
 * - 下载不返回私有存储引用，只回写授权后的文件流；
 * - 正式参考资料下载仍走既有 /api/reference-documents，本类不改旧接口。
 */
@Controller('api/stored-files')
export class StoredFileRestController {
  constructor(
    private readonly uploadUsecase: UploadStoredFileUsecase,
    private readonly metadataUsecase: GetStoredFileMetadataUsecase,
    private readonly downloadUsecase: DownloadStoredFileUsecase,
  ) {}

  /**
   * 上传暂存（R062-01）：multipart/form-data，字段 `businessType` + `file`。
   * 成功返回 VALID + TEMPORARY、businessId 为空的元数据与服务端 uploadContextId；
   * 仅表示校验通过，不表示已绑定业务。
   */
  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: UPLOAD_HARD_LIMIT_BYTES } }))
  @HttpCode(HttpStatus.CREATED)
  async upload(
    @UploadedFile() file: unknown,
    @currentUser() user: JwtPayload,
    @Body('businessType') businessType?: string,
  ): Promise<UploadedStoredFileView> {
    try {
      const uploaded = toUploadedFilePayload(file, STORED_FILE_ERROR.UPLOAD_FILE_MISSING);
      const originalFilename = sanitizeOriginalFilename(decodeUtf8FileName(uploaded.originalname));

      return await this.uploadUsecase.execute({
        session: mapJwtToUsecaseSession(user),
        businessType: businessType ?? '',
        file: { buffer: uploaded.buffer, originalFilename },
      });
    } catch (error) {
      if (error instanceof DomainError) {
        toRestError(error);
      }
      throw error;
    }
  }

  /**
   * 元数据（R062-02）：暂存读取必须带 uploadContextId；
   * 正式绑定读取按真实业务关联与工单访问权校验。
   */
  @Get(':fileId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER, IdentityTypeEnum.SUPER_ADMIN)
  async getMetadata(
    @Param('fileId') fileId: string,
    @Req() request: Request,
    @currentUser() user: JwtPayload,
  ): Promise<StoredFileMetadataView> {
    try {
      return await this.metadataUsecase.execute({
        session: mapJwtToUsecaseSession(user),
        fileId,
        uploadContextId: readUploadContextId(request.query.uploadContextId),
      });
    } catch (error) {
      if (error instanceof DomainError) {
        toRestError(error);
      }
      throw error;
    }
  }

  /**
   * 授权下载（R062-03）：不暴露存储引用；客户与无权同公司账号不可借 ID 读取。
   */
  @Get(':fileId/download')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER, IdentityTypeEnum.SUPER_ADMIN)
  async download(
    @Param('fileId') fileId: string,
    @Req() request: Request,
    @currentUser() user: JwtPayload,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    let payload: Awaited<ReturnType<DownloadStoredFileUsecase['execute']>>;

    try {
      payload = await this.downloadUsecase.execute({
        session: mapJwtToUsecaseSession(user),
        fileId,
        uploadContextId: readUploadContextId(request.query.uploadContextId),
      });
    } catch (error) {
      if (error instanceof DomainError) {
        toRestError(error);
      }
      throw error;
    }

    applyDownloadHeaders(response, {
      mimeType: payload.mimeType,
      originalFilename: payload.originalFilename,
    });

    return new StreamableFile(payload.content);
  }
}

/** Express query 值只接受单值字符串；数组/对象按缺失处理（暂存读取最终 NOT_FOUND） */
function readUploadContextId(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
