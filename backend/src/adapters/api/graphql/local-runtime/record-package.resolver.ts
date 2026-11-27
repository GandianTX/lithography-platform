// src/adapters/api/graphql/local-runtime/record-package.resolver.ts

import type { AuthenticatedSessionUser } from '@app-types/auth/session-restriction.types';
import { mapJwtToUsecaseSession, type UsecaseSession } from '@app-types/auth/session.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import { UseGuards } from '@nestjs/common';
import { Args, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { currentUser } from '@src/adapters/api/graphql/decorators/current-user.decorator';
import { Roles } from '@src/adapters/api/graphql/decorators/roles.decorator';
import { JwtAuthGuard } from '@src/adapters/api/graphql/guards/jwt-auth.guard';
import { RolesGuard } from '@src/adapters/api/graphql/guards/roles.guard';
import {
  RecordPackageCheckResultDTO,
  RecordPackageProcessResultDTO,
  toRecordPackageImportDTO,
  toRecordPackageItemDTO,
} from '@src/adapters/api/graphql/local-runtime/dto/record-package.dto';
import {
  CheckRecordPackageUsecase,
  GetRecordPackageResultUsecase,
} from '@src/usecases/local-runtime/check-record-package.usecase';
import { ImportRecordPackageUsecase } from '@src/usecases/local-runtime/import-record-package.usecase';
import { ExportRecordPackageUsecase } from '@src/usecases/local-runtime/export-record-package.usecase';
import {
  RecordPackageExportEntryInputDTO,
  RecordPackageExportResultDTO,
  toRecordPackageExportDTO,
} from '@src/adapters/api/graphql/local-runtime/dto/record-package-export.dto';
import { recordPackageResourceTypeEnum } from '@core/local-runtime/policy/record-package-export.policy';
import type { RecordPackageResourceType } from '@core/local-runtime/policy/record-package-manifest.policy';

/**
 * 记录包解析器（任务 09 S2.3，R070／R071／R073）。
 *
 * - 导出（R070）：有权用户把本公司（一级任意公司）已授权记录组装为
 *   目录形态记录包，落盘前经导入侧同源结构自校验；
 * - 检查（R071）只落检查事实，不写正式业务；
 * - 导入（R072）需要来源业务受控写入入口（X04），接入前不暴露入口，
 *   避免"检查合格就当作导入成功"的假通道；
 * - 结果查询（R073）按本公司范围过滤，检查结论与导入结果分列；
 * - 包路径是本机绝对路径（U盘挂载点或包目录），只读取包内相对路径文件。
 */
@Resolver()
export class RecordPackageResolver {
  constructor(
    private readonly checkRecordPackageUsecase: CheckRecordPackageUsecase,
    private readonly getRecordPackageResultUsecase: GetRecordPackageResultUsecase,
    private readonly exportRecordPackageUsecase: ExportRecordPackageUsecase,
    private readonly importRecordPackageUsecase: ImportRecordPackageUsecase,
  ) {}

  /** 导出记录包：逐条结果语义，单条失败不影响其他条目 */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER, IdentityTypeEnum.SUPER_ADMIN)
  @Mutation(() => RecordPackageExportResultDTO, {
    name: 'exportRecordPackage',
    description: '导出记录包到本机目录（U盘挂载点）；目标目录必须不存在或为空，逐条结果语义',
  })
  async exportRecordPackage(
    @currentUser() user: AuthenticatedSessionUser,
    @Args('targetPath', { type: () => String }) targetPath: string,
    @Args('organizationId', { type: () => Int, nullable: true }) organizationId: number | null,
    @Args('resourceType', { type: () => recordPackageResourceTypeEnum })
    resourceType: RecordPackageResourceType,
    @Args('recordIds', { type: () => [Int] }) recordIds: number[],
    @Args('entries', {
      type: () => [RecordPackageExportEntryInputDTO],
      nullable: true,
      description: '导出条目清单（可混合多种资源类型）；提供时以它为准，缺省沿用旧的单一类型形态',
    })
    entries?: RecordPackageExportEntryInputDTO[] | null,
  ): Promise<RecordPackageExportResultDTO> {
    const result = await this.exportRecordPackageUsecase.execute({
      session: this.toSession(user),
      targetPath,
      organizationId: organizationId ?? undefined,
      resourceType,
      recordIds,
      entries: entries ?? undefined,
    });
    return toRecordPackageExportDTO(result);
  }

  private toSession(user: AuthenticatedSessionUser): UsecaseSession {
    return mapJwtToUsecaseSession(user);
  }

  /** 检查待导入记录包：逐条资格结论，损坏/错公司/越权引用/重复拒绝 */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER, IdentityTypeEnum.SUPER_ADMIN)
  @Mutation(() => RecordPackageCheckResultDTO, {
    name: 'checkRecordPackage',
    description: '检查待导入记录包（不写正式业务）；同包重复检查返回既有事实',
  })
  async checkRecordPackage(
    @currentUser() user: AuthenticatedSessionUser,
    @Args('packagePath', { type: () => String }) packagePath: string,
  ): Promise<RecordPackageCheckResultDTO> {
    const result = await this.checkRecordPackageUsecase.execute({
      session: this.toSession(user),
      packagePath,
    });
    return {
      outcome: result.outcome,
      import: toRecordPackageImportDTO(result.import),
      items: result.items.map(toRecordPackageItemDTO),
    };
  }

  /**
   * 导入记录包：明确确认 → 受控逐项导入 → 逐项结果。
   *
   * 确认必须带上检查结论的清单摘要；包内容变了旧确认作废（需重新检查与确认）。
   * 每条记录经来源业务受控写入入口落地；没有受控入口的类型逐条失败关闭。
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER, IdentityTypeEnum.SUPER_ADMIN)
  @Mutation(() => RecordPackageProcessResultDTO, {
    name: 'importRecordPackage',
    description:
      '导入记录包（需先通过安全预检并明确确认）；逐条结果语义，受控写入，批次终态由逐条结果汇总',
  })
  async importRecordPackage(
    @currentUser() user: AuthenticatedSessionUser,
    @Args('packageId', { type: () => String }) packageId: string,
    @Args('packagePath', { type: () => String }) packagePath: string,
    @Args('manifestChecksum', { type: () => String }) manifestChecksum: string,
  ): Promise<RecordPackageProcessResultDTO> {
    const result = await this.importRecordPackageUsecase.execute({
      session: this.toSession(user),
      packageId,
      packagePath,
      manifestChecksum,
    });
    return {
      import: toRecordPackageImportDTO(result.import),
      items: result.items.map(toRecordPackageItemDTO),
    };
  }

  /** 记录包处理结果：检查结论与导入结果分列 */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER, IdentityTypeEnum.SUPER_ADMIN)
  @Query(() => RecordPackageProcessResultDTO, {
    name: 'recordPackageResult',
    description: '记录包处理结果（本公司范围；范围外与不存在同码返回）',
  })
  async recordPackageResult(
    @currentUser() user: AuthenticatedSessionUser,
    @Args('packageId', { type: () => String }) packageId: string,
  ): Promise<RecordPackageProcessResultDTO> {
    const result = await this.getRecordPackageResultUsecase.execute({
      session: this.toSession(user),
      packageId,
    });
    return {
      import: toRecordPackageImportDTO(result.import),
      items: result.items.map(toRecordPackageItemDTO),
    };
  }
}
