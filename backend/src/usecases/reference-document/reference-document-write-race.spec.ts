// src/usecases/reference-document/reference-document-write-race.spec.ts

/// <reference types="jest" />
import type { LocalWriteHoldService } from '@src/modules/lithography/local-write-hold.service';
import type { UsecaseSession } from '@app-types/auth/session.types';
import { DomainError, REFERENCE_DOCUMENT_ERROR } from '@core/common/errors/domain-error';
import type { AccountQueryService } from '@src/modules/account/queries/account.query.service';
import type { EquipmentModelQueryService } from '@src/modules/lithography/queries/equipment-model.query.service';
import type { MaintenanceReportQueryService } from '@src/modules/lithography/queries/maintenance-report.query.service';
import type { ManagementAuditService } from '@src/modules/lithography/management-audit.service';
import type { ReferenceDocumentQueryService } from '@src/modules/lithography/queries/reference-document.query.service';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import type { ReferenceDocumentCaseDetailService } from '@src/modules/lithography/reference-document-case-detail.service';
import type { ReferenceDocumentService } from '@src/modules/lithography/reference-document.service';
import type { ReferenceDocumentRevisionService } from '@src/modules/lithography/reference-document-revision.service';
import type { TransactionRunner } from '@src/usecases/common/ports/transaction-runner.contract';
import { ReviseReferenceDocumentUsecase } from './revise-reference-document.usecase';
import { SoftDeleteReferenceDocumentUsecase } from './soft-delete-reference-document.usecase';
import { UpdateReferenceDocumentCaseUsecase } from './update-reference-document-case.usecase';

/**
 * 写竞争受控交错实验台（G2/F01，任务 07 版本化改造）：以内存替身模拟 InnoDB 的
 * 三个关键语义，仅覆盖案例更正 / 管理修订 / 原作者删除三个写入口所需的最小事实面：
 *
 * 1. REPEATABLE READ 事务快照：事务开始时捕获状态快照，非锁定读（普通 SELECT）
 *    永远返回本事务快照（不看到并发事务的提交）；
 * 2. 锁定读（SELECT ... FOR UPDATE，即 findDetail({ forUpdate: true })）是当前读
 *    并持有行锁：依次排队、读到最新已提交状态，锁保持到事务结束（run 返回/抛错）；
 * 3. 行写（UPDATE）同样需要行锁：管理修订的 advanceCurrentRevision 以
 *    current_revision_no = expected 作为条件，未命中返回 VERSION_CONFLICT 状态事实。
 *
 * 这不是真实数据库并发测试（真实连接与同步屏障在 e2e 补验）；它的价值是以
 * 确定性调度构造「快照交错」「锁串行化」与「版本过期」三种执行，证明管理修订
 * 必须走锁定读 + expected_version 条件推进，任何入口都不产生半写。
 */

const writeSession = (): UsecaseSession =>
  ({ accountId: 900001, roles: ['SUPER_ADMIN'], activeRole: 'SUPER_ADMIN' }) as UsecaseSession;

type DocumentRowState = {
  title: string;
  documentType: string;
  equipmentModelId: number | null;
  equipmentModelText: string | null;
  description: string | null;
  contentText: string | null;
  storageReference: string | null;
  publicationStatus: 'ONLINE' | 'OFFLINE';
  ownershipStatus: 'CONFIRMED' | 'PENDING';
  createdByAccountId: number;
  currentRevisionNo: number;
  deprecated: boolean;
};

type CaseDetailRowState = {
  errorCode: string | null;
  handlingStatus: string;
  phenomenon: string;
  conditionText: string | null;
  reproductionSteps: string;
  diagnosis: string | null;
  actionTaken: string | null;
  resolution: string | null;
};

type DbState = { document: DocumentRowState; detail: CaseDetailRowState };

/** 事务上下文替身：快照（RR 事务视图）与行锁控制句柄（测试内部通道） */
type MockTransactionContext = {
  transaction: 'mock';
  snapshot: DbState;
  acquireRowLock: () => Promise<void>;
};

const cloneState = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const makeWriteRaceBench = () => {
  // —— 主资料行锁模拟：持有/等待队列（release 把锁直接移交给下一个等待者，公平且无插队） ——
  let rowLockHeld = false;
  const lockWaiters: Array<() => void> = [];
  const awaitRowLock = async (): Promise<void> => {
    if (!rowLockHeld) {
      rowLockHeld = true;
      return;
    }
    await new Promise<void>((resolve) => lockWaiters.push(resolve));
    // 被 release 唤醒即视为锁已移交，不再竞争
  };
  const releaseRowLock = (): void => {
    const next = lockWaiters.shift();
    if (next) {
      next();
      return;
    }
    rowLockHeld = false;
  };

  const state: DbState = {
    document: {
      title: '案例标题',
      documentType: 'FAULT_CASE',
      equipmentModelId: null,
      equipmentModelText: null,
      description: null,
      contentText: '正文（旧）',
      storageReference: null,
      publicationStatus: 'ONLINE',
      ownershipStatus: 'CONFIRMED',
      createdByAccountId: 900001,
      currentRevisionNo: 1,
      deprecated: false,
    },
    detail: {
      errorCode: 'OLD-CODE',
      handlingStatus: 'UNRESOLVED',
      phenomenon: '现象',
      conditionText: 'OLD-COND',
      reproductionSteps: '步骤',
      diagnosis: null,
      actionTaken: null,
      resolution: null,
    },
  };

  // —— 事务运行器替身：事务开始捕获快照；回调结束（提交/回滚）释放本事务持有的行锁 ——
  const transactionRunner = {
    run: jest.fn(async (callback: (context: unknown) => Promise<unknown>) => {
      const snapshot = cloneState(state);
      let holdsRowLock = false;
      const context: MockTransactionContext = {
        transaction: 'mock',
        snapshot,
        acquireRowLock: async () => {
          if (!holdsRowLock) {
            await awaitRowLock();
            holdsRowLock = true;
          }
        },
      };
      try {
        return await callback(context);
      } finally {
        if (holdsRowLock) {
          releaseRowLock();
        }
      }
    }),
  } as unknown as TransactionRunner & { run: jest.Mock };

  const organizationContextService = {
    resolveForAccount: jest.fn().mockResolvedValue({
      membershipId: 950001,
      organizationId: 910001,
      organizationCode: 'CLIENT_DEFAULT',
      organizationName: '甲方默认组织',
      organizationKind: 'CLIENT',
      memberRole: 'ADMIN',
    }),
  };

  const equipmentModelQueryService = {
    findModelById: jest.fn().mockResolvedValue({ id: 930001, modelCode: 'M', modelName: '型号' }),
  };

  const accountQueryService = {
    findAdminLevelByAccountId: jest.fn().mockResolvedValue(1),
    findNicknamesByAccountIds: jest.fn().mockResolvedValue(new Map()),
  };

  const maintenanceReportQueryService = {
    readVersionById: jest.fn().mockResolvedValue(null),
  };

  const toDetailView = (source: DbState) => {
    if (source.document.deprecated) {
      throw new DomainError(REFERENCE_DOCUMENT_ERROR.NOT_FOUND, '历史维修记录不存在或不可访问');
    }
    return {
      id: 970001,
      title: source.document.title,
      documentType: source.document.documentType,
      equipmentModelId: source.document.equipmentModelId,
      equipmentModelName: null,
      equipmentModelText: source.document.equipmentModelText,
      description: source.document.description,
      originalFilename: null,
      mimeType: null,
      hasFile: source.document.storageReference !== null,
      contentText: source.document.contentText,
      organizationName: '甲方默认组织',
      ingestMethod: 'REVIEWED_SUBMISSION',
      caseDetail: cloneState(source.detail),
      createdByAccountId: source.document.createdByAccountId,
      ownerOrganizationId: 910001,
      storageReference: source.document.storageReference,
      publicationStatus: source.document.publicationStatus,
      ownershipStatus: source.document.ownershipStatus,
      effectiveRevisionNo: source.document.currentRevisionNo,
      schemaVersion: 1,
      createdAt: new Date('2026-01-02T10:00:00.000Z'),
      updatedAt: new Date('2026-01-02T10:00:00.000Z'),
    };
  };

  // —— 读侧替身：forUpdate 锁定读（当前读 + 行锁）；默认非锁定读（事务快照） ——
  const referenceDocumentQueryService = {
    findDetail: jest.fn(
      async (params: { transactionContext?: unknown; forUpdate?: boolean } = {}) => {
        const transactionContext = params.transactionContext as MockTransactionContext;
        if (params.forUpdate === true) {
          // 锁定读：排队获取行锁（保持到事务结束），读到最新已提交状态
          await transactionContext.acquireRowLock();
          return toDetailView(state);
        }
        // 非锁定读：REPEATABLE READ 事务快照（不看到并发提交）
        return toDetailView(transactionContext.snapshot);
      },
    ),
    // 生效修订读替身：返回当前状态的正文快照（修订刚推进时与行内正文一致）
    findRevision: jest.fn().mockImplementation((documentId: number, revisionNo: number) =>
      Promise.resolve({
        revisionNo,
        afterSnapshot: { schema_version: 1, contentText: state.document.contentText },
      }),
    ),
  };

  // —— 修订写替身：条件推进同样通过行锁串行化；expected 不匹配返回 VERSION_CONFLICT ——
  const referenceDocumentRevisionService = {
    insertRevision: jest.fn().mockResolvedValue(undefined),
    advanceCurrentRevision: jest.fn(
      async (
        params: {
          documentId: number;
          expectedRevisionNo: number;
          apply: Record<string, unknown> & { markDeleted?: boolean };
        },
        transactionContext?: unknown,
      ) => {
        const context = transactionContext as MockTransactionContext;
        await context.acquireRowLock();
        if (state.document.deprecated) {
          return 'VERSION_CONFLICT';
        }
        if (state.document.currentRevisionNo !== params.expectedRevisionNo) {
          return 'VERSION_CONFLICT';
        }
        const { apply } = params;
        for (const [key, value] of Object.entries(apply)) {
          if (key === 'markDeleted') continue;
          (state.document as unknown as Record<string, unknown>)[key] = value;
        }
        if (apply.markDeleted === true) {
          state.document.deprecated = true;
          state.document.publicationStatus = 'OFFLINE';
        }
        state.document.currentRevisionNo = params.expectedRevisionNo + 1;
        return 'ADVANCED';
      },
    ),
  };

  const managementAuditService = {
    appendDocumentEvent: jest.fn().mockResolvedValue(undefined),
  };

  // —— 案例写侧替身：行写同样通过行锁串行化 ——
  const referenceDocumentService = {
    updateDocument: jest.fn().mockResolvedValue({ id: 970001 }),
  };

  const referenceDocumentCaseDetailService = {
    updateCaseDetail: jest.fn(
      async (
        data: {
          errorCode: string | null;
          handlingStatus: string;
          phenomenon: string;
          conditionText: string | null;
          reproductionSteps: string;
          diagnosis: string | null;
          actionTaken: string | null;
          resolution: string | null;
        },
        transactionContext?: unknown,
      ) => {
        const context = transactionContext as MockTransactionContext;
        await context.acquireRowLock();
        state.detail = {
          errorCode: data.errorCode,
          handlingStatus: data.handlingStatus,
          phenomenon: data.phenomenon,
          conditionText: data.conditionText,
          reproductionSteps: data.reproductionSteps,
          diagnosis: data.diagnosis,
          actionTaken: data.actionTaken,
          resolution: data.resolution,
        };
        return { documentId: 970001 };
      },
    ),
  };

  const makeUsecases = () => ({
    correction: new UpdateReferenceDocumentCaseUsecase(
      referenceDocumentService as unknown as ReferenceDocumentService,
      referenceDocumentCaseDetailService as unknown as ReferenceDocumentCaseDetailService,
      referenceDocumentQueryService as unknown as ReferenceDocumentQueryService,
      {
        assertBusinessWritable: () => Promise.resolve(),
        assertBusinessWritableInTransaction: () => Promise.resolve(),
        assertCompanyWritable: () => Promise.resolve(),
        assertCompanyWritableInTransaction: () => Promise.resolve(),
        assertWritable: () => Promise.resolve(),
      } as unknown as LocalWriteHoldService,
      equipmentModelQueryService as unknown as EquipmentModelQueryService,
      organizationContextService as unknown as TrustedOrganizationContextQueryService,
      transactionRunner,
    ),
    revise: new ReviseReferenceDocumentUsecase(
      referenceDocumentQueryService as unknown as ReferenceDocumentQueryService,
      {
        assertBusinessWritable: () => Promise.resolve(),
        assertBusinessWritableInTransaction: () => Promise.resolve(),
        assertCompanyWritable: () => Promise.resolve(),
        assertCompanyWritableInTransaction: () => Promise.resolve(),
        assertWritable: () => Promise.resolve(),
      } as unknown as LocalWriteHoldService,
      maintenanceReportQueryService as unknown as MaintenanceReportQueryService,
      referenceDocumentRevisionService as unknown as ReferenceDocumentRevisionService,
      accountQueryService as unknown as AccountQueryService,
      transactionRunner,
    ),
    softDelete: new SoftDeleteReferenceDocumentUsecase(
      referenceDocumentQueryService as unknown as ReferenceDocumentQueryService,
      {
        assertBusinessWritable: () => Promise.resolve(),
        assertBusinessWritableInTransaction: () => Promise.resolve(),
        assertCompanyWritable: () => Promise.resolve(),
        assertCompanyWritableInTransaction: () => Promise.resolve(),
        assertWritable: () => Promise.resolve(),
      } as unknown as LocalWriteHoldService,
      maintenanceReportQueryService as unknown as MaintenanceReportQueryService,
      referenceDocumentRevisionService as unknown as ReferenceDocumentRevisionService,
      managementAuditService as unknown as ManagementAuditService,
      accountQueryService as unknown as AccountQueryService,
      transactionRunner,
    ),
  });

  return {
    state,
    transactionRunner,
    organizationContextService,
    accountQueryService,
    referenceDocumentQueryService,
    referenceDocumentRevisionService,
    referenceDocumentCaseDetailService,
    makeUsecases,
  };
};

describe('正式资料写竞争受控交错（G2/F01，任务 07 版本化口径）', () => {
  it('两个一级管理员以同一 expected_version 并发修订：锁串行化 + 条件推进——先提交者成功，后者 VERSION_CONFLICT，无字段丢失', async () => {
    const bench = makeWriteRaceBench();
    const { revise } = bench.makeUsecases();

    const [resultA, errorB] = await Promise.allSettled([
      revise.execute({
        session: writeSession(),
        documentId: 970001,
        expectedVersion: 1,
        reason: '修订 A',
        patch: { description: 'A-NEW' },
      }),
      revise.execute({
        session: writeSession(),
        documentId: 970001,
        expectedVersion: 1,
        reason: '修订 B',
        patch: { title: 'B-NEW' },
      }),
    ]);

    // 恰好一个成功、一个版本冲突：旧版本不得覆盖新版本
    const fulfilled = [resultA, errorB].filter(
      (r) => r.status === 'fulfilled',
    ) as PromiseFulfilledResult<{ id: number; revisionNo: number }>[];
    const rejected = [resultA, errorB].filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({
      code: REFERENCE_DOCUMENT_ERROR.VERSION_CONFLICT,
    });
    expect(fulfilled[0].value.revisionNo).toBe(2);
    expect(bench.state.document.currentRevisionNo).toBe(2);
    // 失败者在锁定读阶段即版本核对失败：不产生第二个修订行与第二次推进
    expect(bench.referenceDocumentRevisionService.advanceCurrentRevision).toHaveBeenCalledTimes(1);
  });

  it('管理修订（标题）与专属案例更正（明细）并发：两个入口共享同一资源锁，均不丢补丁', async () => {
    const bench = makeWriteRaceBench();
    const { correction, revise } = bench.makeUsecases();

    await Promise.all([
      revise.execute({
        session: writeSession(),
        documentId: 970001,
        expectedVersion: 1,
        reason: '标题修订',
        patch: { title: '新标题' },
      }),
      correction.execute({
        session: writeSession(),
        documentId: 970001,
        patch: { conditionText: 'B-NEW' },
      }),
    ]);

    expect(bench.state.document.title).toBe('新标题');
    expect(bench.state.detail.conditionText).toBe('B-NEW');
    expect(bench.state.document.currentRevisionNo).toBe(2);
  });

  it('管理修订与作者删除的合并读必须走锁定读入口（findDetail({ forUpdate: true })）', async () => {
    const bench = makeWriteRaceBench();
    const { revise, softDelete } = bench.makeUsecases();

    await revise.execute({
      session: writeSession(),
      documentId: 970001,
      expectedVersion: 1,
      reason: '修订',
      patch: { description: '说明' },
    });
    await softDelete.execute({
      session: writeSession(),
      documentId: 970001,
      expectedVersion: 2,
    });

    expect(bench.referenceDocumentQueryService.findDetail).toHaveBeenCalledWith(
      expect.objectContaining({ forUpdate: true }),
    );
    expect(bench.state.document.deprecated).toBe(true);
    expect(bench.state.document.currentRevisionNo).toBe(3);
  });

  it('作者删除先提交、修订随后（修订事务快照早于删除提交）：修订拒绝，不产生软删后成功修订的假结果', async () => {
    const bench = makeWriteRaceBench();
    const { revise, softDelete } = bench.makeUsecases();

    // 受控交错：让修订事务先开始（捕获快照）并停在合并读之前，删除完整提交后再放行
    const originalFindDetail =
      bench.referenceDocumentQueryService.findDetail.getMockImplementation()!;
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let gated = false;
    bench.referenceDocumentQueryService.findDetail.mockImplementation(async (params) => {
      if (!gated) {
        gated = true;
        await gate;
      }
      return originalFindDetail(params);
    });

    const revisePromise = revise.execute({
      session: writeSession(),
      documentId: 970001,
      expectedVersion: 1,
      reason: '修订',
      patch: { title: '后到修订' },
    });
    // 等待修订事务推进到合并读的 gate 前（快照已建立）
    await new Promise<void>((resolve) => setImmediate(resolve));

    await softDelete.execute({
      session: writeSession(),
      documentId: 970001,
      expectedVersion: 1,
    });
    expect(bench.state.document.deprecated).toBe(true);

    releaseGate();

    await expect(revisePromise).rejects.toMatchObject({
      code: REFERENCE_DOCUMENT_ERROR.NOT_FOUND,
    });
    // 修订未被写入（同事务回滚语义由运行器替身模拟）
    expect(bench.state.document.title).toBe('案例标题');
    expect(bench.state.document.currentRevisionNo).toBe(2);
  });
});
