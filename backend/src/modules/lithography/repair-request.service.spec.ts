/// <reference types="jest" />
import { DomainError, REPAIR_REQUEST_ERROR } from '@src/core/common/errors/domain-error';
import {
  RepairRequestHandlingResult,
  RepairRequestHandlingStatus,
} from '@app-types/models/repair-request.types';
import { createTypeOrmPersistenceTransactionContext } from '@src/infrastructure/database/transaction/typeorm-persistence-transaction-context';
import { EntityManager, QueryFailedError, Repository } from 'typeorm';
import { RepairRequestEntity } from './entities/repair-request.entity';
import { RepairRequestAcceptData, RepairRequestInsertData } from './lithography.types';
import { RepairRequestService } from './repair-request.service';

describe('RepairRequestService', () => {
  const createdAt = new Date('2026-08-26T10:00:00.000Z');
  const insertData: RepairRequestInsertData = {
    requestNo: 'RR20260826100000ABC123',
    customerAccountId: 7,
    equipmentModelId: 3,
    errorCode: 'E-100',
    faultDescription: '设备无法启动',
    contentMd: '# 设备维修申请',
  };

  let repository: ReturnType<typeof createMockRepository>;
  let service: RepairRequestService;

  beforeEach(() => {
    repository = createMockRepository();
    repository.create.mockImplementation((data: Record<string, unknown>) => data);
    repository.save.mockImplementation((entity: Record<string, unknown>) => ({
      ...entity,
      id: 11,
      createdAt,
    }));
    service = new RepairRequestService(repository as unknown as Repository<RepairRequestEntity>);
  });

  it('insertRequest 显式落初始状态并返回稳定快照', async () => {
    const snapshot = await service.insertRequest(insertData);

    const created = repository.create.mock.calls[0][0] as Record<string, unknown>;
    expect(created.isAccepted).toBe(false);
    expect(created.deprecated).toBe(false);
    expect(created.acceptedByEngineerAccountId).toBeUndefined();
    expect(created.acceptedAt).toBeUndefined();
    expect(created.deletedAt).toBeUndefined();

    expect(snapshot).toEqual({
      id: 11,
      requestNo: insertData.requestNo,
      customerAccountId: 7,
      equipmentModelId: 3,
      errorCode: 'E-100',
      faultDescription: '设备无法启动',
      createdAt,
      isAccepted: false,
      deprecated: false,
      // 旧调用方不传原稿/组织列时保持存量可空语义
      intakeId: null,
      customerOrganizationId: null,
      serviceOrganizationId: null,
    });
  });

  it('任务 03 提交即出单：原稿与两个组织列随工单一起落库', async () => {
    const snapshot = await service.insertRequest({
      ...insertData,
      intakeId: 21,
      customerOrganizationId: 77,
      serviceOrganizationId: 88,
    });

    const created = repository.create.mock.calls[0][0] as Record<string, unknown>;
    expect(created.intakeId).toBe(21);
    expect(created.customerOrganizationId).toBe(77);
    expect(created.serviceOrganizationId).toBe(88);
    expect(snapshot.intakeId).toBe(21);
    expect(snapshot.customerOrganizationId).toBe(77);
    expect(snapshot.serviceOrganizationId).toBe(88);
  });

  it('唯一索引冲突（ER_DUP_ENTRY）抛出可区分的编号冲突错误', async () => {
    const driverError = new Error('dup entry') as Error & { code: string };
    driverError.code = 'ER_DUP_ENTRY';
    repository.save.mockRejectedValue(new QueryFailedError('INSERT', [], driverError));

    await expect(service.insertRequest(insertData)).rejects.toMatchObject({
      code: REPAIR_REQUEST_ERROR.REQUEST_NO_CONFLICT,
    });
  });

  it('driverError 缺失时回退读取错误对象本身识别唯一约束冲突（errno 1062）', async () => {
    const driverError = new Error('dup') as Error & { errno: number };
    driverError.errno = 1062;
    const failedError = new QueryFailedError('INSERT', [], driverError);
    delete (failedError as unknown as { driverError?: unknown }).driverError;
    repository.save.mockRejectedValue(failedError);

    await expect(service.insertRequest(insertData)).rejects.toMatchObject({
      code: REPAIR_REQUEST_ERROR.REQUEST_NO_CONFLICT,
    });
  });

  it('非唯一约束冲突的落库失败包装为创建失败，且不向客户端泄漏原始数据库错误', async () => {
    // 构造含敏感信息的驱动错误：真实 MySQL 错误可能携带表名、约束名与输入内容
    const sensitiveMessage =
      "Cannot add or update a child row: foreign key constraint fails on 'repair_request'";
    const driverError = new Error(sensitiveMessage) as Error & { code: string };
    driverError.code = 'ER_NO_REFERENCED_ROW_2';
    const queryFailedError = new QueryFailedError('INSERT', [], driverError);
    repository.save.mockRejectedValue(queryFailedError);

    let caught: unknown;
    try {
      await service.insertRequest(insertData);
    } catch (error) {
      caught = error;
    }

    const domainError = caught as DomainError;
    expect(domainError).toBeInstanceOf(DomainError);
    expect(domainError.code).toBe(REPAIR_REQUEST_ERROR.CREATION_FAILED);
    // details 会被全局 GraphQL Filter 原样写入响应：不得包含驱动错误文本，
    // 仅保留业务上可公开的编号；底层异常保留为 cause 供服务端日志使用。
    expect(JSON.stringify(domainError.details ?? null)).not.toContain('ER_NO_REFERENCED_ROW_2');
    expect(JSON.stringify(domainError.details ?? null)).not.toContain('repair_request');
    expect(domainError.details).toEqual({ requestNo: insertData.requestNo });
    expect(domainError.cause).toBe(queryFailedError);
  });

  it('非 QueryFailedError 的异常同样包装为创建失败，且不向客户端泄漏异常消息', async () => {
    repository.save.mockRejectedValue(new Error('connection lost'));

    let caught: unknown;
    try {
      await service.insertRequest(insertData);
    } catch (error) {
      caught = error;
    }

    const domainError = caught as DomainError;
    expect(domainError).toBeInstanceOf(DomainError);
    expect(domainError.code).toBe(REPAIR_REQUEST_ERROR.CREATION_FAILED);
    expect(JSON.stringify(domainError.details ?? null)).not.toContain('connection lost');
  });

  it('携带事务上下文时改用事务内的 EntityManager 落库', async () => {
    const transactionContext = createTypeOrmPersistenceTransactionContext({
      getRepository: () => repository,
    } as unknown as EntityManager);

    await service.insertRequest(insertData, transactionContext);

    expect(repository.create).toHaveBeenCalledTimes(1);
    expect(repository.save).toHaveBeenCalledTimes(1);
  });

  it.each([
    { orderCompany: 22, intakeCompany: 22, expected: 22 },
    { orderCompany: 22, intakeCompany: 33, expected: null },
    { orderCompany: 22, intakeCompany: null, expected: null },
  ])('绑定锁读仅接受一致的服务公司：%j', async ({ orderCompany, intakeCompany, expected }) => {
    const intakeFindOne = jest
      .fn()
      .mockResolvedValue(
        intakeCompany === null ? null : { id: 71, serviceOrganizationId: intakeCompany },
      );
    const transactionRepository = {
      findOne: jest.fn().mockResolvedValue({
        id: 11,
        ownerOrganizationId: 7,
        intakeId: 71,
        serviceOrganizationId: orderCompany,
      }),
      manager: { getRepository: () => ({ findOne: intakeFindOne }) },
    };
    const context = createTypeOrmPersistenceTransactionContext({
      getRepository: () => transactionRepository,
    } as unknown as EntityManager);

    await expect(service.findProcessBindingTargetForUpdate(11, context)).resolves.toMatchObject({
      serviceOrganizationId: expected,
    });
    expect(transactionRepository.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        lock: { mode: 'pessimistic_write' },
        select: expect.objectContaining({ serviceOrganizationId: true }),
      }),
    );
    expect(intakeFindOne).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 71 } }));
  });

  describe('任务 04 工程师读写锁读与结单', () => {
    const createIntakeRepo = (serviceOrganizationId: number | null, found = true) => ({
      findOne: jest.fn().mockResolvedValue(found ? { id: 71, serviceOrganizationId } : null),
    });
    const asContext = (repo: unknown) =>
      createTypeOrmPersistenceTransactionContext({
        getRepository: () => repo,
      } as unknown as EntityManager);

    it.each([
      { orderCompany: 22, intakeCompany: 22, found: true, expected: 22, intakeId: 71 },
      { orderCompany: 22, intakeCompany: 33, found: true, expected: null, intakeId: 71 },
      { orderCompany: 22, intakeCompany: 22, found: false, expected: null, intakeId: 71 },
      { orderCompany: null, intakeCompany: 22, found: true, expected: null, intakeId: 71 },
      { orderCompany: 22, intakeCompany: 22, found: true, expected: null, intakeId: null },
    ])(
      'findAcceptTargetForUpdate 只接受与 intake 一致的服务公司：%j',
      async ({ orderCompany, intakeCompany, found, expected, intakeId }) => {
        const intakeRepo = createIntakeRepo(intakeCompany, found);
        const txRepository = {
          findOne: jest.fn().mockResolvedValue({
            id: 11,
            intakeId,
            serviceOrganizationId: orderCompany,
            isAccepted: false,
            deprecated: false,
          }),
          manager: { getRepository: () => intakeRepo },
        };
        const context = createTypeOrmPersistenceTransactionContext({
          getRepository: () => txRepository,
        } as unknown as EntityManager);

        await expect(service.findAcceptTargetForUpdate(11, context)).resolves.toEqual({
          id: 11,
          isAccepted: false,
          deprecated: false,
          serviceOrganizationId: expected,
        });
        expect(txRepository.findOne).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { id: 11 },
            lock: { mode: 'pessimistic_write' },
            select: expect.objectContaining({
              intakeId: true,
              serviceOrganizationId: true,
            }),
          }),
        );
        if (orderCompany === null || intakeId === null) {
          expect(intakeRepo.findOne).not.toHaveBeenCalled();
        }
      },
    );

    it('findAcceptTargetForUpdate 工单不存在返回 null，数据库异常包装为接单失败且不泄漏细节', async () => {
      repository.findOne.mockResolvedValueOnce(null);
      await expect(
        service.findAcceptTargetForUpdate(11, asContext(repository)),
      ).resolves.toBeNull();

      const dbError = new Error('select * from repair_request where id = 11');
      repository.findOne.mockRejectedValueOnce(dbError);
      let caught: unknown;
      try {
        await service.findAcceptTargetForUpdate(11, asContext(repository));
      } catch (error) {
        caught = error;
      }
      const domainError = caught as DomainError;
      expect(domainError.code).toBe(REPAIR_REQUEST_ERROR.ACCEPT_FAILED);
      expect(domainError.details).toEqual({ requestId: 11 });
      expect(JSON.stringify(domainError.details)).not.toContain('repair_request');
      expect(domainError.cause).toBe(dbError);
    });

    it('findProcessWriteTargetForUpdate 返回含结单事实与可信服务公司的写快照', async () => {
      const intakeRepo = createIntakeRepo(22);
      const txRepository = {
        findOne: jest.fn().mockResolvedValue({
          id: 11,
          ownerOrganizationId: 7,
          intakeId: 71,
          serviceOrganizationId: 22,
          isAccepted: true,
          acceptedByEngineerAccountId: 9,
          deprecated: false,
          handlingStatus: 'IN_PROGRESS',
          closureStatus: 'OPEN',
        }),
        manager: { getRepository: () => intakeRepo },
      };
      const context = createTypeOrmPersistenceTransactionContext({
        getRepository: () => txRepository,
      } as unknown as EntityManager);

      await expect(service.findProcessWriteTargetForUpdate(11, context)).resolves.toEqual({
        id: 11,
        ownerOrganizationId: 7,
        intakeId: 71,
        serviceOrganizationId: 22,
        isAccepted: true,
        acceptedByEngineerAccountId: 9,
        deprecated: false,
        handlingStatus: 'IN_PROGRESS',
        closureStatus: 'OPEN',
      });
      expect(txRepository.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
      );
      expect(intakeRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 71 } }),
      );
    });

    it('findProcessWriteTargetForUpdate 冲突时失败关闭，异常包装为过程写失败', async () => {
      const intakeRepo = createIntakeRepo(33);
      repository.findOne.mockResolvedValueOnce({
        id: 11,
        ownerOrganizationId: 7,
        intakeId: 71,
        serviceOrganizationId: 22,
        isAccepted: true,
        acceptedByEngineerAccountId: 9,
        deprecated: false,
        handlingStatus: 'IN_PROGRESS',
        closureStatus: 'OPEN',
      });
      (repository as unknown as { manager: unknown }).manager = {
        getRepository: () => intakeRepo,
      };

      await expect(
        service.findProcessWriteTargetForUpdate(11, asContext(repository)),
      ).resolves.toMatchObject({
        serviceOrganizationId: null,
      });

      const dbError = new Error('lock wait timeout');
      repository.findOne.mockRejectedValueOnce(dbError);
      await expect(
        service.findProcessWriteTargetForUpdate(11, asContext(repository)),
      ).rejects.toMatchObject({
        code: REPAIR_REQUEST_ERROR.PROCESS_WRITE_FAILED,
        details: { requestId: 11 },
      });
    });

    const createUpdateBuilder = (affected: number) => {
      const execute = jest.fn().mockResolvedValue({ affected });
      const chain = {
        update: jest.fn(),
        set: jest.fn(),
        where: jest.fn(),
        andWhere: jest.fn(),
        execute,
      };
      chain.update.mockReturnValue(chain);
      chain.set.mockReturnValue(chain);
      chain.where.mockReturnValue(chain);
      chain.andWhere.mockReturnValue(chain);
      return chain;
    };

    it('closeRequest 条件更新结单事实，处理中结果不写 handlingEndedAt', async () => {
      const builder = createUpdateBuilder(1);
      repository.createQueryBuilder.mockReturnValueOnce(builder);

      const closedAt = new Date('2026-11-16T10:00:00.000Z');
      await expect(
        service.closeRequest(
          {
            requestId: 11,
            engineerAccountId: 9,
            handlingResult: RepairRequestHandlingResult.INTERRUPTED,
            handlingStatus: RepairRequestHandlingStatus.COMPLETED,
            handlingEndedAt: null,
            closureReason: '厂方原因中断',
            closedAt,
          },
          asContext(repository),
        ),
      ).resolves.toBe(1);

      expect(builder.set).toHaveBeenCalledWith(
        expect.objectContaining({
          handlingResult: 'INTERRUPTED',
          handlingStatus: 'COMPLETED',
          handlingEndedAt: null,
          closureStatus: 'CLOSED',
          closedAt,
          closureReason: '厂方原因中断',
        }),
      );
      const conditions = builder.andWhere.mock.calls.map((call) => call[0]);
      expect(conditions).toEqual(
        expect.arrayContaining([
          'deprecated = :deprecated',
          'is_accepted = :isAccepted',
          'accepted_by_engineer_account_id = :engineerAccountId',
          '(closure_status IS NULL OR closure_status <> :closed)',
        ]),
      );
    });

    it('closeRequest 条件未命中返回 0，异常包装为结单失败', async () => {
      repository.createQueryBuilder.mockReturnValueOnce(createUpdateBuilder(0));
      await expect(
        service.closeRequest(
          {
            requestId: 11,
            engineerAccountId: 9,
            handlingResult: RepairRequestHandlingResult.FIXED,
            handlingStatus: RepairRequestHandlingStatus.COMPLETED,
            handlingEndedAt: new Date('2026-11-16T10:00:00.000Z'),
            closureReason: null,
            closedAt: new Date('2026-11-16T10:00:00.000Z'),
          },
          asContext(repository),
        ),
      ).resolves.toBe(0);

      repository.createQueryBuilder.mockImplementationOnce(() => {
        throw new Error('connection lost');
      });
      await expect(
        service.closeRequest(
          {
            requestId: 11,
            engineerAccountId: 9,
            handlingResult: RepairRequestHandlingResult.FIXED,
            handlingStatus: RepairRequestHandlingStatus.COMPLETED,
            handlingEndedAt: new Date('2026-11-16T10:00:00.000Z'),
            closureReason: null,
            closedAt: new Date('2026-11-16T10:00:00.000Z'),
          },
          asContext(repository),
        ),
      ).rejects.toMatchObject({
        code: REPAIR_REQUEST_ERROR.CLOSE_FAILED,
        details: { requestId: 11 },
      });
    });
  });

  it('requestNoExists 按计数结果返回是否存在', async () => {
    repository.count.mockResolvedValueOnce(1);
    await expect(service.requestNoExists(insertData.requestNo)).resolves.toBe(true);
    expect(repository.count).toHaveBeenLastCalledWith({
      where: { requestNo: insertData.requestNo },
    });

    repository.count.mockResolvedValueOnce(0);
    await expect(service.requestNoExists(insertData.requestNo)).resolves.toBe(false);
  });

  describe('acceptRequest', () => {
    const acceptedAt = new Date('2026-09-02T08:30:00.000Z');
    const acceptData: RepairRequestAcceptData = {
      requestId: 21,
      engineerAccountId: 5,
      acceptedAt,
    };

    it('条件更新命中主键 + 未删除 + 未接单，并在同一语句一次性写入三个接单字段', async () => {
      repository.update.mockResolvedValue({ affected: 1 });

      await expect(service.acceptRequest(acceptData)).resolves.toEqual({ affected: 1 });

      expect(repository.update).toHaveBeenCalledTimes(1);
      expect(repository.update).toHaveBeenCalledWith(
        { id: acceptData.requestId, deprecated: false, isAccepted: false },
        {
          isAccepted: true,
          acceptedByEngineerAccountId: acceptData.engineerAccountId,
          acceptedAt,
        },
      );
    });

    it('affected 缺失时安全归一为 0，未命中时原样返回 0 交由 usecase 裁决', async () => {
      repository.update.mockResolvedValueOnce({ affected: undefined });
      await expect(service.acceptRequest(acceptData)).resolves.toEqual({ affected: 0 });

      repository.update.mockResolvedValueOnce({ affected: 0 });
      await expect(service.acceptRequest(acceptData)).resolves.toEqual({ affected: 0 });
    });

    it('携带事务上下文时改用事务内 Repository 执行条件更新', async () => {
      const transactionRepository = createMockRepository();
      transactionRepository.update.mockResolvedValue({ affected: 1 });
      const transactionContext = createTypeOrmPersistenceTransactionContext({
        getRepository: () => transactionRepository,
      } as unknown as EntityManager);

      await expect(service.acceptRequest(acceptData, transactionContext)).resolves.toEqual({
        affected: 1,
      });

      expect(transactionRepository.update).toHaveBeenCalledTimes(1);
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('数据库异常包装为接单失败，details 不泄漏 SQL / 表名 / 约束名 / 底层错误', async () => {
      // 真实驱动错误可能携带 SQL 语句、表名与错误码
      const sensitiveSql = 'UPDATE `repair_request` SET `is_accepted` = ? WHERE `id` = ?';
      const driverError = new Error(
        'Lock wait timeout exceeded; try restarting transaction',
      ) as Error & {
        code: string;
      };
      driverError.code = 'ER_LOCK_WAIT_TIMEOUT';
      const queryFailedError = new QueryFailedError(sensitiveSql, [], driverError);
      repository.update.mockRejectedValue(queryFailedError);

      let caught: unknown;
      try {
        await service.acceptRequest(acceptData);
      } catch (error) {
        caught = error;
      }

      const domainError = caught as DomainError;
      expect(domainError).toBeInstanceOf(DomainError);
      expect(domainError.code).toBe(REPAIR_REQUEST_ERROR.ACCEPT_FAILED);
      expect(domainError.details).toEqual({ requestId: acceptData.requestId });
      // details 会被全局 GraphQL Filter 原样写入响应，不得含任何数据库细节
      const serialized = JSON.stringify(domainError.details ?? null);
      expect(serialized).not.toContain('repair_request');
      expect(serialized).not.toContain('ER_LOCK_WAIT_TIMEOUT');
      expect(serialized).not.toContain('Lock wait timeout');
      expect(serialized).not.toContain('UPDATE');
      // 底层异常仅以 cause 保留，供服务端日志与排查使用
      expect(domainError.cause).toBe(queryFailedError);
    });
  });

  describe('findAcceptanceStatus', () => {
    it('只读取裁决所需的最小字段集合', async () => {
      repository.findOne.mockResolvedValue(null);

      await service.findAcceptanceStatus(31);

      expect(repository.findOne).toHaveBeenCalledTimes(1);
      expect(repository.findOne).toHaveBeenCalledWith({
        where: { id: 31 },
        select: { id: true, isAccepted: true, deprecated: true },
      });
    });

    it('存在时返回最小快照，不携带归属账号 ID 等未选取字段', async () => {
      // 构造 select 之外字段意外出现在实体上的情况：快照必须收窄为三字段
      repository.findOne.mockResolvedValue({
        id: 31,
        isAccepted: true,
        deprecated: false,
        requestNo: 'RR20260902100000ABC123',
        customerAccountId: 7,
        acceptedByEngineerAccountId: 5,
      });

      await expect(service.findAcceptanceStatus(31)).resolves.toEqual({
        id: 31,
        isAccepted: true,
        deprecated: false,
      });
    });

    it('不存在时返回 null', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(service.findAcceptanceStatus(32)).resolves.toBeNull();
    });

    it('携带事务上下文时在同一事务内读取（与条件更新同事务）', async () => {
      const transactionRepository = createMockRepository();
      transactionRepository.findOne.mockResolvedValue({
        id: 33,
        isAccepted: false,
        deprecated: false,
      });
      const transactionContext = createTypeOrmPersistenceTransactionContext({
        getRepository: () => transactionRepository,
      } as unknown as EntityManager);

      await expect(service.findAcceptanceStatus(33, transactionContext)).resolves.toEqual({
        id: 33,
        isAccepted: false,
        deprecated: false,
      });

      expect(transactionRepository.findOne).toHaveBeenCalledTimes(1);
      expect(repository.findOne).not.toHaveBeenCalled();
    });

    it('数据库异常安全映射为接单失败，不泄漏数据库细节', async () => {
      const driverError = new Error(
        "Unknown column 'deprecated' in 'field list' (SELECT FROM `repair_request`)",
      ) as Error & { code: string };
      driverError.code = 'ER_BAD_FIELD_ERROR';
      const queryFailedError = new QueryFailedError(
        'SELECT `id`, `is_accepted`, `deprecated` FROM `repair_request`',
        [],
        driverError,
      );
      repository.findOne.mockRejectedValue(queryFailedError);

      let caught: unknown;
      try {
        await service.findAcceptanceStatus(34);
      } catch (error) {
        caught = error;
      }

      const domainError = caught as DomainError;
      expect(domainError).toBeInstanceOf(DomainError);
      expect(domainError.code).toBe(REPAIR_REQUEST_ERROR.ACCEPT_FAILED);
      expect(domainError.details).toEqual({ requestId: 34 });
      const serialized = JSON.stringify(domainError.details ?? null);
      expect(serialized).not.toContain('repair_request');
      expect(serialized).not.toContain('ER_BAD_FIELD_ERROR');
      expect(domainError.cause).toBe(queryFailedError);
    });
  });
  describe('softDeleteRequest（原子条件软删除）', () => {
    const deleteParams = { requestId: 11, customerAccountId: 7 };

    it('条件更新命中时软删除并回读编号返回 DELETED', async () => {
      repository.update.mockResolvedValueOnce({ affected: 1 });
      repository.findOne.mockResolvedValueOnce({ id: 11, requestNo: insertData.requestNo });

      const outcome = await service.softDeleteRequest(deleteParams);

      expect(outcome).toEqual({ kind: 'DELETED', id: 11, requestNo: insertData.requestNo });
      // 原子条件更新：删除条件必须含归属与接单/作废状态（接单/删除互斥）
      expect(repository.update).toHaveBeenCalledWith(
        { id: 11, customerAccountId: 7, isAccepted: false, deprecated: false },
        { deprecated: true, deletedAt: expect.any(Function) },
      );
      const setClause = repository.update.mock.calls[0][1] as Record<string, unknown>;
      expect((setClause.deletedAt as () => string)()).toBe('CURRENT_TIMESTAMP(3)');
    });

    it('条件未命中且行不存在时返回 NOT_FOUND_OR_NOT_OWNER', async () => {
      repository.update.mockResolvedValueOnce({ affected: 0 });
      repository.findOne.mockResolvedValueOnce(null);

      await expect(service.softDeleteRequest(deleteParams)).resolves.toEqual({
        kind: 'NOT_FOUND_OR_NOT_OWNER',
        id: 11,
      });
    });

    it('非本人申请一律返回 NOT_FOUND_OR_NOT_OWNER，不泄露已接单/已删除状态', async () => {
      repository.update.mockResolvedValueOnce({ affected: 0 });
      repository.findOne.mockResolvedValueOnce({
        id: 11,
        requestNo: insertData.requestNo,
        customerAccountId: 999,
        isAccepted: true,
        deprecated: false,
      });

      await expect(service.softDeleteRequest(deleteParams)).resolves.toEqual({
        kind: 'NOT_FOUND_OR_NOT_OWNER',
        id: 11,
      });
      // 钉住最小读取投影：防止后续扩大投影泄露无关字段
      expect(repository.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 11 },
          select: {
            id: true,
            requestNo: true,
            customerAccountId: true,
            isAccepted: true,
            deprecated: true,
          },
        }),
      );
    });

    it('本人已软删除时返回 ALREADY_DELETED（幂等成功语义由 usecase 决定）', async () => {
      repository.update.mockResolvedValueOnce({ affected: 0 });
      repository.findOne.mockResolvedValueOnce({
        id: 11,
        requestNo: insertData.requestNo,
        customerAccountId: 7,
        isAccepted: false,
        deprecated: true,
      });

      await expect(service.softDeleteRequest(deleteParams)).resolves.toEqual({
        kind: 'ALREADY_DELETED',
        id: 11,
        requestNo: insertData.requestNo,
      });
    });

    it('本人已接单时返回 ALREADY_ACCEPTED（接单/删除互斥：并发接单先命中后删除未命中）', async () => {
      repository.update.mockResolvedValueOnce({ affected: 0 });
      repository.findOne.mockResolvedValueOnce({
        id: 11,
        requestNo: insertData.requestNo,
        customerAccountId: 7,
        isAccepted: true,
        deprecated: false,
      });

      await expect(service.softDeleteRequest(deleteParams)).resolves.toEqual({
        kind: 'ALREADY_ACCEPTED',
        id: 11,
        requestNo: insertData.requestNo,
      });
      // 钉住最小读取投影与锁读（当前读）：分类不得受 RR 快照时序影响
      expect(repository.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 11 },
          select: {
            id: true,
            requestNo: true,
            customerAccountId: true,
            isAccepted: true,
            deprecated: true,
          },
          lock: { mode: 'pessimistic_read' },
        }),
      );
    });

    it('条件未命中但重读仍满足删除条件时防御性抛出删除失败（理论上不可达）', async () => {
      repository.update.mockResolvedValueOnce({ affected: 0 });
      repository.findOne.mockResolvedValueOnce({
        id: 11,
        requestNo: insertData.requestNo,
        customerAccountId: 7,
        isAccepted: false,
        deprecated: false,
      });

      await expect(service.softDeleteRequest(deleteParams)).rejects.toMatchObject({
        code: REPAIR_REQUEST_ERROR.DELETION_FAILED,
      });
    });

    it('落库失败包装为删除失败，details 只含 id，原始异常进 cause', async () => {
      const dbError = new Error('connection lost');
      repository.update.mockRejectedValueOnce(dbError);

      let caught: unknown;
      try {
        await service.softDeleteRequest(deleteParams);
      } catch (error) {
        caught = error;
      }

      const domainError = caught as DomainError;
      expect(domainError).toBeInstanceOf(DomainError);
      expect(domainError.code).toBe(REPAIR_REQUEST_ERROR.DELETION_FAILED);
      expect(domainError.details).toEqual({ id: 11 });
      expect(JSON.stringify(domainError.details ?? null)).not.toContain('connection lost');
      expect(domainError.cause).toBe(dbError);
    });

    it('携带事务上下文时改用事务内的 EntityManager 执行条件更新与重读', async () => {
      // 独立的仓库 mock：证明操作确实走事务上下文的 EntityManager，而非默认仓库
      const txRepository = createMockRepository();
      txRepository.update.mockResolvedValueOnce({ affected: 1 });
      txRepository.findOne.mockResolvedValueOnce({ id: 11, requestNo: insertData.requestNo });
      const transactionContext = createTypeOrmPersistenceTransactionContext({
        getRepository: () => txRepository,
      } as unknown as EntityManager);

      await service.softDeleteRequest(deleteParams, transactionContext);

      expect(txRepository.update).toHaveBeenCalledTimes(1);
      expect(txRepository.findOne).toHaveBeenCalledTimes(1);
      // 默认仓库不得被使用：事务内操作必须全部经由事务上下文
      expect(repository.update).not.toHaveBeenCalled();
      expect(repository.findOne).not.toHaveBeenCalled();
    });
  });

  // PR #27 复审：同标识重放状态核验的工单侧锁读（删除与重放并发时取单一提交点事实）
  describe('findReplayRequestStateForUpdate（重放核验锁读）', () => {
    it('排他锁 + 最小状态列，返回重放核验所需状态事实', async () => {
      repository.findOne.mockResolvedValueOnce({
        id: 11,
        customerAccountId: 7,
        intakeId: 21,
        deprecated: false,
      });
      const transactionContext = createTypeOrmPersistenceTransactionContext({
        getRepository: () => repository,
      } as unknown as EntityManager);

      await expect(
        service.findReplayRequestStateForUpdate(11, transactionContext),
      ).resolves.toEqual({
        id: 11,
        customerAccountId: 7,
        intakeId: 21,
        deprecated: false,
      });
      // 钉住排他锁与最小投影：防止扩大投影泄露报修内容字段
      expect(repository.findOne).toHaveBeenCalledWith({
        where: { id: 11 },
        select: { id: true, customerAccountId: true, intakeId: true, deprecated: true },
        lock: { mode: 'pessimistic_write' },
      });
    });

    it('已删除工单（deprecated=true）照实返回删除事实，行缺失返回 null', async () => {
      const transactionContext = createTypeOrmPersistenceTransactionContext({
        getRepository: () => repository,
      } as unknown as EntityManager);
      repository.findOne.mockResolvedValueOnce({
        id: 11,
        customerAccountId: 7,
        intakeId: 21,
        deprecated: true,
      });
      await expect(
        service.findReplayRequestStateForUpdate(11, transactionContext),
      ).resolves.toMatchObject({
        deprecated: true,
      });

      repository.findOne.mockResolvedValueOnce(null);
      await expect(
        service.findReplayRequestStateForUpdate(11, transactionContext),
      ).resolves.toBeNull();
    });
  });
});
