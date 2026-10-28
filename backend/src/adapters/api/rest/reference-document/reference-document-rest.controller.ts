// src/adapters/api/rest/reference-document/reference-document-rest.controller.ts

import { mapJwtToUsecaseSession } from '@app-types/auth/session.types';
import { JwtPayload } from '@app-types/jwt.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';

import {
  Body,
  Controller,
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
import { DomainError, REFERENCE_DOCUMENT_ERROR } from '@core/common/errors/domain-error';
import { CreateReferenceDocumentWithFileUsecase } from '@src/usecases/reference-document/create-reference-document-with-file.usecase';
import { GetReferenceDocumentFileUsecase } from '@src/usecases/reference-document/get-reference-document-file.usecase';
import type { ReferenceDocumentFilePayload } from '@src/usecases/reference-document/reference-document.types';

import {
  UPLOAD_HARD_LIMIT_BYTES,
  applyDownloadHeaders,
  decodeUtf8FileName,
  sanitizeOriginalFilename,
  toRestError,
  toUploadedFilePayload,
} from '../shared/upload-boundary.util';

/** 读取 multipart 文本字段：缺省或空白一律视为未提供 */
function readMultipartString(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];

  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();

  return normalized.length > 0 ? normalized : null;
}

/**
 * 参考资料文件上传 / 下载 REST 边界（负责人 0909 第二轮阻塞项 1；0910 架构修复）。
 *
 * - 本类只做 multipart 协议解析、Session 映射、调用 Usecase 与 HTTP 响应封装，
 *   不承载业务规则、事务或 I/O 编排（adapters.rules.md 边界）：
 *   上传交由 CreateReferenceDocumentWithFileUsecase 统一编排保存/落库/补偿；
 *   下载经 GetReferenceDocumentFileUsecase 返回内容流，本类不感知存储实现；
 * - multer 硬上限属于传输层防御，业务大小/类型/双空规则归 usecase 层单一真源；
 * - 错误统一为 HTTP 状态码 + { statusCode, code, message } JSON 体，不携带服务器路径。
 */
@Controller('api/reference-documents')
export class ReferenceDocumentRestController {
  constructor(
    private readonly createReferenceDocumentWithFileUsecase: CreateReferenceDocumentWithFileUsecase,
    private readonly getReferenceDocumentFileUsecase: GetReferenceDocumentFileUsecase,
  ) {}

  /** 文件上传创建（仅 SUPER_ADMIN）：multipart/form-data；contentText 可空，与文件双空才拒绝 */
  @Post('upload')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.SUPER_ADMIN)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: UPLOAD_HARD_LIMIT_BYTES } }))
  @HttpCode(HttpStatus.CREATED)
  async upload(
    @UploadedFile() file: unknown,
    @Body() body: Record<string, unknown>,
    @currentUser() user: JwtPayload,
  ): Promise<{ id: number }> {
    const uploaded = toUploadedFilePayload(file, REFERENCE_DOCUMENT_ERROR.UPLOAD_FILE_MISSING);

    // 协议层职责止于 latin1 还原与展示清洗；大小/类型/双空与存储编排归 usecase 单一真源
    const originalFilename = sanitizeOriginalFilename(decodeUtf8FileName(uploaded.originalname));
    const contentText = readMultipartString(body, 'contentText');
    const equipmentModelIdRaw = readMultipartString(body, 'equipmentModelId');

    try {
      const result = await this.createReferenceDocumentWithFileUsecase.execute({
        session: mapJwtToUsecaseSession(user),
        title: readMultipartString(body, 'title') ?? '',
        documentType: readMultipartString(body, 'documentType') ?? '',
        equipmentModelId: equipmentModelIdRaw === null ? null : Number(equipmentModelIdRaw),
        description: readMultipartString(body, 'description'),
        contentText,
        file: { buffer: uploaded.buffer, originalFilename },
      });

      return { id: result.id };
    } catch (error) {
      if (error instanceof DomainError) {
        toRestError(error);
      }

      throw error;
    }
  }

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
}
