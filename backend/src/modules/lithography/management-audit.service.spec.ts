// src/modules/lithography/management-audit.service.spec.ts

import { MANAGEMENT_AUDIT_ERROR } from '@core/common/errors/domain-error';
import {
  projectManagementAuditDetail,
  serializeManagementAuditDetail,
  type ManagementAuditDetailView,
} from '@core/management-audit/policy/management-audit-detail.policy';
import {
  ManagementAuditBusinessOperation,
  ManagementAuditResult,
} from '@app-types/models/management-audit.types';
import { LOCAL_RESTORE_AUDIT_STAGES } from '@core/local-runtime/policy/local-restore-audit.policy';
import { createTypeOrmPersistenceTransactionContext } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import type { PersistenceTransactionContext } from '@app-types/common/transaction.types';
import type { EntityManager } from 'typeorm';
import type { PinoLogger } from 'nestjs-pino';
import { MANAGEMENT_AUDIT_QUERY_OPERATIONS } from './management-audit.types';
import {
  ManagementAuditService,
  type ManagementAuditBusinessOperationParams,
} from './management-audit.service';

type InsertedRow = {
  eventId: string;
  actorAccountId: number;
  actorAdminLevel: number;
  organizationId: number | null;
  operation: string;
  targetType: string;
  targetId: string;
  result: string;
  detail: string | null;
};

/**
 * 三类业务事实写入服务单测（任务 10 S2.3：本任务自产事实）。
 *
 * 覆盖：三类 operation 与三值 result 的契约、凭据类不得走本方法、目标与公司字段边界、
 * detail 与读侧共用白名单（写入即可读回）、日志不含 detail。
 */
describe('ManagementAuditService.appendBusinessOperation', () => {
  const createHarness = () => {
    const repository = { insert: jest.fn().mockResolvedValue(undefined) };
    const manager = { getRepository: jest.fn(() => repository) };
    const transactionContext = createTypeOrmPersistenceTransactionContext(
      manager as unknown as EntityManager,
    );
    const logger = { setContext: jest.fn(), info: jest.fn() };
    const service = new ManagementAuditService(logger as unknown as PinoLogger);
    return { service, repository, logger, transactionContext };
  };

  const baseParams = (
    transactionContext: ManagementAuditBusinessOperationParams['transactionContext'],
    overrides: Partial<ManagementAuditBusinessOperationParams> = {},
  ): ManagementAuditBusinessOperationParams => ({
    actorAccountId: 1,
    actorAdminLevel: 1,
    organizationId: 2,
    operation: ManagementAuditBusinessOperation.ADMIN_DELETE_DOCUMENT,
    targetType: 'REFERENCE_DOCUMENT',
    targetId: 'doc-1001',
    result: ManagementAuditResult.SUCCEEDED,
    transactionContext,
    ...overrides,
  });

  const insertedRow = (repository: { insert: jest.Mock }): InsertedRow =>
    repository.insert.mock.calls[0][0] as InsertedRow;

  it('写入三类事实的基本行，未提供 detail 时落 null', async () => {
    const { service, repository, transactionContext } = createHarness();

    await service.appendBusinessOperation(baseParams(transactionContext));

    const row = insertedRow(repository);
    expect(row).toMatchObject({
      actorAccountId: 1,
      actorAdminLevel: 1,
      organizationId: 2,
      operation: ManagementAuditBusinessOperation.ADMIN_DELETE_DOCUMENT,
      targetType: 'REFERENCE_DOCUMENT',
      targetId: 'doc-1001',
      result: ManagementAuditResult.SUCCEEDED,
      detail: null,
    });
    expect(row.eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('结果可为 FAILED／DENIED（真实失败与业务拒绝都要能记账）', async () => {
    const { service, repository, transactionContext } = createHarness();

    await service.appendBusinessOperation(
      baseParams(transactionContext, {
        result: ManagementAuditResult.FAILED,
        operation: ManagementAuditBusinessOperation.RESTORE_LOCAL_BUSINESS,
      }),
    );
    await service.appendBusinessOperation(
      baseParams(transactionContext, {
        result: ManagementAuditResult.DENIED,
        operation: ManagementAuditBusinessOperation.CORRECT_DOCUMENT_OWNERSHIP,
      }),
    );

    expect(repository.insert.mock.calls[0][0].result).toBe('FAILED');
    expect(repository.insert.mock.calls[1][0].result).toBe('DENIED');
  });

  it('公司为空时写入 NULL（仅一级管理员可见的归属不明事实）', async () => {
    const { service, repository, transactionContext } = createHarness();

    await service.appendBusinessOperation(baseParams(transactionContext, { organizationId: null }));

    expect(insertedRow(repository).organizationId).toBeNull();
  });

  it('目标 ID 前后空白被去掉，稳定标识原样保留', async () => {
    const { service, repository, transactionContext } = createHarness();

    await service.appendBusinessOperation(
      baseParams(transactionContext, { targetId: '  restore-0001  ' }),
    );

    expect(insertedRow(repository).targetId).toBe('restore-0001');
  });

  it('detail 与读侧共用白名单：写入即可原样读回，未知键被丢弃', async () => {
    const { service, repository, transactionContext } = createHarness();

    // 运行时混入未知键：模拟提供方绕过 TypeScript 直接传普通对象的情况
    const detailWithUnknownKey = {
      reason: '归属更正',
      stage: 'APPLY',
      changedFields: ['ownerOrganizationId'],
      attemptNo: 2,
      beforeOrganizationName: '开发联调公司 A',
      afterOrganizationName: '开发联调公司 B',
      contentMd: '# 正文',
    } as unknown as ManagementAuditDetailView;

    await service.appendBusinessOperation(
      baseParams(transactionContext, { detail: detailWithUnknownKey }),
    );

    const detail = insertedRow(repository).detail;
    expect(detail).not.toBeNull();
    expect(JSON.parse(detail as string)).toEqual({
      reason: '归属更正',
      stage: 'APPLY',
      changedFields: ['ownerOrganizationId'],
      attemptNo: 2,
      beforeOrganizationName: '开发联调公司 A',
      afterOrganizationName: '开发联调公司 B',
    });
    expect(projectManagementAuditDetail(detail)).toEqual({
      reason: '归属更正',
      stage: 'APPLY',
      changedFields: ['ownerOrganizationId'],
      attemptNo: 2,
      beforeOrganizationName: '开发联调公司 A',
      afterOrganizationName: '开发联调公司 B',
    });
  });

  it('全部 detail 字段非法时不写空 JSON', async () => {
    const { service, repository, transactionContext } = createHarness();

    await service.appendBusinessOperation(
      baseParams(transactionContext, { detail: { reason: '   ', stage: '预检通过' } }),
    );

    expect(insertedRow(repository).detail).toBeNull();
  });

  it.each([
    ['凭据类 operation', { operation: 'REISSUE_LEVEL2_CREDENTIAL' }],
    ['等级 3', { actorAdminLevel: 3 }],
    ['等级 0', { actorAdminLevel: 0 }],
    ['账号 ID 非正整数', { actorAccountId: 0 }],
    ['公司 ID 非正整数', { organizationId: -1 }],
    ['目标类型小写', { targetType: 'reference_document' }],
    ['目标类型为空', { targetType: '' }],
    ['目标 ID 为空串', { targetId: '   ' }],
    ['目标 ID 含控制字符', { targetId: 'doc\u0000-1' }],
    ['目标 ID 超长', { targetId: 'd'.repeat(65) }],
    ['结果值非法', { result: 'UNKNOWN' }],
  ])('契约违例被拦下：%s', async (_label, override) => {
    const { service, repository, transactionContext } = createHarness();

    await expect(
      service.appendBusinessOperation(
        baseParams(transactionContext, override as Partial<ManagementAuditBusinessOperationParams>),
      ),
    ).rejects.toMatchObject({ code: MANAGEMENT_AUDIT_ERROR.INVALID_WRITE_PARAMS });

    expect(repository.insert).not.toHaveBeenCalled();
  });

  it('审计插入失败时直接抛错，不吞异常（由调用方事务整体回滚，不返回成功）', async () => {
    const { service, repository, transactionContext } = createHarness();
    repository.insert.mockRejectedValueOnce(new Error('audit insert failed'));

    await expect(service.appendBusinessOperation(baseParams(transactionContext))).rejects.toThrow(
      'audit insert failed',
    );
    expect(repository.insert).toHaveBeenCalledTimes(1);
  });

  it('写入日志不携带 detail 原文', async () => {
    const { service, logger, transactionContext } = createHarness();

    await service.appendBusinessOperation(
      baseParams(transactionContext, { detail: { reason: '保护副本校验失败' } }),
    );

    const logPayload = JSON.stringify(logger.info.mock.calls[0][0]);
    expect(logPayload).not.toContain('保护副本校验失败');
    expect(logPayload).toContain('REFERENCE_DOCUMENT');
  });

  it('写入可接受的三类 operation 与读侧白名单完全一致（防漂移）', () => {
    expect([...MANAGEMENT_AUDIT_QUERY_OPERATIONS]).toEqual([
      'ADMIN_DELETE_DOCUMENT',
      'CORRECT_DOCUMENT_OWNERSHIP',
      'RESTORE_LOCAL_BUSINESS',
    ]);
    for (const operation of MANAGEMENT_AUDIT_QUERY_OPERATIONS) {
      expect(serializeManagementAuditDetail({ reason: operation })).not.toBeNull();
    }
  });
});

const build = () => {
  const insert = jest.fn();
  const manager = {
    getRepository: () => ({ insert }),
  };
  const transactionContext = createTypeOrmPersistenceTransactionContext(manager as never);
  const logger = { setContext: jest.fn(), info: jest.fn(), error: jest.fn() };
  const service = new ManagementAuditService(logger as unknown as PinoLogger);

  return { service, insert, logger, transactionContext };
};

describe('管理审计写入服务', () => {
  it('写入成功事实：结果固定 SUCCEEDED、目标为账号，detail 为空时写 null', async () => {
    const { service, insert, transactionContext } = build();

    await service.append({
      actorAccountId: 900101,
      actorAdminLevel: 1,
      organizationId: 4,
      targetAccountId: 900202,
      operation: 'RESET_LEVEL2_CREDENTIAL',
      transactionContext,
    });

    expect(insert).toHaveBeenCalledTimes(1);
    const row = insert.mock.calls[0][0] as Record<string, unknown>;

    expect(row).toMatchObject({
      actorAccountId: 900101,
      actorAdminLevel: 1,
      organizationId: 4,
      targetType: 'ACCOUNT',
      targetId: '900202',
      result: 'SUCCEEDED',
      detail: null,
    });
    expect(typeof row.eventId).toBe('string');
    expect(String(row.eventId).length).toBeGreaterThan(0);
  });

  it('detail 只承载脱敏摘要字段，不写入其他内容', async () => {
    const { service, insert, transactionContext } = build();

    await service.append({
      actorAccountId: 900101,
      actorAdminLevel: 2,
      organizationId: 4,
      targetAccountId: 900202,
      operation: 'RESET_LEVEL2_CREDENTIAL',
      transactionContext,
      reason: '用户申请重置',
      loginNameMasked: 'zh***@example.com',
    });

    const row = insert.mock.calls[0][0] as Record<string, unknown>;
    const detail = JSON.parse(String(row.detail)) as Record<string, unknown>;

    expect(Object.keys(detail).sort()).toEqual(['loginNameMasked', 'reason']);
    expect(detail.reason).toBe('用户申请重置');
    expect(detail.loginNameMasked).toBe('zh***@example.com');
  });

  it('插入失败直接抛错：审计失败不得被吞掉', async () => {
    const { service, insert, transactionContext } = build();

    insert.mockRejectedValueOnce(new Error('audit insert failed'));

    await expect(
      service.append({
        actorAccountId: 900101,
        actorAdminLevel: 1,
        organizationId: 4,
        targetAccountId: 900202,
        operation: 'REISSUE_LEVEL2_CREDENTIAL',
        transactionContext,
      }),
    ).rejects.toThrow('audit insert failed');
  });

  it('日志只记操作类型与主键，不记 detail', async () => {
    const { service, logger, transactionContext } = build();

    await service.append({
      actorAccountId: 900101,
      actorAdminLevel: 1,
      organizationId: 4,
      targetAccountId: 900202,
      operation: 'RESET_LEVEL2_CREDENTIAL',
      transactionContext,
      reason: '用户申请重置',
      loginNameMasked: 'zh***@example.com',
    });

    expect(logger.info).toHaveBeenCalledTimes(1);
    const [payload] = logger.info.mock.calls[0] as [Record<string, unknown>];

    expect(Object.keys(payload).sort()).toEqual(['operation', 'organizationId', 'targetAccountId']);
    expect(JSON.stringify(payload)).not.toContain('用户申请重置');
  });
});

describe('ManagementAuditService.appendRestoreEvent（任务 09 新计划第 06 项）', () => {
  const createHarness = () => {
    const repository = {
      insert: jest.fn().mockResolvedValue(undefined),
      findOne: jest.fn().mockResolvedValue(null),
    };
    const manager = { getRepository: jest.fn(() => repository) };
    const transactionContext = createTypeOrmPersistenceTransactionContext(
      manager as unknown as EntityManager,
    );
    const logger = { setContext: jest.fn(), info: jest.fn() };
    const service = new ManagementAuditService(logger as unknown as PinoLogger);
    return { service, repository, logger, transactionContext };
  };

  const baseParams = (
    transactionContext: PersistenceTransactionContext,
    overrides: Record<string, unknown> = {},
  ) =>
    ({
      actorAccountId: 7,
      actorAdminLevel: 1,
      organizationId: 4,
      operation: 'RESTORE_LOCAL_BUSINESS' as const,
      restoreId: 'restore-uuid-1',
      backupId: 'backup-uuid-1',
      protectionBackupId: 'protection-uuid-1',
      result: 'SUCCEEDED' as const,
      stage: LOCAL_RESTORE_AUDIT_STAGES.EXECUTION_SUCCEEDED,
      transactionContext,
      ...overrides,
    }) as Parameters<ManagementAuditService['appendRestoreEvent']>[0];

  it('detail 按任务 10 白名单写入：reason ＋ stage 可被读侧原样读回', async () => {
    const { service, repository, transactionContext } = createHarness();

    await service.appendRestoreEvent(
      baseParams(transactionContext, {
        result: 'FAILED',
        stage: LOCAL_RESTORE_AUDIT_STAGES.EXECUTION_ROLLBACK_FAILED,
        reasonCode: 'RESTORE_EXECUTION_FAILED',
      }),
    );

    const row = repository.insert.mock.calls[0][0] as { detail: string | null };
    // 读侧（任务 10）按同一套白名单投影 ⇒ 写得进去就必然读得出来
    const projected = projectManagementAuditDetail(row.detail);
    expect(projected).toEqual({
      reason: 'RESTORE_EXECUTION_FAILED',
      stage: 'RESTORE_ROLLBACK_FAILED',
    });
  });

  it('恢复 ID／公司／操作者／终态走事件列，不塞进 detail', async () => {
    const { service, repository, transactionContext } = createHarness();

    await service.appendRestoreEvent(baseParams(transactionContext));

    const row = repository.insert.mock.calls[0][0] as Record<string, unknown>;
    expect(row).toMatchObject({
      actorAccountId: 7,
      actorAdminLevel: 1,
      organizationId: 4,
      operation: 'RESTORE_LOCAL_BUSINESS',
      targetType: 'LOCAL_RESTORE',
      targetId: 'restore-uuid-1',
      result: 'SUCCEEDED',
    });
    const projected = projectManagementAuditDetail(row['detail'] as string | null);
    expect(projected?.reason).toBeUndefined();
  });

  it('幂等：同一 (恢复 ID, 终态**阶段**) 重试执行不再重复写入', async () => {
    const { service, repository, transactionContext } = createHarness();
    // 既有事件按**真实形态**给：detail 里带可读出的阶段（同一次执行的重复）
    repository.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({
      eventId: 'existing',
      detail: JSON.stringify({ stage: LOCAL_RESTORE_AUDIT_STAGES.EXECUTION_SUCCEEDED }),
    });

    await service.appendRestoreEvent(baseParams(transactionContext));
    await service.appendRestoreEvent(baseParams(transactionContext));

    expect(repository.insert).toHaveBeenCalledTimes(1);
  });

  it('同一恢复 ID 的失败终态**升级为更严重阶段**时必须留痕（不被幂等吞掉）', async () => {
    const { service, repository, transactionContext } = createHarness();
    // 既有事件：同一恢复 ID、同一失败结果，但阶段是"已回滚"
    repository.findOne.mockResolvedValue({
      eventId: 'existing',
      detail: JSON.stringify({ stage: LOCAL_RESTORE_AUDIT_STAGES.EXECUTION_ROLLED_BACK }),
    });

    await service.appendRestoreEvent(
      baseParams(transactionContext, {
        result: 'FAILED',
        stage: LOCAL_RESTORE_AUDIT_STAGES.EXECUTION_ROLLBACK_FAILED,
        reasonCode: 'RESTORE_EXECUTION_FAILED',
      }),
    );

    // 阶段不同 ⇒ 是另一个终态事实（回滚也失败）⇒ 必须写下
    expect(repository.insert).toHaveBeenCalledTimes(1);
    const row = repository.insert.mock.calls[0][0] as { detail: string | null };
    expect(projectManagementAuditDetail(row.detail)?.stage).toBe('RESTORE_ROLLBACK_FAILED');
  });

  it('既有事件的阶段读不出来（历史自由文本）⇒ 不吞掉新事件', async () => {
    const { service, repository, transactionContext } = createHarness();
    repository.findOne.mockResolvedValue({
      eventId: 'legacy',
      detail: JSON.stringify({ restore_id: 'restore-uuid-1', counts: { records: 3 } }),
    });

    await service.appendRestoreEvent(baseParams(transactionContext));

    // 读不出阶段 ⇒ 无法判定是同一事实 ⇒ 写新的（宁可多留，不可漏掉终态）
    expect(repository.insert).toHaveBeenCalledTimes(1);
  });

  it('同一恢复 ID 的不同终态各留一条（成功与失败是不同事实）', async () => {
    const { service, repository, transactionContext } = createHarness();
    repository.findOne.mockResolvedValue(null);

    await service.appendRestoreEvent(baseParams(transactionContext));
    await service.appendRestoreEvent(
      baseParams(transactionContext, { result: 'FAILED', reasonCode: 'X' }),
    );

    expect(repository.insert).toHaveBeenCalledTimes(2);
  });
});
