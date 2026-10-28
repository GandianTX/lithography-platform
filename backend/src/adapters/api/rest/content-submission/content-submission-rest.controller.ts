// src/adapters/api/rest/content-submission/content-submission-rest.controller.ts

import { mapJwtToUsecaseSession } from '@app-types/auth/session.types';
import { JwtPayload } from '@app-types/jwt.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';

import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';

import { currentUser } from '@src/adapters/api/graphql/decorators/current-user.decorator';
import { Roles } from '@src/adapters/api/graphql/decorators/roles.decorator';
import { JwtAuthGuard } from '@src/adapters/api/graphql/guards/jwt-auth.guard';
import { RolesGuard } from '@src/adapters/api/graphql/guards/roles.guard';
import { CONTENT_SUBMISSION_ERROR, DomainError } from '@core/common/errors/domain-error';
import { DownloadContentSubmissionAttachmentUsecase } from '@src/usecases/content-submission/download-content-submission-attachment.usecase';
import { RemoveContentSubmissionAttachmentUsecase } from '@src/usecases/content-submission/remove-content-submission-attachment.usecase';
import { UploadContentSubmissionAttachmentUsecase } from '@src/usecases/content-submission/upload-content-submission-attachment.usecase';
import type {
  ContentSubmissionAttachmentFilePayload,
  ContentSubmissionAttachmentUploadResult,
} from '@src/usecases/content-submission/content-submission.types';

import {
  UPLOAD_HARD_LIMIT_BYTES,
  applyDownloadHeaders,
  decodeUtf8FileName,
  sanitizeOriginalFilename,
  toRestError,
  toUploadedFilePayload,
} from '../shared/upload-boundary.util';

/**
 * 投稿私有附件 REST 边界（A-PR0 §4.2；单附件模型）。
 *
 * - 本类只做 multipart 协议解析、Session 映射、调用 Usecase 与 HTTP 响应封装，
 *   不承载业务规则、事务或 I/O 编排（adapters.rules.md 边界）：
 *   上传/移除/下载的授权、状态裁决、存储编排与失败补偿全部归 usecase 层；
 * - 传输层粗筛（@Roles）只挡住明显未认证角色，精确权限（activeRole、
 *   本人/本组织归属）以 usecase 层断言为唯一决策点；
 * - multer 硬上限属于传输层防御，业务大小/类型规则归 usecase 单一真源
 *   （与管理员上传同一配置）；
 * - 错误统一为 HTTP 状态码 + { statusCode, code, message } JSON 体，不携带服务器路径。
 */
@Controller('api/content-submissions')
export class ContentSubmissionRestController {
  constructor(
    private readonly uploadAttachmentUsecase: UploadContentSubmissionAttachmentUsecase,
    private readonly removeAttachmentUsecase: RemoveContentSubmissionAttachmentUsecase,
    private readonly downloadAttachmentUsecase: DownloadContentSubmissionAttachmentUsecase,
  ) {}

  /**
   * 上传/替换单附件（仅投稿人角色粗筛）：multipart/form-data；
   * 本人 DRAFT/RETURNED 时可上传/替换；返回附件 ID、原名、MIME、实际大小等安全元数据。
   */
  @Post(':id/attachment')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: UPLOAD_HARD_LIMIT_BYTES } }))
  @HttpCode(HttpStatus.CREATED)
  async uploadAttachment(
    @Param('id', ParseIntPipe) id: number,
    @UploadedFile() file: unknown,
    @currentUser() user: JwtPayload,
  ): Promise<ContentSubmissionAttachmentUploadResult> {
    const uploaded = toUploadedFilePayload(file, CONTENT_SUBMISSION_ERROR.UPLOAD_FILE_MISSING);

    // 协议层职责止于 latin1 还原与展示清洗；大小/类型/授权/存储编排归 usecase 单一真源
    const originalFilename = sanitizeOriginalFilename(decodeUtf8FileName(uploaded.originalname));

    try {
      return await this.uploadAttachmentUsecase.execute({
        session: mapJwtToUsecaseSession(user),
        submissionId: id,
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
   * 移除当前附件（仅投稿人角色粗筛）：本人 DRAFT/RETURNED 时退役当前引用；
   * 历史已冻结引用保留（只退役数据库记录，不删除存储文件）；无当前附件时幂等成功。
   */
  @Delete(':id/attachment')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER)
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeAttachment(
    @Param('id', ParseIntPipe) id: number,
    @currentUser() user: JwtPayload,
  ): Promise<void> {
    try {
      await this.removeAttachmentUsecase.execute({
        session: mapJwtToUsecaseSession(user),
        submissionId: id,
      });
    } catch (error) {
      if (error instanceof DomainError) {
        toRestError(error);
      }

      throw error;
    }
  }

  /**
   * 下载指定原件（ENGINEER + SUPER_ADMIN 角色粗筛）：本人或本组织授权审核员；
   * 必须校验附件属于该投稿；历史 RETIRED 原件经授权同样可下载（不只下载「当前文件」）。
   */
  @Get(':id/attachments/:attachmentId/download')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER, IdentityTypeEnum.SUPER_ADMIN)
  async downloadAttachment(
    @Param('id', ParseIntPipe) id: number,
    @Param('attachmentId', ParseIntPipe) attachmentId: number,
    @currentUser() user: JwtPayload,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    let payload: ContentSubmissionAttachmentFilePayload;

    try {
      payload = await this.downloadAttachmentUsecase.execute({
        session: mapJwtToUsecaseSession(user),
        submissionId: id,
        attachmentId,
      });
    } catch (error) {
      if (error instanceof DomainError) {
        toRestError(error);
      }

      throw error;
    }

    // MIME 取自 DB（上传时由扩展名映射写入；不信任客户端 Content-Type），
    // 文件名按 RFC 5987 编码防乱码与头注入
    applyDownloadHeaders(response, {
      mimeType: payload.mimeType,
      originalFilename: payload.originalFilename,
    });

    return new StreamableFile(payload.content);
  }
}
