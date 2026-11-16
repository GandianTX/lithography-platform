// src/usecases/registration/check-registration-organization-name.usecase.ts

import { DomainError, INPUT_NORMALIZE_ERROR } from '@core/common/errors';
import { Injectable } from '@nestjs/common';
import { normalizeOrganizationNameForComparison } from '@src/modules/lithography/organization-name.normalize';
import { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
import { REGISTRATION_ORGANIZATION_NAME_MAX_LENGTH } from './registration-input.normalize';

/**
 * Web 注册手填公司名的精确同名提示（公开只读）。
 *
 * - 资格口径与候选检索一致：`ACTIVE` 且属于一级维护名单；
 * - 名称按「去首尾空白、连续空白合并、统一小写」归一后整体相等，不是 LIKE 子串、
 *   前缀或候选首屏近似；
 * - 契约是「可能存在同名公司」的提示，不是唯一性、资格或提交前置校验：
 *   空白名称与超过注册列上限（200）的名称直接返回未命中，不发起查询；
 * - 手填注册仍会创建独立公司档，本查询结果不改变任何写入行为。
 */
@Injectable()
export class CheckRegistrationOrganizationNameUsecase {
  constructor(private readonly organizationQueryService: OrganizationQueryService) {}

  async execute(input: { name: unknown }): Promise<boolean> {
    if (typeof input.name !== 'string') {
      throw new DomainError(INPUT_NORMALIZE_ERROR.INVALID_TEXT, '公司名称 必须是字符串', {
        field: 'name',
      });
    }

    const normalizedName = normalizeOrganizationNameForComparison(input.name);
    if (
      normalizedName.length === 0 ||
      normalizedName.length > REGISTRATION_ORGANIZATION_NAME_MAX_LENGTH
    ) {
      return false;
    }

    return this.organizationQueryService.existsEligibleRegistrationOptionByName({ normalizedName });
  }
}
