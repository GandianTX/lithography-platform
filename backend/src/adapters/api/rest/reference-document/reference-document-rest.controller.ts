// src/adapters/api/rest/reference-document/reference-document-rest.controller.ts

import { mapJwtToUsecaseSession } from '@app-types/auth/session.types';
import { JwtPayload } from '@app-types/jwt.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';

import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';

import { currentUser } from '@src/adapters/api/graphql/decorators/current-user.decorator';
import { Roles } from '@src/adapters/api/graphql/decorators/roles.decorator';
import { JwtAuthGuard } from '@src/adapters/api/graphql/guards/jwt-auth.guard';
import { RolesGuard } from '@src/adapters/api/graphql/guards/roles.guard';
import { DomainError } from '@core/common/errors/domain-error';
import { DownloadReferenceDocumentSourceAttachmentUsecase } from '@src/usecases/reference-document/download-reference-document-source-attachment.usecase';
import { GetReferenceDocumentFileUsecase } from '@src/usecases/reference-document/get-reference-document-file.usecase';
import type { ReferenceDocumentFilePayload } from '@src/usecases/reference-document/reference-document.types';

import { applyDownloadHeaders, toRestError } from '../shared/upload-boundary.util';

/**
 * 历史维修记录文件下载 REST 边界（任务 07）。
 *
 * - 旧 POST /api/reference-documents/upload（普通资料文件新增写入口）已按确认需求
 *   关闭：本期普通资料新增取消，服务端同步关闭生产写入口，不为 E2E 造数保留；
 *   历史资料的原件授权下载能力保留，走任务 11 的授权 REST 底座；
 * - 本类只做 Session 映射、调用 Usecase 与 HTTP 响应封装，不承载业务规则、事务
 *   或 I/O 编排：下载经 GetReferenceDocumentFileUsecase 返回内容流，
 *   本类不感知存储实现（adapters.rules.md 边界）；
 * - 来源报告原件下载（任务 07 P2）经 DownloadReferenceDocumentSourceAttachmentUsecase
 *   扩展同一资料下载入口：按正式资料读取范围授权后再核验冻结版本附件绑定；
 * - 错误统一为 HTTP 状态码 + { statusCode, code, message } JSON 体，不携带服务器路径。
 */
@Controller('api/reference-documents')
export class ReferenceDocumentRestController {
  constructor(
    private readonly getReferenceDocumentFileUsecase: GetReferenceDocumentFileUsecase,
    private readonly downloadSourceAttachmentUsecase: DownloadReferenceDocumentSourceAttachmentUsecase,
  ) {}

  /** 文件下载（ENGINEER + SUPER_ADMIN，与 GraphQL 读口径一致——客户无页面访问权限不开放下载；软删/不存在/文件缺失统一受控错误，不泄露路径） */
  @Get(':id/download')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.SUPER_ADMIN, IdentityTypeEnum.ENGINEER)
  async download(
    @Param('id', ParseIntPipe) id: number,
    @currentUser() user: JwtPayload,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    let payload: ReferenceDocumentFilePayload;

    try {
      payload = await this.getReferenceDocumentFileUsecase.execute({
        session: mapJwtToUsecaseSession(user),
        documentId: id,
      });
    } catch (error) {
      if (error instanceof DomainError) {
        toRestError(error);
      }

      throw error;
    }

    // MIME 取自 DB（上传时由扩展名映射写入），文件名按 RFC 5987 编码防乱码与头注入
    applyDownloadHeaders(response, {
      mimeType: payload.mimeType,
      originalFilename: payload.originalFilename,
    });

    return new StreamableFile(payload.content);
  }

  /**
   * 来源报告原件下载（任务 07 P2；ENGINEER + SUPER_ADMIN，与资料详情读口径一致）：
   * 先按正式资料现有状态与可信读取范围授权，再核验冻结版本附件绑定后读取文件；
   * 客户无页面访问权限不开放下载，不泄露路径与存储引用。
   */
  @Get(':id/source-attachments/:attachmentId/download')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.SUPER_ADMIN, IdentityTypeEnum.ENGINEER)
  async downloadSourceAttachment(
    @Param('id', ParseIntPipe) id: number,
    @Param('attachmentId', ParseIntPipe) attachmentId: number,
    @currentUser() user: JwtPayload,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    let payload: ReferenceDocumentFilePayload;

    try {
      payload = await this.downloadSourceAttachmentUsecase.execute({
        session: mapJwtToUsecaseSession(user),
        documentId: id,
        attachmentId,
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
