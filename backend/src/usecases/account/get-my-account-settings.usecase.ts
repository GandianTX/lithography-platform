// src/usecases/account/get-my-account-settings.usecase.ts

import { ADMIN_USER_ERROR, DomainError, isDomainError } from '@core/common/errors/domain-error';
import { Injectable } from '@nestjs/common';
import type { MyAccountSettingsSnapshot } from '@src/modules/account/account.types';
import { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import { OrganizationQueryService } from '@src/modules/lithography/queries/organization.query.service';
import { PinoLogger } from 'nestjs-pino';
import {
  resolveTrustedOrganizationId,
  toMyAccountSettingsView,
} from './my-account-settings.support';
import { normalizeMyAccountSettingsAccountId } from './my-account-settings.input.normalize';
import type {
  GetMyAccountSettingsCommand,
  GetMyAccountSettingsOutcome,
} from './my-account-settings.types';

/**
 * 当前用户账号设置**只读**用例（P1）。
 *
 * 执行顺序刻意固定：
 * 1. 场景 normalize：对 Session 携带的可信 `accountId` 做防御性前置校验，畸形即失败关闭，
 *    不进入数据库读取；
 * 2. 调用 `AccountQueryService.findMyAccountSettingsSnapshot()` 窄读取（三源角色收敛、双字段
 *    状态一致性判定与资料缺失失败关闭都在 QueryService 单一映射点完成，本用例不重复实现）；
 * 3. 账号行缺失（`null`）失败关闭：读链路上「Session 引用的账号在库中不存在」属数据不变量被
 *    破坏，映射 `INTERNAL_SERVER_ERROR`，**不得塌缩为 `UNAUTHENTICATED`**（错误契约：not-found
 *    不得塌缩为未认证）；
 * 4. 从内部快照剥离 `accountId`，映射为公开稳定 View 返回。
 *
 * 依赖方向（`usecase.rules.md`）：只依赖 `AccountQueryService`，**不访问 Repository、不接触 ORM、
 * 不开启事务、不持有 Entity**（读链路没有事务边界）。目标账号只来自 Session，本用例不提供任何
 * 读取他人设置的路径。
 *
 * 三源不收敛 / 资料缺失 / 双状态不一致由 QueryService 抛 `ADMIN_USER_ERROR.ROLE_DATA_INCONSISTENT`
 * 或 `READ_FAILED`（均映射 `INTERNAL_SERVER_ERROR`），本用例原样上抛——不选任一源字段兜底、
 * 不静默修复。诊断信息（账号主键 + 失败原因分类）取自 `DomainError.cause`，`cause` 不会被全局
 * 过滤器序列化进 `extensions`，因此 accountId 与内部原因不外泄给前端。
 */
@Injectable()
export class GetMyAccountSettingsUsecase {
  constructor(
    private readonly accountQueryService: AccountQueryService,
    private readonly organizationQueryService: OrganizationQueryService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(GetMyAccountSettingsUsecase.name);
  }

  async execute(command: GetMyAccountSettingsCommand): Promise<GetMyAccountSettingsOutcome> {
    const accountId = normalizeMyAccountSettingsAccountId(command.session);

    let snapshot: MyAccountSettingsSnapshot | null;
    try {
      snapshot = await this.accountQueryService.findMyAccountSettingsSnapshot({ accountId });
    } catch (error) {
      this.logReadFailure(error, accountId);
      throw error;
    }

    if (!snapshot) {
      // 账号行缺失：Session 引用的账号在库中不存在，属数据不变量被破坏，失败关闭为
      // INTERNAL_SERVER_ERROR。details 留空，accountId 只进 cause 供服务端排查。
      const error = new DomainError(
        ADMIN_USER_ERROR.READ_FAILED,
        '账号设置读取失败，请稍后重试',
        undefined,
        { diagnostic: 'ACCOUNT_ROW_MISSING', accountId },
      );
      this.logReadFailure(error, accountId);
      throw error;
    }

    return this.buildView(snapshot, command);
  }

  /**
   * 按快照角色解析可信组织 ID 并读取组织名称作为可信公司名称。
   *
   * 口径：组织 ID 为 `null`（该角色无唯一有效组织归属）或组织名称读取为 `null`（组织行缺失）
   * 时统一返回 `null`，**不得回退 `companyName`**——二者来源不同，回退会把用户自填的公司名
   * 伪造成可信组织事实。逐字段显式赋值由 `toMyAccountSettingsView()` 单一实现承担。
   */
  private async buildView(
    snapshot: MyAccountSettingsSnapshot,
    command: GetMyAccountSettingsCommand,
  ): Promise<GetMyAccountSettingsOutcome> {
    const organizationId = resolveTrustedOrganizationId(
      snapshot.role,
      command.trustedOrganizations,
    );
    const trustedCompanyName =
      organizationId === null
        ? null
        : await this.organizationQueryService.findOrganizationNameById({ organizationId });
    return toMyAccountSettingsView(snapshot, trustedCompanyName);
  }

  /**
   * 只记录错误大类与最小定位信息（accountId 取自 Session，非敏感）；不记录三源角色原值、
   * `access_group` / `meta_digest` 内容、密码或 Token，也不把原始数据库异常对象整体打进日志
   * （其 `message` 可能带 SQL 文本）。`cause` 为 `Error` 实例时只保留类型名。
   *
   * 非领域异常分支是纵深防御：`findMyAccountSettingsSnapshot()` 当前会把所有非领域异常收敛为
   * `READ_FAILED`，活路径预期不会进入该分支；保留它与 admin 写用例的既有防御先例一致。
   */
  private logReadFailure(error: unknown, accountId: number): void {
    if (!isDomainError(error)) {
      this.logger.error(
        { accountId, reason: 'UNEXPECTED' },
        '账号设置读取失败（非领域异常，已按 INTERNAL_SERVER_ERROR 上抛）',
      );
      return;
    }

    const cause = error.cause;
    const diagnostic = cause instanceof Error || cause === undefined ? undefined : cause;
    this.logger.error(
      {
        accountId,
        errorCode: error.code,
        diagnostic,
        causeErrorName: cause instanceof Error ? cause.name : undefined,
      },
      '账号设置读取失败',
    );
  }
}
