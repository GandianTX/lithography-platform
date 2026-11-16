// src/usecases/organization/create-admin-organization.usecase.ts

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
import type { AdminOrganizationView } from '@src/modules/lithography/organization.types';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';
import { PinoLogger } from 'nestjs-pino';
import { normalizeAdminOrganizationCreateInput } from './admin-organization.input.normalize';

export type CreateAdminOrganizationCommand = {
  readonly session: UsecaseSession;
  readonly name: unknown;
  readonly contactPhone: unknown;
  readonly shortName?: unknown;
  readonly contactName?: unknown;
  readonly contactEmail?: unknown;
  readonly address?: unknown;
  readonly remark?: unknown;
  readonly status?: unknown;
  readonly isServiceProvider?: unknown;
};

/**
 * 一级管理员新增公司档案（任务 08.2）。
 *
 * 授权：仅一级管理员。新增即进入一级维护名单（`isManagedCompany = true`）、
 * 类别固定 `CLIENT`，编号由服务端生成；状态按入参一次落定（缺省 `ACTIVE`），
 * 维修资格按入参单独设置。
 *
 * 事务边界由本用例持有：创建后在同一事务内回读完整视图，回读失败按写入失败关闭，
 * 不返回「已提交但不可读」的假成功。编号唯一索引冲突映射为 `CODE_CONFLICT`（对外 `CONFLICT`）。
 */
@Injectable()
export class CreateAdminOrganizationUsecase {
  constructor(
    private readonly organizationService: OrganizationService,
    private readonly organizationQueryService: OrganizationQueryService,
    private readonly logger: PinoLogger,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {
    this.logger.setContext(CreateAdminOrganizationUsecase.name);
  }

  async execute(command: CreateAdminOrganizationCommand): Promise<AdminOrganizationView> {
    resolveLevelOneAdminScope(command.session, '新增公司档案');

    const data = normalizeAdminOrganizationCreateInput({
      name: command.name,
      contactPhone: command.contactPhone,
      shortName: command.shortName,
      contactName: command.contactName,
      contactEmail: command.contactEmail,
      address: command.address,
      remark: command.remark,
      status: command.status,
      isServiceProvider: command.isServiceProvider,
    });

    try {
      const view = await this.transactionRunner.run(async (transactionContext) => {
        const created = await this.organizationService.createManagedCompany(
          data,
          transactionContext,
        );
        const readBack = await this.organizationQueryService.findAdminOrganizationView({
          organizationId: created.id,
          transactionContext,
        });
        if (readBack === null) {
          throw new DomainError(
            ORGANIZATION_MANAGEMENT_ERROR.WRITE_FAILED,
            '公司创建后读取失败，请稍后重试',
            { diagnostic: 'CREATED_ORGANIZATION_NOT_READABLE', organizationId: created.id },
          );
        }
        return readBack;
      });

      this.logger.info({ organizationId: view.id }, '一级管理员新增公司档案成功');
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
        { error: error instanceof Error ? error.message : String(error) },
        '一级管理员新增公司档案失败',
      );
      throw new DomainError(
        ORGANIZATION_MANAGEMENT_ERROR.WRITE_FAILED,
        '新增公司失败，请稍后重试',
        undefined,
        error,
      );
    }
  }
}
