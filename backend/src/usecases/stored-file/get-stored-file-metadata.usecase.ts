// src/usecases/stored-file/get-stored-file-metadata.usecase.ts

import { StoredFileBusinessType } from '@app-types/models/stored-file.types';
import { DomainError, STORED_FILE_ERROR } from '@core/common/errors/domain-error';
import {
  normalizeStoredFileId,
  normalizeUploadContextId,
} from '@core/stored-file/policy/stored-file-input.policy';
import { assertStoredFileReadRole } from '@core/stored-file/policy/stored-file-permission.policy';
import { Injectable } from '@nestjs/common';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import type { StoredFileMetadataView } from '@src/modules/lithography/lithography.types';
import { StoredFileQueryService } from '@src/modules/lithography/queries/stored-file.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import {
  resolveStoredFileAdminScope,
  resolveStoredFileViewerOrganizationId,
} from './stored-file-admin-scope';
import type { GetStoredFileMetadataQuery } from './stored-file.types';

/**
 * 共用业务原件元数据查询用例（R062-02）。
 *
 * 访问口径全部下沉 StoredFileQueryService：
 * - 暂存：原上传者 + 同公司 + 同用途 + uploadContextId 精确匹配；
 * - 正式：真实业务关联 + 工单组织范围/本人接单；管理员按复用后的工单授权范围
 *   （一级全公司、二级本公司）读取，工程师口径不变；
 * - 客户、外公司、同公司非工程师账号统一 NOT_FOUND，不泄露原件存在性。
 */
@Injectable()
export class GetStoredFileMetadataUsecase {
  constructor(
    private readonly storedFileQueryService: StoredFileQueryService,
    private readonly trustedOrganizationContext: TrustedOrganizationContextQueryService,
    private readonly accountQueryService: AccountQueryService,
  ) {}

  async execute(query: GetStoredFileMetadataQuery): Promise<StoredFileMetadataView> {
    const fileId = normalizeStoredFileId(query.fileId);
    if (!fileId) {
      throw new DomainError(STORED_FILE_ERROR.INVALID_PARAMS, '原件编号格式不合法');
    }

    assertStoredFileReadRole(query.session);

    const adminScope = await resolveStoredFileAdminScope({
      session: query.session,
      accountQueryService: this.accountQueryService,
      trustedOrganizationContext: this.trustedOrganizationContext,
    });
    const viewerOrganizationId = await resolveStoredFileViewerOrganizationId({
      session: query.session,
      adminScope,
      trustedOrganizationContext: this.trustedOrganizationContext,
    });

    const view = await this.storedFileQueryService.findAuthorizedMetadata({
      fileId,
      session: query.session,
      viewerOrganizationId,
      uploadContextId: normalizeUploadContextId(query.uploadContextId),
      expectedBusinessType: StoredFileBusinessType.REPAIR_PROCESS,
      ...(adminScope ? { adminOrganizationId: adminScope.organizationId } : {}),
    });
    if (!view) {
      throw new DomainError(STORED_FILE_ERROR.NOT_FOUND, '原件不存在或无权访问');
    }

    return view;
  }
}
