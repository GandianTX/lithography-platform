// src/modules/lithography/engineer-registration.service.spec.ts

/// <reference types="jest" />
import { EngineerRegistrationApplicationStatus } from '@app-types/models/registration.types';
import { createTypeOrmPersistenceTransactionContext } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import type { EntityManager } from 'typeorm';
import { EngineerRegistrationService } from './engineer-registration.service';

const makeRepo = () => ({
  create: jest.fn((value: unknown) => value),
  save: jest.fn(),
  findOne: jest.fn(),
  update: jest.fn(),
});

const contextOf = (repo: ReturnType<typeof makeRepo>) =>
  createTypeOrmPersistenceTransactionContext({
    getRepository: () => repo,
  } as unknown as EntityManager);

const applicationRow = {
  id: 916001,
  accountId: 900301,
  organizationId: 910001,
  status: 'PENDING',
  applicationNote: '申请加入组织',
  submittedAt: new Date('2026-10-29T08:00:00.000Z'),
  reviewedByAccountId: null,
  reviewedAt: null,
  reviewComment: null,
  pendingAccountId: 900301,
  createdAt: new Date('2026-10-29T08:00:01.000Z'),
  updatedAt: new Date('2026-10-29T08:00:01.000Z'),
};

describe('EngineerRegistrationService', () => {
  it('新增申请固定落 PENDING 且审核字段为空，生成列不参与写入', async () => {
    const repo = makeRepo();
    repo.save.mockResolvedValue({ id: 916001 });
    const service = new EngineerRegistrationService(repo as never);

    const result = await service.insertApplication({
      accountId: 900301,
      organizationId: 910001,
      applicationNote: '申请加入组织',
      submittedAt: new Date('2026-10-29T08:00:00.000Z'),
    });

    expect(result).toEqual({ applicationId: 916001 });
    expect(repo.create).toHaveBeenCalledWith({
      accountId: 900301,
      organizationId: 910001,
      status: 'PENDING',
      applicationNote: '申请加入组织',
      submittedAt: new Date('2026-10-29T08:00:00.000Z'),
      reviewedByAccountId: null,
      reviewedAt: null,
      reviewComment: null,
    });
    // pending_account_id 是数据库生成列，写入对象不得携带推断值
    expect(repo.create.mock.calls[0][0]).not.toHaveProperty('pendingAccountId');
  });

  it('生成列唯一键冲突收敛为 PENDING_APPLICATION_EXISTS，不泄露索引与驱动细节', async () => {
    const repo = makeRepo();
    const rawError = Object.assign(
      new Error(
        "Duplicate entry '900301' for key 'engineer_registration_application.uk_engineer_registration_application_pending_account'",
      ),
      { code: 'ER_DUP_ENTRY', errno: 1062 },
    );
    repo.save.mockRejectedValue(rawError);
    const service = new EngineerRegistrationService(repo as never);

    await expect(
      service.insertApplication({
        accountId: 900301,
        organizationId: 910001,
        applicationNote: null,
        submittedAt: new Date('2026-10-29T08:00:00.000Z'),
      }),
    ).rejects.toMatchObject({
      code: 'ENGINEER_REGISTRATION_PENDING_APPLICATION_EXISTS',
      details: undefined,
    });
  });

  it('非唯一冲突的落库失败收敛为 WRITE_FAILED，原始异常只进 cause', async () => {
    const repo = makeRepo();
    const rawError = new Error('connection reset');
    repo.save.mockRejectedValue(rawError);
    const service = new EngineerRegistrationService(repo as never);

    await expect(
      service.insertApplication({
        accountId: 900301,
        organizationId: 910001,
        applicationNote: null,
        submittedAt: new Date('2026-10-29T08:00:00.000Z'),
      }),
    ).rejects.toMatchObject({ code: 'ENGINEER_REGISTRATION_WRITE_FAILED', cause: rawError });
  });

  it('重提流程锁定账号最新一份申请：按 id 倒序且使用 pessimistic_write', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(applicationRow);
    const service = new EngineerRegistrationService(repo as never);

    const snapshot = await service.lockLatestApplicationByAccountId(900301, contextOf(repo));

    expect(repo.findOne).toHaveBeenCalledWith({
      where: { accountId: 900301 },
      order: { id: 'DESC' },
      lock: { mode: 'pessimistic_write' },
    });
    expect(snapshot).toMatchObject({ id: 916001, status: 'PENDING' });
  });

  it('审批流程按主键锁定申请；不存在返回 null', async () => {
    const repo = makeRepo();
    repo.findOne.mockResolvedValue(null);
    const service = new EngineerRegistrationService(repo as never);

    expect(await service.lockApplicationById(916001, contextOf(repo))).toBeNull();
    expect(repo.findOne).toHaveBeenCalledWith({
      where: { id: 916001 },
      lock: { mode: 'pessimistic_write' },
    });
  });

  it('终态决策只从 PENDING 迁出：条件更新命中时 updated 为 true', async () => {
    const repo = makeRepo();
    repo.update.mockResolvedValue({ affected: 1 });
    const service = new EngineerRegistrationService(repo as never);

    const reviewedAt = new Date('2026-10-29T09:00:00.000Z');
    const result = await service.updateApplicationDecision(
      {
        applicationId: 916001,
        status: EngineerRegistrationApplicationStatus.APPROVED,
        reviewedByAccountId: 900101,
        reviewedAt,
        reviewComment: null,
      },
      contextOf(repo),
    );

    expect(result).toEqual({ updated: true });
    expect(repo.update).toHaveBeenCalledWith(
      { id: 916001, status: 'PENDING' },
      {
        status: 'APPROVED',
        reviewedByAccountId: 900101,
        reviewedAt,
        reviewComment: null,
      },
    );
  });

  it('并发第二次决策条件更新未命中：updated 为 false，不覆盖历史行', async () => {
    const repo = makeRepo();
    repo.update.mockResolvedValue({ affected: 0 });
    const service = new EngineerRegistrationService(repo as never);

    const result = await service.updateApplicationDecision(
      {
        applicationId: 916001,
        status: EngineerRegistrationApplicationStatus.REJECTED,
        reviewedByAccountId: 900101,
        reviewedAt: new Date('2026-10-29T09:00:00.000Z'),
        reviewComment: '资料不完整',
      },
      contextOf(repo),
    );

    expect(result).toEqual({ updated: false });
  });
});
