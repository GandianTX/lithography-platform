// src/usecases/organization/update-admin-organization.usecase.ts

import type { UsecaseSession } from '@app-types/auth/session.types';
import { resolveLevelOneAdminScope } from '@core/account/policy/admin-scope.policy';
import {
  DomainError,
  isDomainError,
  ORGANIZATION_MANAGEMENT_ERROR,
} from '@core/common/errors/domain-error';
import { Inject, Injectable } from '@nestjs/common';
import { isDuplicateKeyError } from '@src/modules/common/utils/database-error.util';
import { OrganizationService } from '@src/modules/lithography/organization.service';
import { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
import type {
  AdminOrganizationView,
  UpdateManagedCompanyPatch,
} from '@src/modules/lithography/organization.types';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';
import { PinoLogger } from 'nestjs-pino';
import { normalizeAdminOrganizationUpdateInput } from './admin-organization.input.normalize';

export type UpdateAdminOrganizationCommand = {
  readonly session: UsecaseSession;
  readonly organizationId: unknown;
  readonly name?: unknown;
  readonly shortName?: unknown;
  readonly contactName?: unknown;
  readonly contactPhone?: unknown;
  readonly contactEmail?: unknown;
  readonly address?: unknown;
  readonly remark?: unknown;
  readonly status?: unknown;
  readonly isServiceProvider?: unknown;
};

/**
 * 一级管理员编辑公司档案（任务 08.2）。
 *
 * 授权：仅一级管理员。只写白名单补丁：未传字段保持不变，可选文本显式 `null` / 空白为清空；
 * 编号、受管归类、类别与创建时间不可经任何输入改写。
 *
 * 编辑与启停、维修资格共用本入口（`status` / `isServiceProvider`），避免同一目标被
 * 多条写路径并发覆盖。事务内先锁目标再读判：目标不存在统一 `TARGET_NOT_FOUND`
 * （对外 `NOT_FOUND`）；写入后在同事务内回读并逐字段校验补丁已生效，未生效按
 * 写入失败关闭，不返回假成功。
 */
@Injectable()
export class UpdateAdminOrganizationUsecase {
  constructor(
    private readonly organizationService: OrganizationService,
    private readonly organizationQueryService: OrganizationQueryService,
    private readonly logger: PinoLogger,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {
    this.logger.setContext(UpdateAdminOrganizationUsecase.name);
  }

  async execute(command: UpdateAdminOrganizationCommand): Promise<AdminOrganizationView> {
    resolveLevelOneAdminScope(command.session, '编辑公司档案');

    const { organizationId, patch } = normalizeAdminOrganizationUpdateInput({
      organizationId: command.organizationId,
      name: command.name,
      shortName: command.shortName,
      contactName: command.contactName,
      contactPhone: command.contactPhone,
      contactEmail: command.contactEmail,
      address: command.address,
      remark: command.remark,
      status: command.status,
      isServiceProvider: command.isServiceProvider,
    });

    try {
      const view = await this.transactionRunner.run(async (transactionContext) => {
        const locked = await this.organizationQueryService.lockAdminOrganizationForUpdate({
          organizationId,
          transactionContext,
        });
        if (locked === null) {
          throw new DomainError(
            ORGANIZATION_MANAGEMENT_ERROR.TARGET_NOT_FOUND,
            '公司不存在或已被删除',
            { organizationId },
          );
        }

        await this.organizationService.updateManagedCompany({
          organizationId,
          patch,
          updatedAt: new Date(),
          transactionContext,
        });

        const readBack = await this.organizationQueryService.findAdminOrganizationView({
          organizationId,
          transactionContext,
        });
        if (readBack === null) {
          throw new DomainError(
            ORGANIZATION_MANAGEMENT_ERROR.WRITE_FAILED,
            '公司更新后读取失败，请稍后重试',
            { diagnostic: 'UPDATED_ORGANIZATION_NOT_READABLE', organizationId },
          );
        }
        assertPatchReflected({ organizationId, view: readBack, patch });
        return readBack;
      });

      this.logger.info({ organizationId: view.id }, '一级管理员编辑公司档案成功');
      return view;
    } catch (error) {
      if (isDomainError(error)) {
        throw error;
      }
      if (isDuplicateKeyError(error)) {
        throw new DomainError(
          ORGANIZATION_MANAGEMENT_ERROR.CODE_CONFLICT,
          '公司编号冲突，请重试',
          undefined,
          error,
        );
      }
      this.logger.error(
        { error: error instanceof Error ? error.message : String(error), organizationId },
        '一级管理员编辑公司档案失败',
      );
      throw new DomainError(
        ORGANIZATION_MANAGEMENT_ERROR.WRITE_FAILED,
        '编辑公司失败，请稍后重试',
        undefined,
        error,
      );
    }
  }
}

/** 回读校验：补丁中每个已提供字段都必须与回读值一致，否则按写入失败关闭 */
function assertPatchReflected(params: {
  organizationId: number;
  view: AdminOrganizationView;
  patch: UpdateManagedCompanyPatch;
}): void {
  const { organizationId, view, patch } = params;
  const mismatchedFields: (keyof UpdateManagedCompanyPatch)[] = [];
  for (const field of Object.keys(patch) as (keyof UpdateManagedCompanyPatch)[]) {
    if (view[field] !== patch[field]) {
      mismatchedFields.push(field);
    }
  }

  if (mismatchedFields.length > 0) {
    throw new DomainError(
      ORGANIZATION_MANAGEMENT_ERROR.WRITE_FAILED,
      '公司更新未生效，请稍后重试',
      { diagnostic: 'PATCH_NOT_REFLECTED_AFTER_WRITE', organizationId, mismatchedFields },
    );
  }
}
