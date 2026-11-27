// src/adapters/api/rest/local-runtime/local-backup-cloud-package-rest.controller.ts

/**
 * 云端备份包的**授权下载**入口（任务 09 S4／A09-07）。
 *
 * 为什么走 REST 而不是 GraphQL：备份包字节体量可能很大，
 * 走 REST 字节流可避免把二进制塞进 GraphQL 响应（与任务 11 原件下载同一范式）。
 *
 * 纪律：
 * - **下载权限 ≠ 恢复权限**：本入口只给字节，不产生任何恢复动作
 *   （恢复仍需管理员准入 ＋ 恢复预检 ＋ 保护副本）；
 * - **范围由可信 session 决定**：请求里的 `organizationId` 只是"看哪家公司"，
 *   越权由 usecase 按 session 范围拒绝（一级管理员可指定，其余仅本公司）；
 * - **不暴露密钥与存储引用**：响应只给包字节与建议文件名；
 * - **云服务未接入时失败关闭**：生产云 provider 未注册（R-02）⇒ 返回受控原因码
 *   `CLOUD_PACKAGES_UNAVAILABLE`，**不伪造可用包**。
 */

import { mapJwtToUsecaseSession } from '@app-types/auth/session.types';
import { JwtPayload } from '@app-types/jwt.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import { DomainError } from '@core/common/errors/domain-error';
import { Controller, Get, HttpException, Param, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';

import { currentUser } from '@src/adapters/api/graphql/decorators/current-user.decorator';
import { Roles } from '@src/adapters/api/graphql/decorators/roles.decorator';
import { JwtAuthGuard } from '@src/adapters/api/graphql/guards/jwt-auth.guard';
import { RolesGuard } from '@src/adapters/api/graphql/guards/roles.guard';
import { DownloadLocalBackupCloudPackageUsecase } from '@src/usecases/local-runtime/local-backup-cloud-packages.usecase';

import { applyDownloadHeaders, toRestError } from '../shared/upload-boundary.util';

/** 云端包标识的保守形态（只允许字母数字与少量分隔符，长度受限） */
const CLOUD_PACKAGE_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

// 路由前缀含 `api/`：与仓库既有 REST 控制器一致（后端**没有**全局前缀），
// 前端也只代理 `/api`——漏掉它会让前端下载请求直接 404。
@Controller('api/local-runtime/backup/cloud-packages')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(IdentityTypeEnum.ENGINEER, IdentityTypeEnum.SUPER_ADMIN)
export class LocalBackupCloudPackageRestController {
  constructor(
    private readonly downloadCloudPackageUsecase: DownloadLocalBackupCloudPackageUsecase,
  ) {}

  /**
   * 授权下载云端备份包（只给字节）。
   *
   * 响应头写出后不再改写状态码：字节发送失败即中断连接，
   * 不追加 JSON 或底层错误文本（与任务 11 原件下载同一处置）。
   */
  @Get(':packageId/download')
  async download(
    @Param('packageId') packageId: string,
    @Req() request: Request,
    @currentUser() user: JwtPayload,
    @Res() response: Response,
  ): Promise<void> {
    if (!CLOUD_PACKAGE_ID_PATTERN.test(packageId)) {
      throw new HttpException(
        {
          statusCode: 400,
          code: 'INVALID_PARAMS',
          message: '云端包标识格式不合法',
        },
        400,
      );
    }
    const organizationIdValue = readOrganizationId(readQueryValue(request, 'organizationId'));

    let payload: Awaited<ReturnType<DownloadLocalBackupCloudPackageUsecase['execute']>>;
    try {
      payload = await this.downloadCloudPackageUsecase.execute({
        session: mapJwtToUsecaseSession(user),
        packageId,
        organizationId: organizationIdValue,
      });
    } catch (error) {
      if (error instanceof DomainError) {
        toRestError(error);
      }
      throw error;
    }

    applyDownloadHeaders(response, {
      mimeType: 'application/octet-stream',
      originalFilename: payload.fileName,
    });
    response.setHeader('Content-Length', String(payload.content.byteLength));
    await new Promise<void>((resolve, reject) => {
      response.end(payload.content, (error?: Error | null) => {
        if (error !== undefined && error !== null) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

/** 读取查询串里的单个值（REST 层不引入 GraphQL 装饰器） */
function readQueryValue(request: Request, key: string): string | undefined {
  const value = request.query?.[key];
  if (typeof value === 'string') {
    return value;
  }
  return undefined;
}

/** 解析请求里的公司 id（仅"看哪家公司"，越权由 usecase 按 session 范围裁决） */
function readOrganizationId(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') {
    return null;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new HttpException(
      { statusCode: 400, code: 'INVALID_PARAMS', message: '公司数据区参数不合法' },
      400,
    );
  }
  return parsed;
}
