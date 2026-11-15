// src/adapters/api/rest/stored-file/stored-file-rest.controller.ts

import type { Readable } from 'node:stream';

import { mapJwtToUsecaseSession } from '@app-types/auth/session.types';
import { JwtPayload } from '@app-types/jwt.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import { DomainError, STORED_FILE_ERROR } from '@core/common/errors/domain-error';
import { resolveRestStatus } from '@core/common/errors/rest-error-status';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Post,
  Req,
  Res,
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
  private readonly logger = new Logger(StoredFileRestController.name);

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
   *
   * 响应头已写出后才发生的读流故障不能再改写状态码：
   * - 未发送响应头：清除下载专用头，返回固定受控错误体（不回显底层异常/路径/引用）；
   * - 已开始响应：直接中断连接，不追加 JSON 或底层错误文本。
   */
  @Get(':fileId/download')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER, IdentityTypeEnum.SUPER_ADMIN)
  async download(
    @Param('fileId') fileId: string,
    @Req() request: Request,
    @currentUser() user: JwtPayload,
    @Res() response: Response,
  ): Promise<void> {
    // 等待授权与存储打开期间客户端可能已断开：先跟踪响应状态，避免对已关闭响应
    // 设置下载头或启动传输，也避免迟到的源流无人销毁。
    let responseClosed = false;
    const markResponseClosed = (): void => {
      responseClosed = true;
    };
    response.once('close', markResponseClosed);

    let payload: Awaited<ReturnType<DownloadStoredFileUsecase['execute']>>;

    try {
      payload = await this.downloadUsecase.execute({
        session: mapJwtToUsecaseSession(user),
        fileId,
        uploadContextId: readUploadContextId(request.query.uploadContextId),
      });
    } catch (error) {
      response.removeListener('close', markResponseClosed);
      if (error instanceof DomainError) {
        toRestError(error);
      }
      throw error;
    }

    response.removeListener('close', markResponseClosed);

    if (responseClosed || response.destroyed) {
      this.discardLateContent(payload.content);
      return;
    }

    applyDownloadHeaders(response, {
      mimeType: payload.mimeType,
      originalFilename: payload.originalFilename,
    });

    await this.streamDownload(response, payload.content, fileId);
  }

  /** 响应已关闭时到达的源流：销毁并吞掉销毁期间的读流错误，随后移除监听器。 */
  private discardLateContent(content: Readable): void {
    this.destroyContentQuietly(content);
  }

  /**
   * 销毁源流，同时把销毁回调抛出的读流错误留在本地监听器内。
   * 监听器在 destroy 完成后再移除；重复调用不会留下未清理的监听器。
   */
  private destroyContentQuietly(content: Readable): void {
    const swallowError = (): void => undefined;
    const removeSwallow = (): void => {
      content.removeListener('error', swallowError);
    };
    content.on('error', swallowError);
    if (content.closed) {
      removeSwallow();
      content.destroy();
      return;
    }
    content.once('close', removeSwallow);
    content.destroy();
  }

  /**
   * 交付授权文件流，并把读流故障收敛为协议层终态。
   * 底层异常只写入服务端日志的文件标识，不进入响应体。
   */
  private async streamDownload(
    response: Response,
    content: Readable,
    fileId: string,
  ): Promise<void> {
    await new Promise<void>((resolve) => {
      let settled = false;
      const settle = (): void => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      const onContentError = (error: unknown): void => {
        content.unpipe(response);
        content.removeListener('error', onContentError);
        this.logger.warn(
          `原件下载读流失败: fileId=${fileId} stage=${
            response.headersSent ? 'after-headers' : 'before-headers'
          } reason=${error instanceof Error ? error.name : typeof error}`,
        );

        if (!response.headersSent) {
          // 尚未写出任何字节：撤销下载专用头，按 REST 契约返回固定受控错误
          response.removeHeader('Content-Type');
          response.removeHeader('Content-Disposition');
          const status = resolveRestStatus(STORED_FILE_ERROR.FILE_NOT_AVAILABLE);
          response.status(status).json({
            statusCode: status,
            code: STORED_FILE_ERROR.FILE_NOT_AVAILABLE,
            message: '原件文件暂时不可用',
          });
        } else if (!response.writableEnded) {
          // 已有响应字节：中断传输，绝不追加 JSON 或底层错误文本
          response.destroy();
        }

        settle();
      };

      const onResponseClosed = (): void => {
        content.removeListener('error', onContentError);
        this.destroyContentQuietly(content);
        settle();
      };

      const onResponseError = (): void => {
        content.removeListener('error', onContentError);
        this.destroyContentQuietly(content);
        settle();
      };

      response.once('close', onResponseClosed);
      response.once('error', onResponseError);
      response.once('finish', settle);
      content.once('error', onContentError);

      try {
        content.pipe(response);
      } catch (error) {
        onContentError(error);
      }
    });
  }
}

/** Express query 值只接受单值字符串；数组/对象按缺失处理（暂存读取最终 NOT_FOUND） */
function readUploadContextId(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
