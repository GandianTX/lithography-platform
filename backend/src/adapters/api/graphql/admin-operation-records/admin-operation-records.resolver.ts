// src/adapters/api/graphql/admin-operation-records/admin-operation-records.resolver.ts

import { mapJwtToUsecaseSession } from '@app-types/auth/session.types';
import { JwtPayload } from '@app-types/jwt.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import { UseGuards } from '@nestjs/common';
import { Args, Query, Resolver } from '@nestjs/graphql';
import { currentUser } from '@src/adapters/api/graphql/decorators/current-user.decorator';
import { Roles } from '@src/adapters/api/graphql/decorators/roles.decorator';
import { JwtAuthGuard } from '@src/adapters/api/graphql/guards/jwt-auth.guard';
import { RolesGuard } from '@src/adapters/api/graphql/guards/roles.guard';
import { mapGqlToCoreParams } from '@src/adapters/api/graphql/pagination.mapper';
import { PaginationArgs } from '@src/adapters/api/graphql/pagination.args';
import { ListManagementAuditEventsUsecase } from '@src/usecases/management-audit/list-management-audit-events.usecase';
import {
  ManagementAuditEventPaginatedDTO,
  toManagementAuditEventItemDTO,
} from './dto/management-audit-event.dto';
import { ValidateManagementAuditInput } from './validate-management-audit-input.decorator';

/**
 * 关键操作记录只读解析器（任务 10，页面 §14.1）。
 *
 * 职责边界（`docs/api/adapters.rules.md`）：
 * - 只做协议映射：入参校验 → 调用 usecase → 输出 DTO；业务异常不在此捕获；
 * - 权限口径：`@Roles(SUPER_ADMIN)` 只做粗准入；精确授权（activeRole、等级、
 *   二级可信公司，失败关闭）由 usecase 首行裁决；
 * - 只读：本解析器不提供新增、编辑、删除、导出或审计配置能力的任何入口；
 * - 入参只有分页，没有筛选/排序/公司参数，组织范围不可能由客户端指定。
 */
@Resolver()
export class AdminOperationRecordsResolver {
  constructor(
    private readonly listManagementAuditEventsUsecase: ListManagementAuditEventsUsecase,
  ) {}

  /** 管理员分页查询关键操作记录（一级全公司，二级限本公司；固定三类操作） */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.SUPER_ADMIN)
  @Query(() => ManagementAuditEventPaginatedDTO, {
    name: 'managementAuditEvents',
    description: '管理员分页查询关键操作记录（只读；一级全公司，二级限本公司）',
  })
  @ValidateManagementAuditInput()
  async managementAuditEvents(
    @Args('pagination') pagination: PaginationArgs,
    @currentUser() user: JwtPayload,
  ): Promise<ManagementAuditEventPaginatedDTO> {
    const page = await this.listManagementAuditEventsUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      pagination: mapGqlToCoreParams(pagination),
    });

    return {
      items: page.items.map(toManagementAuditEventItemDTO),
      total: page.total,
      page: page.page,
      pageSize: page.pageSize,
    };
  }
}
