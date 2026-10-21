// src/usecases/reference-document/reference-document-write-race.spec.ts

/// <reference types="jest" />
import type { UsecaseSession } from '@app-types/auth/session.types';
import { DomainError, REFERENCE_DOCUMENT_ERROR } from '@core/common/errors/domain-error';
import type { EquipmentModelQueryService } from '@src/modules/lithography/queries/equipment-model.query.service';
import type { ReferenceDocumentQueryService } from '@src/modules/lithography/queries/reference-document.query.service';
import type { TrustedOrganizationContextQueryService } from '@src/modules/lithography/queries/trusted-organization-context.query.service';
import type { ReferenceDocumentCaseDetailService } from '@src/modules/lithography/reference-document-case-detail.service';
import type { ReferenceDocumentService } from '@src/modules/lithography/reference-document.service';
import type { TransactionRunner } from '@src/usecases/common/ports/transaction-runner.contract';
import { SoftDeleteReferenceDocumentUsecase } from './soft-delete-reference-document.usecase';
import { UpdateReferenceDocumentCaseUsecase } from './update-reference-document-case.usecase';
import { UpdateReferenceDocumentUsecase } from './update-reference-document.usecase';

/**
 * 写竞争受控交错实验台（G2/F01）：以内存替身模拟 InnoDB 的三个关键语义，
 * 仅覆盖更正/通用编辑/软删除三个写入口所需的最小事实面：
 *
 * 1. REPEATABLE READ 事务快照：事务开始时捕获状态快照，非锁定读（普通 SELECT）
 *    永远返回本事务快照（不看到并发事务的提交）；
 * 2. 锁定读（SELECT ... FOR UPDATE，即 findDetail({ forUpdate: true })）是当前读
 *    并持有行锁：依次排队、读到最新已提交状态，锁保持到事务结束（run 返回/抛错）；
 * 3. 行写（UPDATE）同样需要行锁：主资料条件更新（deprecated=false）未命中时
 *    返回 NOT_FOUND 状态事实。
 *
 * 这不是真实数据库并发测试（真实连接与同步屏障在 e2e 补验）；它的价值是以
 * 确定性调度构造「快照交错」与「锁串行化」两种执行，证明合并必须走锁定读。
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

  const toDetailView = (source: DbState) => {
    if (source.document.deprecated) {
      throw new DomainError(REFERENCE_DOCUMENT_ERROR.NOT_FOUND, '参考资料不存在或不可访问');
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
      createdByAccountId: 900001,
      storageReference: source.document.storageReference,
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
  };

  // —— 写侧替身：行写同样通过行锁串行化；条件更新未命中返回状态事实 ——
  const referenceDocumentService = {
    updateDocument: jest.fn(
      async (
        data: {
          title: string;
          documentType: string;
          equipmentModelId: number | null;
          equipmentModelText?: string | null;
          description: string | null;
          contentText: string | null;
        },
        transactionContext?: unknown,
      ) => {
        const context = transactionContext as MockTransactionContext;
        await context.acquireRowLock();
        if (state.document.deprecated) {
          throw new DomainError(REFERENCE_DOCUMENT_ERROR.NOT_FOUND, '参考资料不存在或不可编辑');
        }
        state.document.title = data.title;
        state.document.documentType = data.documentType;
        state.document.equipmentModelId = data.equipmentModelId;
        if (data.equipmentModelText !== undefined) {
          state.document.equipmentModelText = data.equipmentModelText;
        }
        state.document.description = data.description;
        state.document.contentText = data.contentText;
        return { id: 970001 };
      },
    ),
    softDeleteDocument: jest.fn(
      async (params: { documentId: number }, transactionContext?: unknown) => {
        const context = transactionContext as MockTransactionContext;
        await context.acquireRowLock();
        if (state.document.deprecated) {
          return { kind: 'NOT_FOUND', id: params.documentId };
        }
        state.document.deprecated = true;
        return { kind: 'DELETED', id: params.documentId };
      },
    ),
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
      equipmentModelQueryService as unknown as EquipmentModelQueryService,
      organizationContextService as unknown as TrustedOrganizationContextQueryService,
      transactionRunner,
    ),
    update: new UpdateReferenceDocumentUsecase(
      referenceDocumentService as unknown as ReferenceDocumentService,
      referenceDocumentQueryService as unknown as ReferenceDocumentQueryService,
      equipmentModelQueryService as unknown as EquipmentModelQueryService,
      organizationContextService as unknown as TrustedOrganizationContextQueryService,
      transactionRunner,
    ),
    softDelete: new SoftDeleteReferenceDocumentUsecase(
      referenceDocumentService as unknown as ReferenceDocumentService,
      referenceDocumentQueryService as unknown as ReferenceDocumentQueryService,
      organizationContextService as unknown as TrustedOrganizationContextQueryService,
      transactionRunner,
    ),
  });

  return {
    state,
    transactionRunner,
    organizationContextService,
    referenceDocumentQueryService,
    referenceDocumentService,
    referenceDocumentCaseDetailService,
    makeUsecases,
  };
};

describe('正式资料写竞争受控交错（G2/F01）', () => {
  it('两个管理员并发更正不同字段：锁串行化 + 锁读最新事实后，两个补丁均保留', async () => {
    const bench = makeWriteRaceBench();
    const { correction } = bench.makeUsecases();

    const [resultA, resultB] = await Promise.all([
      correction.execute({
        session: writeSession(),
        documentId: 970001,
        patch: { errorCode: 'A-NEW' },
      }),
      correction.execute({
        session: writeSession(),
        documentId: 970001,
        patch: { conditionText: 'B-NEW' },
      }),
    ]);

    expect(resultA).toEqual({ id: 970001, updatedAt: expect.any(Date) });
    expect(resultB).toEqual({ id: 970001, updatedAt: expect.any(Date) });
    // 修复前（快照交错 + 全量覆盖）：后写者会用自身快照回退先写者字段，必有一项丢失
    expect(bench.state.detail.errorCode).toBe('A-NEW');
    expect(bench.state.detail.conditionText).toBe('B-NEW');
  });

  it('通用编辑（标题）与专属更正（明细）并发：两个入口共享同一资源锁，均不丢补丁', async () => {
    const bench = makeWriteRaceBench();
    const { correction, update } = bench.makeUsecases();

    await Promise.all([
      update.execute({
        session: writeSession(),
        documentId: 970001,
        patch: { title: '新标题' },
      }),
      correction.execute({
        session: writeSession(),
        documentId: 970001,
        patch: { conditionText: 'B-NEW' },
      }),
    ]);

    // 修复前：更正用旧快照的标题写回主资料（标题回退），通用编辑的修改丢失
    expect(bench.state.document.title).toBe('新标题');
    expect(bench.state.detail.conditionText).toBe('B-NEW');
  });

  it('更正/通用编辑的合并读必须走锁定读入口（findDetail({ forUpdate: true })）', async () => {
    const bench = makeWriteRaceBench();
    const { correction, update } = bench.makeUsecases();

    await correction.execute({
      session: writeSession(),
      documentId: 970001,
      patch: { errorCode: 'X-NEW' },
    });
    await update.execute({
      session: writeSession(),
      documentId: 970001,
      patch: { description: '说明' },
    });

    expect(bench.referenceDocumentQueryService.findDetail).toHaveBeenCalledWith(
      expect.objectContaining({ forUpdate: true }),
    );
  });

  it('软删除先提交、更正随后（更正事务快照早于软删提交）：更正拒绝，不产生下架后成功更正的假结果', async () => {
    const bench = makeWriteRaceBench();
    const { correction, softDelete } = bench.makeUsecases();

    // 受控交错：让更正事务先开始（捕获快照）并停在合并读之前，软删完整提交后再放行
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

    const correctionPromise = correction.execute({
      session: writeSession(),
      documentId: 970001,
      patch: { conditionText: 'B-NEW' },
    });
    // 等待更正事务推进到合并读的 gate 前（快照已建立）
    await new Promise<void>((resolve) => setImmediate(resolve));

    await softDelete.execute({ session: writeSession(), documentId: 970001 });
    expect(bench.state.document.deprecated).toBe(true);

    releaseGate();

    await expect(correctionPromise).rejects.toMatchObject({
      code: REFERENCE_DOCUMENT_ERROR.NOT_FOUND,
    });
    // 明细未被更正写入（同事务回滚语义由运行器替身模拟）
    expect(bench.state.detail.conditionText).toBe('OLD-COND');
    expect(bench.state.detail.errorCode).toBe('OLD-CODE');
  });
});
