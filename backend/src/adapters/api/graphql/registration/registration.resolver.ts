// src/adapters/api/graphql/registration/registration.resolver.ts
import { ValidateInput } from '@adapters/api/graphql/common/validate-input.decorator';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import {
  EngineerRegistrationApplicationStatus,
  RegistrationEntryChannel,
} from '@app-types/models/registration.types';
import { mapJwtToUsecaseSession, type UsecaseSession } from '@app-types/auth/session.types';
import { JwtPayload } from '@app-types/jwt.types';
import { Args, Context, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { mapGqlToCoreParams } from '@src/adapters/api/graphql/pagination.mapper';
import { PaginationArgs } from '@src/adapters/api/graphql/pagination.args';
import { currentUser } from '@src/adapters/api/graphql/decorators/current-user.decorator';
import { Roles } from '@src/adapters/api/graphql/decorators/roles.decorator';
import { JwtAuthGuard } from '@src/adapters/api/graphql/guards/jwt-auth.guard';
import { MustChangePasswordGuard } from '@src/adapters/api/graphql/guards/must-change-password.guard';
import { RolesGuard } from '@src/adapters/api/graphql/guards/roles.guard';
import { UseGuards } from '@nestjs/common';
import { GetAdminEngineerRegistrationApprovalDetailUsecase } from '@src/usecases/registration/get-admin-engineer-registration-approval-detail.usecase';
import { GetAdminEngineerRegistrationDetailUsecase } from '@src/usecases/registration/get-admin-engineer-registration-detail.usecase';
import { GetEngineerRegistrationStatusUsecase } from '@src/usecases/registration/get-engineer-registration-status.usecase';
import { GetMyEngineerRegistrationUsecase } from '@src/usecases/registration/get-my-engineer-registration.usecase';
import { ListAdminEngineerRegistrationsUsecase } from '@src/usecases/registration/list-admin-engineer-registrations.usecase';
import { ListRegistrationOrganizationsUsecase } from '@src/usecases/registration/list-registration-organizations.usecase';
import { SearchRegistrationOrganizationsUsecase } from '@src/usecases/registration/search-registration-organizations.usecase';
import { CheckRegistrationOrganizationNameUsecase } from '@src/usecases/registration/check-registration-organization-name.usecase';
import { RegisterWithEmailUsecase } from '@usecases/registration/register-with-email.usecase';
import { RegisterWithThirdPartyUsecase } from '@usecases/registration/register-with-third-party.usecase';
import { ResubmitEngineerRegistrationUsecase } from '@src/usecases/registration/resubmit-engineer-registration.usecase';
import { ReviewEngineerRegistrationUsecase } from '@src/usecases/registration/review-engineer-registration.usecase';
import { GetWeappPhoneUsecase } from '@usecases/third-party-accounts/get-weapp-phone.usecase';
import { Request } from 'express';
import { PinoLogger } from 'nestjs-pino';
import {
  AdminEngineerRegistrationItemDTO,
  toAdminEngineerRegistrationItemDTO,
} from './dto/admin-engineer-registration-item.dto';
import {
  AdminEngineerRegistrationDetailDTO,
  toAdminEngineerRegistrationDetailDTO,
} from './dto/admin-engineer-registration-detail.dto';
import { AdminEngineerRegistrationPageDTO } from './dto/admin-engineer-registration-page.dto';
import { toEngineerRegistrationApplicationDTO } from './dto/engineer-registration-application.dto';
import { toEngineerRegistrationApplicationPageDTO } from './dto/engineer-registration-application-page.dto';
import { EngineerRegistrationCredentialInput } from './dto/engineer-registration-credential.input';
import { EngineerRegistrationStatusDTO } from './dto/engineer-registration-status.dto';
import {
  MyEngineerRegistrationDTO,
  toMyEngineerRegistrationDTO,
} from './dto/my-engineer-registration.dto';
import {
  RegistrationOrganizationPageDTO,
  toRegistrationOrganizationPageDTO,
} from './dto/registration-organization-page.dto';
import {
  RegistrationOrganizationDTO,
  toRegistrationOrganizationDTO,
} from './dto/registration-organization.dto';
import { RegisterResult } from './dto/register-result.dto';
import { RegisterInput } from './dto/register.input';
import { RegisterWebInput } from './dto/register-web.input';
import { ResubmitEngineerRegistrationResultDTO } from './dto/resubmit-engineer-registration-result.dto';
import { ResubmitEngineerRegistrationInput } from './dto/resubmit-engineer-registration.input';
import { ReviewEngineerRegistrationInput } from './dto/review-engineer-registration.input';
import { ThirdPartyRegisterInput } from './dto/third-party-register.input';

@Resolver()
export class RegistrationResolver {
  constructor(
    private readonly registerWithEmail: RegisterWithEmailUsecase,
    private readonly registerWithThirdParty: RegisterWithThirdPartyUsecase,
    private readonly getWeappPhoneUsecase: GetWeappPhoneUsecase,
    private readonly listRegistrationOrganizations: ListRegistrationOrganizationsUsecase,
    private readonly searchRegistrationOrganizations: SearchRegistrationOrganizationsUsecase,
    private readonly checkRegistrationOrganizationName: CheckRegistrationOrganizationNameUsecase,
    private readonly getEngineerRegistrationStatus: GetEngineerRegistrationStatusUsecase,
    private readonly getMyEngineerRegistration: GetMyEngineerRegistrationUsecase,
    private readonly resubmitEngineerRegistrationUsecase: ResubmitEngineerRegistrationUsecase,
    private readonly listAdminEngineerRegistrations: ListAdminEngineerRegistrationsUsecase,
    private readonly getAdminEngineerRegistrationDetail: GetAdminEngineerRegistrationDetailUsecase,
    private readonly getAdminEngineerRegistrationApprovalDetail: GetAdminEngineerRegistrationApprovalDetailUsecase,
    private readonly reviewEngineerRegistrationUsecase: ReviewEngineerRegistrationUsecase,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RegistrationResolver.name);
  }

  /**
   * 旧注册入口（兼容既有客户端）。
   *
   * 请求形状与主线原行为一致：`organizationId` 必填（客户与工程师都必须选择组织），
   * 组织资格只要求 `ACTIVE`；工程师姓名/电话可省略；不支持手填公司名称；
   * 客户注册不写 `customer_organization_id`。V44 Web 规则由 `registerWeb` 承担。
   */
  @Mutation(() => RegisterResult, { description: '用户注册（旧入口，兼容既有客户端）' })
  @ValidateInput()
  async register(
    @Args('input') input: RegisterInput,
    @Context() context: { req: Request },
  ): Promise<RegisterResult> {
    const result = await this.registerWithEmail.execute({
      loginName: input.loginName ?? null,
      loginEmail: input.loginEmail,
      loginPassword: input.loginPassword,
      nickname: input.nickname,
      type: input.type,
      entryChannel: RegistrationEntryChannel.LEGACY,
      organizationId: input.organizationId,
      applicationNote: input.applicationNote,
      inviteToken: input.inviteToken,
      clientIp: this.resolveClientIp(context),
    });

    return {
      success: result.success,
      message: result.message,
      accountId: result.accountId,
      registrationStatus: result.registrationStatus,
      applicationId: result.applicationId,
    };
  }

  /**
   * V44 Web 注册入口（客户与工程师注册页使用）。
   *
   * 与旧 `register` 共用同一注册事务，但执行 Web 规则：工程师必填真实姓名与电话，
   * 公司须为 `ACTIVE + 受管`；客户可选名单内公司或手填自家公司，二者互斥，
   * 选择公司时写可信 `customer_organization_id`。
   */
  @Mutation(() => RegisterResult, {
    name: 'registerWeb',
    description: 'Web 用户注册（V44 规则：工程师姓名/电话必填，公司须启用且受管）',
  })
  @ValidateInput()
  async registerWeb(
    @Args('input') input: RegisterWebInput,
    @Context() context: { req: Request },
  ): Promise<RegisterResult> {
    const result = await this.registerWithEmail.execute({
      loginName: input.loginName ?? null,
      loginEmail: input.loginEmail,
      loginPassword: input.loginPassword,
      nickname: input.nickname,
      realName: input.realName ?? null,
      phone: input.phone ?? null,
      type: input.type,
      entryChannel: RegistrationEntryChannel.WEB,
      organizationId: input.organizationId ?? null,
      organizationName: input.organizationName ?? null,
      applicationNote: input.applicationNote,
      inviteToken: input.inviteToken,
      clientIp: this.resolveClientIp(context),
    });

    return {
      success: result.success,
      message: result.message,
      accountId: result.accountId,
      registrationStatus: result.registrationStatus,
      applicationId: result.applicationId,
    };
  }

  /**
   * 提取客户端 IP：与既有注册入口口径一致，只传递 usecase 关心的扁平字符串，
   * 避免把 Express 类型下沉到用例层。
   */
  private resolveClientIp(context: { req?: Request }): string {
    const req = context?.req;
    if (!req) return '';
    const clean = (ip: string | undefined): string => ip?.replace(/^::ffff:/, '').trim() || '';
    const xRealIp = req.headers['x-real-ip'];
    if (xRealIp) {
      const ip = Array.isArray(xRealIp) ? xRealIp[0] : xRealIp;
      return clean(ip);
    }
    const xForwardedFor = req.headers['x-forwarded-for'];
    if (xForwardedFor) {
      const firstIp =
        typeof xForwardedFor === 'string'
          ? xForwardedFor.split(',')[0].trim()
          : Array.isArray(xForwardedFor)
            ? xForwardedFor[0].split(',')[0].trim()
            : '';
      if (firstIp) return firstIp;
    }
    if (req.ip) return req.ip;
    return req.socket?.remoteAddress ?? '';
  }

  /**
   * 第三方注册
   */
  @Mutation(() => RegisterResult, { description: '第三方注册' })
  @ValidateInput()
  async thirdPartyRegister(@Args('input') input: ThirdPartyRegisterInput): Promise<RegisterResult> {
    const result = await this.registerWithThirdParty.execute({
      provider: input.provider,
      authCredential: input.authCredential, // 使用正确的字段名
      audience: input.audience,
      email: input.email,
      organizationId: input.organizationId,
      weAppData: input.weAppData, // 传递整个 weAppData 对象
    });

    // 移除之前单独获取手机号的逻辑，因为现在在注册时就处理了

    return {
      success: result.success,
      message: result.message,
      accountId: result.accountId,
      registrationStatus: result.registrationStatus,
      applicationId: result.applicationId,
    };
  }

  /**
   * 注册可选组织（公开只读，兼容入口）：保持主线既有 `{ id name }` 数组契约。
   *
   * 返回全部 `ACTIVE` 组织，不分页、不区分受管资格；小程序注册与拒绝后凭据重提
   * 等既有调用方无需改动请求即可通过 Schema 验证并得到原有响应。Web 注册页使用
   * 独立的 `registrationOrganizationSearch`（受管公司 + 关键字 + 分页）。
   * 提交的 organizationId 仍由写入事务按各自入口的资格复核。
   */
  @Query(() => [RegistrationOrganizationDTO], {
    name: 'registrationOrganizations',
    description: '注册可选组织（公开，仅 ACTIVE 组织；兼容入口）',
  })
  async registrationOrganizations(): Promise<RegistrationOrganizationDTO[]> {
    const options = await this.listRegistrationOrganizations.execute();
    return options.map((option) => toRegistrationOrganizationDTO(option));
  }

  /**
   * Web 注册公司候选检索（公开只读）：客户与工程师注册共用。
   *
   * 资格口径为 `status = ACTIVE AND is_managed_company = true`，支持名称关键字与
   * OFFSET 分页；返回结果只含主键、名称与分页信息。提交的 organizationId 仍由写入
   * 事务按同一资格复核，本查询结果不作为资格凭证。
   */
  @Query(() => RegistrationOrganizationPageDTO, {
    name: 'registrationOrganizationSearch',
    description: 'Web 注册可选公司检索（公开，仅启用且属于一级维护名单的公司）',
  })
  @ValidateInput()
  async registrationOrganizationSearch(
    @Args('pagination', { description: '分页参数（仅 OFFSET）' }) pagination: PaginationArgs,
    @Args('keyword', {
      type: () => String,
      nullable: true,
      description: '公司名称关键字；缺省表示不过滤',
    })
    keyword?: string,
  ): Promise<RegistrationOrganizationPageDTO> {
    const page = await this.searchRegistrationOrganizations.execute({
      keyword: keyword ?? null,
      pagination: mapGqlToCoreParams(pagination),
    });
    return toRegistrationOrganizationPageDTO(page);
  }

  /**
   * 手填公司名精确同名提示（公开只读，返回最小布尔结果）。
   *
   * 与候选分页相互独立：按归一化后的完整名称精确比较启用且受管的公司，
   * 不受候选首屏或已加载页影响。结果只用于界面提示「可能同名」，
   * 不阻断手填注册，也不作为公司唯一性或资格凭证。
   */
  @Query(() => Boolean, {
    name: 'registrationOrganizationNameExists',
    description: '手填公司名精确同名提示（公开，仅启用且属于一级维护名单的公司）',
  })
  @ValidateInput()
  async registrationOrganizationNameExists(
    @Args('name', {
      type: () => String,
      description: '手填公司名称；按去首尾空白、合并连续空白、忽略大小写后精确比较',
    })
    name: string,
  ): Promise<boolean> {
    return this.checkRegistrationOrganizationName.execute({ name });
  }

  /**
   * 本人工程师注册申请状态查询。
   *
   * 待审账号没有登录态，因此不使用 JWT：由输入中的本人凭据证明身份，
   * 服务端只按已证明的账号主键返回申请历史，不签发令牌、不放行登录。
   * 凭据不匹配统一按 `CREDENTIAL_MISMATCH`（对外 UNAUTHENTICATED）拒绝。
   *
   * 使用 Mutation 而非 Query：凭据必须走 POST 请求体，避免密码进入查询串、
   * 网关访问日志与可缓存的 GET 语义；本操作不产生任何业务状态变更。
   */
  @Mutation(() => EngineerRegistrationStatusDTO, {
    name: 'myEngineerRegistrationStatus',
    description: '本人工程师注册申请状态（受限凭据证明式提交，不使用 JWT）',
  })
  @ValidateInput()
  async myEngineerRegistrationStatus(
    @Args('input') input: EngineerRegistrationCredentialInput,
    @Args('pagination', { description: '分页参数（仅 OFFSET）' }) pagination: PaginationArgs,
  ): Promise<EngineerRegistrationStatusDTO> {
    const result = await this.getEngineerRegistrationStatus.execute({
      accountIdentifier: input.accountIdentifier,
      password: input.password,
      pagination: mapGqlToCoreParams(pagination),
    });
    return {
      accountId: result.accountId,
      latest: result.latest === null ? null : toEngineerRegistrationApplicationDTO(result.latest),
      applications: toEngineerRegistrationApplicationPageDTO(result.applications),
    };
  }

  /**
   * 受限会话读取本人最新一份工程师申请。
   *
   * 与 `myEngineerRegistrationStatus` 的分工：本入口使用已认证会话（每请求复核后的
   * restriction），供 `/restricted` 页在待审 / 已拒绝 / 资格未生效时展示申请公司与
   * 审核意见；账号主键只来自 Session，不接受任何账号或申请 ID 参数。
   *
   * 挂 `MustChangePasswordGuard` 而非 `SessionRestrictionGuard`：强制改密之外的限制态
   * 必须能读到自己的申请，否则受限页无法解释「为什么被限制」。
   */
  @UseGuards(JwtAuthGuard, MustChangePasswordGuard)
  @Query(() => MyEngineerRegistrationDTO, {
    name: 'myEngineerRegistration',
    description: '本人最新工程师注册申请（受限会话）',
  })
  async myEngineerRegistration(
    @currentUser() user: JwtPayload,
  ): Promise<MyEngineerRegistrationDTO> {
    const session: UsecaseSession = mapJwtToUsecaseSession(user);
    const view = await this.getMyEngineerRegistration.execute({ session });
    return toMyEngineerRegistrationDTO(view);
  }

  /**
   * 拒绝后重提工程师注册申请。
   *
   * 同为本人凭据证明；重提只新增一份 PENDING 申请，原拒绝记录与审核意见永久保留。
   */
  @Mutation(() => ResubmitEngineerRegistrationResultDTO, {
    name: 'resubmitEngineerRegistration',
    description: '拒绝后重新提交工程师注册申请（本人凭据证明）',
  })
  @ValidateInput()
  async resubmitEngineerRegistration(
    @Args('input') input: ResubmitEngineerRegistrationInput,
  ): Promise<ResubmitEngineerRegistrationResultDTO> {
    return this.resubmitEngineerRegistrationUsecase.execute({
      accountIdentifier: input.accountIdentifier,
      password: input.password,
      organizationId: input.organizationId,
      applicationNote: input.applicationNote,
    });
  }

  /**
   * 工程师注册审核队列。
   *
   * 粗粒度准入由 Guard 完成；精确权限（activeRole === SUPER_ADMIN + 请求期 admin_level）
   * 与可见组织范围由用例裁决：一级全范围，二级仅本公司；组织由服务端解析，
   * 不接受客户端自报 organizationId。
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.SUPER_ADMIN)
  @Query(() => AdminEngineerRegistrationPageDTO, {
    name: 'adminEngineerRegistrations',
    description: '工程师注册审核队列（一级全范围，二级仅本公司）',
  })
  @ValidateInput()
  async adminEngineerRegistrations(
    @Args('pagination', { description: '分页参数（仅 OFFSET）' }) pagination: PaginationArgs,
    @currentUser() user: JwtPayload,
    @Args('status', {
      type: () => EngineerRegistrationApplicationStatus,
      nullable: true,
      description: '状态筛选；缺省表示全部',
    })
    status?: EngineerRegistrationApplicationStatus,
  ): Promise<AdminEngineerRegistrationPageDTO> {
    const session: UsecaseSession = mapJwtToUsecaseSession(user);
    const page = await this.listAdminEngineerRegistrations.execute({
      session,
      status: status ?? null,
      pagination: mapGqlToCoreParams(pagination),
    });
    return {
      items: page.items.map((item) => toAdminEngineerRegistrationItemDTO(item)),
      total: page.total,
      page: page.page,
      pageSize: page.pageSize,
    };
  }

  /**
   * 工程师注册申请详情（既有契约）：返回申请人 `AdminUserDTO` 字段面，不含真实姓名。
   *
   * 一级任意公司；二级跨公司或不存在的申请统一按 NOT_FOUND 拒绝。
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.SUPER_ADMIN)
  @Query(() => AdminEngineerRegistrationItemDTO, {
    name: 'adminEngineerRegistrationDetail',
    description: '工程师注册申请详情（申请 + 申请人公开资料；一级全范围，二级仅本公司）',
  })
  async adminEngineerRegistrationDetail(
    @Args('applicationId', { type: () => Int, description: '申请 ID' }) applicationId: number,
    @currentUser() user: JwtPayload,
  ): Promise<AdminEngineerRegistrationItemDTO> {
    const session: UsecaseSession = mapJwtToUsecaseSession(user);
    const item = await this.getAdminEngineerRegistrationDetail.execute({
      session,
      applicationId,
    });
    return toAdminEngineerRegistrationItemDTO(item);
  }

  /**
   * 审批详情读入口：同一份申请的窄字段面，额外提供真实姓名。
   *
   * 授权与错误口径与既有详情入口一致（复用其可见性裁决）；真实姓名只在本入口可读。
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.SUPER_ADMIN)
  @Query(() => AdminEngineerRegistrationDetailDTO, {
    name: 'adminEngineerRegistrationApprovalDetail',
    description: '工程师注册审批详情（申请 + 申请人详情资料含真实姓名；一级全范围，二级仅本公司）',
  })
  async adminEngineerRegistrationApprovalDetail(
    @Args('applicationId', { type: () => Int, description: '申请 ID' }) applicationId: number,
    @currentUser() user: JwtPayload,
  ): Promise<AdminEngineerRegistrationDetailDTO> {
    const session: UsecaseSession = mapJwtToUsecaseSession(user);
    const item = await this.getAdminEngineerRegistrationApprovalDetail.execute({
      session,
      applicationId,
    });
    return toAdminEngineerRegistrationDetailDTO(item);
  }

  /**
   * 管理员一次性终态审核。
   *
   * - 一级可跨公司批准，成员关系写入申请目标公司；二级仅限本公司；
   * - `APPROVE`：账号、资料、有效 ENGINEER 成员关系与申请终态在同一事务生效；
   * - `REJECT`：只写否决与意见，账号保持待审，可凭本人凭据重提；
   * - 重复/并发决策命中 0 行 → CONFLICT，不覆盖既有终态。
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.SUPER_ADMIN)
  @Mutation(() => AdminEngineerRegistrationItemDTO, {
    name: 'reviewEngineerRegistration',
    description: '管理员审核工程师注册申请（一次性终态；一级跨公司，二级仅本公司）',
  })
  @ValidateInput()
  async reviewEngineerRegistration(
    @Args('input') input: ReviewEngineerRegistrationInput,
    @currentUser() user: JwtPayload,
  ): Promise<AdminEngineerRegistrationItemDTO> {
    const session: UsecaseSession = mapJwtToUsecaseSession(user);
    const result = await this.reviewEngineerRegistrationUsecase.execute({
      session,
      applicationId: input.applicationId,
      action: input.action,
      reviewComment: input.reviewComment,
    });
    return toAdminEngineerRegistrationItemDTO(result);
  }
}
