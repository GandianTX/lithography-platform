// src/adapters/api/graphql/repair-request/repair-request.resolver.ts

import {
  EngineerResolutionStatus,
  RepairRequestAcceptanceViewStatus,
  RepairRequestHandlingResult,
  RepairRequestHandlingStatus,
} from '@app-types/models/repair-request.types';
import { mapJwtToUsecaseSession } from '@app-types/auth/session.types';
import type { AuthenticatedSessionUser } from '@app-types/auth/session-restriction.types';
import { JwtPayload } from '@app-types/jwt.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import { UseGuards } from '@nestjs/common';
import { Args, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { ValidateInput } from '@adapters/api/graphql/common/validate-input.decorator';
import { currentUser } from '@src/adapters/api/graphql/decorators/current-user.decorator';
import { Roles } from '@src/adapters/api/graphql/decorators/roles.decorator';
import { JwtAuthGuard } from '@src/adapters/api/graphql/guards/jwt-auth.guard';
import { RolesGuard } from '@src/adapters/api/graphql/guards/roles.guard';
import { mapGqlToCoreParams } from '@src/adapters/api/graphql/pagination.mapper';
import { PaginationArgs } from '@src/adapters/api/graphql/pagination.args';
import { AcceptRepairRequestUsecase } from '@src/usecases/repair-request/accept-repair-request.usecase';
import { CloseRepairRequestUsecase } from '@src/usecases/repair-request/close-repair-request.usecase';
import { CreateEngineerResponseUsecase } from '@src/usecases/repair-request/create-engineer-response.usecase';
import { CreateRepairProcessEntryUsecase } from '@src/usecases/repair-request/create-repair-process-entry.usecase';
import { CreateRepairRequestUsecase } from '@src/usecases/repair-request/create-repair-request.usecase';
import { DeleteMyRepairRequestUsecase } from '@src/usecases/repair-request/delete-my-repair-request.usecase';
import { GetEngineerRepairRequestDetailUsecase } from '@src/usecases/repair-request/get-engineer-repair-request-detail.usecase';
import { GetMyRepairRequestDetailUsecase } from '@src/usecases/repair-request/get-my-repair-request-detail.usecase';
import { ListEngineerRepairRequestsUsecase } from '@src/usecases/repair-request/list-engineer-repair-requests.usecase';
import { ListMyRepairRequestsUsecase } from '@src/usecases/repair-request/list-my-repair-requests.usecase';
import { SearchRepairServiceOrganizationsUsecase } from '@src/usecases/repair-request/search-repair-service-organizations.usecase';
import { UpdateRepairProcessEntryUsecase } from '@src/usecases/repair-request/update-repair-process-entry.usecase';
import { CreateEngineerResponseInput } from './dto/create-engineer-response.input';
import { CreateRepairProcessEntryInput } from './dto/create-repair-process-entry.input';
import { CreateRepairRequestInput } from './dto/create-repair-request.input';
import { UpdateRepairProcessEntryInput } from './dto/update-repair-process-entry.input';
import { CloseRepairRequestInput } from './dto/close-repair-request.input';
import { RepairRequestClosureDTO } from './dto/repair-request-closure.dto';
import { RepairProcessEntryDTO } from './dto/repair-process-entry.dto';
import { DeleteMyRepairRequestResultDTO } from './dto/delete-my-repair-request-result.dto';
import {
  RepairServiceOrganizationPageDTO,
  toRepairServiceOrganizationPageDTO,
} from './dto/repair-service-organization.dto';
import { RepairRequestDTO } from './dto/repair-request.dto';
import { EngineerRepairRequestFilterInput } from './dto/engineer-repair-request-filter.input';
import { ValidateRepairRequestInput } from './validate-repair-request-input.decorator';
import {
  EngineerResponseDTO,
  RepairRequestDetailDTO,
  RepairRequestEngineerListItemDTO,
  RepairRequestEngineerPaginatedDTO,
  RepairRequestListItemDTO,
  RepairRequestPaginatedDTO,
} from './dto/repair-request-read.dto';

/**
 * 维修申请 GraphQL 解析器
 * 仅做协议映射：结构校验 → 调用 usecase → 输出 DTO
 * 业务异常不在此捕获，交由全局过滤器映射为 GraphQL 错误契约
 */
@Resolver(() => RepairRequestDTO)
export class RepairRequestResolver {
  constructor(
    private readonly createRepairRequestUsecase: CreateRepairRequestUsecase,
    private readonly acceptRepairRequestUsecase: AcceptRepairRequestUsecase,
    private readonly createEngineerResponseUsecase: CreateEngineerResponseUsecase,
    private readonly createRepairProcessEntryUsecase: CreateRepairProcessEntryUsecase,
    private readonly updateRepairProcessEntryUsecase: UpdateRepairProcessEntryUsecase,
    private readonly closeRepairRequestUsecase: CloseRepairRequestUsecase,
    private readonly deleteMyRepairRequestUsecase: DeleteMyRepairRequestUsecase,
    private readonly listMyRepairRequestsUsecase: ListMyRepairRequestsUsecase,
    private readonly listEngineerRepairRequestsUsecase: ListEngineerRepairRequestsUsecase,
    private readonly getMyRepairRequestDetailUsecase: GetMyRepairRequestDetailUsecase,
    private readonly getEngineerRepairRequestDetailUsecase: GetEngineerRepairRequestDetailUsecase,
    private readonly searchRepairServiceOrganizationsUsecase: SearchRepairServiceOrganizationsUsecase,
  ) {}

  /**
   * 客户查询报修服务公司候选（启用且具备维修服务资格）。
   *
   * 入口仅按 `@Roles(CUSTOMER)` 做粗粒度准入（角色继承不放开给 SUPER_ADMIN）；
   * 客户角色与「已补齐可信公司归属」由 Usecase 精确复核，缺失即 FORBIDDEN。
   * 只返回 `id` / `name` / `shortName`，所选公司仍由 03 在提交事务内复核。
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.CUSTOMER)
  @Query(() => RepairServiceOrganizationPageDTO, {
    name: 'repairServiceOrganizationSearch',
    description: '客户查询报修服务公司候选（启用且具备维修服务资格）',
  })
  @ValidateInput()
  async repairServiceOrganizationSearch(
    @Args('pagination', { description: '分页参数（仅 OFFSET）' }) pagination: PaginationArgs,
    @currentUser() user: AuthenticatedSessionUser,
    @Args('keyword', {
      type: () => String,
      nullable: true,
      description: '公司名称关键字；缺省表示不过滤',
    })
    keyword?: string,
  ): Promise<RepairServiceOrganizationPageDTO> {
    const page = await this.searchRepairServiceOrganizationsUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      keyword: keyword ?? null,
      pagination: mapGqlToCoreParams(pagination),
    });
    return toRepairServiceOrganizationPageDTO(page);
  }

  /**
   * 客户创建维修申请
   * 仅 CUSTOMER 可提交；customerAccountId 取自会话，客户端不可传入
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.CUSTOMER)
  @Mutation(() => RepairRequestDTO, { description: '客户创建维修申请' })
  @ValidateInput()
  async createRepairRequest(
    @Args('input') input: CreateRepairRequestInput,
    @currentUser() user: JwtPayload,
  ): Promise<RepairRequestDTO> {
    const snapshot = await this.createRepairRequestUsecase.execute({
      session: {
        accountId: user.sub,
        accessGroup: user.accessGroup,
      },
      equipmentModelId: input.equipmentModelId,
      errorCode: input.errorCode,
      faultDescription: input.faultDescription,
    });
    return {
      id: snapshot.id,
      requestNo: snapshot.requestNo,
      equipmentModelId: snapshot.equipmentModelId,
      errorCode: snapshot.errorCode,
      faultDescription: snapshot.faultDescription,
      createdAt: snapshot.createdAt,
      isAccepted: snapshot.isAccepted,
    };
  }

  /**
   * 工程师接单（原子条件更新，竞争时仅一方可成功）
   * 入口仅做粗粒度准入（@Roles(ENGINEER) 按 accessGroup 判断）；
   * 接单写权限的精确角色规则（roles 含 ENGINEER 且可信 JWT activeRole=ENGINEER）
   * 由 AcceptRepairRequestUsecase 作为业务规则执行，读权限继承不等于写权限继承；
   * 接单工程师取自会话，接单时间由后端生成，均不可由客户端传入；
   * 成功输出复用工程师详情读链路与本 Resolver 既有详情 DTO 映射，
   * 业务异常（不存在/已接单/越权/系统失败）不在此捕获，交由全局过滤器映射
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER)
  @Mutation(() => RepairRequestDetailDTO, { description: '工程师接单维修申请' })
  async acceptRepairRequest(
    @Args({ name: 'id', type: () => Int, description: '维修申请 ID' }) id: number,
    @currentUser() user: JwtPayload,
  ): Promise<RepairRequestDetailDTO> {
    const detail = await this.acceptRepairRequestUsecase.execute({
      requestId: id,
      session: mapJwtToUsecaseSession(user),
    });
    return this.toDetailDTO(detail);
  }

  /**
   * 工程师追加处理回复（追加写入，不更新历史回复）
   * 入口仅做粗粒度准入（@Roles(ENGINEER) 按 accessGroup 判断）；
   * 回复写权限的精确角色规则（roles 含 ENGINEER 且可信 JWT activeRole=ENGINEER）
   * 由 CreateEngineerResponseUsecase 作为业务规则执行；
   * engineerAccountId 取自可信 Session，customerAccountId 由目标申请派生，
   * 客户端不可传入；成功只返回本次新建回复，事务提交后不重查整份详情；
   * 业务异常（不可访问/未接单/越权/输入非法/系统失败）不在此捕获，交由全局过滤器映射
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER)
  @Mutation(() => EngineerResponseDTO, { description: '工程师追加处理回复' })
  @ValidateInput()
  async createEngineerResponse(
    @Args('input') input: CreateEngineerResponseInput,
    @currentUser() user: JwtPayload,
  ): Promise<EngineerResponseDTO> {
    const view = await this.createEngineerResponseUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      requestId: input.requestId,
      responseText: input.responseText,
      resolutionStatus: input.resolutionStatus,
    });
    return this.toResponseDTO(view);
  }

  /**
   * 工程师创建内部维修过程（可选在同一事务内绑定暂存原件）
   * 写权限、接单人、组织范围、工单状态与作者均由 usecase 在同一事务内裁决；
   * 结单后过程只读；客户不可调用
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER)
  @Mutation(() => RepairProcessEntryDTO, { description: '工程师创建内部维修过程' })
  @ValidateInput()
  async createRepairProcessEntry(
    @Args('input') input: CreateRepairProcessEntryInput,
    @currentUser() user: JwtPayload,
  ): Promise<RepairProcessEntryDTO> {
    const snapshot = await this.createRepairProcessEntryUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      requestId: input.requestId,
      operationText: input.operationText,
      testResult: input.testResult,
      occurredAt: input.occurredAt,
      file: input.file,
    });
    return this.toProcessEntryDTO(snapshot);
  }

  /**
   * 工程师编辑内部维修过程
   * 仅作者本人、接单人、同组织可编辑；expectedVersion 不符返回冲突；
   * 仅当前过程无原件时可补传一份暂存原件；已有原件不允许替换/移除；结单后只读
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER)
  @Mutation(() => RepairProcessEntryDTO, { description: '工程师编辑内部维修过程' })
  @ValidateInput()
  async updateRepairProcessEntry(
    @Args('input') input: UpdateRepairProcessEntryInput,
    @currentUser() user: JwtPayload,
  ): Promise<RepairProcessEntryDTO> {
    const snapshot = await this.updateRepairProcessEntryUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      requestId: input.requestId,
      entryId: input.entryId,
      expectedVersion: input.expectedVersion,
      operationText: input.operationText,
      testResult: input.testResult,
      occurredAt: input.occurredAt,
      file: input.file,
    });
    return this.toProcessEntryDTO(snapshot);
  }

  /**
   * 工程师结单
   * 仅接单工程师本人、同组织可结单；处理结果经固定策略映射为三态状态；
   * 结单与回复互相独立；结单后过程与回复只读
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER)
  @Mutation(() => RepairRequestClosureDTO, { description: '工程师结单' })
  @ValidateInput()
  async closeRepairRequest(
    @Args('input') input: CloseRepairRequestInput,
    @currentUser() user: JwtPayload,
  ): Promise<RepairRequestClosureDTO> {
    return this.closeRepairRequestUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      requestId: input.requestId,
      handlingResult: input.handlingResult,
      closureReason: input.closureReason,
    });
  }

  /**
   * 客户删除自己的未接单维修申请（原子条件软删除）
   * 仅 CUSTOMER 可删除；SUPER_ADMIN 不能以客户身份删除（负责人 20260901 裁定 2）；
   * 错误语义（裁定 5）：不存在/非本人统一 NOT_FOUND，已接单 CONFLICT，
   * 本人重复删除幂等成功；账号仅取自会话，客户端不可传入
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.CUSTOMER)
  @Mutation(() => DeleteMyRepairRequestResultDTO, {
    description: '客户删除自己的未接单维修申请（软删除；重复删除幂等成功）',
  })
  async deleteMyRepairRequest(
    @Args({ name: 'id', type: () => Int, description: '维修申请 ID' }) id: number,
    @currentUser() user: JwtPayload,
  ): Promise<DeleteMyRepairRequestResultDTO> {
    const result = await this.deleteMyRepairRequestUsecase.execute({
      requestId: id,
      session: mapJwtToUsecaseSession(user),
    });
    return { id: result.id, requestNo: result.requestNo };
  }

  /**
   * 客户查询自己的维修申请列表（仅本人、未删除）
   * 排序由契约固定：创建时间倒序 + 主键倒序；仅支持 OFFSET 分页（usecase 强制）
   * SUPER_ADMIN 按角色继承规则准入（负责人 20260901 裁定 2）
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.CUSTOMER, IdentityTypeEnum.SUPER_ADMIN)
  @Query(() => RepairRequestPaginatedDTO, { description: '客户查询自己的维修申请列表' })
  @ValidateInput()
  async myRepairRequests(
    @Args('pagination') pagination: PaginationArgs,
    @currentUser() user: JwtPayload,
  ): Promise<RepairRequestPaginatedDTO> {
    const page = await this.listMyRepairRequestsUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      pagination: mapGqlToCoreParams(pagination),
    });
    return {
      items: page.items.map((item) => this.toListItemDTO(item)),
      total: page.total,
      page: page.page,
      pageSize: page.pageSize,
    };
  }

  /**
   * 工程师查询维修申请列表：scope 四态 ALL / AVAILABLE / MINE / TAKEN_BY_OTHER（缺省 ALL）
   * 范围取值与筛选入参由 usecase 校验/收敛；排序与分页口径同客户列表；
   * 客户昵称筛选由 usecase 经账号域批量解析后在分页计数前完成；
   * SUPER_ADMIN 按角色继承规则准入（负责人 20260901 裁定 2）
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER, IdentityTypeEnum.SUPER_ADMIN)
  @Query(() => RepairRequestEngineerPaginatedDTO, {
    description: '工程师查询维修申请列表（全部 / 待接单 / 我的接单 / 他人已接单）',
  })
  @ValidateRepairRequestInput()
  async engineerRepairRequests(
    @Args('scope', {
      type: () => String,
      nullable: true,
      defaultValue: 'ALL',
      description: '列表范围：ALL（默认）/ AVAILABLE / MINE / TAKEN_BY_OTHER',
    })
    scope: string,
    @Args('pagination') pagination: PaginationArgs,
    @currentUser() user: JwtPayload,
    @Args('filter', {
      type: () => EngineerRepairRequestFilterInput,
      nullable: true,
      description: '可选筛选：设备型号 / 客户昵称关键词',
    })
    filter?: EngineerRepairRequestFilterInput,
  ): Promise<RepairRequestEngineerPaginatedDTO> {
    const page = await this.listEngineerRepairRequestsUsecase.execute({
      session: mapJwtToUsecaseSession(user),
      scope,
      filter: {
        equipmentModelId: filter?.equipmentModelId,
        customerNickname: filter?.customerNickname,
      },
      pagination: mapGqlToCoreParams(pagination),
    });
    return {
      items: page.items.map((item) => this.toEngineerListItemDTO(item)),
      total: page.total,
      page: page.page,
      pageSize: page.pageSize,
    };
  }

  /**
   * 客户查询自己的维修申请详情（含回复时间线）
   * 细粒度读权限由 QueryService 按客户身份判定；越权统一拒绝，不泄露存在性；
   * SUPER_ADMIN 按角色继承规则准入（负责人 20260901 裁定 2）
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.CUSTOMER, IdentityTypeEnum.SUPER_ADMIN)
  @Query(() => RepairRequestDetailDTO, { description: '客户查询自己的维修申请详情（含回复）' })
  async myRepairRequest(
    @Args({ name: 'id', type: () => Int, description: '维修申请 ID' }) id: number,
    @currentUser() user: JwtPayload,
  ): Promise<RepairRequestDetailDTO> {
    const detail = await this.getMyRepairRequestDetailUsecase.execute({
      requestId: id,
      session: mapJwtToUsecaseSession(user),
    });
    return this.toDetailDTO(detail);
  }

  /**
   * 工程师查询维修申请详情（含回复时间线）
   * 工程师可读取任意未删除申请（含他人已接单的只读视角）；
   * 细粒度读权限由 QueryService 按工程师身份判定；
   * 越权统一拒绝，不泄露存在性；写权限仍由各写用例精确裁决（读放宽不等于写放宽）；
   * SUPER_ADMIN 按角色继承规则准入（裁定 2）
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.ENGINEER, IdentityTypeEnum.SUPER_ADMIN)
  @Query(() => RepairRequestDetailDTO, { description: '工程师查询维修申请详情（含回复）' })
  async engineerRepairRequest(
    @Args({ name: 'id', type: () => Int, description: '维修申请 ID' }) id: number,
    @currentUser() user: JwtPayload,
  ): Promise<RepairRequestDetailDTO> {
    const detail = await this.getEngineerRepairRequestDetailUsecase.execute({
      requestId: id,
      session: mapJwtToUsecaseSession(user),
    });
    return this.toDetailDTO(detail);
  }

  /**
   * 单条回复视图 → DTO（回复 Mutation 成功输出与详情 responses 复用同一映射，
   * 不各写一份；不返回工程师账号 ID）
   */
  private toResponseDTO(response: {
    id: number;
    engineerNickname: string;
    resolutionStatus: EngineerResolutionStatus;
    responseText: string;
    createdAt: Date;
  }): EngineerResponseDTO {
    return {
      id: response.id,
      engineerNickname: response.engineerNickname,
      resolutionStatus: response.resolutionStatus,
      responseText: response.responseText,
      createdAt: response.createdAt,
    };
  }

  /**
   * 内部维修过程视图 → DTO（创建/编辑成功返回；file 为 null 时前端刷新详情读取绑定信息）
   */
  private toProcessEntryDTO(entry: {
    id: string;
    entryUuid: string;
    requestId: number;
    operationText: string;
    testResult: string | null;
    occurredAt: Date | null;
    timeSource: string;
    fileId: string | null;
    versionNo: number;
    createdAt: Date;
  }): RepairProcessEntryDTO {
    return {
      id: entry.id,
      entryUuid: entry.entryUuid,
      requestId: entry.requestId,
      operationText: entry.operationText,
      testResult: entry.testResult,
      occurredAt: entry.occurredAt,
      timeSource: entry.timeSource,
      fileId: entry.fileId,
      file: null,
      versionNo: entry.versionNo,
      createdAt: entry.createdAt,
    };
  }

  /**
   * 详情视图 → DTO（回复含工程师安全昵称，不返回工程师账号 ID）
   * 工程师入口富集字段（客户/接单工程师资料与视角状态）存在时透传，客户入口为空
   */
  private toDetailDTO(detail: {
    id: number;
    requestNo: string;
    equipmentModel: { id: number; modelCode: string; modelName: string };
    errorCode: string;
    faultDescription: string;
    contentMd: string;
    createdAt: Date;
    isAccepted: boolean;
    acceptedAt: Date | null;
    latestResolutionStatus: EngineerResolutionStatus | null;
    responses: Array<{
      id: number;
      engineerNickname: string;
      resolutionStatus: EngineerResolutionStatus;
      responseText: string;
      createdAt: Date;
    }>;
    customerNickname?: string | null;
    customerCompanyName?: string | null;
    acceptanceViewStatus?: RepairRequestAcceptanceViewStatus | null;
    acceptedEngineerNickname?: string | null;
    closureStatus: string | null;
    closedAt: Date | null;
    closureReason: string | null;
    handlingResult: RepairRequestHandlingResult | null;
    handlingStatus: RepairRequestHandlingStatus | null;
    processEntries: Array<{
      id: string;
      entryUuid: string;
      requestId: number;
      operationText: string;
      testResult: string | null;
      occurredAt: Date | null;
      timeSource: string;
      fileId: string | null;
      versionNo: number;
      createdAt: Date;
      file: {
        fileId: string;
        originalFilename: string;
        mimeType: string;
        byteSize: number;
        checksumSha256: string;
      } | null;
    }>;
  }): RepairRequestDetailDTO {
    return {
      ...this.toListItemDTO(detail),
      faultDescription: detail.faultDescription,
      contentMd: detail.contentMd,
      responses: detail.responses.map((response) => this.toResponseDTO(response)),
      customerNickname: detail.customerNickname ?? null,
      customerCompanyName: detail.customerCompanyName ?? null,
      acceptanceViewStatus: detail.acceptanceViewStatus ?? null,
      acceptedEngineerNickname: detail.acceptedEngineerNickname ?? null,
      closureStatus: detail.closureStatus,
      closedAt: detail.closedAt,
      closureReason: detail.closureReason,
      handlingResult: detail.handlingResult,
      handlingStatus: detail.handlingStatus,
      processEntries: detail.processEntries.map((entry) => ({
        ...this.toProcessEntryDTO(entry),
        file: entry.file,
      })),
    };
  }

  /**
   * 工程师列表项视图 → DTO（不返回归属类账号 ID）
   */
  private toEngineerListItemDTO(view: {
    id: number;
    requestNo: string;
    equipmentModel: { id: number; modelCode: string; modelName: string };
    errorCode: string;
    createdAt: Date;
    isAccepted: boolean;
    acceptedAt: Date | null;
    latestResolutionStatus: EngineerResolutionStatus | null;
    customerNickname: string;
    customerCompanyName: string | null;
    acceptanceViewStatus: RepairRequestAcceptanceViewStatus;
    acceptedEngineerNickname: string | null;
    closureStatus?: string | null;
    closedAt?: Date | null;
    handlingResult?: RepairRequestHandlingResult | null;
    handlingStatus?: RepairRequestHandlingStatus | null;
  }): RepairRequestEngineerListItemDTO {
    return {
      ...this.toListItemDTO(view),
      customerNickname: view.customerNickname,
      customerCompanyName: view.customerCompanyName,
      acceptanceViewStatus: view.acceptanceViewStatus,
      acceptedEngineerNickname: view.acceptedEngineerNickname,
      closureStatus: view.closureStatus,
      closedAt: view.closedAt,
      handlingResult: view.handlingResult,
      handlingStatus: view.handlingStatus,
    };
  }

  /**
   * 列表项视图 → DTO（详情复用同一映射，字段子集兼容）
   */
  private toListItemDTO(view: {
    id: number;
    requestNo: string;
    equipmentModel: { id: number; modelCode: string; modelName: string };
    errorCode: string;
    createdAt: Date;
    isAccepted: boolean;
    acceptedAt: Date | null;
    latestResolutionStatus: EngineerResolutionStatus | null;
  }): RepairRequestListItemDTO {
    return {
      id: view.id,
      requestNo: view.requestNo,
      equipmentModel: {
        id: view.equipmentModel.id,
        modelCode: view.equipmentModel.modelCode,
        modelName: view.equipmentModel.modelName,
      },
      errorCode: view.errorCode,
      createdAt: view.createdAt,
      isAccepted: view.isAccepted,
      acceptedAt: view.acceptedAt,
      latestResolutionStatus: view.latestResolutionStatus,
    };
  }
}
