// src/modules/lithography/engineer-response.service.ts

import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import { DomainError, REPAIR_REQUEST_ERROR } from '@core/common/errors/domain-error';
import { Injectable } from '@nestjs/common';
import { getTypeOrmEntityManager } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { EngineerResponseEntity } from './entities/engineer-response.entity';
import { EngineerResponseInsertData, EngineerResponseWriteSnapshot } from './lithography.types';
import { RestoreScopeWriteGuardService } from './restore-scope-write-guard.service';

/**
 * 工程师回复写服务
 *
 * 职责范围：
 * - 仅负责向 engineer_response 追加一条回复记录，返回普通快照（非 ORM Entity）
 *
 * 不包含：
 * - 回复资格、归属派生、输入规范化、错误类别裁决等业务决策（归 usecase）
 * - 事务开启（事务边界由 usecase 通过 TransactionRunner 持有；
 *   本服务要求显式传入事务上下文，确保追加写入与目标申请锁定读取处在同一事务内）
 *
 * 所有读写均经事务上下文的 EntityManager 进行（本服务无事务外调用路径），
 * 因此不注入独立 Repository，避免不可用的死依赖
 */
@Injectable()
export class EngineerResponseService {
  constructor(private readonly restoreScopeWriteGuardService: RestoreScopeWriteGuardService) {}

  /**
   * 追加一条工程师回复（只插入，不更新、不覆盖历史回复）
   *
   * 数据库异常（含正文空白 CHECK）包装为 RESPONSE_FAILED：
   * 客户端可见 details 仅携带申请标识，不泄漏 SQL/表名/约束/正文；
   * 底层异常仅以 cause 保留，供服务端日志与排查使用
   * （全局 GraphQL Filter 会将 details 原样写入响应）。
   *
   * @param data 已完成业务裁决的写入数据（归属账号由 usecase 派生）
   * @param transactionContext 事务上下文（必须与目标申请锁定读取同事务）
   * @returns 写入完成后的回复快照
   */
  async insertResponse(
    data: EngineerResponseInsertData,
    transactionContext: PersistenceTransactionContext,
  ): Promise<EngineerResponseWriteSnapshot> {
    // 恢复期冻结守卫：`engineer_response` 已纳入受保护备份范围，
    // 恢复期间追加回复会污染恢复结果（回复属于工单数据区）。
    await this.restoreScopeWriteGuardService.assertRequestScopeWritable(data.requestId);
    const manager = getTypeOrmEntityManager(transactionContext);
    const repository = manager.getRepository(EngineerResponseEntity);
    try {
      const entity = repository.create({
        requestId: data.requestId,
        engineerAccountId: data.engineerAccountId,
        customerAccountId: data.customerAccountId,
        resolutionStatus: data.resolutionStatus,
        responseText: data.responseText,
      });
      const saved = await repository.save(entity);
      return {
        id: saved.id,
        requestId: saved.requestId,
        engineerAccountId: saved.engineerAccountId,
        resolutionStatus: saved.resolutionStatus,
        responseText: saved.responseText,
        createdAt: saved.createdAt,
      };
    } catch (error) {
      throw new DomainError(
        REPAIR_REQUEST_ERROR.RESPONSE_FAILED,
        '处理回复失败，请稍后重试',
        { requestId: data.requestId },
        error,
      );
    }
  }
}
