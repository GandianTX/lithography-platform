// src/adapters/api/rest/stored-file/stored-file-rest.controller.ts

import type { Readable } from 'node:stream';

import { mapJwtToUsecaseSession } from '@app-types/auth/session.types';
import { JwtPayload } from '@app-types/jwt.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import { DomainError, STORED_FILE_ERROR } from '@core/common/errors/domain-error';
import { resolveRestStatus } from '@core/common/errors/rest-error-status';
import {
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  Param,
  Post,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import type { Observable } from 'rxjs';

import { currentUser } from '@src/adapters/api/graphql/decorators/current-user.decorator';
import { Roles } from '@src/adapters/api/graphql/decorators/roles.decorator';
import { JwtAuthGuard } from '@src/adapters/api/graphql/guards/jwt-auth.guard';
import { RolesGuard } from '@src/adapters/api/graphql/guards/roles.guard';
import type { StoredFileMetadataView } from '@src/modules/lithography/lithography.types';
import { DownloadStoredFileUsecase } from '@src/usecases/stored-file/download-stored-file.usecase';
import { GetStoredFileMetadataUsecase } from '@src/usecases/stored-file/get-stored-file-metadata.usecase';
import { STORED_FILE_UPLOAD_MAX_BYTES } from '@src/usecases/stored-file/stored-file-upload.contract';
import type { UploadedStoredFileView } from '@src/usecases/stored-file/stored-file.types';
import { UploadStoredFileUsecase } from '@src/usecases/stored-file/upload-stored-file.usecase';

import {
  applyDownloadHeaders,
  decodeUtf8FileName,
  sanitizeOriginalFilename,
  toRestError,
  toUploadedFilePayload,
} from '../shared/upload-boundary.util';

/**
 * 本入口独立的 multipart 解析限额（不改全局上传配置）。
 *
 * busboy/multer 在「达到」限额时即报错，因此数值设置为「允许值的边界 + 1」：
 * - fileSize：允许恰好 20,000,000 字节，20,000,001 字节在解析阶段即被拒绝；
 * - fieldSize：允许 businessType 最多 64 字节，更长值在解析阶段即被拒绝；
 * - parts：允许 businessType + file 两个部分，第三个部分在解析阶段即被拒绝；
 * - fields/files：分别只允许一个文本字段与一个文件。
 * 精确字段名、重复字段与缺失字段由控制器在解析后按形态校验（不会解析超大内容）。
 */
const STORED_FILE_BUSINESS_TYPE_MAX_BYTES = 64;

const STORED_FILE_MULTIPART_LIMITS = {
  fileSize: STORED_FILE_UPLOAD_MAX_BYTES + 1,
  files: 1,
  fields: 1,
  fieldSize: STORED_FILE_BUSINESS_TYPE_MAX_BYTES + 1,
  parts: 3,
} as const;

/** 仅本入口使用的 multipart 解析器（Nest 直接依赖，不改全局上传配置） */
const storedFileMultipartParser = FileInterceptor('file', {
  limits: STORED_FILE_MULTIPART_LIMITS,
});

/**
 * 上传入口专用 multipart 拦截器：在解析阶段收紧限额，并把解析错误收敛为
 * 本域固定 REST 错误体（超限 413、其余表单错误 400），解析失败时处理器不会执行。
 */
@Injectable()
export class StoredFileUploadInterceptor implements NestInterceptor {
  private readonly parser = new storedFileMultipartParser();

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    try {
      return await this.parser.intercept(context, next);
    } catch (error) {
      throw mapStoredFileMultipartError(error);
    }
  }
}

/** 解析期错误 → 固定 REST 错误体；LIMIT_FILE_SIZE 为 413，其余表单结构问题为 400 */
function mapStoredFileMultipartError(error: unknown): Error {
  const tooLarge =
    error instanceof HttpException && error.getStatus() === Number(HttpStatus.PAYLOAD_TOO_LARGE);
  const domainError = tooLarge
    ? new DomainError(STORED_FILE_ERROR.UPLOAD_FILE_TOO_LARGE, '业务原件不能超过 20,000,000 字节')
    : new DomainError(STORED_FILE_ERROR.INVALID_PARAMS, '上传表单不合法');

  try {
    toRestError(domainError);
  } catch (mapped) {
    return mapped instanceof Error ? mapped : new Error('上传表单不合法');
  }
}

/** 只接受唯一 businessType 文本字段：重复（数组）、额外字段、错名或缺失一律拒绝 */
function readStoredFileBusinessType(body: unknown): string {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new DomainError(STORED_FILE_ERROR.INVALID_PARAMS, '上传表单不合法');
  }

  const entries = Object.entries(body as Record<string, unknown>);
  if (entries.length !== 1 || entries[0][0] !== 'businessType') {
    throw new DomainError(STORED_FILE_ERROR.INVALID_PARAMS, '上传表单不合法');
  }

  const value = entries[0][1];
  if (typeof value !== 'string') {
    throw new DomainError(STORED_FILE_ERROR.INVALID_PARAMS, '上传表单不合法');
  }
  if (value.length === 0) {
    throw new DomainError(STORED_FILE_ERROR.INVALID_PARAMS, '缺少业务原件用途');
  }

  return value;
}

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
   *
   * 入口角色只做粗粒度准入（工程师 / 客户），用途级写身份由 usecase 精确裁决：
   * `REPAIR_PROCESS` 仅工程师，`REPAIR_REQUEST` 仅客户；交叉用途一律拒绝。
   */
  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER, IdentityTypeEnum.CUSTOMER)
  @UseInterceptors(StoredFileUploadInterceptor)
  @HttpCode(HttpStatus.CREATED)
  async upload(
    @UploadedFile() file: unknown,
    @Req() request: Request,
    @currentUser() user: JwtPayload,
  ): Promise<UploadedStoredFileView> {
    try {
      const businessType = readStoredFileBusinessType(request.body);
      const uploaded = toUploadedFilePayload(file, STORED_FILE_ERROR.UPLOAD_FILE_MISSING);
      const originalFilename = sanitizeOriginalFilename(decodeUtf8FileName(uploaded.originalname));

      return await this.uploadUsecase.execute({
        session: mapJwtToUsecaseSession(user),
        businessType,
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
   * 任务 03 第三段起 CUSTOMER 准入：客户仅可读取本人报修原件（用途级归属由 usecase/QueryService 裁决）。
   */
  @Get(':fileId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER, IdentityTypeEnum.SUPER_ADMIN, IdentityTypeEnum.CUSTOMER)
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
   * 任务 03 第三段起 CUSTOMER 准入：客户仅可下载本人报修原件（用途级归属由 usecase/QueryService 裁决）。
   *
   * 响应头已写出后才发生的读流故障不能再改写状态码：
   * - 未发送响应头：清除下载专用头，返回固定受控错误体（不回显底层异常/路径/引用）；
   * - 已开始响应：直接中断连接，不追加 JSON 或底层错误文本。
   */
  @Get(':fileId/download')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER, IdentityTypeEnum.SUPER_ADMIN, IdentityTypeEnum.CUSTOMER)
  async download(
    @Param('fileId') fileId: string,
    @Req() request: Request,
    @currentUser() user: JwtPayload,
    @Res() response: Response,
  ): Promise<void> {
    // 等待授权、存储打开与完整性校验期间客户端可能已断开：跟踪响应状态并把断开
    // 传递给用例，由用例销毁源流（含打开迟到返回的流）；校验完成前不写下载头/正文。
    let responseClosed = false;
    const abortController = new AbortController();
    const markResponseClosed = (): void => {
      responseClosed = true;
      abortController.abort();
    };
    response.once('close', markResponseClosed);

    let payload: Awaited<ReturnType<DownloadStoredFileUsecase['execute']>>;

    try {
      payload = await this.downloadUsecase.execute({
        session: mapJwtToUsecaseSession(user),
        fileId,
        uploadContextId: readUploadContextId(request.query.uploadContextId),
        signal: abortController.signal,
      });
    } catch (error) {
      response.removeListener('close', markResponseClosed);
      // 客户端已断开时响应无法再承载错误体：仅结束处理，不再写响应
      if (responseClosed || response.destroyed) {
        return;
      }
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
