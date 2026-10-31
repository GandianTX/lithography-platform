// 文件位置：src/usecases/account/update-visible-user-info.usecase.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { type UsecaseSession } from '@app-types/auth/session.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import { UserInfoView } from '@app-types/models/auth.types';
import { Gender, type GeographicInfo } from '@app-types/models/user-info.types';
import { hasRole } from '@core/account/policy/role-access.policy';
import {
  ACCOUNT_ERROR,
  DomainError,
  isDomainError,
  PERMISSION_ERROR,
} from '@core/common/errors/domain-error';
import { Inject, Injectable } from '@nestjs/common';
import {
  AccountService,
  type UserInfoUpdateData,
} from '@src/modules/account/base/services/account.service';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { OrganizationMembershipQueryService } from '@src/modules/lithography/queries/organization-membership.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';
import { FetchUserInfoUsecase } from './fetch-user-info.usecase';
import {
  assertVisibleUserInfoTargetOrganization,
  throwVisibleUserInfoTargetUnavailable,
} from './visible-user-info-organization';
import {
  normalizeVisibleBirthDateInput,
  normalizeVisibleGenderInput,
  normalizeVisibleGeographicInput,
  normalizeVisibleNicknameInput,
  normalizeVisibleLimitedNullableTextInput,
  normalizeVisibleNonNegativeIntInput,
  normalizeVisibleTagsInput,
} from './update-visible-user-info.input.normalize';

export type UserInfoPatch = {
  nickname?: string;
  gender?: Gender;
  birthDate?: string | null;
  avatarUrl?: string | null;
  email?: string | null;
  signature?: string | null;
  address?: string | null;
  phone?: string | null;
  tags?: string[] | null;
  geographic?: GeographicInfo | null;
  notifyCount?: number;
  unreadCount?: number;
};

type UserInfoUpdatePatch = UserInfoUpdateData;

type UserInfoUpdateField = keyof UserInfoUpdatePatch & keyof UserInfoView;

export interface UpdateVisibleUserInfoParams {
  session: UsecaseSession;
  targetAccountId: number;
  patch: UserInfoPatch;
  identityHint?: IdentityTypeEnum;
}

export interface UpdateVisibleUserInfoResult {
  view: UserInfoView;
  isUpdated: boolean;
}

@Injectable()
export class UpdateVisibleUserInfoUsecase {
  constructor(
    private readonly accountService: AccountService,
    private readonly accountQueryService: AccountQueryService,
    private readonly fetchUserInfoUsecase: FetchUserInfoUsecase,
    private readonly organizationContextQueryService: TrustedOrganizationContextQueryService,
    private readonly organizationMembershipQueryService: OrganizationMembershipQueryService,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {}

  /**
   * 执行按可见性更新用户信息
   * 规则：
   * - 权限沿用查看规则：能查看即可更新（SUPER_ADMIN / ENGINEER 可更新其他账户；CUSTOMER 仅能更新自己）
   * - 非本人目标额外要求同一有效组织：操作者有唯一有效组织且目标在该组织内有有效成员关系；
   *   跨组织 / 目标无有效成员关系与目标不存在使用同一拒绝口径，不泄露存在性
   * - 字段白名单：仅允许更新基础与联系字段；禁止修改 accessGroup / metaDigest
   * - 幂等：无字段变更则直接返回当前视图
   *
   * 执行顺序（写路径，不可交换）：
   * 1. 纯会话角色判定先于任何数据库访问：未获角色准入的调用方一律 `ACCESS_DENIED`，
   *    无法用目标 ID 探测账号是否存在；
   * 2. 进入 `TransactionRunner` 事务后**先锁目标账号行**，再解析组织、读取资料：
   *    锁前建立的普通读取会被后续事务快照复用，读到并发方提交前的旧组织事实；
   * 3. 组织授权与字段写入、回读在同一事务内完成，同成同败。
   */
  async execute(params: UpdateVisibleUserInfoParams): Promise<UpdateVisibleUserInfoResult> {
    const { session, targetAccountId, identityHint } = params;
    const patch = params.patch ?? {};

    if (!Number.isInteger(targetAccountId) || targetAccountId <= 0) {
      throw new DomainError(PERMISSION_ERROR.ACCESS_DENIED, '非法的目标账户 ID');
    }

    const allowed = this.isAllowedToUpdate(session, targetAccountId);
    if (!allowed) {
      throw new DomainError(PERMISSION_ERROR.ACCESS_DENIED, '无权限更新该用户信息');
    }

    const isSelf = session.accountId === targetAccountId;

    // 事务编排：锁定目标 → 组织授权 → 读取 → 校验 → 幂等 → 更新 → 回读视图
    const result = await this.transactionRunner.run<UpdateVisibleUserInfoResult>(
      async (transactionContext) => {
        const lockedAccount = await this.lockTargetAccount(targetAccountId, transactionContext);

        // 非本人目标：锁后解析操作者可信组织并核验目标归属；
        // 本人路径不进入组织解析，保留历史无组织账号的自改能力。
        if (!isSelf) {
          await assertVisibleUserInfoTargetOrganization({
            organizationContextQueryService: this.organizationContextQueryService,
            organizationMembershipQueryService: this.organizationMembershipQueryService,
            operatorAccountId: session.accountId,
            targetAccountId,
            transactionContext,
          });
        }

        const current = await this.fetchUserInfoUsecase.executeStrict({
          accountId: targetAccountId,
          transactionContext,
        });

        const isStaffRole = hasRole(session.roles, IdentityTypeEnum.ENGINEER);
        const isAdminRole = hasRole(session.roles, IdentityTypeEnum.SUPER_ADMIN);
        const sanitized = await this.sanitizePatch(patch, current, {
          isStaff: isStaffRole,
          isSelf,
          isAdmin: isAdminRole,
        });
        const resolvedIdentityHint = this.sanitizeIdentityHint({
          requested: identityHint,
          accessGroup: current.accessGroup,
          isSelf,
        });
        const hasUserInfoUpdate = Object.keys(sanitized).length > 0;
        const shouldUpdateIdentityHint = typeof resolvedIdentityHint !== 'undefined';
        if (!hasUserInfoUpdate && !shouldUpdateIdentityHint) {
          const view = await this.fetchUserInfoUsecase.executeStrict({
            accountId: targetAccountId,
            transactionContext,
          });
          return { view, isUpdated: false };
        }

        let identityHintChanged = false;
        if (hasUserInfoUpdate) {
          await this.accountService.updateUserInfoFields({
            accountId: targetAccountId,
            patch: sanitized,
            transactionContext,
          });
        }
        if (shouldUpdateIdentityHint && resolvedIdentityHint) {
          // 目标行锁已在事务入口取得，直接复用锁内读取的账号事实，不再二次加锁。
          const currentIdentityHint = this.normalizeIdentityHint(lockedAccount.identityHint);
          if (currentIdentityHint !== resolvedIdentityHint) {
            await this.accountService.updateAccount(
              targetAccountId,
              { identityHint: resolvedIdentityHint },
              transactionContext,
            );
            identityHintChanged = true;
          }
        }

        const view = await this.fetchUserInfoUsecase.executeStrict({
          accountId: targetAccountId,
          transactionContext,
        });
        return { view, isUpdated: hasUserInfoUpdate || identityHintChanged };
      },
    );

    return result;
  }

  /**
   * 权限判定：沿用查看可见性策略
   */
  private isAllowedToUpdate(session: UsecaseSession, targetAccountId: number): boolean {
    const isSelf = session.accountId === targetAccountId;
    if (isSelf) return true;
    if (hasRole(session.roles, IdentityTypeEnum.SUPER_ADMIN)) return true;

    return hasRole(session.roles, IdentityTypeEnum.ENGINEER);
  }

  /**
   * 事务内先锁定目标账号行。
   *
   * 目标不存在时 `lockByIdForUpdate()` 抛 `ACCOUNT_ERROR.ACCOUNT_NOT_FOUND`，其码值与
   * `AUTH_ERROR.ACCOUNT_NOT_FOUND` 相同，会被全局过滤器映射为 `UNAUTHENTICATED`；
   * 本用例统一转换为与跨组织目标相同的 `USER_INFO_NOT_FOUND`（NOT_FOUND），
   * 既避免前端误判会话失效，也保证「目标不存在」与「目标不可见」对外不可区分。
   */
  private async lockTargetAccount(
    targetAccountId: number,
    transactionContext: PersistenceTransactionContext,
  ): Promise<Awaited<ReturnType<AccountService['lockByIdForUpdate']>>> {
    try {
      return await this.accountService.lockByIdForUpdate(targetAccountId, transactionContext);
    } catch (error) {
      if (isDomainError(error) && error.code === ACCOUNT_ERROR.ACCOUNT_NOT_FOUND) {
        return throwVisibleUserInfoTargetUnavailable();
      }
      throw error;
    }
  }

  /**
   * 清洗并验证更新字段（支持 isSelf / isStaff / isAdmin 开关）
   * - admin：允许除敏感系统字段外的全部白名单（等同于 staff 自改）
   * - staff 自改：允许更广的白名单（包含 notifyCount/unreadCount）
   * - staff 改他人：仅允许极少字段（nickname / avatarUrl / phone）
   * - 非 staff：允许基础与联系白名单，不允许计数
   * - userState 不在任何白名单：启用/停用统一走 AdminSetUserStatusUsecase（双字段同事务同步）
   */
  private async sanitizePatch(
    patch: UserInfoPatch,
    current: UserInfoView,
    flags: { isStaff: boolean; isSelf: boolean; isAdmin: boolean },
  ): Promise<UserInfoUpdatePatch> {
    const out: UserInfoUpdatePatch = {};
    const allow = (key: UserInfoUpdateField): boolean => this.isFieldAllowed(key, flags);
    const assignIfChanged = <K extends UserInfoUpdateField>(
      key: K,
      next: UserInfoUpdatePatch[K],
    ) => {
      if (next !== current[key]) out[key] = next as never;
    };

    await this.applyBasicFields(patch, current, allow, assignIfChanged);
    this.applyExtendedFields(patch, current, allow, assignIfChanged);
    this.applyStaffSelfOnlyFields(patch, allow, assignIfChanged, flags);
    return out;
  }

  private async applyBasicFields(
    patch: UserInfoPatch,
    current: UserInfoView,
    allow: (key: UserInfoUpdateField) => boolean,
    assignIfChanged: <K extends UserInfoUpdateField>(key: K, next: UserInfoUpdatePatch[K]) => void,
  ): Promise<void> {
    await this.applyNicknameField(patch, current, allow, assignIfChanged);
    this.applyGenderBirthdateFields(patch, allow, assignIfChanged);
    this.applyStringFields(patch, allow, assignIfChanged);
  }

  /**
   * 处理昵称字段（需要唯一性校验）
   */
  private async applyNicknameField(
    patch: UserInfoPatch,
    current: UserInfoView,
    allow: (key: UserInfoUpdateField) => boolean,
    assignIfChanged: <K extends UserInfoUpdateField>(key: K, next: UserInfoUpdatePatch[K]) => void,
  ): Promise<void> {
    if (typeof patch.nickname !== 'undefined' && allow('nickname')) {
      assignIfChanged('nickname', await this.sanitizeNickname(patch.nickname, current));
    }
  }

  /**
   * 处理性别与生日等基础枚举/日期字段
   */
  private applyGenderBirthdateFields(
    patch: UserInfoPatch,
    allow: (key: UserInfoUpdateField) => boolean,
    assignIfChanged: <K extends UserInfoUpdateField>(key: K, next: UserInfoUpdatePatch[K]) => void,
  ): void {
    if (typeof patch.gender !== 'undefined' && allow('gender')) {
      assignIfChanged('gender', normalizeVisibleGenderInput(patch.gender));
    }
    if (typeof patch.birthDate !== 'undefined' && allow('birthDate')) {
      assignIfChanged('birthDate', normalizeVisibleBirthDateInput(patch.birthDate));
    }
  }

  /**
   * 处理可空字符串类字段（avatarUrl/email/signature/address/phone）
   */
  private applyStringFields(
    patch: UserInfoPatch,
    allow: (key: UserInfoUpdateField) => boolean,
    assignIfChanged: <K extends UserInfoUpdateField>(key: K, next: UserInfoUpdatePatch[K]) => void,
  ): void {
    if (typeof patch.avatarUrl !== 'undefined' && allow('avatarUrl')) {
      assignIfChanged(
        'avatarUrl',
        normalizeVisibleLimitedNullableTextInput(patch.avatarUrl, {
          fieldName: '头像 URL',
          maxLen: 255,
          tooLongMessage: '头像 URL 长度不能超过 255',
        }),
      );
    }
    if (typeof patch.email !== 'undefined' && allow('email')) {
      assignIfChanged(
        'email',
        normalizeVisibleLimitedNullableTextInput(patch.email, {
          fieldName: '邮箱',
          maxLen: 50,
          tooLongMessage: '邮箱长度不能超过 50',
        }),
      );
    }
    if (typeof patch.signature !== 'undefined' && allow('signature')) {
      assignIfChanged(
        'signature',
        normalizeVisibleLimitedNullableTextInput(patch.signature, {
          fieldName: '个性签名',
          maxLen: 100,
          tooLongMessage: '个性签名长度不能超过 100',
        }),
      );
    }
    if (typeof patch.address !== 'undefined' && allow('address')) {
      assignIfChanged(
        'address',
        normalizeVisibleLimitedNullableTextInput(patch.address, {
          fieldName: '地址',
          maxLen: 255,
          tooLongMessage: '地址长度不能超过 255',
        }),
      );
    }
    if (typeof patch.phone !== 'undefined' && allow('phone')) {
      assignIfChanged(
        'phone',
        normalizeVisibleLimitedNullableTextInput(patch.phone, {
          fieldName: '电话',
          maxLen: 20,
          tooLongMessage: '电话长度不能超过 20',
        }),
      );
    }
  }

  private applyExtendedFields(
    patch: UserInfoPatch,
    current: UserInfoView,
    allow: (key: UserInfoUpdateField) => boolean,
    assignIfChanged: <K extends UserInfoUpdateField>(key: K, next: UserInfoUpdatePatch[K]) => void,
  ): void {
    if (typeof patch.tags !== 'undefined' && allow('tags')) {
      const v = normalizeVisibleTagsInput(patch.tags);
      const eq = JSON.stringify(v) === JSON.stringify(current.tags);
      if (!eq) assignIfChanged('tags', v as never);
    }
    if (typeof patch.geographic !== 'undefined' && allow('geographic')) {
      const v = normalizeVisibleGeographicInput(patch.geographic);
      const eq = JSON.stringify(v) === JSON.stringify(current.geographic);
      if (!eq) assignIfChanged('geographic', v as never);
    }
  }

  private applyStaffSelfOnlyFields(
    patch: UserInfoPatch,
    allow: (key: UserInfoUpdateField) => boolean,
    assignIfChanged: <K extends UserInfoUpdateField>(key: K, next: UserInfoUpdatePatch[K]) => void,
    _flags: { isStaff: boolean; isSelf: boolean; isAdmin: boolean },
  ): void {
    if (typeof patch.notifyCount !== 'undefined') {
      if (!allow('notifyCount')) {
        throw new DomainError(
          PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
          '仅在 staff 自改或 admin 时可修改通知计数',
        );
      }
      assignIfChanged('notifyCount', normalizeVisibleNonNegativeIntInput(patch.notifyCount));
    }
    if (typeof patch.unreadCount !== 'undefined') {
      if (!allow('unreadCount')) {
        throw new DomainError(
          PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
          '仅在 staff 自改或 admin 时可修改未读计数',
        );
      }
      assignIfChanged('unreadCount', normalizeVisibleNonNegativeIntInput(patch.unreadCount));
    }
  }

  /**
   * 清洗昵称：去空格、非空、长度限制、唯一性校验
   */
  private async sanitizeNickname(
    value: string | null | undefined,
    current: UserInfoView,
  ): Promise<string> {
    const val = normalizeVisibleNicknameInput(value);
    if (val !== current.nickname) {
      const exists = await this.accountQueryService.checkNicknameExists(val);
      if (exists) throw new DomainError(ACCOUNT_ERROR.NICKNAME_TAKEN, '昵称已被占用');
    }
    return val;
  }

  /**
   * 校验并解析登录 hint 更新
   */
  private sanitizeIdentityHint(params: {
    requested?: IdentityTypeEnum;
    accessGroup: IdentityTypeEnum[];
    isSelf: boolean;
  }): IdentityTypeEnum | undefined {
    const { requested, accessGroup, isSelf } = params;
    if (typeof requested === 'undefined') {
      return undefined;
    }
    if (!isSelf) {
      throw new DomainError(PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS, '仅允许本人修改登录提示');
    }
    if (!accessGroup || accessGroup.length === 0) {
      throw new DomainError(ACCOUNT_ERROR.OPERATION_NOT_SUPPORTED, '访问组不能为空');
    }
    if (!accessGroup.includes(requested)) {
      throw new DomainError(ACCOUNT_ERROR.OPERATION_NOT_SUPPORTED, '身份提示必须包含在访问组中');
    }
    return requested;
  }

  /**
   * 字段允许策略（isSelf / isStaff）
   * - staff 自改：允许 nickname / gender / birthDate / avatarUrl / email / signature / address / phone / tags / geographic
   * - staff 改他人：仅允许 nickname / avatarUrl / phone
   * - 非 staff：允许基础与联系白名单
   * - userState 不在任何白名单：状态写入统一走 AdminSetUserStatusUsecase
   */
  private isFieldAllowed(
    key: UserInfoUpdateField,
    flags: { isStaff: boolean; isSelf: boolean; isAdmin: boolean },
  ): boolean {
    const staffSelfAllowed: UserInfoUpdateField[] = [
      'nickname',
      'gender',
      'birthDate',
      'avatarUrl',
      'email',
      'signature',
      'address',
      'phone',
      'tags',
      'geographic',
      'notifyCount',
      'unreadCount',
    ];
    const staffOtherAllowed: UserInfoUpdateField[] = ['nickname', 'avatarUrl', 'phone'];
    const nonStaffAllowed: UserInfoUpdateField[] = [
      'nickname',
      'gender',
      'birthDate',
      'avatarUrl',
      'email',
      'signature',
      'address',
      'phone',
      'tags',
      'geographic',
    ];

    if (flags.isAdmin) {
      return staffSelfAllowed.includes(key);
    }
    if (flags.isStaff) {
      return flags.isSelf ? staffSelfAllowed.includes(key) : staffOtherAllowed.includes(key);
    }
    return nonStaffAllowed.includes(key);
  }

  /**
   * 规范化登录 hint
   */
  private normalizeIdentityHint(value: string | null): IdentityTypeEnum | null {
    if (!value) return null;
    const enumValues = Object.values(IdentityTypeEnum) as string[];
    return enumValues.includes(value) ? (value as IdentityTypeEnum) : null;
  }
}

export interface UpdateAccessGroupParams {
  session: UsecaseSession;
  targetAccountId: number;
  accessGroup: IdentityTypeEnum[];
  identityHint?: IdentityTypeEnum;
}

export interface UpdateAccessGroupResult {
  accountId: number;
  accessGroup: IdentityTypeEnum[];
  identityHint: IdentityTypeEnum;
  isUpdated: boolean;
}

@Injectable()
export class UpdateAccessGroupUsecase {
  constructor(
    private readonly accountService: AccountService,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
  ) {}

  /**
   * 执行访问组更新
   * 规则：
   * - 仅允许 admin / staff 操作
   * - 访问组不能为空
   * - identityHint 必须包含在访问组中
   */
  async execute(params: UpdateAccessGroupParams): Promise<UpdateAccessGroupResult> {
    const { session, targetAccountId, accessGroup, identityHint } = params;

    if (!Number.isInteger(targetAccountId) || targetAccountId <= 0) {
      throw new DomainError(PERMISSION_ERROR.ACCESS_DENIED, '非法的目标账户 ID');
    }

    const allowed =
      hasRole(session.roles, IdentityTypeEnum.SUPER_ADMIN) ||
      hasRole(session.roles, IdentityTypeEnum.ENGINEER);
    if (!allowed) {
      throw new DomainError(PERMISSION_ERROR.ACCESS_DENIED, '仅 admin / staff 可调整访问组');
    }

    const normalizedAccessGroup = this.normalizeAccessGroup(accessGroup);
    if (normalizedAccessGroup.length === 0) {
      throw new DomainError(ACCOUNT_ERROR.OPERATION_NOT_SUPPORTED, '访问组不能为空');
    }

    const finalIdentityHint = this.resolveIdentityHint({
      requested: identityHint,
      accessGroup: normalizedAccessGroup,
    });
    if (!finalIdentityHint) {
      throw new DomainError(ACCOUNT_ERROR.OPERATION_NOT_SUPPORTED, '无法生成身份提示');
    }

    return await this.transactionRunner.run(async (transactionContext) => {
      const account = await this.accountService.lockByIdForUpdate(
        targetAccountId,
        transactionContext,
      );
      const accessGroupUpdate = await this.accountService.updateUserInfoAccessGroup({
        accountId: targetAccountId,
        accessGroup: normalizedAccessGroup,
        transactionContext,
      });
      const currentIdentityHint = this.normalizeIdentityHint(account.identityHint);
      const identityHintChanged = currentIdentityHint !== finalIdentityHint;

      if (identityHintChanged) {
        await this.accountService.updateAccount(
          targetAccountId,
          { identityHint: finalIdentityHint },
          transactionContext,
        );
      }

      return {
        accountId: targetAccountId,
        accessGroup: normalizedAccessGroup,
        identityHint: finalIdentityHint,
        isUpdated: accessGroupUpdate.isUpdated || identityHintChanged,
      };
    });
  }

  /**
   * 解析身份提示
   */
  private resolveIdentityHint(params: {
    requested?: IdentityTypeEnum;
    accessGroup: IdentityTypeEnum[];
  }): IdentityTypeEnum | undefined {
    const { requested, accessGroup } = params;
    if (requested) {
      if (!accessGroup.includes(requested)) {
        throw new DomainError(ACCOUNT_ERROR.OPERATION_NOT_SUPPORTED, '身份提示必须包含在访问组中');
      }
      return requested;
    }

    const priority: IdentityTypeEnum[] = [
      IdentityTypeEnum.SUPER_ADMIN,
      IdentityTypeEnum.ENGINEER,
      IdentityTypeEnum.CUSTOMER,
      IdentityTypeEnum.CUSTOMER,
    ];

    return priority.find((role) => accessGroup.includes(role)) ?? accessGroup[0];
  }

  /**
   * 规范化身份提示
   */
  private normalizeIdentityHint(value: string | null): IdentityTypeEnum | null {
    if (!value) return null;
    const enumValues = Object.values(IdentityTypeEnum) as string[];
    return enumValues.includes(value) ? (value as IdentityTypeEnum) : null;
  }

  /**
   * 去重访问组并保持顺序
   */
  private normalizeAccessGroup(input: IdentityTypeEnum[]): IdentityTypeEnum[] {
    const out: IdentityTypeEnum[] = [];
    const seen = new Set<IdentityTypeEnum>();
    const validRoles = new Set<string>(Object.values(IdentityTypeEnum));
    for (const item of input) {
      if (!validRoles.has(String(item))) continue;
      if (!seen.has(item)) {
        seen.add(item);
        out.push(item);
      }
    }
    return out;
  }
}
