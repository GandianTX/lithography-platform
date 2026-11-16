// src/usecases/account/change-my-password.usecase.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import {
  ADMIN_USER_ERROR,
  AUTH_ERROR,
  DomainError,
  isDomainError,
  MY_ACCOUNT_ERROR,
} from '@core/common/errors/domain-error';
import { Inject, Injectable } from '@nestjs/common';
import { PasswordPolicyService } from '@core/common/password/password-policy.service';
import {
  ADMIN_ACCOUNT_RESET_OPTIONS,
  type AdminAccountResetOptions,
} from '@src/modules/account/admin-account-reset.contract';
import { AccountService } from '@src/modules/account/base/services/account.service';
import {
  TRANSACTION_RUNNER,
  type TransactionRunner,
} from '@src/usecases/common/ports/transaction-runner.contract';
import { PinoLogger } from 'nestjs-pino';
import {
  assertAdminUserPasswordPolicy,
  logAdminUserWriteFailure,
} from './admin-user-write-support';
import { normalizeAdminUserDefaultPasswordSetting } from './admin-user-management.input.normalize';
import {
  normalizeMyAccountPasswordInput,
  normalizeMyAccountSettingsAccountId,
} from './my-account-settings.input.normalize';
import type { ChangeMyPasswordCommand, ChangeMyPasswordOutcome } from './my-account-settings.types';

/** 事务内的写入阶段标记，只用于服务端日志定位，不出现在任何对外响应中。 */
type ChangeMyPasswordPhase =
  | 'LOCK_CREDENTIAL'
  | 'VERIFY_CURRENT_PASSWORD'
  | 'VERIFY_NEW_PASSWORD_NOT_ALLOWED'
  | 'VERIFY_NEW_PASSWORD_DISTINCT'
  | 'WRITE_PASSWORD_HASH';

/** 固定成功提示：不声称服务端撤销了已签发 Token。 */
const CHANGE_MY_PASSWORD_NOTICE = '密码已更新，请使用新密码重新登录';

/** 写哈希阶段（UPDATE 绑定参数嵌新密码派生哈希）的失败日志抑制 `message`（P0-6 同款纵深防御）。 */
const SUPPRESSED_MESSAGE_PHASES: ReadonlyArray<ChangeMyPasswordPhase> = ['WRITE_PASSWORD_HASH'];

/** 预期业务拒绝码（当前密码不正确 / 新密码不被允许 / 提交与当前密码相同的新密码）：
 *  命中共享失败日志 helper 的 warn 分流。 */
const CHANGE_MY_PASSWORD_WARN_ERROR_CODES: ReadonlyArray<string> = [
  MY_ACCOUNT_ERROR.CURRENT_PASSWORD_MISMATCH,
  MY_ACCOUNT_ERROR.NEW_PASSWORD_NOT_ALLOWED,
  MY_ACCOUNT_ERROR.NEW_PASSWORD_UNCHANGED,
];

/**
 * 当前用户自助修改登录密码用例（P3，契约见 `docs/api/account-write-current.md`）。
 *
 * 执行顺序刻意固定：
 * 1. 从 Session 取得当前 `accountId`（防御性前置校验）；
 * 2. 两个密码做**不丢字符**的非空断言（不 trim——trim 会静默改写秘密）；
 * 3. 用全仓唯一的 `PasswordPolicyService` 校验**新密码**（当前密码刻意不做策略校验：
 *    存量账号的密码可能先于现行策略设立，策略校验会把本来正确的当前密码误判为非法）；
 * 4. 单一事务内：锁定 account 行取得纯 credential 快照（含数据库权威 `createdAt`）→
 *    `AccountService.verifyPassword()` 校验当前密码 → 拒绝部署默认重置密码及其 NFKC 等价值 →
 *    拒绝同值新密码 → 同一 `createdAt` 做盐再哈希 →
 *    `AccountService.updateAccountPasswordHash()` 写入。
 *
 * 同值拒绝语义：无论是否处于强制改密状态，新密码若仍能通过同一旧凭据校验（即新旧相同）
 * 一律拒绝为 `MY_ACCOUNT_ERROR.NEW_PASSWORD_UNCHANGED`（对外 `BAD_USER_INPUT`）。
 * 强制改密场景下否则写哈希会在同一 UPDATE 内清掉强制改密标记，用户重新登录即恢复完整访问，
 * 却从未真正更换凭据，等于绕过管理员要求；普通主动改密提交同值同样没有实际更换凭据，
 * 统一拒绝可避免无意义的哈希重写与 `updated_at` 抖动。比较复用
 * `AccountService.verifyPassword()`（登录侧同一归一化 / 校验口径），拒绝发生在任何写调用
 * 之前，哈希、标记与事务外会话均不变。
 *
 * 部署默认密码拒绝（任务 02.2「拒绝重置默认值」）：新密码等于管理员默认重置入口读取的
 * 部署配置值时拒绝为 `MY_ACCOUNT_ERROR.NEW_PASSWORD_NOT_ALLOWED`（对外 `BAD_USER_INPUT`）。
 * 读取复用 `normalizeAdminUserDefaultPasswordSetting()`，相等判断复用凭据哈希的 NFKC
 * 归一化口径（`password-hashing.policy.ts` 的 `preprocessPassword()`）；因新密码已先通过
 * 策略校验（无首尾空白），NFKC 相等即等同于哈希后凭据相同。
 * **顺序（安全关键）**：该判断依赖部署配置，只能在该账号的当前密码核验成功之后执行；
 * 否则持有一个有效会话但没有当前密码的人，可以用「错误当前密码 + 猜测值」的响应差异
 * 确认部署默认密码（该密码可能仍是其他未改密账号的登录凭据）。因此它位于锁内事务中
 * `verifyCurrentPassword()` 之后、写哈希与清强改标记之前；对外细码与文案都是通用提示，
 * 不让调用方确认命中哪条部署配置；配置缺失 / 空白时不干预合法自助改密；响应、日志与
 * 取证都不得回显配置值。
 *
 * 与管理员重置密码（P0-6）的关系：权限（本人 vs SUPER_ADMIN + 目标保护）、入参（含当前
 * 密码 vs 不含）与编排均不同，是两条独立链路；**不调用** `AdminResetUserPasswordUsecase`，
 * 只在低层密码原语与共享策略断言处汇合。复用
 * `assertAdminUserPasswordPolicy()` 是为了避免出现第二份策略断言（错误码 / 文案口径漂移），
 * 该函数本身不含任何管理员目标逻辑。
 *
 * 错误边界（安全关键）：当前密码验证失败收敛为 `MY_ACCOUNT_ERROR.CURRENT_PASSWORD_MISMATCH`
 * （对外 `BAD_USER_INPUT`）。`verifyPassword()` 内部的 `preprocessPassword()` 对空值 /
 * NFKC 后首尾空白抛 `AUTH_ERROR.INVALID_PASSWORD`，该码被全局过滤器映射为
 * `UNAUTHENTICATED`，会让前端误判会话失效并清理 Session 跳转登录页——此处显式拦截该码
 * 并转译为「当前密码不正确」：无法通过预处理的输入形态不可能验证成功，语义等价且不泄露
 * 密码构成信息。normalize 层的非空断言先行拦截空值，本拦截是首尾空白形态的兜底。
 *
 * Token 语义：旧密码提交成功后立即不能再登录（哈希已被覆盖），已签发 Access Token 按
 * `JWT_EXPIRES_IN` 自然过期；本用例不新增 Token 黑名单、tokenVersion、Refresh Token 或
 * 服务端 Session 撤销（刻意不做）。REPEATABLE READ 下已建立的登录读快照
 * 可能在极短窗口内以旧密码通过验证，属快照隔离固有语义，不经本用例消除。
 *
 * 依赖方向：事务边界由本用例经 `TransactionRunner` 持有；只调用 modules 细粒度方法与
 * 静态密码原语，不访问 Repository、不接触 ORM API、不持有 ORM Entity。取锁顺序
 * （account 行优先）与本组统一口径一致。
 */
@Injectable()
export class ChangeMyPasswordUsecase {
  constructor(
    private readonly accountService: AccountService,
    private readonly passwordPolicyService: PasswordPolicyService,
    private readonly logger: PinoLogger,
    @Inject(TRANSACTION_RUNNER)
    private readonly transactionRunner: TransactionRunner,
    @Inject(ADMIN_ACCOUNT_RESET_OPTIONS)
    private readonly resetOptions: AdminAccountResetOptions,
  ) {
    this.logger.setContext(ChangeMyPasswordUsecase.name);
  }

  async execute(command: ChangeMyPasswordCommand): Promise<ChangeMyPasswordOutcome> {
    const accountId = normalizeMyAccountSettingsAccountId(command.session);
    const currentPassword = normalizeMyAccountPasswordInput(command.currentPassword, '当前密码');
    const newPassword = normalizeMyAccountPasswordInput(command.newPassword, '新密码');
    assertAdminUserPasswordPolicy({
      passwordPolicyService: this.passwordPolicyService,
      password: newPassword,
      fieldName: '新密码',
    });

    // 任务 02.2：默认值等价判断依赖部署配置，必须放在锁内事务中「当前密码核验成功之后」，
    // 详见 changeInTransaction() 与类注释的顺序说明；此处不再做任何依赖配置的前置判断。
    try {
      await this.transactionRunner.run((transactionContext) =>
        this.changeInTransaction({ transactionContext, accountId, currentPassword, newPassword }),
      );
    } catch (error) {
      // 事务内各阶段的异常已由 changeInTransaction 的 catch 记录日志并收敛为 DomainError；
      // 走到这里的非 DomainError 只可能来自事务边界本身（BEGIN / COMMIT 失败都不经过
      // 内层 catch），统一收敛为 WRITE_FAILED
      if (isDomainError(error)) {
        throw error;
      }
      logAdminUserWriteFailure({
        logger: this.logger,
        phase: 'TRANSACTION_BOUNDARY',
        error,
        summary: '修改密码',
        accountId,
        warnErrorCodes: CHANGE_MY_PASSWORD_WARN_ERROR_CODES,
      });
      throw new DomainError(
        ADMIN_USER_ERROR.WRITE_FAILED,
        '修改密码失败，请稍后重试',
        undefined,
        error,
      );
    }

    // 成功日志在事务提交之后记录（假成功规避），只含账号主键：不含当前密码、新密码、
    // 哈希或任何凭据派生物
    this.logger.info({ accountId }, '用户修改登录密码成功');
    return { isUpdated: true, notice: CHANGE_MY_PASSWORD_NOTICE };
  }

  /**
   * 事务内的原子密码修改：锁定 → 验证当前密码 → 再哈希 → 覆盖写。任一步失败整体回滚，
   * 不存在部分写入（哈希只在一个 UPDATE 内落库，失败即回滚）。
   *
   * 时间盐取**锁内数据库行**的 `createdAt`（登录校验侧以库中 `created_at` 为盐，两侧同源
   * 才可验证；本用例不另取应用时钟，与 `AdminResetUserPasswordUsecase` 的盐事实约束一致）。
   */
  private async changeInTransaction(params: {
    transactionContext: PersistenceTransactionContext;
    accountId: number;
    currentPassword: string;
    newPassword: string;
  }): Promise<void> {
    const { transactionContext, accountId, currentPassword, newPassword } = params;
    let phase: ChangeMyPasswordPhase = 'LOCK_CREDENTIAL';

    try {
      const snapshot = await this.accountService.lockMyAccountCredentialSnapshot({
        accountId,
        transactionContext,
      });
      if (!snapshot) {
        // Session 引用的账号行在库中不存在，属数据不变量被破坏，失败关闭为
        // INTERNAL_SERVER_ERROR（不得塌缩为 UNAUTHENTICATED）
        throw new DomainError(
          ADMIN_USER_ERROR.READ_FAILED,
          '账号状态读取失败，请稍后重试',
          undefined,
          { diagnostic: 'ACCOUNT_ROW_MISSING', accountId },
        );
      }

      phase = 'VERIFY_CURRENT_PASSWORD';
      const isCurrentPasswordValid = this.verifyCurrentPassword({
        currentPassword,
        snapshotPasswordHash: snapshot.loginPassword,
        snapshotCreatedAt: snapshot.createdAt,
      });
      if (!isCurrentPasswordValid) {
        // details 留空；不区分「密码错误」与「格式不可验证」，避免泄露账号密码构成信息
        throw new DomainError(MY_ACCOUNT_ERROR.CURRENT_PASSWORD_MISMATCH, '当前密码不正确');
      }

      // 只有通过当前密码核验后，才允许执行依赖部署配置的等价判断：否则有效会话持有者可
      // 用「错误当前密码 + 猜测值」的响应差异确认部署默认重置密码。配置缺失 / 空白时
      // 跳过；对外细码与文案都是通用提示，不确认命中了哪条部署配置。
      phase = 'VERIFY_NEW_PASSWORD_NOT_ALLOWED';
      const comparableDefaultPassword = this.resolveComparableDefaultPassword();
      if (
        comparableDefaultPassword !== null &&
        newPassword.normalize('NFKC') === comparableDefaultPassword
      ) {
        throw new DomainError(
          MY_ACCOUNT_ERROR.NEW_PASSWORD_NOT_ALLOWED,
          '新密码不被允许，请更换其他密码',
        );
      }

      // 新密码必须实际更换凭据：无论是否强制改密，新密码仍能通过同一旧凭据校验时拒绝。
      // 比较复用与当前密码校验相同的 verifyPassword 口径（含 INVALID_PASSWORD 收敛为 false），
      // 不新增第二套密码比较实现；拒绝发生在写哈希之前，强制改密标记不会被清除。
      phase = 'VERIFY_NEW_PASSWORD_DISTINCT';
      const isNewPasswordSameAsCurrent = this.verifyCurrentPassword({
        currentPassword: newPassword,
        snapshotPasswordHash: snapshot.loginPassword,
        snapshotCreatedAt: snapshot.createdAt,
      });
      if (isNewPasswordSameAsCurrent) {
        throw new DomainError(MY_ACCOUNT_ERROR.NEW_PASSWORD_UNCHANGED, '新密码需与当前密码不同');
      }

      phase = 'WRITE_PASSWORD_HASH';
      const passwordHash = AccountService.hashPasswordWithTimestamp(
        newPassword,
        snapshot.createdAt,
      );
      await this.accountService.updateAccountPasswordHash({
        accountId,
        passwordHash,
        transactionContext,
        // 「必须改密」是管理员对下次登录的要求；用户完成改密后必须在同一 UPDATE 内清除，
        // 否则重新登录仍会被判为受限会话
        mustChangePassword: false,
      });
    } catch (error) {
      logAdminUserWriteFailure({
        logger: this.logger,
        phase,
        error,
        summary: '修改密码',
        accountId,
        warnErrorCodes: CHANGE_MY_PASSWORD_WARN_ERROR_CODES,
        suppressMessagePhases: SUPPRESSED_MESSAGE_PHASES,
      });
      if (isDomainError(error)) {
        throw error;
      }
      throw new DomainError(
        ADMIN_USER_ERROR.WRITE_FAILED,
        '修改密码失败，请稍后重试',
        undefined,
        error,
      );
    }
  }

  /**
   * 部署默认重置密码的可比较形态：与管理员默认重置入口同一读取口径
   * （`normalizeAdminUserDefaultPasswordSetting()`，缺失 / 空白 → `null`），再按凭据哈希的
   * `preprocessPassword()` 口径做 NFKC 归一化。返回 `null` 表示未配置，调用方跳过该守卫。
   * 本方法只产出比较值，返回值不得出现在响应、日志或错误文案中。
   */
  private resolveComparableDefaultPassword(): string | null {
    const configured = normalizeAdminUserDefaultPasswordSetting(this.resetOptions.defaultPassword);
    return configured === null ? null : configured.normalize('NFKC');
  }

  /**
   * 当前密码验证的异常边界：`verifyPassword()` 只返回布尔值，唯一会抛错的是内部
   * `preprocessPassword()` 对空值 / NFKC 后首尾空白的 `AUTH_ERROR.INVALID_PASSWORD`。
   * 该输入形态不可能验证成功，转译为「不匹配」语义等价；其余异常原样上抛
   * （基础设施故障不得被伪装成业务拒绝）。
   */
  private verifyCurrentPassword(args: {
    readonly currentPassword: string;
    readonly snapshotPasswordHash: string;
    readonly snapshotCreatedAt: Date;
  }): boolean {
    try {
      return AccountService.verifyPassword(
        args.currentPassword,
        args.snapshotPasswordHash,
        args.snapshotCreatedAt,
      );
    } catch (error) {
      if (isDomainError(error) && error.code === AUTH_ERROR.INVALID_PASSWORD) {
        return false;
      }
      throw error;
    }
  }
}
