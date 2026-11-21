// src/modules/lithography/queries/stored-file.query.service.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import {
  MaintenanceAttachmentStatus,
  MaintenanceReportStatus,
} from '@app-types/models/maintenance-report.types';
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
import { MaintenanceReportAttachmentEntity } from '../entities/maintenance-report-attachment.entity';
import { MaintenanceReportEntity } from '../entities/maintenance-report.entity';
import { RepairProcessEntryEntity } from '../entities/repair-process-entry.entity';
import { RepairRequestEntity } from '../entities/repair-request.entity';
import { RepairRequestIntakeEntity } from '../entities/repair-request-intake.entity';
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
  /**
   * 管理员工单组织范围（仅 BOUND REPAIR_PROCESS 生效）：
   * `undefined` 表示非管理员，继续既有工程师口径；`null` 为一级全公司；
   * 数字为二级管理员可信本公司。不得由客户端传入。
   */
  adminOrganizationId?: number | null;
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
 * - 正式绑定（BOUND REPAIR_PROCESS）：必须存在真实业务关联，
 *   旧路径为 repair_process_entry，新路径为 repair_request.maintenance_attachment_file_id；
 *   且读取者具备工程师角色，工单及 intake 的服务公司一致并匹配读取者可信组织；
 *   新路径仅限接单工程师本人（旧过程关联保持既有同公司工程师口径）；
 *   管理员分支复用管理员工单授权策略：一级全公司、二级仅本公司（见 adminOrganizationId）；
 *   已结单只限制写入，不阻止原本有权的工程师下载已绑定原件；
 * - 正式绑定（BOUND REPAIR_REQUEST，任务 03 第三段起）：报修本人可读；
 *   任务 03/04 交叉链路起，对工单有权限的指定厂家工程师亦可读（复用工单详情
 *   可信服务公司口径，须存在真实关联该原稿的未删除工单，见
 *   canAccessBoundRepairRequestOriginal）；
 * - 客户报修原件之外，其他客户、外公司、同公司非工程师账号一律返回 null，
 *   不泄露原件存在性或内部过程。
 * - 正式绑定（BOUND MAINTENANCE_REPORT）：报告附件存在且 CURRENT；作者本人任何状态可读；
 *   管理员仅可读 SUBMITTED 冻结报告（一级全公司、二级归属公司），草稿不可读；
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
    @InjectRepository(RepairRequestIntakeEntity)
    private readonly repairRequestIntakeRepository: Repository<RepairRequestIntakeEntity>,
    @InjectRepository(MaintenanceReportEntity)
    private readonly maintenanceReportRepository: Repository<MaintenanceReportEntity>,
    @InjectRepository(MaintenanceReportAttachmentEntity)
    private readonly maintenanceReportAttachmentRepository: Repository<MaintenanceReportAttachmentEntity>,
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
      byteSize: Number(file.byteSize),
      checksumSha256: file.checksumSha256,
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
      // 客户报修原件（任务 03 第三段）：仅本人原稿真实绑定的 REPAIR_REQUEST 原件
      if ((file.businessType as StoredFileBusinessType) === StoredFileBusinessType.REPAIR_REQUEST) {
        return (await this.canAccessBoundRepairRequestOriginal(file, query)) ? file : null;
      }
      // 维修报告原件（任务 06）：作者本人 / 管理员按报告状态口径
      if (
        (file.businessType as StoredFileBusinessType) === StoredFileBusinessType.MAINTENANCE_REPORT
      ) {
        return (await this.canAccessBoundMaintenanceReport(file, query)) ? file : null;
      }
      return (await this.canAccessBoundRepairProcess(file, query)) ? file : null;
    }

    return null;
  }

  /**
   * 客户报修原件访问（任务 03 第三段；任务 03/04 交叉链路补齐工程师口径）：
   * 「真实绑定到本人原稿」的 REPAIR_REQUEST 原件对两类读取者开放——
   * ① 报修本人（客户，含按角色继承展开的客户身份）；
   * ② 对该原稿对应工单有读取权限的指定厂家工程师（复用工单详情可信服务公司
   *    口径：工单真实关联该原稿、未删除，且工单与原稿的服务公司一致并等于
   *    读取者可信组织；是否已接单不参与读取判定，与工单详情读规则一致）。
   *
   * - 以真实业务关联为准：`repair_request_intake.file_id` 必须实际引用该文件，
       且必须存在 `repair_request.intake_id` 指向该原稿的未删除工单；
   * - 原稿已删除（deleted_at 非空）后原件对客户与工程师均关闭；
   * - 管理员会话（adminOrganizationId 已解析）不因本分支放行，管理员口径不变；
   * - 暂存（TEMPORARY）原件不开放客户读取；同公司其他客户与外公司账号一律拒绝，
   *   统一返回 null（上层映射 NOT_FOUND），不泄露原件存在性。
   */
  private async canAccessBoundRepairRequestOriginal(
    file: StoredFileAccessRow,
    query: StoredFileAccessQuery,
  ): Promise<boolean> {
    if (
      (file.businessType as StoredFileBusinessType) !== StoredFileBusinessType.REPAIR_REQUEST ||
      file.businessId === null ||
      (file.status as StoredFileStatus) !== StoredFileStatus.VALID ||
      file.verifiedAt === null
    ) {
      return false;
    }

    const intakeId = Number(file.businessId);
    if (!Number.isSafeInteger(intakeId) || intakeId <= 0) {
      return false;
    }

    const intake = await this.repairRequestIntakeRepository.findOne({
      where: { id: intakeId },
      select: {
        id: true,
        fileId: true,
        customerAccountId: true,
        serviceOrganizationId: true,
        deletedAt: true,
      },
    });
    if (intake === null || intake.deletedAt !== null || intake.fileId !== file.fileId) {
      return false;
    }

    // 客户本人：仅报修原稿归属本人时可读（不改变既有客户口径）
    if (hasRole(query.session.roles, IdentityTypeEnum.CUSTOMER)) {
      return intake.customerAccountId === query.session.accountId;
    }

    // 指定厂家工程师：须为真实工单读取身份（管理员会话不进入本分支，口径不变）
    if (
      query.adminOrganizationId === undefined &&
      hasRole(query.session.roles, IdentityTypeEnum.ENGINEER)
    ) {
      return this.canAccessBoundRequestOriginalAsEngineer(intake, query);
    }

    return false;
  }

  /**
   * 工程师读取客户报修原件：复用工单详情可信服务公司口径
   * （见 RepairRequestQueryService.assertEngineerTrustedScope）——
   * 必须存在真实关联该原稿（repair_request.intake_id）的未删除工单，且工单
   * `service_organization_id` 与原稿一致并等于读取者可信组织；不信任文件
   * business_id 或前端传入的厂家单独放行。是否已接单不参与读取判定，
   * 与工单详情「同公司工程师均可读客户原始报修」规则一致。
   */
  private async canAccessBoundRequestOriginalAsEngineer(
    intake: Pick<RepairRequestIntakeEntity, 'id' | 'serviceOrganizationId'>,
    query: StoredFileAccessQuery,
  ): Promise<boolean> {
    if (query.viewerOrganizationId === null) {
      return false;
    }
    const request = await this.repairRequestRepository.findOne({
      where: { intakeId: intake.id },
      select: { id: true, serviceOrganizationId: true, deprecated: true },
    });
    return (
      request !== null &&
      !request.deprecated &&
      request.serviceOrganizationId !== null &&
      request.serviceOrganizationId === query.viewerOrganizationId &&
      intake.serviceOrganizationId === request.serviceOrganizationId
    );
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
          intakeId: true,
          serviceOrganizationId: true,
          ownerOrganizationId: true,
          deprecated: true,
          maintenanceAttachmentFileId: true,
          isAccepted: true,
          acceptedByEngineerAccountId: true,
        },
      }),
    ]);
    if (!request || request.deprecated) {
      return false;
    }

    const referencedByProcessEntry = entry !== null;
    const referencedByMaintenanceAttachment = request.maintenanceAttachmentFileId === file.fileId;
    if (!referencedByProcessEntry && !referencedByMaintenanceAttachment) {
      return false;
    }

    if (query.adminOrganizationId !== undefined) {
      return this.canAccessBoundAsAdmin(request, query.adminOrganizationId);
    }

    if (referencedByProcessEntry) {
      return this.canAccessBoundAsEngineer(request, query);
    }

    return this.canAccessBoundAsMaintenanceEngineer(request, file.fileId, query);
  }

  /** 工程师分支：工单 intake 服务公司须与读取者可信公司一致 */
  private async canAccessBoundAsEngineer(
    request: RepairRequestEntity,
    query: StoredFileAccessQuery,
  ): Promise<boolean> {
    if (
      request.intakeId === null ||
      query.viewerOrganizationId === null ||
      request.serviceOrganizationId !== query.viewerOrganizationId
    ) {
      return false;
    }
    const intake = await this.repairRequestIntakeRepository.findOne({
      where: { id: request.intakeId },
      select: { id: true, serviceOrganizationId: true },
    });
    return intake !== null && intake.serviceOrganizationId === request.serviceOrganizationId;
  }

  /**
   * 新版维修原件分支：工单必须实际通过 `maintenance_attachment_file_id`
   * 引用该文件，且读取者就是接单本人。
   *
   * 旧 `repair_process_entry` 关联不进入本分支，保持既有同公司工程师口径；
   * 客户、外公司、同公司非接单工程师均不得因新关联获得内部原件权限；
   * 结单状态不参与读取判定（结单只限制写入）。
   */
  private async canAccessBoundAsMaintenanceEngineer(
    request: RepairRequestEntity,
    fileId: string,
    query: StoredFileAccessQuery,
  ): Promise<boolean> {
    if (
      request.maintenanceAttachmentFileId !== fileId ||
      !request.isAccepted ||
      request.acceptedByEngineerAccountId !== query.session.accountId
    ) {
      return false;
    }
    return this.canAccessBoundAsEngineer(request, query);
  }

  /**
   * 管理员分支：一级全公司；二级必须由工单与原始报修共同的 `service_organization_id`
   * 证明属于本公司。
   *
   * 二级管理员除了「真实过程关联 + 工单未删除」外，还必须满足：
   * - 工单明确关联 `intake_id`，且对应原始报修真实存在；
   * - 工单与原始报修的 `service_organization_id` 均存在且一致；
   * - 该服务公司等于服务端解析的可信本公司。
   *
   * 工单原件不采用管理员工单列表/详情的 owner 回退：`service_organization_id`
   * 为空、两处冲突或指向外公司时，即使 `owner_organization_id` 匹配也拒绝，
   * 避免二级管理员借历史列读取没有明确服务归属的原件（失败关闭，
   * 见 data-contracts §5「2 级限本公司」）。
   */
  private async canAccessBoundAsAdmin(
    request: RepairRequestEntity,
    adminOrganizationId: number | null,
  ): Promise<boolean> {
    if (adminOrganizationId === null) {
      return true;
    }
    if (
      request.serviceOrganizationId === null ||
      request.serviceOrganizationId !== adminOrganizationId ||
      request.intakeId === null
    ) {
      return false;
    }
    const intake = await this.repairRequestIntakeRepository.findOne({
      where: { id: request.intakeId },
      select: { id: true, serviceOrganizationId: true },
    });
    return intake !== null && intake.serviceOrganizationId === request.serviceOrganizationId;
  }

  /**
   * 报告附件分支（R062-03）：BOUND MAINTENANCE_REPORT 的 business_id 为报告根 ID。
   *
   * - 附件行必须真实存在且为 CURRENT（已移除/退役的附件不授予下载权）；
   * - 作者本人任何报告状态可读（草稿仅作者，R062-03「管理员不能读取他人草稿」）；
   * - 管理员按报告查看权限读取附件（与 export-maintenance-report 管理员状态门一致，
   *   功能 V5.6 R055/R062-03「管理员有权管理资源」）：仅拒绝工作态 DRAFT/RETURNED，
   *   SUBMITTED/PENDING_REVIEW/APPROVED 冻结态均可读；一级全公司、二级报告归属公司。
   *   （2026-11-21 修复：旧审核流 APPROVED 为正式冻结态——
   *   chk_maintenance_report_status_consistency 要求已提交且已审核——
   *   原先仅放行 SUBMITTED 与导出权限不一致）；
   * - 客户、外公司、同公司非作者工程师一律拒绝，不泄露存在性。
   */
  private async canAccessBoundMaintenanceReport(
    file: StoredFileAccessRow,
    query: StoredFileAccessQuery,
  ): Promise<boolean> {
    if (
      (file.businessType as StoredFileBusinessType) !== StoredFileBusinessType.MAINTENANCE_REPORT ||
      file.businessId === null ||
      (file.status as StoredFileStatus) !== StoredFileStatus.VALID ||
      file.verifiedAt === null
    ) {
      return false;
    }
    const reportId = Number(file.businessId);
    if (!Number.isSafeInteger(reportId) || reportId <= 0) {
      return false;
    }

    const [report, attachment] = await Promise.all([
      this.maintenanceReportRepository.findOne({
        where: { id: reportId },
        select: {
          id: true,
          ownerOrganizationId: true,
          maintenanceEngineerAccountId: true,
          status: true,
        },
      }),
      this.maintenanceReportAttachmentRepository.findOne({
        where: { fileId: file.fileId, reportId, status: MaintenanceAttachmentStatus.CURRENT },
        select: { id: true },
      }),
    ]);
    if (report === null || attachment === null) {
      return false;
    }

    if (query.adminOrganizationId !== undefined) {
      // 管理员状态门与导出管理员口径一致：仅工作态 DRAFT/RETURNED 关闭，
      // SUBMITTED/PENDING_REVIEW/APPROVED 冻结态可读
      const status = report.status as MaintenanceReportStatus;
      if (status === MaintenanceReportStatus.DRAFT || status === MaintenanceReportStatus.RETURNED) {
        return false;
      }
      if (query.adminOrganizationId === null) {
        return true;
      }
      return report.ownerOrganizationId === query.adminOrganizationId;
    }
    // 工程师分支纵深防御：即使上游角色守卫缺失，也不授予非工程师作者身份
    if (!hasRole(query.session.roles, IdentityTypeEnum.ENGINEER)) {
      return false;
    }
    return report.maintenanceEngineerAccountId === query.session.accountId;
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
