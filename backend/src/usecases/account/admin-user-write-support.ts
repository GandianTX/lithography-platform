// src/usecases/account/admin-user-write-support.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import {
  ACCOUNT_ERROR,
  ADMIN_USER_ERROR,
  DomainError,
  INPUT_NORMALIZE_ERROR,
  isDomainError,
  PERMISSION_ERROR,
} from '@core/common/errors/domain-error';
import { PasswordPolicyService } from '@core/common/password/password-policy.service';
import type { AdminUserView } from '@src/modules/account/account.types';
import { assertWritableAdminUserTargetRole } from './admin-user-permission';
import { AccountService } from '@src/modules/account/base/services/account.service';
import { AdminUserQueryService } from '@src/modules/account/queries/admin-user.query.service';
import { OrganizationMembershipQueryService } from '@src/modules/lithography/queries/organization-membership.query.service';
import { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import { PinoLogger } from 'nestjs-pino';

/**
 * account 写用例（P0-4 / P0-5 / P0-6 管理员链路 + P2 / P3 自助链路）的共享执行支撑：
 * - `loadWritableAdminUserTarget()`：事务内锁定目标 + 读取收敛 View + 目标角色保护，
 *   写用例共用的单一实现（沿用 `admin-user-permission.ts` 在 P0-1 确立的「同一裁决
 * - `assertAdminUserPasswordPolicy()`：管理员创建初始密码、管理员重置密码与自助修改密码
 *   共用的密码策略校验（P0-6 起入本文件，避免第二份策略断言）；
 * - `logAdminUserWriteFailure()`：P0-4 / P0-5 / P0-6 与 P2 / P3 写用例的失败日志，
 *   脱敏与结构化诊断；warn 分流经可选 `warnErrorCodes` 按调用方注入（缺省为管理员四码，
 *   既有管理员调用方行为不变），自助链路传入各自的 MY_ACCOUNT 预期业务码；
 *   `accountId` 为可选定位字段（管理员链路在 `cause.diagnostic` 携带、不传本参数；
 *   自助链路传 Session 账号 ID）。
 *
 * `extractDriverErrorCode()` 与 `errorMessage()` 两个取值 helper。「按阶段抑制 `message`」
 * 已于 P0-6 并入共享 helper——`logAdminUserWriteFailure()` 新增可选 `suppressMessagePhases`
 * 参数（缺省不抑制，既有调用方行为不变），P0-6 与 P3 写哈希阶段的失败日志经类型化常量
 * `SUPPRESSED_MESSAGE_PHASES` 传入抑制清单。`AdminCreateUserUsecase.logCreateFailure()`
 * 仍保留「`UPDATE_PASSWORD_HASH` 阶段抑制 `message`」与「`CREDENTIAL_CONFLICT` 记 warn」
 * 两个创建路径特有分支，后者现已可由 `warnErrorCodes` 表达，迁移属独立清理项不随本轮。
 *
 * `loadWritableAdminUserTarget()` 先取 `base_user_account` 的悲观行锁，各用例随后才写
 * `base_user_info`；依据是 `usecase-write-flow-boundaries.rules.md` 第 78-79 行「usecase 先开启
 * 事务，再显式调用 `lockByIdForUpdate(accountId, transactionContext)`」的表述，以及
 * `UpdateAccessGroupUsecase` 的既有同序实现。新增管理员写用例必须沿用本顺序，不得第三次分叉
 * （`UpdateVisibleUserInfoUsecase` 的既有现状例外见下方 R14 说明）。
 *
 * **R14 锁顺序说明（现状记录，非已完成收口）**：`UpdateVisibleUserInfoUsecase`（已发布的
 * `updateUserInfo` mutation）**尚未**复用 `loadWritableAdminUserTarget()`：它先经
 * `FetchUserInfoUsecase.executeStrict()` 读取并更新 userInfo，仅在需要更新 `identityHint`
 * 时才对 account 行取悲观锁；`identityHint` 也未在事务前禁止，仍保留锁内比对后单字段更新。
 * 因此「管理员写入口先锁 account 行再写 userInfo」的收口对该用例**尚未达成**，上述顺序目前
 * 只约束新增管理员写用例；若后续收口，应让该用例改走本文件共享实现，而不是在本文件外分叉。
 *
 * 本文件只被 `usecases/account` 内的写用例引用，不下沉 modules、不进 core：
 * 它编排的是 usecase 层的写流程步骤（锁、读、断言、日志），不是通用输入收敛。
 */

/**
 * 取异常文本；非 `Error` 值不参与日志，避免把未知形状的对象整体序列化。
 *
 * 实现。本轮只统一取值 helper，不统一失败日志的分流逻辑，理由见文件头。
 */
export const errorMessage = (error: unknown): string | undefined =>
  error instanceof Error ? error.message : undefined;

/**
 * 取驱动错误的结构化错误码（MySQL 典型值：`errno` 数字 `1062` / `code` 字符串 `'ER_DUP_ENTRY'`）。
 *
 * TypeORM 1.0 的 `QueryFailedError` 以 `super(driverError.toString())` 构造，因此 `message` 是
 * **驱动错误文本**（形如 `ER_DUP_ENTRY: Duplicate entry 'x' for key 'uk_login_name'`），
 * **不含 SQL 文本**；SQL 在 `error.query`、绑定参数在 `error.parameters`，两者当前都不入日志。
 * 不取 `message` 的理由因此是：驱动文本可能内嵌冲突值与索引名，而错误码不含任何敏感数据，
 * 却足以区分故障类别（唯一索引冲突 / 连接中断 / 死锁）。
 *
 * 来源的异常（如 Node 的 `ERR_*`）也会出现在日志的 `driverCode` 字段里。该字段名只表达取值
 * 意图，不保证一定是数据库错误码；刻意不收窄为 `/^ER_/`——否则将来更换驱动或数据库时错误码
 * 会静默消失，排查面反而退化。
 *
 * 同时检查异常自身与 `driverError`：TypeORM 把原始驱动错误挂在 `driverError` 上，并用
 * `ObjectUtils.assign()` 把除 `name` 之外的驱动属性（含 `errno` / `code` / `sqlState`）复制到
 * `QueryFailedError` 自身，因此两处都可能读到。
 */
export const extractDriverErrorCode = (error: unknown): string | number | undefined => {
  if (!(error instanceof Error)) return undefined;
  const source = error as {
    driverError?: unknown;
    errno?: unknown;
    errNo?: unknown;
    code?: unknown;
  };
  for (const candidate of [source.driverError, source]) {
    if (candidate === null || typeof candidate !== 'object') continue;
    const driver = candidate as { errno?: unknown; errNo?: unknown; code?: unknown };
    if (typeof driver.errno === 'number') return driver.errno;
    if (typeof driver.errNo === 'number') return driver.errNo;
    if (typeof driver.code === 'string') return driver.code;
  }
  return undefined;
};

/**
 * 事务内加载受保护的管理员写目标：锁定 → 解析管理员组织 → 读取收敛 View → 组织归属
 * 校验 → 目标角色保护断言。
 *
 * 1. **先锁定目标账号**（`AccountService.lockByIdForUpdate()` 持 `SELECT ... FOR UPDATE`
 *    悲观行锁）：串行化针对同一目标账号的并发管理写，并要求后续所有读取都发生在取得
 *    行锁之后。锁前建立的普通读取（含组织解析）会被后续事务快照复用，读到并发方的旧
 *    状态，故顺序不可交换；
 * 2. **锁后解析管理员可信组织**
 *    （`TrustedOrganizationContextQueryService.resolveForAccount()`）：组织范围只来自
 *    Session 账号的单一有效成员关系，绝不取客户端自报。无有效组织或存在歧义时失败关闭
 *    为 `ORGANIZATION_*`（对外 FORBIDDEN），**不**塌缩为目标不存在；
 * 3. 锁内经 `findAdminUserViewById()` 读取收敛后的稳定 View：目标角色数据异常或不一致
 *    （`ROLE_DATA_INCONSISTENT`）、资料行缺失（`READ_FAILED`）由 `toAdminUserView()`
 *    统一失败关闭，本层不重复实现，也不顺手修复历史数据；
 * 4. **组织归属校验先于角色断言**：目标在本组织内必须有一条有效成员关系
 *    （`findActiveMembership()`）；不匹配统一收敛为 `TARGET_NOT_FOUND`——跨组织目标
 *    与不存在的目标对外不可区分，也不泄露目标在其它组织或是否为只读 SUPER_ADMIN；
 * 5. `assertWritableAdminUserTargetRole()` 依数据库事实拒绝 SUPER_ADMIN 目标——
 *    SUPER_ADMIN 在本功能内全部只读，其中也包含「管理员操作自己」（自己的账号必然是
 *    SUPER_ADMIN）。
 *
 * 目标不存在时收敛为 `ADMIN_USER_ERROR.TARGET_NOT_FOUND`（过滤器映射 `NOT_FOUND`）：
 * **不得**沿用 `lockByIdForUpdate()` 原有的 `ACCOUNT_ERROR.ACCOUNT_NOT_FOUND` ——该码值
 * 与 `AUTH_ERROR.ACCOUNT_NOT_FOUND` 相同，会被过滤器映射为 `UNAUTHENTICATED`，违反
 * `graphql-error-contract-current.md`「not-found 不得塌缩为 UNAUTHENTICATED」的契约。
 *
 * @param params.accountService 锁能力由既有域内方法提供，本层不直接访问 ORM API
 * @param params.adminAccountId 发起操作的管理员账号 ID（必须来自可信 Session）
 * @param params.actionLabel 管理动作文案（如「编辑资料」「修改状态」「重置密码」），
 *   仅用于目标保护拒绝提示
 */
export async function loadWritableAdminUserTarget(params: {
  readonly accountService: AccountService;
  readonly adminUserQueryService: AdminUserQueryService;
  readonly organizationContextQueryService: TrustedOrganizationContextQueryService;
  readonly organizationMembershipQueryService: OrganizationMembershipQueryService;
  readonly adminAccountId: number;
  readonly accountId: number;
  readonly actionLabel: string;
  readonly transactionContext: PersistenceTransactionContext;
}): Promise<AdminUserView> {
  // 先取得目标行锁：后续组织解析与目标资料读取都必须发生在锁后，
  // 否则普通读取会在锁前建立快照，并发方提交后仍读到旧状态。
  try {
    await params.accountService.lockByIdForUpdate(params.accountId, params.transactionContext);
  } catch (error) {
    if (isDomainError(error) && error.code === ACCOUNT_ERROR.ACCOUNT_NOT_FOUND) {
      throw new DomainError(ADMIN_USER_ERROR.TARGET_NOT_FOUND, '目标用户不存在');
    }
    throw error;
  }

  // 锁后解析管理员可信组织（fail-fast，早于目标资料读取与写入）
  const adminOrganization = await params.organizationContextQueryService.resolveForAccount({
    accountId: params.adminAccountId,
    transactionContext: params.transactionContext,
  });

  const view = await params.adminUserQueryService.findAdminUserViewById({
    accountId: params.accountId,
    transactionContext: params.transactionContext,
  });
  if (view === null) {
    // 锁定成功后账号仍读不到属系统侧故障（行锁不覆盖读写分离的复制路径等），失败关闭
    throw new DomainError(ADMIN_USER_ERROR.READ_FAILED, '用户账号读取失败，请稍后重试', undefined, {
      diagnostic: 'LOCKED_ACCOUNT_NOT_READABLE',
      accountId: params.accountId,
    });
  }

  // 目标归属校验先于角色断言：跨组织目标统一按不存在处理，不泄露存在性与只读身份
  const targetMembership = await params.organizationMembershipQueryService.findActiveMembership({
    accountId: params.accountId,
    organizationId: adminOrganization.organizationId,
    transactionContext: params.transactionContext,
  });
  if (targetMembership === null) {
    throw new DomainError(ADMIN_USER_ERROR.TARGET_NOT_FOUND, '目标用户不存在');
  }

  assertWritableAdminUserTargetRole(view.role, params.actionLabel);
  return view;
}

/**
 * 管理员写用例的预期业务拒绝码缺省清单：目标不存在 / 权限不足 / 状态转换不允许 /
 * 重置密码状态边界不允许。命中时记 warn（预期业务结果而非系统故障），且不记录
 * 密码 / 哈希 / Token / 角色原值。自助链路（P2 / P3）不使用本清单，必须经
 * `warnErrorCodes` 显式传入各自的 MY_ACCOUNT 业务码，避免把管理员专用码的语义
 * 带进自助日志分流。
 */
const ADMIN_USER_WRITE_WARN_ERROR_CODES: ReadonlyArray<string> = [
  ADMIN_USER_ERROR.TARGET_NOT_FOUND,
  PERMISSION_ERROR.INSUFFICIENT_PERMISSIONS,
  ADMIN_USER_ERROR.STATUS_TRANSITION_NOT_ALLOWED,
  ADMIN_USER_ERROR.PASSWORD_RESET_TARGET_STATUS_NOT_ALLOWED,
];

/**
 * account 写用例（管理员 P0-4 / P0-5 / P0-6 与自助 P2 / P3）失败的统一日志出口：
 * 单一实现覆盖两条链路，warn 分流与定位字段只经参数注入，不在本函数内按调用方分支。
 *
 * - 非领域异常：记录异常类型名、驱动错误码与 `message`，供定位连接中断 / 死锁等
 *   基础设施故障；写流程语句不含密码派生物时记录 `message` 不引入敏感数据。
 *   **写哈希阶段例外**：管理员重置密码（`WRITE_PASSWORD_HASH`）与自助修改密码
 *   （`UPDATE_PASSWORD_HASH`）的 UPDATE 语句绑定参数嵌密码派生哈希，这些阶段必须经
 *   `suppressMessagePhases` 抑制 `message`（与 `AdminCreateUserUsecase.logCreateFailure()`
 *   对 `UPDATE_PASSWORD_HASH` 阶段的纵深防御口径一致）；
 * - 预期业务拒绝（`warnErrorCodes` 命中）：记 warn 并返回，属预期业务结果而非系统故障；
 * - 其余领域异常：记录错误码、阶段名与结构化 `cause.diagnostic`（如管理员链路的
 *   `accountId` + `reason`），`cause` 为 `Error` 实例时丢弃 `message`，只保留类型名
 *   与驱动错误码。
 *
 * @param phase 事务内阶段标记（各用例自己的联合类型成员或 `'TRANSACTION_BOUNDARY'`），
 *   只用于服务端日志定位，不出现在任何对外响应中
 * @param summary 动作摘要（如「管理员编辑用户资料」「账号设置更新」），用于拼接日志消息
 * @param accountId 可选目标账号 ID，注入各日志条目便于定位。管理员链路刻意不传
 *   （accountId 已在 `cause.diagnostic` 携带，避免双写）；自助链路传 Session 账号 ID。
 *   缺省时 Pino 丢弃 undefined 字段，既有管理员日志形状不变。
 * @param suppressMessagePhases 可选：命中这些阶段时抑制非领域异常的 `message` 字段
 *   （错误类型名与驱动错误码仍保留）。仅供写哈希等语句参数含密码派生物的阶段使用；
 *   缺省不抑制，既有 P0-4 / P0-5 调用者行为不变。
 * @param warnErrorCodes 可选：记 warn 的领域错误码清单（预期业务拒绝），缺省
 *   `ADMIN_USER_WRITE_WARN_ERROR_CODES`（管理员四码，既有调用方行为不变）；自助链路
 *   必须显式传入各自的 MY_ACCOUNT 业务码。
 */
export function logAdminUserWriteFailure(params: {
  readonly logger: PinoLogger;
  readonly phase: string;
  readonly error: unknown;
  readonly summary: string;
  readonly accountId?: number;
  readonly suppressMessagePhases?: ReadonlyArray<string>;
  readonly warnErrorCodes?: ReadonlyArray<string>;
}): void {
  const { logger, phase, error, summary, accountId, suppressMessagePhases, warnErrorCodes } =
    params;
  const suppressMessage = suppressMessagePhases?.includes(phase) ?? false;
  const warnCodes = warnErrorCodes ?? ADMIN_USER_WRITE_WARN_ERROR_CODES;

  if (!isDomainError(error)) {
    const errorName = error instanceof Error ? error.name : 'UNKNOWN';
    logger.error(
      {
        reason: 'UNEXPECTED',
        accountId,
        phase,
        errorName,
        driverCode: extractDriverErrorCode(error),
        message: suppressMessage ? undefined : errorMessage(error),
      },
      `${summary}失败（非领域异常，已收敛为 WRITE_FAILED 上抛）`,
    );
    return;
  }

  if (warnCodes.includes(error.code)) {
    logger.warn({ accountId, errorCode: error.code, phase }, `${summary}被拒绝，已按业务结果返回`);
    return;
  }

  const cause = error.cause;
  const diagnostic = cause instanceof Error || cause === undefined ? undefined : cause;
  logger.error(
    {
      accountId,
      errorCode: error.code,
      phase,
      diagnostic,
      causeErrorName: cause instanceof Error ? cause.name : undefined,
      driverCode: cause instanceof Error ? extractDriverErrorCode(cause) : undefined,
    },
    `${summary}失败`,
  );
}

/**
 * 管理员写用例的密码策略校验：复用全仓单一的 `PasswordPolicyService`，不另写强度规则。
 * 管理员创建普通用户（P0-3，初始密码）与管理员重置密码（P0-6，新密码）共用本实现，
 * 不各写一份；P3 起自助修改密码的新密码同样经本断言校验（错误码与文案口径必须与
 * 管理员链路保持一致，避免第二份策略断言），本函数不含任何管理员目标逻辑。
 *
 * 失败抛 `INPUT_NORMALIZE_ERROR.INVALID_TEXT`（未入过滤器映射表 → 默认 `BAD_USER_INPUT`），
 * **不使用** `CreateAccountUsecase` 的 `AUTH_ERROR.INVALID_PASSWORD`：后者映射为
 * `UNAUTHENTICATED`，会让「管理员填了弱密码」被前端误判为会话失效并清理 Session 跳转登录页
 *
 * 先行校验后，`AccountService.hashPasswordWithTimestamp()` 内部 `preprocessPassword()` 的
 * `AUTH_ERROR.INVALID_PASSWORD` 分支对管理员路径不可达：两处判定同源（空/纯空白、NFKC 后
 * 首尾空白），能被策略层放行的密码必然也能通过预处理。
 *
 * 错误文案拼接 `validation.errors`，与 `RegisterWithEmailUsecase` / `CreateAccountUsecase`
 * 同源：管理员必须知道该改什么才能完成操作，而密码策略本身已经由公开注册入口对外暴露，
 * 拼接原因不构成额外信息泄露。`errors` 不含密码原文、黑名单具体条目与强度评分
 *
 * 调用方约束（`admin-user-management.input.normalize.ts` 文件头）：调用前必须已经过
 * `normalizeAdminUserPasswordInput()` 的非空断言；本函数只裁决强度，不重复判定存在性。
 *
 * @param params.fieldName 仅用于拒绝提示的字段名（如「初始密码」「新密码」）
 */
export function assertAdminUserPasswordPolicy(params: {
  readonly passwordPolicyService: PasswordPolicyService;
  readonly password: string;
  readonly fieldName: string;
}): void {
  const validation = params.passwordPolicyService.validatePassword(params.password);
  if (!validation.isValid) {
    throw new DomainError(
      INPUT_NORMALIZE_ERROR.INVALID_TEXT,
      `${params.fieldName}不符合安全要求: ${validation.errors.join(', ')}`,
    );
  }
}
