/// <reference types="jest" />
import { EngineerResolutionStatus } from '@app-types/models/repair-request.types';
import { DomainError, REPAIR_REQUEST_ERROR } from '@src/core/common/errors/domain-error';
import { createTypeOrmPersistenceTransactionContext } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { EntityManager, QueryFailedError } from 'typeorm';
import { EngineerResponseInsertData } from './lithography.types';
import { EngineerResponseService } from './engineer-response.service';

/** 恢复期写入冻结守卫替身：本 spec 只验证本服务行为，冻结判定另由守卫自身规格覆盖 */
const restoreScopeWriteGuardStub = {
  assertRequestScopeWritable: jest.fn().mockResolvedValue(undefined),
  assertIntakeScopeWritable: jest.fn().mockResolvedValue(undefined),
  assertConversationScopeWritable: jest.fn().mockResolvedValue(undefined),
  assertAnalysisScopeWritable: jest.fn().mockResolvedValue(undefined),
  assertDocumentScopeWritable: jest.fn().mockResolvedValue(undefined),
  assertOrganizationScopeWritable: jest.fn().mockResolvedValue(undefined),
};

describe('EngineerResponseService', () => {
  const createdAt = new Date('2026-09-03T10:00:00.000Z');
  const insertData: EngineerResponseInsertData = {
    requestId: 21,
    engineerAccountId: 5,
    customerAccountId: 7,
    resolutionStatus: EngineerResolutionStatus.PENDING,
    responseText: '已初步处理，等待备件',
  };

  let repository: ReturnType<typeof createMockRepository>;
  let service: EngineerResponseService;

  beforeEach(() => {
    repository = createMockRepository();
    repository.create.mockImplementation((data: Record<string, unknown>) => data);
    repository.save.mockImplementation((entity: Record<string, unknown>) => ({
      ...entity,
      id: 301,
      createdAt,
    }));
    // 本服务无独立 Repository 依赖：所有写入均经事务上下文的 EntityManager
    service = new EngineerResponseService(restoreScopeWriteGuardStub as never);
  });

  const contextOf = (repo: ReturnType<typeof createMockRepository>) =>
    createTypeOrmPersistenceTransactionContext({
      getRepository: () => repo,
    } as unknown as EntityManager);

  it('insertResponse 落库字段与传入写入数据一致，返回普通写入快照（不泄漏 ORM Entity）', async () => {
    const snapshot = await service.insertResponse(insertData, contextOf(repository));

    expect(repository.create.mock.calls[0][0]).toEqual({
      requestId: insertData.requestId,
      engineerAccountId: insertData.engineerAccountId,
      customerAccountId: insertData.customerAccountId,
      resolutionStatus: insertData.resolutionStatus,
      responseText: insertData.responseText,
    });
    // 不写入 history/状态类额外字段：回复是纯追加记录
    expect(repository.create.mock.calls[0][0]).not.toHaveProperty('isAccepted');
    expect(repository.create.mock.calls[0][0]).not.toHaveProperty('deprecated');

    expect(snapshot).toEqual({
      id: 301,
      requestId: insertData.requestId,
      engineerAccountId: insertData.engineerAccountId,
      resolutionStatus: insertData.resolutionStatus,
      responseText: insertData.responseText,
      createdAt,
    });
    expect(Object.keys(snapshot).sort()).toEqual([
      'createdAt',
      'engineerAccountId',
      'id',
      'requestId',
      'resolutionStatus',
      'responseText',
    ]);
  });

  it('createdAt 来自真实保存结果，不是 null/undefined', async () => {
    const snapshot = await service.insertResponse(insertData, contextOf(repository));

    expect(snapshot.createdAt).toBe(createdAt);
    expect(snapshot.createdAt).not.toBeNull();
    expect(snapshot.createdAt).not.toBeUndefined();
  });

  it('只经事务上下文的 Repository 落库（本服务无事务外调用路径）', async () => {
    const txRepository = createMockRepository();
    txRepository.create.mockImplementation((data: Record<string, unknown>) => data);
    txRepository.save.mockImplementation((entity: Record<string, unknown>) => ({
      ...entity,
      id: 302,
      createdAt,
    }));

    const snapshot = await service.insertResponse(insertData, contextOf(txRepository));

    expect(txRepository.create).toHaveBeenCalledTimes(1);
    expect(txRepository.save).toHaveBeenCalledTimes(1);
    expect(snapshot.id).toBe(302);
  });

  it('数据库写入失败包装为 RESPONSE_FAILED，details 只含申请标识', async () => {
    // 构造含敏感信息的驱动错误：真实 MySQL 错误可能携带表名、约束名与输入内容
    const sensitiveMessage =
      "Data too long for column 'response_text' at row 1 (constraint 'chk_engineer_response_text')";
    const driverError = new Error(sensitiveMessage) as Error & { code: string };
    driverError.code = 'ER_CHECK_CONSTRAINT_VIOLATED';
    const queryFailedError = new QueryFailedError('INSERT', [], driverError);
    repository.save.mockRejectedValue(queryFailedError);

    let caught: unknown;
    try {
      await service.insertResponse(insertData, contextOf(repository));
    } catch (error) {
      caught = error;
    }

    const domainError = caught as DomainError;
    expect(domainError).toBeInstanceOf(DomainError);
    expect(domainError.code).toBe(REPAIR_REQUEST_ERROR.RESPONSE_FAILED);
    // details 会被全局 GraphQL Filter 原样写入响应：不得包含驱动错误文本、
    // 表名、约束名或回复正文；底层异常保留为 cause 供服务端日志使用
    const serializedDetails = JSON.stringify(domainError.details ?? null);
    expect(serializedDetails).not.toContain('ER_CHECK_CONSTRAINT_VIOLATED');
    expect(serializedDetails).not.toContain('engineer_response');
    expect(serializedDetails).not.toContain('chk_engineer_response_text');
    expect(serializedDetails).not.toContain(insertData.responseText);
    expect(domainError.details).toEqual({ requestId: insertData.requestId });
    expect(domainError.cause).toBe(queryFailedError);
  });

  it('非 QueryFailedError 的异常同样包装为 RESPONSE_FAILED，且不向客户端泄漏异常消息', async () => {
    const dbError = new Error('connection lost');
    repository.save.mockRejectedValue(dbError);

    let caught: unknown;
    try {
      await service.insertResponse(insertData, contextOf(repository));
    } catch (error) {
      caught = error;
    }

    const domainError = caught as DomainError;
    expect(domainError).toBeInstanceOf(DomainError);
    expect(domainError.code).toBe(REPAIR_REQUEST_ERROR.RESPONSE_FAILED);
    expect(JSON.stringify(domainError.details ?? null)).not.toContain('connection lost');
    expect(domainError.cause).toBe(dbError);
  });
});
