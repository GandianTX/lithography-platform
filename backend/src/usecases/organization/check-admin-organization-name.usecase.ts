// src/usecases/organization/check-admin-organization-name.usecase.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import { resolveLevelOneAdminScope } from '@core/account/policy/admin-scope.policy';
import { DomainError, INPUT_NORMALIZE_ERROR } from '@core/common/errors/domain-error';
import { Injectable } from '@nestjs/common';
import { normalizeOrganizationNameForComparison } from '@src/modules/lithography/organization-name.normalize';
import { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
import {
  ADMIN_ORGANIZATION_NAME_MAX_LENGTH,
  normalizeOrganizationId,
} from './admin-organization.input.normalize';

export type CheckAdminOrganizationNameCommand = {
  readonly session: UsecaseSession;
  readonly name: unknown;
  readonly excludeOrganizationId?: unknown;
};

/**
 * 一级管理员新增 / 编辑公司档案时的精确同名提示（只读）。
 *
 * - 管理档案范围覆盖全部公司档案（含停用与未受管），与公开注册提示的
 *   「ACTIVE 且受管」口径不同；
 * - 编辑时按实际主键排除自身，避免把自己的现有名称判成同名；
 * - 名称按共享归一化口径整体比较；空白名称与超长名称直接返回未命中，不发起查询；
 * - 契约是「可能存在同名档案」的提示，不阻断提交，也不改变同名不合并的写入语义。
 */
@Injectable()
export class CheckAdminOrganizationNameUsecase {
  constructor(private readonly organizationQueryService: OrganizationQueryService) {}

  async execute(command: CheckAdminOrganizationNameCommand): Promise<boolean> {
    resolveLevelOneAdminScope(command.session, '检查公司同名档案');

    if (typeof command.name !== 'string') {
      throw new DomainError(INPUT_NORMALIZE_ERROR.INVALID_TEXT, '公司名称必须是字符串', {
        field: 'name',
      });
    }

    const normalizedName = normalizeOrganizationNameForComparison(command.name);
    if (
      normalizedName.length === 0 ||
      normalizedName.length > ADMIN_ORGANIZATION_NAME_MAX_LENGTH
    ) {
      return false;
    }

    const excludeOrganizationId =
      command.excludeOrganizationId === undefined || command.excludeOrganizationId === null
        ? null
        : normalizeOrganizationId(command.excludeOrganizationId);

    return this.organizationQueryService.existsAnyOrganizationByName({
      normalizedName,
      excludeOrganizationId,
    });
  }
}
