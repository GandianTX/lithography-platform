// src/modules/lithography/queries/stored-file.query.service.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import {
  StoredFileBindingStatus,
  StoredFileBusinessType,
  StoredFileStatus,
} from '@app-types/models/stored-file.types';
import { hasRole } from '@core/account/policy/role-access.policy';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { getTypeOrmEntityManager } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { Repository } from 'typeorm';
import { RepairProcessEntryEntity } from '../entities/repair-process-entry.entity';
import { RepairRequestEntity } from '../entities/repair-request.entity';
import { StoredFileEntity } from '../entities/stored-file.entity';
import type { StoredFileDownloadFacts, StoredFileMetadataView } from '../lithography.types';

/** 原件读取的访问上下文（由 usecase 从可信会话与公司事实组装，不来自前端组织参数） */
export type StoredFileAccessQuery = {
  fileId: string;
  session: UsecaseSession;
  /** 可信当前公司；无有效归属时为 null（仅影响无归属工单的本人接单读取） */
  viewerOrganizationId: number | null;
  /** 暂存读取必须携带并匹配；正式业务读取不使用 */
  uploadContextId: string | null;
  expectedBusinessType: string;
};

/** 读取授权所需的原件安全事实（含仅服务端可见的存储引用） */
type StoredFileAccessRow = {
  fileId: string;
  uploadedByAccountId: number;
  ownerOrganizationId: number;
  storageReference: string;
  originalFilename: string;
  mimeType: string;
  byteSize: string;
  checksumSha256: string;
  status: string;
  businessType: string;
  businessId: string | null;
  uploadContextId: string;
  bindingStatus: string;
  createdAt: Date;
  verifiedAt: Date | null;
};

/**
 * 共用业务原件读服务。
 *
 * 统一的读授权口径（不按文件 ID / 上下文 ID / 前端组织参数单独放行）：
 * - 暂存（TEMPORARY）：原上传者 + 可信当前公司一致 + 用途一致 + upload_context_id 精确匹配；
 * - 正式绑定（BOUND REPAIR_PROCESS）：必须存在 repair_process_entry 真实关联，
 *   且读取者具备工程师角色，并按工单口径限制组织（有归属公司）或本人接单（无归属公司）；
 * - 客户、外公司、同公司非工程师账号一律返回 null，不泄露原件存在性或内部过程。
 */
@Injectable()
export class StoredFileQueryService {
  constructor(
    @InjectRepository(StoredFileEntity)
    private readonly storedFileRepository: Repository<StoredFileEntity>,
    @InjectRepository(RepairProcessEntryEntity)
    private readonly repairProcessEntryRepository: Repository<RepairProcessEntryEntity>,
    @InjectRepository(RepairRequestEntity)
    private readonly repairRequestRepository: Repository<RepairRequestEntity>,
  ) {}

  /** 授权元数据；不可访问返回 null（usecase 统一映射 NOT_FOUND） */
  async findAuthorizedMetadata(
    query: StoredFileAccessQuery,
  ): Promise<StoredFileMetadataView | null> {
    const file = await this.findAuthorizedFile(query);
    return file ? this.toMetadataView(file) : null;
  }

  /** 授权下载定位；不可访问返回 null（usecase 统一映射 NOT_FOUND） */
  async findAuthorizedDownload(
    query: StoredFileAccessQuery,
  ): Promise<StoredFileDownloadFacts | null> {
    const file = await this.findAuthorizedFile(query);
    if (!file) {
      return null;
    }
    return {
      fileId: file.fileId,
      storageReference: file.storageReference,
      originalFilename: file.originalFilename,
      mimeType: file.mimeType,
    };
  }

  /** 补偿判定：存储引用是否已被任何原件登记引用（含已绑定），避免误删已提交数据 */
  async isStorageReferenceReferenced(storageReference: string): Promise<boolean> {
    const count = await this.storedFileRepository.count({
      where: { storageReference },
    });
    return count > 0;
  }

  /** 绑定占用判定：该原件是否已被任何内部维修过程引用（在同一事务内读取） */
  async isReferencedByRepairProcess(
    fileId: string,
    transactionContext: PersistenceTransactionContext,
  ): Promise<boolean> {
    const manager = getTypeOrmEntityManager(transactionContext);
    const entry = await manager.getRepository(RepairProcessEntryEntity).findOne({
      where: { fileId },
      select: { id: true },
    });
    return entry !== null;
  }

  private async findAuthorizedFile(
    query: StoredFileAccessQuery,
  ): Promise<StoredFileAccessRow | null> {
    const file = await this.storedFileRepository.findOne({
      where: { fileId: query.fileId },
      select: {
        fileId: true,
        uploadedByAccountId: true,
        ownerOrganizationId: true,
        storageReference: true,
        originalFilename: true,
        mimeType: true,
        byteSize: true,
        checksumSha256: true,
        status: true,
        businessType: true,
        businessId: true,
        uploadContextId: true,
        bindingStatus: true,
        createdAt: true,
        verifiedAt: true,
      },
    });
    if (!file) {
      return null;
    }

    const bindingStatus = file.bindingStatus as StoredFileBindingStatus;
    if (bindingStatus === StoredFileBindingStatus.TEMPORARY) {
      return this.canAccessTemporary(file, query) ? file : null;
    }

    if (bindingStatus === StoredFileBindingStatus.BOUND) {
      return (await this.canAccessBoundRepairProcess(file, query)) ? file : null;
    }

    return null;
  }

  /** 暂存访问：只允许原上传者在同一公司、同一用途、同一上传上下文内读取 */
  private canAccessTemporary(file: StoredFileAccessRow, query: StoredFileAccessQuery): boolean {
    if (
      (file.status as StoredFileStatus) !== StoredFileStatus.VALID ||
      file.verifiedAt === null ||
      file.businessId !== null
    ) {
      return false;
    }
    if (file.businessType !== query.expectedBusinessType) {
      return false;
    }
    if (!hasRole(query.session.roles, IdentityTypeEnum.ENGINEER)) {
      return false;
    }
    if (file.uploadedByAccountId !== query.session.accountId) {
      return false;
    }
    if (
      query.viewerOrganizationId === null ||
      file.ownerOrganizationId !== query.viewerOrganizationId
    ) {
      return false;
    }
    return (
      query.uploadContextId !== null &&
      query.uploadContextId.length > 0 &&
      file.uploadContextId === query.uploadContextId
    );
  }

  /**
   * 正式绑定访问：以真实业务关联为准（不信任文件自身 business_id 单独放行）。
   * 内部维修过程对客户关闭；外公司与同公司非工程师账号不可借 ID 读取。
   */
  private async canAccessBoundRepairProcess(
    file: StoredFileAccessRow,
    query: StoredFileAccessQuery,
  ): Promise<boolean> {
    if (
      (file.businessType as StoredFileBusinessType) !== StoredFileBusinessType.REPAIR_PROCESS ||
      file.businessId === null ||
      (file.status as StoredFileStatus) !== StoredFileStatus.VALID ||
      file.verifiedAt === null ||
      !hasRole(query.session.roles, IdentityTypeEnum.ENGINEER)
    ) {
      return false;
    }

    const requestId = Number(file.businessId);
    if (!Number.isSafeInteger(requestId) || requestId <= 0) {
      return false;
    }

    const [entry, request] = await Promise.all([
      this.repairProcessEntryRepository.findOne({
        where: { fileId: file.fileId, requestId },
        select: { id: true },
      }),
      this.repairRequestRepository.findOne({
        where: { id: requestId },
        select: {
          id: true,
          ownerOrganizationId: true,
          isAccepted: true,
          acceptedByEngineerAccountId: true,
          deprecated: true,
        },
      }),
    ]);
    if (!entry || !request || request.deprecated) {
      return false;
    }

    if (request.ownerOrganizationId !== null) {
      return request.ownerOrganizationId === query.viewerOrganizationId;
    }
    return request.isAccepted && request.acceptedByEngineerAccountId === query.session.accountId;
  }

  private toMetadataView(file: StoredFileAccessRow): StoredFileMetadataView {
    return {
      fileId: file.fileId,
      businessType: file.businessType,
      originalFilename: file.originalFilename,
      mimeType: file.mimeType,
      byteSize: Number(file.byteSize),
      checksumSha256: file.checksumSha256,
      status: file.status as StoredFileStatus,
      bindingStatus: file.bindingStatus as StoredFileBindingStatus,
      businessId: file.businessId,
      uploadContextId: file.uploadContextId,
      verifiedAt: file.verifiedAt,
      createdAt: file.createdAt,
    };
  }
}
