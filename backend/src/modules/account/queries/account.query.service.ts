// src/modules/account/queries/account.query.service.ts
import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import {
  IdentityTypeEnum,
  ThirdPartyProviderEnum,
  UserAccountView,
} from '@app-types/models/account.types';
import { UserInfoView } from '@app-types/models/auth.types';
import { Gender, UserState } from '@app-types/models/user-info.types';
import { convergeAccountRole } from '@core/account/policy/account-role-convergence.policy';
import { isDualStatusFieldsConsistent } from '@core/account/policy/dual-status-consistency.policy';
import { ACCOUNT_ERROR } from '@core/common/errors';
import { ADMIN_USER_ERROR, DomainError, isDomainError } from '@core/common/errors/domain-error';
import { normalizeEmail } from '@core/common/normalize/normalize.helper';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { getTypeOrmEntityManager } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { Repository, In, Raw } from 'typeorm';
import type {
  AccountCredentialSnapshot,
  AccountDisplayInfo,
  AccountLoginBootstrapSnapshot,
  AccountSessionAuthoritySnapshot,
  AccountSnapshot,
  MyAccountSettingsSnapshot,
} from '../account.types';
import { AccountEntity } from '../base/entities/account.entity';
import { UserInfoEntity } from '../base/entities/user-info.entity';

/**
 * 账号安全展示资料（昵称 + 公司名）：供其他域读模型跨域富集展示，
 * 只读公开字段，不含登录名、邮箱、电话等敏感信息。
 */
export type AccountDisplayProfile = {
  nickname: string;
  companyName: string | null;
};

/** 昵称模糊搜索：转义 LIKE 通配符，避免用户输入 % / _ 意外扩大匹配范围 */
function escapeLikePattern(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * 把实体上的角色数组原值转为快照值（`AccountSessionAuthoritySnapshot` 的字段口径）。
 *
 * - 数组：显式拷贝（`[...]`），断开 ORM 实体别名，避免消费方的原地修改被 TypeORM
 *   脏检查持久化（该类型注释的强制要求）；
 * - 非数组：**原样透传**，不做补全、猜测或修复——`meta_digest` 实际是 varchar(1024)
 *   加密列，解密失败时水合会保留密文字符串（遗留数据可能不是数组），运行时形状的
 *   裁决统一由消费方的三源收敛纯函数失败关闭；此处仅把非空原值收窄为声明类型
 *   以通过编译，不改变任何运行时语义。
 */
const toRoleArraySnapshot = (value: unknown): ReadonlyArray<IdentityTypeEnum> | null => {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) return value as ReadonlyArray<IdentityTypeEnum>;
  return Array.from(value as ReadonlyArray<IdentityTypeEnum>);
};

@Injectable()
export class AccountQueryService {
  constructor(
    @InjectRepository(AccountEntity)
    private readonly accountRepository: Repository<AccountEntity>,
    @InjectRepository(UserInfoEntity)
    private readonly userInfoRepository: Repository<UserInfoEntity>,
  ) {}

  /**
   * 账号详情读取（纯读投影，不含任何授权裁决）。
   *
   * 历史实现曾在此处按 `session.roles` 放行 SUPER_ADMIN 的跨账号读取，但 account 域
   * 无法读取组织成员事实，管理员查询因此缺少可信同组织校验，构成跨组织旁路。
   * 现把「本人 / 管理员 + 同组织」的裁决统一上移到 `GetAccountByIdUsecase`：
   * 本方法只按主键读取并映射 View，调用方必须先完成授权，不得把它当作对外入口。
   * QueryService 保持只读、同域依赖（不导入组织 Entity / 组织 QueryService）。
   *
   * @returns 账号行缺失时返回 `null`，由调用方决定错误口径
   */
  async findAccountSnapshotById(params: {
    accountId: number;
    transactionContext?: PersistenceTransactionContext;
  }): Promise<AccountSnapshot | null> {
    const accountRepository = this.getAccountRepository(params.transactionContext);
    const account = await accountRepository.findOne({ where: { id: params.accountId } });
    return account ? this.toUserAccountView(account) : null;
  }

  async getUserAccountViewById(params: {
    accountId: number;
    transactionContext?: PersistenceTransactionContext;
  }): Promise<UserAccountView> {
    const account = await this.findAccountSnapshotById(params);
    if (!account) {
      throw new DomainError(ACCOUNT_ERROR.ACCOUNT_NOT_FOUND, '账户不存在');
    }
    return account;
  }

  /**
   * 受保护请求的账号权限事实快照（P0-7，单一语义读取，query-side projection）。
   *
   * 为 `ValidateAccessTokenSessionUsecase` 提供数据库当前授权事实，用于把
   * 「Token 签发时的声明」与「请求时的数据库事实」比对。形状与缺失语义见
   * `AccountSessionAuthoritySnapshot`：
   * - 账号行缺失 → `accountStatus: null` 且 `identityHint: null`、`userInfo: null`；
   *   资料行缺失 → 仅 `userInfo: null`（结构上不可漏判）；缺失不在此抛错，
   *   错误口径（失败关闭为 `UNAUTHENTICATED`）归调用方 Usecase；
   * - `identityHint` 是账号侧列（`base_user_account.identity_hint`）；
   *   `accessGroup` / `metaDigest` 按数据库原值透传（经 `toRoleArraySnapshot()`），
   *   不做任何补全或修复。
   *
   * 刻意走 entity 水合路径（`findOne` + relation）：`meta_digest` 是加密列，只有
   * 水合路径（`FieldEncryptionSubscriber.afterLoad`）才解密并 `JSON.parse`；与
   * `AdminUserQueryService` 文件头的「必须走 entity 水合路径、禁止 `getRawMany()`」
   * 强制约束同源，不新增第二套绕过订阅者的查询路径。
   *
   * 不接受事务上下文：JWT 校验发生在每个受保护请求的认证阶段，不在任何事务内，
   * 读到的就是请求时刻的已提交事实。
   *
   * 快照仅供服务端内部复核，任何字段（尤其 `metaDigest`）不得经 View / DTO 外泄
   * （`AccountSessionAuthoritySnapshot` 注释）。数据库异常按既有链路冒泡，不在本方法
   * 包装改写：数据库不可用不是「会话无效」。
   *
   * @returns 快照；账号行缺失时返回缺省事实（不返回 `null`，由调用方统一判字段）。
   */
  async findSessionAuthoritySnapshot(params: {
    accountId: number;
  }): Promise<AccountSessionAuthoritySnapshot> {
    const account = await this.accountRepository.findOne({
      where: { id: params.accountId },
      relations: { userInfo: true },
    });

    if (!account) {
      return {
        accountId: params.accountId,
        accountStatus: null,
        identityHint: null,
        userInfo: null,
      };
    }

    const userInfo = account.userInfo;
    return {
      accountId: account.id,
      accountStatus: account.status,
      identityHint: account.identityHint,
      userInfo: userInfo
        ? {
            userState: userInfo.userState,
            accessGroup: toRoleArraySnapshot(userInfo.accessGroup),
            metaDigest: toRoleArraySnapshot(userInfo.metaDigest),
          }
        : null,
    };
  }

  /**
   * 当前用户账号设置的窄读取（P1，单一语义，query-side projection）。
   *
   * 为 `GetMyAccountSettingsUsecase` 提供自助设置只读 View 所需的账号 + 资料事实。入参
   * `accountId` 是**由 Session 提供的可信账号主键**，不来自任何 GraphQL 参数；本方法不接受
   * 任意目标 ID 作为对外入参。
   *
   * 刻意走 entity 水合路径（`findOne` + relation）：`meta_digest` 是 varchar(1024) 的**加密列**
   * （`AccountFieldEncryptionRegistrar` 注册），只有水合路径（`FieldEncryptionSubscriber.afterLoad`
   * → `decryptEntity()`）才会解密并 `JSON.parse` 回数组，`getRawMany()` 拿到的是密文，会让三源
   * 收敛对每一行都失败。与 `AdminUserQueryService` 文件头的同一强制约束同源，不新增第二套
   * 绕过订阅者的查询路径。
   *
   * 失败关闭口径（P1 验收基线：资料缺失或角色/状态异常失败关闭）：
   * - 账号行缺失：返回 `null`，由 Usecase 决定错误口径（读链路上这属数据不变量被破坏，
   *   不是「查无此人」，不得塌缩为 `UNAUTHENTICATED`）；
   * - 资料行缺失 / 三源角色不能收敛 / 账号与资料双状态不一致：在唯一映射点
   *   `toMyAccountSettingsSnapshot()` 失败关闭抛错，映射 `INTERNAL_SERVER_ERROR`，`details` 刻意
   *   留空，诊断信息（账号主键 + 失败原因分类）只进 `DomainError.cause`（过滤器不序列化 `cause`）。
   *
   * 只读：不写库、不开启业务事务、不产生副作用（刻意不注入 logger，诊断信息以 `cause` 上行，
   * 由 Usecase 决定是否记录）。对上游只返回稳定 `MyAccountSettingsSnapshot`，不返回 ORM Entity。
   *
   * @returns 账号行缺失时返回 `null`；否则返回已完成三源收敛与双状态一致性判定的窄快照。
   *
   * `transactionContext` 可选（P2 起）：自助设置更新用例在**写入后的同一事务内**回读校验
   * 时传入；缺省读已提交事实，与 P1 只读路径行为一致。
   */
  async findMyAccountSettingsSnapshot(params: {
    accountId: number;
    transactionContext?: PersistenceTransactionContext;
  }): Promise<MyAccountSettingsSnapshot | null> {
    try {
      const accountRepository = this.getAccountRepository(params.transactionContext);
      const account = await accountRepository.findOne({
        where: { id: params.accountId },
        relations: { userInfo: true },
      });
      if (!account) {
        return null;
      }
      return this.toMyAccountSettingsSnapshot(account);
    } catch (error) {
      // 非领域异常（如驱动故障）统一收敛为读失败码，原始异常仅以 cause 保留供服务端排查；
      // 领域异常（资料缺失 / 三源不收敛 / 双状态不一致）原样冒泡，不被改写错误码。
      if (isDomainError(error)) {
        throw error;
      }
      throw new DomainError(
        ADMIN_USER_ERROR.READ_FAILED,
        '账号设置读取失败，请稍后重试',
        undefined,
        error,
      );
    }
  }

  /**
   * 账号 + 资料 → 内部窄快照 `MyAccountSettingsSnapshot` 的唯一映射点。
   *
   * 三类失败关闭判定集中在此，`findMyAccountSettingsSnapshot()` 不重复实现：
   * 1. 资料行缺失 → `READ_FAILED`（`diagnostic: 'USER_INFO_ROW_MISSING'`）；
   * 2. 三源角色不能收敛为唯一角色 → `ROLE_DATA_INCONSISTENT`（`diagnostic: 'ROLE_CONVERGENCE_FAILED'`），
   *    与 `AdminUserView.role` 共用 `convergeAccountRole()` 单一实现，不另写一份；
   * 3. 账号侧 `status` 与资料侧 `user_state` 双字段不一致 → `READ_FAILED`
   *    （`diagnostic: 'STATUS_DUAL_FIELDS_INCONSISTENT'`）。两枚举成员字符串当前逐字相同，
   *    一致性判定与 admin 写用例共用 core `dual-status-consistency.policy.ts` 单一实现，
   *    不各写一份。
   *
   * 复用 `ADMIN_USER_ERROR.READ_FAILED` / `ROLE_DATA_INCONSISTENT`：二者已在全局过滤器映射为
   * `INTERNAL_SERVER_ERROR`，语义正是「系统侧读取失败 / 账号资料不变量被破坏」，与本场景一致；
   * P1 刻意不改错误契约过滤器，故不新增自助场景专用码。`details` 一律留空，敏感定位信息只进 `cause`。
   *
   * 字段口径见 `MyAccountSettingsSnapshot` 注释：`contactEmail` 取 `base_user_info.email`（联系邮箱），
   * 与 `loginEmail`（`base_user_account.login_email`，登录凭据）严格区分；`updatedAt` 取账号侧与资料侧较新值。
   * 逐字段显式赋值，不使用 `{ ...account }` 展开，因此新增敏感列不会自动流入快照。
   */
  private toMyAccountSettingsSnapshot(account: AccountEntity): MyAccountSettingsSnapshot {
    const userInfo: UserInfoEntity | undefined = account.userInfo;
    if (!userInfo) {
      throw new DomainError(
        ADMIN_USER_ERROR.READ_FAILED,
        '账号资料缺失，无法生成账号设置视图',
        undefined,
        { diagnostic: 'USER_INFO_ROW_MISSING', accountId: account.id },
      );
    }

    const convergence = convergeAccountRole({
      identityHint: account.identityHint,
      accessGroup: userInfo.accessGroup,
      metaDigest: userInfo.metaDigest,
    });
    if (!convergence.converged) {
      throw new DomainError(
        ADMIN_USER_ERROR.ROLE_DATA_INCONSISTENT,
        '账号数据异常，暂时无法加载账号设置',
        undefined,
        {
          diagnostic: 'ROLE_CONVERGENCE_FAILED',
          accountId: account.id,
          reason: convergence.reason,
        },
      );
    }

    if (
      !isDualStatusFieldsConsistent({
        accountStatus: account.status,
        userState: userInfo.userState,
      })
    ) {
      throw new DomainError(
        ADMIN_USER_ERROR.READ_FAILED,
        '账号状态数据异常，暂时无法加载账号设置',
        undefined,
        { diagnostic: 'STATUS_DUAL_FIELDS_INCONSISTENT', accountId: account.id },
      );
    }

    return {
      accountId: account.id,
      loginName: account.loginName,
      loginEmail: account.loginEmail,
      nickname: userInfo.nickname,
      companyName: userInfo.companyName,
      phone: userInfo.phone,
      contactEmail: userInfo.email,
      role: convergence.role,
      status: account.status,
      updatedAt: this.resolveSettingsUpdatedAt(account.updatedAt, userInfo.updatedAt),
    };
  }

  /**
   * `updatedAt` 取账号侧与资料侧 `updated_at` 的较新值，使资料编辑与状态修改都反映为同一个
   * 「最近变更时间」。与 `AdminUserQueryService.resolveUpdatedAt()` 同口径。
   */
  private resolveSettingsUpdatedAt(accountUpdatedAt: Date, userInfoUpdatedAt: Date): Date {
    return userInfoUpdatedAt.getTime() > accountUpdatedAt.getTime()
      ? userInfoUpdatedAt
      : accountUpdatedAt;
  }

  /**
   * 自助设置更新（P2）的登录凭据唯一性预检查：对**发生变化的**候选值，检查是否存在
   * 其他账号占用，排除当前 `accountId` 自身。返回先命中的冲突维度（判定顺序固定：
   * 先 `loginName` 后 `loginEmail`），无冲突返回 `null`。
   *
   * 为什么不复用 `checkAccountExists()`：其入参把 `loginEmail` 声明为必填、语义是「是否存在」
   * 布尔值且不排除自身，无法表达自助更新「排除自己、逐维度定位」的需要（与
   * `AdminUserCredentialConflictField` 对该方法的否决理由同源）。
   * 也不复用 admin 场景的 `findAdminUserCredentialConflict()`（可复用底层事实
   * 与设计经验，但新能力必须有当前用户场景的窄实现）。
   *
   * 预检查只是友好错误提示的来源，**不能代替数据库唯一索引**：并发竞争仍由
   * `uk_login_name` / `uk_login_email` 在窄写入方法内裁决。候选值传
   * `undefined` 表示该维度未变化、无需检查（清空为 `null` 不冲突，多个 NULL 可共存）。
   * 大小写口径：`login_name` / `login_email` 列继承 `_ci` 排序规则，等值比较与唯一索引
   * 行为一致，无需额外归一。
   */
  async findMyAccountCredentialConflictField(params: {
    accountId: number;
    loginName?: string;
    loginEmail?: string;
    transactionContext?: PersistenceTransactionContext;
  }): Promise<'loginName' | 'loginEmail' | null> {
    const accountRepository = this.getAccountRepository(params.transactionContext);
    if (params.loginName !== undefined) {
      const count = await accountRepository
        .createQueryBuilder('account')
        .where('account.loginName = :loginName', { loginName: params.loginName })
        .andWhere('account.id != :accountId', { accountId: params.accountId })
        .getCount();
      if (count > 0) {
        return 'loginName';
      }
    }
    if (params.loginEmail !== undefined) {
      const count = await accountRepository
        .createQueryBuilder('account')
        .where('account.loginEmail = :loginEmail', { loginEmail: params.loginEmail })
        .andWhere('account.id != :accountId', { accountId: params.accountId })
        .getCount();
      if (count > 0) {
        return 'loginEmail';
      }
    }
    return null;
  }

  async findCredentialByLoginName(params: {
    loginName: string;
  }): Promise<AccountCredentialSnapshot | null> {
    const normalizedLoginName = normalizeEmail(params.loginName);
    const account = await this.accountRepository
      .createQueryBuilder('account')
      .where('account.loginName = :loginName', { loginName: params.loginName })
      .orWhere('account.loginEmail = :loginEmail', { loginEmail: normalizedLoginName })
      .getOne();
    if (!account) {
      return null;
    }
    return {
      id: account.id,
      status: account.status,
      loginPassword: account.loginPassword,
      createdAt: account.createdAt,
    };
  }

  async checkAccountExists(params: {
    loginName?: string | null;
    loginEmail: string;
  }): Promise<boolean> {
    const query = this.accountRepository
      .createQueryBuilder('account')
      .where('account.loginEmail = :loginEmail', { loginEmail: normalizeEmail(params.loginEmail) });
    if (params.loginName) {
      query.orWhere('account.loginName = :loginName', { loginName: params.loginName });
    }
    const count = await query.getCount();
    return count > 0;
  }

  async checkNicknameExists(nickname: string): Promise<boolean> {
    const userInfo = await this.userInfoRepository.findOne({ where: { nickname } });
    return !!userInfo;
  }

  /**
   * 按账号 ID 批量读取安全昵称（只读公开显示名，不含敏感字段）。
   * 供其他域读模型跨域富集展示昵称（负责人 20260901 裁定 3：不存快照，读时关联）；
   * 缺失/空白昵称不进入结果，由调用方决定回落展示。
   */
  async findNicknamesByAccountIds(accountIds: ReadonlyArray<number>): Promise<Map<number, string>> {
    const uniqueIds = [...new Set(accountIds.filter((id) => Number.isInteger(id) && id > 0))];
    if (uniqueIds.length === 0) {
      return new Map();
    }
    const rows = await this.userInfoRepository.find({
      where: { accountId: In(uniqueIds) },
      select: { accountId: true, nickname: true },
    });
    const nicknames = new Map<number, string>();
    for (const row of rows) {
      const trimmed = row.nickname?.trim();
      if (trimmed) {
        nicknames.set(row.accountId, trimmed);
      }
    }
    return nicknames;
  }

  /**
   * 按账号 ID 批量读取对外展示信息（安全昵称 + 所属公司名称，只读公开字段）。
   * 供管理员文档数据库读模型一次批量富集客户/工程师展示信息，避免逐行查询；
   * 资料行缺失不进入结果，由调用方回落展示；昵称空白收敛口径与
   * findNicknamesByAccountIds 一致（trim 后空白视为缺失，返回 null）。
   */
  async findAccountDisplayInfosByAccountIds(
    accountIds: ReadonlyArray<number>,
  ): Promise<Map<number, AccountDisplayInfo>> {
    const uniqueIds = [...new Set(accountIds.filter((id) => Number.isInteger(id) && id > 0))];
    if (uniqueIds.length === 0) {
      return new Map();
    }
    const rows = await this.userInfoRepository.find({
      where: { accountId: In(uniqueIds) },
      select: { accountId: true, nickname: true, companyName: true },
    });
    const infos = new Map<number, AccountDisplayInfo>();
    for (const row of rows) {
      const trimmed = row.nickname?.trim();
      infos.set(row.accountId, {
        nickname: trimmed ? trimmed : null,
        companyName: row.companyName ?? null,
      });
    }
    return infos;
  }

  /**
   * 按展示关键字（昵称 / 公司名称模糊匹配）批量解析账号 ID 有界集合。
   * 供管理员文档数据库读模型把跨域展示关键字筛选收敛为本域账号 ID 过滤，
   * 关键字筛选由此保持在 SQL 侧执行（不破坏分页正确性）。
   * LIKE 通配符转义与参考资料标题搜索同口径；accountIds 为按 limit 截断的
   * 前 limit 个命中（accountId ASC），totalMatched 为不含截断的命中总数，
   * 调用方（usecase）据此检测超限并显式拒绝，保证筛选语义完整不静默漏数；
   * totalMatched 为 0 时调用方短路返回空页，不再发起本域查询。
   */
  async findAccountIdsByDisplayKeyword(
    keyword: string,
    limit: number,
  ): Promise<{ accountIds: number[]; totalMatched: number }> {
    const trimmed = keyword.trim();
    if (!trimmed || !Number.isInteger(limit) || limit <= 0) {
      return { accountIds: [], totalMatched: 0 };
    }
    const escaped = trimmed.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    const pattern = `%${escaped}%`;
    const where = [
      { nickname: Raw((alias) => `${alias} LIKE :pattern`, { pattern }) },
      { companyName: Raw((alias) => `${alias} LIKE :pattern`, { pattern }) },
    ];
    const [rows, totalMatched] = await Promise.all([
      this.userInfoRepository.find({
        where,
        select: { accountId: true },
        order: { accountId: 'ASC' },
        take: limit,
      }),
      this.userInfoRepository.count({ where }),
    ]);
    return { accountIds: rows.map((row) => row.accountId), totalMatched };
  }

  /**
   * 按昵称关键词批量返回匹配账号 ID（参数化 LIKE，通配符转义防逃逸）。
   * 供其他域读模型在分页计数前完成「按昵称筛选」的账号域解析；
   * 只返回昵称非空白的账号，匹配语义（等值/包含）由调用方传入的关键词决定。
   */
  async findAccountIdsByNicknameKeyword(keyword: string): Promise<number[]> {
    const trimmed = keyword.trim();
    if (!trimmed) {
      return [];
    }
    const rows = await this.userInfoRepository.find({
      where: {
        nickname: Raw((alias) => `${alias} LIKE :pattern`, {
          pattern: `%${escapeLikePattern(trimmed)}%`,
        }),
      },
      select: { accountId: true },
    });
    return rows.map((row) => row.accountId);
  }

  /**
   * 按账号 ID 批量读取安全展示资料（昵称 + 公司名）。
   * 一次批量查询供调用方组装列表/详情，禁止逐行 N+1；
   * 昵称缺失/空白的账号不进入结果，由调用方决定回落展示。
   */
  async findAccountDisplayProfilesByAccountIds(
    accountIds: ReadonlyArray<number>,
  ): Promise<Map<number, AccountDisplayProfile>> {
    const uniqueIds = [...new Set(accountIds.filter((id) => Number.isInteger(id) && id > 0))];
    if (uniqueIds.length === 0) {
      return new Map();
    }
    const rows = await this.userInfoRepository.find({
      where: { accountId: In(uniqueIds) },
      select: { accountId: true, nickname: true, companyName: true },
    });
    const profiles = new Map<number, AccountDisplayProfile>();
    for (const row of rows) {
      const trimmed = row.nickname?.trim();
      if (trimmed) {
        profiles.set(row.accountId, { nickname: trimmed, companyName: row.companyName ?? null });
      }
    }
    return profiles;
  }

  async pickAvailableNickname(params: {
    providedNickname?: string;
    fallbackOptions?: ReadonlyArray<string>;
    provider?: ThirdPartyProviderEnum;
  }): Promise<string | undefined> {
    const candidates: string[] = [];
    if (params.providedNickname) {
      candidates.push(params.providedNickname);
    }

    for (const option of params.fallbackOptions ?? []) {
      const nickname = option.includes('@') ? option.split('@')[0] : option;
      if (nickname) {
        candidates.push(nickname);
      }
    }

    for (const candidate of candidates) {
      const exists = await this.checkNicknameExists(candidate);
      if (!exists) {
        return candidate;
      }

      const uniqueNickname = await this.generateUniqueNicknameWithSuffix(candidate);
      if (uniqueNickname) {
        return uniqueNickname;
      }
    }

    if (!params.provider) {
      return undefined;
    }

    const fallbackBase = this.getFallbackNicknameByProvider(params.provider);
    const fallbackNickname = await this.generateUniqueNicknameWithSuffix(fallbackBase);
    if (fallbackNickname) {
      return fallbackNickname;
    }

    const randomSuffix = this.generateRandomString(12);
    return `${fallbackBase}#${randomSuffix}`;
  }

  toUserAccountView(account: AccountEntity): UserAccountView {
    return {
      id: account.id,
      loginName: account.loginName,
      loginEmail: account.loginEmail,
      status: account.status,
      identityHint: account.identityHint,
      recentLoginHistory: account.recentLoginHistory || null,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    };
  }

  async getLoginBootstrapSnapshot(params: {
    accountId: number;
    transactionContext?: PersistenceTransactionContext;
  }): Promise<AccountLoginBootstrapSnapshot> {
    const accountRepository = this.getAccountRepository(params.transactionContext);
    const account = await accountRepository.findOne({ where: { id: params.accountId } });
    if (!account) {
      throw new DomainError(ACCOUNT_ERROR.ACCOUNT_NOT_FOUND, '账户不存在');
    }

    const userInfo = await this.findUserInfoByAccountId(
      params.accountId,
      params.transactionContext,
    );
    if (!userInfo) {
      throw new DomainError(ACCOUNT_ERROR.USER_INFO_NOT_FOUND, '用户信息不存在');
    }

    return {
      account: {
        id: account.id,
        loginName: account.loginName,
        loginEmail: account.loginEmail,
        status: account.status,
        identityHint: account.identityHint,
        createdAt: account.createdAt,
        updatedAt: account.updatedAt,
      },
      userInfo: {
        id: userInfo.id,
        accountId: userInfo.accountId,
        nickname: userInfo.nickname,
        avatarUrl: userInfo.avatarUrl,
        accessGroup: userInfo.accessGroup ?? null,
        metaDigest: userInfo.metaDigest ?? null,
        createdAt: userInfo.createdAt,
        updatedAt: userInfo.updatedAt,
      },
    };
  }

  async getUserInfoViewStrict(params: {
    accountId: number;
    transactionContext?: PersistenceTransactionContext;
  }): Promise<
    UserInfoView & {
      nickname: string;
      userState: UserState;
      notifyCount: number;
      unreadCount: number;
      createdAt: Date;
      updatedAt: Date;
    }
  > {
    const { accountId } = params;

    const base = await this.findUserInfoByAccountId(accountId, params.transactionContext);
    if (!base) {
      throw new DomainError(
        ACCOUNT_ERROR.USER_INFO_NOT_FOUND,
        `账户 ID ${accountId} 对应的用户信息不存在，无法完成操作`,
      );
    }

    const finalAccessGroup: IdentityTypeEnum[] = base.accessGroup?.length
      ? base.accessGroup
      : [IdentityTypeEnum.CUSTOMER];

    return this.buildUserInfoView(base, accountId, finalAccessGroup);
  }

  async getUserInfoViewForLogin(params: { accountId: number }): Promise<UserInfoView> {
    const base = await this.findUserInfoByAccountId(params.accountId);
    const finalAccessGroup: IdentityTypeEnum[] = base?.accessGroup?.length
      ? base.accessGroup
      : [IdentityTypeEnum.CUSTOMER];

    return this.buildUserInfoView(base, params.accountId, finalAccessGroup);
  }

  private buildUserInfoView(
    base: UserInfoEntity | null,
    accountId: number,
    accessGroup: IdentityTypeEnum[],
  ): UserInfoView {
    return {
      accountId,
      accessGroup,
      ...this.buildBasicFields(base),
      ...this.buildContactFields(base),
      ...this.buildExtendedFields(base),
      ...this.buildSystemFields(base),
    };
  }

  private buildBasicFields(base: UserInfoEntity | null) {
    return {
      nickname: base?.nickname ?? '',
      gender: base?.gender ?? Gender.SECRET,
      birthDate: base?.birthDate ?? null,
      avatarUrl: base?.avatarUrl ?? null,
      signature: base?.signature ?? null,
    };
  }

  private buildContactFields(base: UserInfoEntity | null) {
    return {
      email: base?.email ?? null,
      address: base?.address ?? null,
      phone: base?.phone ?? null,
    };
  }

  private buildExtendedFields(base: UserInfoEntity | null) {
    return {
      tags: this.normalizeTags(base?.tags),
      geographic: base?.geographic ?? null,
      metaDigest: base?.metaDigest ?? null,
    };
  }

  private buildSystemFields(base: UserInfoEntity | null) {
    return {
      notifyCount: base?.notifyCount ?? 0,
      unreadCount: base?.unreadCount ?? 0,
      userState: base?.userState ?? UserState.PENDING,
      createdAt: base?.createdAt ?? new Date(),
      updatedAt: base?.updatedAt ?? new Date(),
    };
  }

  private async findUserInfoByAccountId(
    accountId: number,
    transactionContext?: PersistenceTransactionContext,
  ): Promise<UserInfoEntity | null> {
    const repository = this.getUserInfoRepository(transactionContext);
    return await repository.findOne({
      where: { accountId },
      relations: { account: true },
    });
  }

  private getAccountRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<AccountEntity> {
    return transactionContext
      ? getTypeOrmEntityManager(transactionContext).getRepository(AccountEntity)
      : this.accountRepository;
  }

  private getUserInfoRepository(
    transactionContext?: PersistenceTransactionContext,
  ): Repository<UserInfoEntity> {
    return transactionContext
      ? getTypeOrmEntityManager(transactionContext).getRepository(UserInfoEntity)
      : this.userInfoRepository;
  }

  private getFallbackNicknameByProvider(provider: ThirdPartyProviderEnum): string {
    switch (provider) {
      case ThirdPartyProviderEnum.WEAPP:
      case ThirdPartyProviderEnum.WECHAT:
        return '微信用户';
      case ThirdPartyProviderEnum.QQ:
        return 'QQ用户';
      case ThirdPartyProviderEnum.GOOGLE:
        return 'Google用户';
      case ThirdPartyProviderEnum.GITHUB:
        return 'GitHub用户';
      default:
        return '用户';
    }
  }

  private async generateUniqueNicknameWithSuffix(
    baseNickname: string,
  ): Promise<string | undefined> {
    const maxAttempts = 5;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const randomSuffix = this.generateRandomString(6);
      const uniqueNickname = `${baseNickname}#${randomSuffix}`;
      const exists = await this.checkNicknameExists(uniqueNickname);
      if (!exists) {
        return uniqueNickname;
      }
    }
    return undefined;
  }

  private generateRandomString(length: number): string {
    return Math.random()
      .toString(36)
      .substring(2, 2 + length);
  }

  private normalizeTags(tags: unknown): string[] | null {
    if (!tags) return null;
    if (Array.isArray(tags)) return tags.map((v) => String(v));
    return null;
  }
}
