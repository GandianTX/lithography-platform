// src/adapters/api/graphql/registration/registration.resolver.ts
import { ValidateInput } from '@adapters/api/graphql/common/validate-input.decorator';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import { EngineerRegistrationApplicationStatus } from '@app-types/models/registration.types';
import { mapJwtToUsecaseSession, type UsecaseSession } from '@app-types/auth/session.types';
import { JwtPayload } from '@app-types/jwt.types';
import { Args, Context, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { mapGqlToCoreParams } from '@src/adapters/api/graphql/pagination.mapper';
import { PaginationArgs } from '@src/adapters/api/graphql/pagination.args';
import { currentUser } from '@src/adapters/api/graphql/decorators/current-user.decorator';
import { Roles } from '@src/adapters/api/graphql/decorators/roles.decorator';
import { JwtAuthGuard } from '@src/adapters/api/graphql/guards/jwt-auth.guard';
import { RolesGuard } from '@src/adapters/api/graphql/guards/roles.guard';
import { UseGuards } from '@nestjs/common';
import { GetAdminEngineerRegistrationDetailUsecase } from '@src/usecases/registration/get-admin-engineer-registration-detail.usecase';
import { GetEngineerRegistrationStatusUsecase } from '@src/usecases/registration/get-engineer-registration-status.usecase';
import { ListAdminEngineerRegistrationsUsecase } from '@src/usecases/registration/list-admin-engineer-registrations.usecase';
import { ListRegistrationOrganizationsUsecase } from '@src/usecases/registration/list-registration-organizations.usecase';
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
import { AdminEngineerRegistrationPageDTO } from './dto/admin-engineer-registration-page.dto';
import { toEngineerRegistrationApplicationDTO } from './dto/engineer-registration-application.dto';
import { toEngineerRegistrationApplicationPageDTO } from './dto/engineer-registration-application-page.dto';
import { EngineerRegistrationCredentialInput } from './dto/engineer-registration-credential.input';
import { EngineerRegistrationStatusDTO } from './dto/engineer-registration-status.dto';
import {
  RegistrationOrganizationDTO,
  toRegistrationOrganizationDTO,
} from './dto/registration-organization.dto';
import { RegisterResult } from './dto/register-result.dto';
import { RegisterInput } from './dto/register.input';
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
    private readonly getEngineerRegistrationStatus: GetEngineerRegistrationStatusUsecase,
    private readonly resubmitEngineerRegistrationUsecase: ResubmitEngineerRegistrationUsecase,
    private readonly listAdminEngineerRegistrations: ListAdminEngineerRegistrationsUsecase,
    private readonly getAdminEngineerRegistrationDetail: GetAdminEngineerRegistrationDetailUsecase,
    private readonly reviewEngineerRegistrationUsecase: ReviewEngineerRegistrationUsecase,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RegistrationResolver.name);
  }

  @Mutation(() => RegisterResult, { description: '用户注册' })
  @ValidateInput()
  async register(
    @Args('input') input: RegisterInput,
    @Context() context: { req: Request },
  ): Promise<RegisterResult> {
    // 只传递 usecase 关心的"扁平请求形状"，避免把 Express 类型下沉到用例层
    const req = context?.req;
    const clientIp = (() => {
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
    })();

    const result = await this.registerWithEmail.execute({
      loginName: input.loginName ?? null,
      loginEmail: input.loginEmail,
      loginPassword: input.loginPassword,
      nickname: input.nickname,
      type: input.type,
      organizationId: input.organizationId,
      applicationNote: input.applicationNote,
      inviteToken: input.inviteToken,
      clientIp,
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
   * 注册可选组织（公开只读）：两类注册都必须选择有效组织。
   * 返回结果只含主键与名称；提交的 organizationId 仍由写入事务复核有效性。
   */
  @Query(() => [RegistrationOrganizationDTO], {
    name: 'registrationOrganizations',
    description: '注册可选组织（公开，仅 ACTIVE 组织）',
  })
  async registrationOrganizations(): Promise<RegistrationOrganizationDTO[]> {
    const options = await this.listRegistrationOrganizations.execute();
    return options.map((option) => toRegistrationOrganizationDTO(option));
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
   * 本组织工程师注册审核队列。
   *
   * 粗粒度准入由 Guard 完成；精确权限（activeRole === SUPER_ADMIN）与可信组织范围
   * 由用例裁决：组织由服务端解析，不接受客户端自报 organizationId。
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.SUPER_ADMIN)
  @Query(() => AdminEngineerRegistrationPageDTO, {
    name: 'adminEngineerRegistrations',
    description: '本组织工程师注册审核队列',
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
   * 本组织工程师注册申请详情。跨组织或不存在的申请统一按 NOT_FOUND 拒绝。
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.SUPER_ADMIN)
  @Query(() => AdminEngineerRegistrationItemDTO, {
    name: 'adminEngineerRegistrationDetail',
    description: '本组织工程师注册申请详情',
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
   * 本组织管理员一次性终态审核。
   *
   * - `APPROVE`：账号、资料、有效 ENGINEER 成员关系与申请终态在同一事务生效；
   * - `REJECT`：只写否决与意见，账号保持待审，可凭本人凭据重提；
   * - 重复/并发决策命中 0 行 → CONFLICT，不覆盖既有终态。
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.SUPER_ADMIN)
  @Mutation(() => AdminEngineerRegistrationItemDTO, {
    name: 'reviewEngineerRegistration',
    description: '组织管理员审核工程师注册申请（一次性终态）',
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
