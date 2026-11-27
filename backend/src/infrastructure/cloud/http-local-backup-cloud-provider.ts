// src/infrastructure/cloud/http-local-backup-cloud-provider.ts

/**
 * 云端备份包的**生产适配实现**（任务 09 S4／A09-07）。
 *
 * 协议（与云端约定一致）：
 * - `GET {baseUrl}/backup-packages?organizationId=X` → `{ "packages": [ ... ] }`；
 * - `GET {baseUrl}/backup-packages/{packageId}/content?organizationId=X` → 二进制包内容。
 *
 * 纪律：
 * - **下载权限 ≠ 恢复权限**：本实现只给字节，不触发任何恢复动作；
 * - **不暴露密钥与存储引用**：只给受控元数据（包标识、公司、时间、字节数、摘要）；
 * - **隐藏范围外数据**：只返回请求公司数据区的包，实现方越界也由本层过滤；
 * - 凭据只在请求头出现，不进日志、不进错误信息。
 */

import { Injectable } from '@nestjs/common';

import type { UsecaseSession } from '@app-types/auth/session.types';

import {
  LOCAL_BACKUP_CLOUD_PROVIDER,
  type LocalBackupCloudPackageDownload,
  type LocalBackupCloudPackageSummary,
  type LocalBackupCloudProvider,
} from '@usecases/common/ports/local-backup-cloud-provider.contract';

import { HttpLocalBackupCloudClient } from './http-local-backup-cloud.client';

@Injectable()
export class HttpLocalBackupCloudProvider implements LocalBackupCloudProvider {
  constructor(private readonly client: HttpLocalBackupCloudClient) {}

  async listPackages(
    session: UsecaseSession,
    query: { organizationId: number },
  ): Promise<LocalBackupCloudPackageSummary[]> {
    void session;
    const result = await this.client.call(
      async () => {
        const response = await this.client.http.get(this.client.buildUrl('/backup-packages'), {
          headers: this.client.headers(),
          params: { organizationId: query.organizationId },
        });
        return { status: response.status, data: response.data as unknown };
      },
      (data) => parsePackageList(data),
    );
    if (!result.ok) {
      throw new CloudProviderUnavailableError(result.code);
    }
    // 只回本公司的包：实现方越界也不外泄
    return result.value.filter((item) => item.organizationId === query.organizationId);
  }

  async downloadPackage(
    session: UsecaseSession,
    key: { organizationId: number; packageId: string },
  ): Promise<LocalBackupCloudPackageDownload> {
    void session;
    const result = await this.client.call(
      async () => {
        const response = await this.client.http.get(
          this.client.buildUrl(`/backup-packages/${encodeURIComponent(key.packageId)}/content`),
          {
            headers: this.client.headers(),
            params: { organizationId: key.organizationId },
            responseType: 'arraybuffer',
          },
        );
        return { status: response.status, data: response.data as unknown };
      },
      (data) => (Buffer.isBuffer(data) && data.length > 0 ? data : null),
    );
    if (!result.ok) {
      throw new CloudProviderUnavailableError(result.code);
    }
    return {
      fileName: `backup-${key.packageId}.bin`,
      content: result.value,
    };
  }
}

/** 云端不可用（未配置／不可达／超时／被拒／响应非法） */
export class CloudProviderUnavailableError extends Error {
  constructor(readonly code: string) {
    super(`云端备份包服务不可用：${code}`);
    this.name = 'CloudProviderUnavailableError';
  }
}

/** 解析云端包清单：字段逐个校验形态，非法条目丢弃 */
function parsePackageList(data: unknown): LocalBackupCloudPackageSummary[] | null {
  if (typeof data !== 'object' || data === null) {
    return null;
  }
  const container = data as { packages?: unknown };
  if (!Array.isArray(container.packages)) {
    return null;
  }
  const items: LocalBackupCloudPackageSummary[] = [];
  for (const entry of container.packages) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const candidate = entry as {
      packageId?: unknown;
      organizationId?: unknown;
      backupId?: unknown;
      createdAt?: unknown;
      byteSize?: unknown;
      checksumSha256?: unknown;
    };
    if (typeof candidate.packageId !== 'string' || candidate.packageId.length === 0) {
      continue;
    }
    if (
      typeof candidate.organizationId !== 'number' ||
      !Number.isInteger(candidate.organizationId)
    ) {
      continue;
    }
    items.push({
      packageId: candidate.packageId,
      organizationId: candidate.organizationId,
      backupId: typeof candidate.backupId === 'string' ? candidate.backupId : null,
      createdAt: typeof candidate.createdAt === 'string' ? candidate.createdAt : null,
      byteSize: typeof candidate.byteSize === 'number' ? candidate.byteSize : null,
      checksumSha256:
        typeof candidate.checksumSha256 === 'string' ? candidate.checksumSha256 : null,
    });
  }
  return items;
}

/** 端口令牌别名（便于 DI 引用） */
export const LOCAL_BACKUP_CLOUD_PROVIDER_TOKEN = LOCAL_BACKUP_CLOUD_PROVIDER;
