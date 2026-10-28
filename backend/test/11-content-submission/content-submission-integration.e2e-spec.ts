// test/11-content-submission/content-submission-integration.e2e-spec.ts
//
// 投稿内容链路用例集成测试（PR0-S0-S5 修复计划 R6：V6/V7/V8/V9；R1 真实排序补充）
//
// 边界声明：本规格直接调用真实 usecase + 真实 TypeOrmTransactionRunner + 真实
// MySQL + 真实本地文件存储，验证用例层内部行为，不经协议层。投稿链路（草稿/
// 送审/版本/审核/附件）的 GraphQL/REST 协议层真实请求验收见
// content-submission-graphql.e2e-spec.ts（S7 已接入协议入口）。
//
// 存储隔离：本规格使用运行级临时上传目录（mkdtemp，先于应用初始化设置 env），
// 结束后按精确路径删除本测试拥有的目录与数据，不污染默认 var/。
//
// SCI-1（V7）并发说明：并发用例通过 Promise.all/Promise.allSettled 同时发起
// 多个用例调用，每次调用经 TypeOrmTransactionRunner 从连接池获取独立连接、
// 在数据库层以投稿行锁（SELECT ... FOR UPDATE）串行化，属真实独立连接竞争。
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DataSource, type QueryRunner, Repository } from 'typeorm';

import type { UsecaseSession } from '@app-types/auth/session.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import { CONTENT_SUBMISSION_ERROR } from '@core/common/errors/domain-error';
import { ApiModule } from '@src/bootstraps/api/api.module';
import { AccountEntity } from '@src/modules/account/base/entities/account.entity';
import { ContentSubmissionService } from '@src/modules/lithography/content-submission.service';
import { ContentSubmissionAttachmentEntity } from '@src/modules/lithography/entities/content-submission-attachment.entity';
import { ContentSubmissionEntity } from '@src/modules/lithography/entities/content-submission.entity';
import { ContentSubmissionReviewEntity } from '@src/modules/lithography/entities/content-submission-review.entity';
import { ContentSubmissionRevisionEntity } from '@src/modules/lithography/entities/content-submission-revision.entity';
import { ReferenceDocumentCaseDetailEntity } from '@src/modules/lithography/entities/reference-document-case-detail.entity';
import { ReferenceDocumentEntity } from '@src/modules/lithography/entities/reference-document.entity';
import { LocalReferenceDocumentStorage } from '@src/infrastructure/file-storage/local-reference-document-storage';
import { ApproveContentSubmissionUsecase } from '@src/usecases/content-submission/approve-content-submission.usecase';
import { CONTENT_SUBMISSION_ATTACHMENT_STORAGE } from '@src/usecases/content-submission/content-submission-attachment-storage.contract';
import { CreateContentSubmissionDraftUsecase } from '@src/usecases/content-submission/create-content-submission-draft.usecase';
import { GetContentSubmissionRevisionUsecase } from '@src/usecases/content-submission/get-content-submission-revision.usecase';
import { ListReviewQueueUsecase } from '@src/usecases/content-submission/list-review-queue.usecase';
import { ReturnContentSubmissionUsecase } from '@src/usecases/content-submission/return-content-submission.usecase';
import { SubmitContentSubmissionUsecase } from '@src/usecases/content-submission/submit-content-submission.usecase';
import { UpdateContentSubmissionDraftUsecase } from '@src/usecases/content-submission/update-content-submission-draft.usecase';
import { UploadContentSubmissionAttachmentUsecase } from '@src/usecases/content-submission/upload-content-submission-attachment.usecase';
import { SoftDeleteReferenceDocumentUsecase } from '@src/usecases/reference-document/soft-delete-reference-document.usecase';

import { initGraphQLSchema } from '../../src/adapters/api/graphql/schema/schema.init';
import { BarrierAttachmentStorage, sha256Hex } from './attachment-storage-barrier';
import {
  createOwnedResourceLedger,
  runGuardedSpecCleanup,
  toResidueAccountFingerprint,
} from '../utils/e2e-scoped-cleanup';
import { captureEnvValue, restoreEnvValue, runE2eTeardown } from '../utils/e2e-teardown';
import { seedTestAccounts, testAccountsConfig } from '../utils/test-accounts';
import {
  buildSuiteOrganizationCodes,
  requireOrganizationId,
  seedTestMemberships,
  seedTestOrganizations,
} from '../utils/test-organizations';

// 运行级临时存储目录：先于应用初始化设置 env，使配置加载时读到本规格专属目录。
// 原环境变量值先捕获，收尾时恢复原值（不假定原值不存在）。
const originalStorageDir = captureEnvValue('REFERENCE_DOCUMENT_STORAGE_DIR');
const e2eStorageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contsub-e2e-storage-'));
process.env.REFERENCE_DOCUMENT_STORAGE_DIR = e2eStorageRoot;

jest.setTimeout(60000);

/** Promise.allSettled 分拣守卫（类型层面收窄，避免非空断言猜测） */
const isFulfilled = <T>(result: PromiseSettledResult<T>): result is PromiseFulfilledResult<T> =>
  result.status === 'fulfilled';
const isRejected = <T>(result: PromiseSettledResult<T>): result is PromiseRejectedResult =>
  result.status === 'rejected';

describe('投稿内容链路用例集成 (V6-V9)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  let submissionRepository: Repository<ContentSubmissionEntity>;
  let attachmentRepository: Repository<ContentSubmissionAttachmentEntity>;
  let revisionRepository: Repository<ContentSubmissionRevisionEntity>;
  let reviewRepository: Repository<ContentSubmissionReviewEntity>;
  let documentRepository: Repository<ReferenceDocumentEntity>;
  let caseDetailRepository: Repository<ReferenceDocumentCaseDetailEntity>;

  let createDraft: CreateContentSubmissionDraftUsecase;
  let updateDraft: UpdateContentSubmissionDraftUsecase;
  let uploadAttachment: UploadContentSubmissionAttachmentUsecase;
  let submit: SubmitContentSubmissionUsecase;
  let getRevision: GetContentSubmissionRevisionUsecase;
  let listReviewQueue: ListReviewQueueUsecase;
  let returnSubmission: ReturnContentSubmissionUsecase;
  let approve: ApproveContentSubmissionUsecase;
  let softDeleteDocument: SoftDeleteReferenceDocumentUsecase;
  let contentSubmissionService: ContentSubmissionService;
  /** 测试专用存储委托：真实 open/save/delete + 可控屏障（默认 off，仅 N03 场景启用） */
  let storageBarrier: BarrierAttachmentStorage;

  // 规格专属测试组织（不借用开发库默认组织；编码带 E2E 前缀，清理以编码为界）
  const suiteOrganizationCodes = buildSuiteOrganizationCodes('CONTSUB');
  let primaryOrganizationId = 0;
  const ownership = createOwnedResourceLedger();

  let engineerSession: UsecaseSession;
  let adminSession: UsecaseSession;

  const storageFiles = (): string[] =>
    fs.existsSync(e2eStorageRoot) ? fs.readdirSync(e2eStorageRoot).sort() : [];

  const readStoredBytes = (storageReference: string): Buffer =>
    fs.readFileSync(path.join(e2eStorageRoot, storageReference));

  const findAccountIdByLoginName = async (loginName: string): Promise<number> => {
    const account = await dataSource.getRepository(AccountEntity).findOne({ where: { loginName } });
    if (!account) {
      throw new Error(`测试账号初始化失败：未找到 ${loginName}`);
    }
    return account.id;
  };

  /** 建立 MATERIAL 草稿（V6/V7-1/V7-2/V8 共用最小完整形态） */
  const createMaterialDraft = async (title: string, contentText: string): Promise<number> => {
    const draft = await createDraft.execute({
      session: engineerSession,
      kind: 'MATERIAL',
      fields: {
        title,
        documentType: 'MAINTENANCE_GUIDE',
        contentText,
        equipmentModelText: '投稿集成测试机型',
      },
    });
    expect(draft.status).toBe('DRAFT');
    return draft.id;
  };

  /** 上传附件（本人 DRAFT/RETURNED；扩展名白名单以 .txt 为例） */
  const uploadTextAttachment = async (
    submissionId: number,
    originalFilename: string,
    content: string,
  ) => {
    return uploadAttachment.execute({
      session: engineerSession,
      submissionId,
      file: { buffer: Buffer.from(content), originalFilename },
    });
  };

  /** W01–W07：记录真实连接的事务隔离级别（R01 前提：REPEATABLE-READ） */
  const readTransactionIsolation = async (): Promise<string> => {
    const rows: Array<{ isolation?: string }> = await dataSource.query(
      'SELECT @@transaction_isolation AS isolation',
    );
    return (rows[0]?.isolation ?? '').toUpperCase();
  };

  /**
   * 真实独立连接持投稿主表行锁：用于在竞争事务建立 RR 快照后、释放主行锁前
   * 提交一笔已完成的保存/附件变更，确定性复现「主表锁后普通读旧快照」。
   */
  const openHeldSubmissionLock = async (submissionId: number): Promise<QueryRunner> => {
    const runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    const rows: Array<{ id: number }> = await runner.query(
      'SELECT id FROM content_submission WHERE id = ? FOR UPDATE',
      [submissionId],
    );
    if (rows.length !== 1) {
      await runner.rollbackTransaction();
      await runner.release();
      throw new Error(`W 用例未能锁定投稿主行：${submissionId}`);
    }
    return runner;
  };

  /**
   * 屏障：等待竞争 usecase 真正发起「投稿主行锁」尝试。
   * 该调用发生在事务内首个一致性读（组织/成员解析）之后，因此收到信号即证明
   * 竞争事务的 REPEATABLE-READ 快照已建立；此时释放持锁连接即可确定性复现
   * 「主表锁后普通读旧快照」。
   *
   * 观测方式：测试侧对真实 service 实例做委托包装（先调用真实实现，再发信号），
   * 不替换实现、不改变锁行为，也不在 src 注入测试钩子。隔离账号无权读取
   * performance_schema/information_schema.INNODB_TRX，故不使用系统视图。
   */
  type LockAttemptWaiter = { submissionId: number; settled: boolean; resolve: () => void };
  type LockParker = {
    submissionId: number;
    used: boolean;
    parked: () => void;
    gate: Promise<void>;
  };
  let lockAttemptWaiters: LockAttemptWaiter[] = [];
  let lockParkers: LockParker[] = [];
  let restoreLockAttemptSignal: (() => void) | null = null;

  const signalLockAttempt = (submissionId: number): void => {
    const pending = lockAttemptWaiters.filter(
      (waiter) => waiter.submissionId === submissionId && !waiter.settled,
    );
    for (const waiter of pending) {
      waiter.settled = true;
      waiter.resolve();
    }
    lockAttemptWaiters = lockAttemptWaiters.filter((waiter) => !waiter.settled);
  };

  /**
   * W07 专用：让「送审」在持主行锁后停住，便于在其提交前启动晚到写，
   * 使晚到写先建立旧快照、再排队等锁。返回 parked（已持锁停住）与 release。
   */
  const parkNextLockAttempt = (
    submissionId: number,
  ): { parked: Promise<void>; release: () => void } => {
    let releaseGate: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let markParked: () => void = () => undefined;
    const parked = new Promise<void>((resolve) => {
      markParked = resolve;
    });
    lockParkers.push({ submissionId, used: false, parked: markParked, gate });
    return { parked, release: releaseGate };
  };

  const installLockAttemptSignal = (): void => {
    const original = contentSubmissionService.lockSubmissionForWrite.bind(contentSubmissionService);
    contentSubmissionService.lockSubmissionForWrite = async (submissionId, transactionContext) => {
      const pending = original(submissionId, transactionContext);
      // 发起锁请求即发信号：此前的组织/成员解析已建立 RR 快照，持锁方可安全提交
      signalLockAttempt(submissionId);
      const snapshot = await pending;
      const parker = lockParkers.find(
        (candidate) => candidate.submissionId === submissionId && !candidate.used,
      );
      if (parker) {
        parker.used = true;
        parker.parked();
        await parker.gate;
      }
      return snapshot;
    };
    restoreLockAttemptSignal = () => {
      contentSubmissionService.lockSubmissionForWrite = original;
      lockAttemptWaiters = [];
      lockParkers = [];
      restoreLockAttemptSignal = null;
    };
  };

  /**
   * 在启动竞争请求之前创建本轮等待句柄：信号若先于 `wait()` 到达，结果被保留，
   * 不会因 waiter 尚未注册而丢失（旧实现只唤醒已注册 waiter）。
   * 每轮使用独立句柄，历史轮的信号不会满足本轮；超时后自动移除 waiter。
   */
  const expectLockAttempt = (
    submissionId: number,
  ): { wait: (timeoutMs?: number) => Promise<void> } => {
    let markArrived: () => void = () => undefined;
    const arrived = new Promise<void>((resolve) => {
      markArrived = resolve;
    });
    const waiter: LockAttemptWaiter = {
      submissionId,
      settled: false,
      resolve: () => {
        waiter.settled = true;
        markArrived();
      },
    };
    lockAttemptWaiters.push(waiter);

    return {
      wait: (timeoutMs = 15000): Promise<void> =>
        new Promise<void>((resolve, reject) => {
          if (waiter.settled) {
            resolve();
            return;
          }
          const timer = setTimeout(() => {
            if (waiter.settled) {
              return;
            }
            waiter.settled = true;
            lockAttemptWaiters = lockAttemptWaiters.filter((candidate) => candidate !== waiter);
            reject(new Error(`等待投稿 ${submissionId} 的写前主行锁尝试超时`));
          }, timeoutMs);
          void arrived.then(() => {
            clearTimeout(timer);
            resolve();
          });
        }),
    };
  };

  const closeHeldSubmissionLock = async (runner: QueryRunner): Promise<void> => {
    if (runner.isTransactionActive) {
      await runner.rollbackTransaction();
    }
    await runner.release();
  };

  type Settled<T> = { status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown };

  const guardSettlement = <T>(promise: Promise<T>): Promise<Settled<T>> =>
    promise.then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason) => ({ status: 'rejected' as const, reason }),
    );

  const readMaterialDetailRow = async (
    submissionId: number,
  ): Promise<{ title: string; description: string | null; contentText: string | null }> => {
    const rows: Array<{
      title: string;
      description: string | null;
      content_text: string | null;
    }> = await dataSource.query(
      'SELECT title, description, content_text FROM material_submission_detail WHERE submission_id = ?',
      [submissionId],
    );
    const row = rows[0];
    if (!row) {
      throw new Error(`未找到资料明细：${submissionId}`);
    }
    return { title: row.title, description: row.description, contentText: row.content_text };
  };

  /** W06：确认该投稿仅有一条附件记录（移除后不新增、不复用） */
  const attachmentCountForSubmission = async (submissionId: number): Promise<number> => {
    const rows: Array<{ total: number | string }> = await dataSource.query(
      'SELECT COUNT(*) AS total FROM content_submission_attachment WHERE submission_id = ?',
      [submissionId],
    );
    return Number(rows[0]?.total ?? 0);
  };

  // W01–W07 交错屏障：委托包装真实 lockSubmissionForWrite（仅在测试侧），
  // 用于观测「已经发起主行锁请求」与 W07 的持锁停靠；用例结束即恢复。
  beforeEach(() => {
    installLockAttemptSignal();
  });

  afterEach(() => {
    restoreLockAttemptSignal?.();
  });

  beforeAll(async () => {
    initGraphQLSchema();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ApiModule],
    })
      // N03：仅在本规格替换附件存储 token 为「真实本地存储 + 可控屏障」的测试委托。
      // 委托内部转发真实 LocalReferenceDocumentStorage（同一存储根、真实写入），
      // 默认 off；生产装配与其他规格不受影响
      .overrideProvider(CONTENT_SUBMISSION_ATTACHMENT_STORAGE)
      .useFactory({
        inject: [LocalReferenceDocumentStorage],
        factory: (realStorage: LocalReferenceDocumentStorage) =>
          (storageBarrier = new BarrierAttachmentStorage(realStorage)),
      })
      .compile();

    app = moduleFixture.createNestApplication();
    dataSource = app.get(DataSource);
    contentSubmissionService = app.get(ContentSubmissionService);

    submissionRepository = dataSource.getRepository(ContentSubmissionEntity);
    attachmentRepository = dataSource.getRepository(ContentSubmissionAttachmentEntity);
    revisionRepository = dataSource.getRepository(ContentSubmissionRevisionEntity);
    reviewRepository = dataSource.getRepository(ContentSubmissionReviewEntity);
    documentRepository = dataSource.getRepository(ReferenceDocumentEntity);
    caseDetailRepository = dataSource.getRepository(ReferenceDocumentCaseDetailEntity);

    createDraft = app.get(CreateContentSubmissionDraftUsecase);
    updateDraft = app.get(UpdateContentSubmissionDraftUsecase);
    uploadAttachment = app.get(UploadContentSubmissionAttachmentUsecase);
    submit = app.get(SubmitContentSubmissionUsecase);
    getRevision = app.get(GetContentSubmissionRevisionUsecase);
    listReviewQueue = app.get(ListReviewQueueUsecase);
    returnSubmission = app.get(ReturnContentSubmissionUsecase);
    approve = app.get(ApproveContentSubmissionUsecase);
    softDeleteDocument = app.get(SoftDeleteReferenceDocumentUsecase);

    await app.init();

    // 预清理：组织/账号均按完整指纹回收已知残留；投稿链由本轮 owned 组织/账号预检圈定
    await runGuardedSpecCleanup({
      dataSource,
      residue: {
        organizations: [
          {
            organizationCode: suiteOrganizationCodes.primary,
            name: '投稿集成测试甲方组织',
            kind: 'CLIENT',
          },
        ],
        accounts: [testAccountsConfig.staffPrimary, testAccountsConfig.admin].map(
          toResidueAccountFingerprint,
        ),
      },
      helper: 'content-submission-integration.e2e-spec beforeAll 预清理',
    });

    await seedTestAccounts({
      dataSource,
      includeKeys: ['staffPrimary', 'admin'],
      ownership,
    });

    // 甲方组织：admin 管理员 + staffPrimary 工程师（成员关系不借用开发库默认组织）
    const organizationIds = await seedTestOrganizations({
      dataSource,
      organizations: [
        {
          organizationCode: suiteOrganizationCodes.primary,
          name: '投稿集成测试甲方组织',
          kind: 'CLIENT',
        },
      ],
      ownership,
    });
    primaryOrganizationId = requireOrganizationId(organizationIds, suiteOrganizationCodes.primary);
    await seedTestMemberships({
      dataSource,
      memberships: [
        {
          accountLoginName: testAccountsConfig.staffPrimary.loginName,
          organizationCode: suiteOrganizationCodes.primary,
          memberRole: 'ENGINEER',
        },
        {
          accountLoginName: testAccountsConfig.admin.loginName,
          organizationCode: suiteOrganizationCodes.primary,
          memberRole: 'SUPER_ADMIN',
        },
      ],
      organizationIdsByCode: organizationIds,
      ownership,
    });

    const engineerAccountId = await findAccountIdByLoginName(
      testAccountsConfig.staffPrimary.loginName,
    );
    const adminAccountId = await findAccountIdByLoginName(testAccountsConfig.admin.loginName);

    engineerSession = {
      accountId: engineerAccountId,
      roles: [IdentityTypeEnum.ENGINEER],
      activeRole: IdentityTypeEnum.ENGINEER,
    };
    adminSession = {
      accountId: adminAccountId,
      roles: [IdentityTypeEnum.SUPER_ADMIN],
      activeRole: IdentityTypeEnum.SUPER_ADMIN,
    };
  });

  afterAll(async () => {
    await runE2eTeardown({
      cleanup: async () => {
        if (dataSource?.isInitialized) {
          await runGuardedSpecCleanup({
            dataSource,
            owned: ownership,
            helper: 'content-submission-integration.e2e-spec afterAll 收尾',
          });
        }
      },
      finalize: () => {
        // 临时存储目录按精确路径清理，并恢复捕获时的原环境变量值
        fs.rmSync(e2eStorageRoot, { recursive: true, force: true });
        restoreEnvValue('REFERENCE_DOCUMENT_STORAGE_DIR', originalStorageDir);
      },
      closeApp: app
        ? async () => {
            await app.close();
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        : null,
    });
  });

  it('V6 退回重提：版本1→退回→改正文/换附件→版本2；旧快照、原件与审核事实保持不变', async () => {
    const submissionId = await createMaterialDraft('V6 退回重提样本', '版本1正文：初始内容。');

    // 版本 1：附件 A + 送审
    const attachmentA = await uploadTextAttachment(
      submissionId,
      'v6-a.txt',
      'v6-attachment-a-bytes',
    );
    const submitted1 = await submit.execute({
      session: engineerSession,
      submissionId,
      libraryNoticeConfirmed: true,
    });
    expect(submitted1).toMatchObject({ revisionNo: 1, status: 'PENDING_REVIEW' });

    const snapshot1Before = await getRevision.execute({
      session: engineerSession,
      submissionId,
      revisionNo: 1,
    });
    expect(snapshot1Before.payloadSnapshot).toMatchObject({ contentText: '版本1正文：初始内容。' });
    expect(snapshot1Before.attachment?.id).toBe(attachmentA.attachmentId);

    // 附件 A 的冻结存储引用（退回后不得变化）
    const rowABefore = await attachmentRepository.findOneByOrFail({
      id: attachmentA.attachmentId,
    });

    // 管理员退回：审核事实落库（RETURN 必填理由、不发布附件）
    const returned = await returnSubmission.execute({
      session: adminSession,
      submissionId,
      revisionId: submitted1.revisionId,
      comment: '请修改正文并更换附件后重新送审。',
    });
    expect(returned).toMatchObject({ status: 'RETURNED', documentId: null });

    // 退回后编辑正文 + 替换附件 B
    await updateDraft.execute({
      session: engineerSession,
      submissionId,
      patch: { contentText: '版本2正文：按审核意见修改。' },
    });
    const attachmentB = await uploadTextAttachment(
      submissionId,
      'v6-b.txt',
      'v6-attachment-b-bytes',
    );
    expect(attachmentB.attachmentId).not.toBe(attachmentA.attachmentId);

    // 重提：版本 2
    const submitted2 = await submit.execute({
      session: engineerSession,
      submissionId,
      libraryNoticeConfirmed: true,
    });
    expect(submitted2).toMatchObject({ revisionNo: 2, status: 'PENDING_REVIEW' });

    // —— 断言：版本 1 快照冻结不变（正文与附件引用均为送审当次事实）——
    const snapshot1After = await getRevision.execute({
      session: engineerSession,
      submissionId,
      revisionNo: 1,
    });
    expect(snapshot1After.payloadSnapshot).toEqual(snapshot1Before.payloadSnapshot);
    expect(snapshot1After.attachment?.id).toBe(attachmentA.attachmentId);

    // —— 断言：版本 2 快照为修改后内容 + 新附件 ——
    const snapshot2 = await getRevision.execute({
      session: engineerSession,
      submissionId,
      revisionNo: 2,
    });
    expect(snapshot2.payloadSnapshot).toMatchObject({
      contentText: '版本2正文：按审核意见修改。',
    });
    expect(snapshot2.attachment?.id).toBe(attachmentB.attachmentId);

    // —— 断言：审核事实保持（仍绑定版本 1；理由未变）——
    const reviews = await reviewRepository.find({ where: { submissionId }, order: { id: 'ASC' } });
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      decision: 'RETURN',
      revisionId: submitted1.revisionId,
      publishAttachment: false,
      comment: '请修改正文并更换附件后重新送审。',
    });

    // —— 断言：原件 A 只退役不删除（DB 行保留、引用未变、物理文件字节一致）——
    const rowAAfter = await attachmentRepository.findOneByOrFail({ id: attachmentA.attachmentId });
    expect(rowAAfter).toMatchObject({
      status: 'RETIRED',
      storageReference: rowABefore.storageReference,
    });
    expect(rowAAfter.retiredAt).not.toBeNull();
    expect(readStoredBytes(rowABefore.storageReference).toString()).toBe('v6-attachment-a-bytes');

    // —— 断言：附件 B 为当前有效，物理文件存在 ——
    const rowB = await attachmentRepository.findOneByOrFail({ id: attachmentB.attachmentId });
    expect(rowB.status).toBe('CURRENT');
    expect(readStoredBytes(rowB.storageReference).toString()).toBe('v6-attachment-b-bytes');

    // —— 断言：至多一个 CURRENT ——
    const currentRows = await attachmentRepository.find({
      where: { submissionId, status: 'CURRENT' },
    });
    expect(currentRows).toHaveLength(1);
  });

  it('V7-1 并发附件替换：真实独立连接同时上传，最终恰一个 CURRENT 且两副本均不丢失', async () => {
    const submissionId = await createMaterialDraft('V7-1 并发上传样本', '并发上传正文。');

    const settled = await Promise.allSettled([
      uploadTextAttachment(submissionId, 'v7-1-a.txt', 'v7-1-concurrent-a-bytes'),
      uploadTextAttachment(submissionId, 'v7-1-b.txt', 'v7-1-concurrent-b-bytes'),
    ]);
    const successes = settled.filter(isFulfilled);
    const failures = settled.filter(isRejected);
    // 行锁串行化：两个上传都在可编辑状态上完成（后来者替换先到者），不产生状态冲突
    expect(failures).toHaveLength(0);
    expect(successes).toHaveLength(2);
    expect(successes[0].value.attachmentId).not.toBe(successes[1].value.attachmentId);

    const rows = await attachmentRepository.find({ where: { submissionId }, order: { id: 'ASC' } });
    expect(rows).toHaveLength(2);

    // 最终恰一个 CURRENT（先到者的附件被退役），两个副本的物理文件都在且内容不混淆
    const currentRows = rows.filter((row) => row.status === 'CURRENT');
    const retiredRows = rows.filter((row) => row.status === 'RETIRED');
    expect(currentRows).toHaveLength(1);
    expect(retiredRows).toHaveLength(1);
    expect(retiredRows[0].retiredAt).not.toBeNull();

    const storedContents = rows
      .map((row) => readStoredBytes(row.storageReference).toString())
      .sort();
    expect(storedContents).toEqual(['v7-1-concurrent-a-bytes', 'v7-1-concurrent-b-bytes'].sort());
  });

  it('V7-2 并发送审：真实独立连接同时送审，恰好一次成功且版本号只增加一次', async () => {
    const submissionId = await createMaterialDraft('V7-2 并发送审样本', '并发送审正文。');

    const settled = await Promise.allSettled([
      submit.execute({ session: engineerSession, submissionId, libraryNoticeConfirmed: true }),
      submit.execute({ session: engineerSession, submissionId, libraryNoticeConfirmed: true }),
    ]);
    const successes = settled.filter(isFulfilled);
    const failures = settled.filter(isRejected);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(successes[0].value).toMatchObject({ revisionNo: 1, status: 'PENDING_REVIEW' });
    // 后来者在行锁内看到已流转的待审状态被拒绝（不产生第二个版本）
    expect(failures[0].reason).toMatchObject({
      name: 'DomainError',
      code: CONTENT_SUBMISSION_ERROR.STATE_NOT_EDITABLE,
    });

    const revisions = await revisionRepository.find({ where: { submissionId } });
    expect(revisions).toHaveLength(1);
    const row = await submissionRepository.findOneByOrFail({ id: submissionId });
    expect(row).toMatchObject({ status: 'PENDING_REVIEW', currentRevisionNo: 1 });
  });

  it('V7-3 并发审核通过：真实独立连接同时审批，恰好一次发布成功且正式资料仅一份', async () => {
    const submissionId = await createMaterialDraft('V7-3 并发审核样本', '并发审核正文。');
    const submitted = await submit.execute({
      session: engineerSession,
      submissionId,
      libraryNoticeConfirmed: true,
    });

    const settled = await Promise.allSettled([
      approve.execute({
        session: adminSession,
        submissionId,
        revisionId: submitted.revisionId,
        publishAttachment: false,
        comment: null,
      }),
      approve.execute({
        session: adminSession,
        submissionId,
        revisionId: submitted.revisionId,
        publishAttachment: false,
        comment: null,
      }),
    ]);
    const successes = settled.filter(isFulfilled);
    const failures = settled.filter(isRejected);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(successes[0].value).toMatchObject({ status: 'PUBLISHED' });
    expect(successes[0].value.documentId).not.toBeNull();
    expect(failures[0].reason).toMatchObject({
      name: 'DomainError',
      code: CONTENT_SUBMISSION_ERROR.STATE_NOT_EDITABLE,
    });

    // 唯一来源约束 + 单次发布：正式资料仅一份、APPROVE 审核记录仅一条
    const documents = await documentRepository.find({
      where: { sourceSubmissionId: submissionId },
    });
    expect(documents).toHaveLength(1);
    const approveReviews = await reviewRepository.find({
      where: { submissionId, decision: 'APPROVE' },
    });
    expect(approveReviews).toHaveLength(1);
    const row = await submissionRepository.findOneByOrFail({ id: submissionId });
    expect(row.status).toBe('PUBLISHED');
    expect(row.publishedAt).not.toBeNull();
  });

  it('V7-4 并发审核均发布附件：真实独立连接同时审批，一份发布、失败副本精确清理、冻结原件保留', async () => {
    const submissionId = await createMaterialDraft('V7-4 并发发布附件样本', '并发发布附件正文。');
    const attachment = await uploadTextAttachment(submissionId, 'v7-4.txt', 'v7-4-original-bytes');
    const originalRow = await attachmentRepository.findOneByOrFail({
      id: attachment.attachmentId,
    });
    const submitted = await submit.execute({
      session: engineerSession,
      submissionId,
      libraryNoticeConfirmed: true,
    });

    // 两个审批请求同选 publishAttachment=true（各自复制获准原件为正式副本），
    // 经 Promise.all 以真实独立连接同时发起（见头部 SCI-1 说明）；
    // 「两请求已各复制文件」的确定性交错由受控替身单测覆盖，本用例走真实
    // MySQL/文件存储路径验证补偿结果，不冒充精确时序注入。
    const filesBefore = storageFiles();
    const settled = await Promise.allSettled([
      approve.execute({
        session: adminSession,
        submissionId,
        revisionId: submitted.revisionId,
        publishAttachment: true,
        comment: null,
      }),
      approve.execute({
        session: adminSession,
        submissionId,
        revisionId: submitted.revisionId,
        publishAttachment: true,
        comment: null,
      }),
    ]);
    const successes = settled.filter(isFulfilled);
    const failures = settled.filter(isRejected);
    // 行锁重核：恰一次发布成功，另一次在事务内重核状态已流转被拒
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(successes[0].value).toMatchObject({ status: 'PUBLISHED' });
    expect(failures[0].reason).toMatchObject({
      name: 'DomainError',
      code: CONTENT_SUBMISSION_ERROR.STATE_NOT_EDITABLE,
    });

    // 唯一来源约束 + 单次发布：正式资料仅一份、APPROVE 审核记录仅一条
    const documents = await documentRepository.find({
      where: { sourceSubmissionId: submissionId },
    });
    expect(documents).toHaveLength(1);
    expect(
      await reviewRepository.find({ where: { submissionId, decision: 'APPROVE' } }),
    ).toHaveLength(1);
    const publishedDoc = documents[0];
    if (publishedDoc.storageReference === null) {
      throw new Error('发布未生成正式存储引用，后续断言无法继续');
    }

    // 成功副本可读且与冻结原件同字节；冻结原件保留不删除、不覆盖
    expect(publishedDoc.storageReference).not.toBe(originalRow.storageReference);
    expect(readStoredBytes(publishedDoc.storageReference).toString()).toBe('v7-4-original-bytes');
    expect(readStoredBytes(originalRow.storageReference).toString()).toBe('v7-4-original-bytes');

    // 失败方若已复制其副本，必须被精确清理：目录只新增「成功正式副本」一个文件，
    // 且不删除任何既有文件（失败副本零残留）
    const filesAfter = storageFiles();
    const added = filesAfter.filter((name) => !filesBefore.includes(name));
    const removed = filesBefore.filter((name) => !filesAfter.includes(name));
    expect(added).toEqual([publishedDoc.storageReference]);
    expect(removed).toEqual([]);
  });

  it('V8 真实故障路径：不可编辑状态拒绝不触盘；获准原件缺失受控失败且无残留副本', async () => {
    // —— A) 待审状态上传：授权先于文件 I/O，请求被拒绝且存储目录不产生任何新文件 ——
    const pendingSubmissionId = await createMaterialDraft('V8-A 状态拒绝样本', '状态拒绝正文。');
    await submit.execute({
      session: engineerSession,
      submissionId: pendingSubmissionId,
      libraryNoticeConfirmed: true,
    });

    const filesBeforeReject = storageFiles();
    await expect(
      uploadTextAttachment(pendingSubmissionId, 'v8-a.txt', 'v8-a-should-not-persist'),
    ).rejects.toMatchObject({
      name: 'DomainError',
      code: CONTENT_SUBMISSION_ERROR.STATE_NOT_EDITABLE,
    });
    expect(storageFiles()).toEqual(filesBeforeReject);

    // —— B) 审核发布阶段获准原件不可用：受控失败、投稿仍待审、无正式资料、无新副本 ——
    const missingFileSubmissionId = await createMaterialDraft(
      'V8-B 原件缺失样本',
      '原件缺失正文。',
    );
    const missingAttachment = await uploadTextAttachment(
      missingFileSubmissionId,
      'v8-b.txt',
      'v8-b-original-bytes',
    );
    const submittedB = await submit.execute({
      session: engineerSession,
      submissionId: missingFileSubmissionId,
      libraryNoticeConfirmed: true,
    });

    // 模拟存储侧原件丢失：按精确引用删除本测试拥有目录中的该文件（不批量扫描）
    const missingRow = await attachmentRepository.findOneByOrFail({
      id: missingAttachment.attachmentId,
    });
    fs.rmSync(path.join(e2eStorageRoot, missingRow.storageReference));

    const filesBeforeApprove = storageFiles();
    await expect(
      approve.execute({
        session: adminSession,
        submissionId: missingFileSubmissionId,
        revisionId: submittedB.revisionId,
        publishAttachment: true,
        comment: null,
      }),
    ).rejects.toMatchObject({
      name: 'DomainError',
      code: CONTENT_SUBMISSION_ERROR.FILE_NOT_AVAILABLE,
    });

    expect(storageFiles()).toEqual(filesBeforeApprove);
    expect(
      await documentRepository.find({ where: { sourceSubmissionId: missingFileSubmissionId } }),
    ).toHaveLength(0);
    expect(
      await reviewRepository.find({ where: { submissionId: missingFileSubmissionId } }),
    ).toHaveLength(0);
    const rowB = await submissionRepository.findOneByOrFail({ id: missingFileSubmissionId });
    expect(rowB.status).toBe('PENDING_REVIEW');

    // —— 与受控替身的区别（V8 要求标明）——
    // 本用例验证真实数据库/真实文件存储上的确定性故障路径（状态拒绝、来源缺失）。
    // 「回调已完成但 COMMIT 确认丢失」「提交终局不明」等不确定路径无法在真实
    // MySQL 上精确注入（需要控制连接在 COMMIT 瞬间断连），由受控替身单测覆盖：
    // - content-submission-attachments.usecases.spec.ts：COMMIT_ACK_LOST 控制流复现、
    //   落库失败补偿删除、终局不明保留、核查失败 fail-safe；
    // - content-submission-approve-review.usecases.spec.ts：发布补偿系列（含并发
    //   成功方引用其他副本时失败方精确清理）。
    // 两者区别：受控替身以代码控制 runner 在 COMMIT 阶段抛错，属模拟时序；
    // 真实 COMMIT 故障未在本集成测试注入，不得据此宣称已完成真实 COMMIT 故障测试。
  });

  it('V9 发布与软删：正式内容来自获准快照、案例明细一致；软删不改源投稿状态且不可再发布', async () => {
    // FAULT_CASE 草稿（必填字段齐全，已解决必须有结果）
    const draft = await createDraft.execute({
      session: engineerSession,
      kind: 'FAULT_CASE',
      fields: {
        title: 'V9 案例：光源同步异常',
        equipmentModelText: '投稿集成测试机型',
        errorCode: 'V9-ERR-100',
        phenomenon: '曝光期间同步误差超限。',
        conditionText: '连续曝光超过 20 分钟。',
        reproductionSteps: '1. 复现同步误差；2. 记录趋势。',
        diagnosis: '编码器信号噪声。',
        actionTaken: '更换编码器线缆。',
        handlingStatus: 'RESOLVED',
        resolution: '更换线缆后连续 5 批无异常。',
      },
    });
    const submissionId = draft.id;

    // 附件 + 送审（冻结快照）
    const attachmentUpload = await uploadTextAttachment(
      submissionId,
      'v9-report.txt',
      'v9-original-bytes',
    );
    const originalRow = await attachmentRepository.findOneByOrFail({
      id: attachmentUpload.attachmentId,
    });
    const submitted = await submit.execute({
      session: engineerSession,
      submissionId,
      libraryNoticeConfirmed: true,
    });
    const snapshot = await getRevision.execute({
      session: engineerSession,
      submissionId,
      revisionNo: submitted.revisionNo,
    });

    // 审核通过并发布附件（正式内容来自获准快照）
    const approved = await approve.execute({
      session: adminSession,
      submissionId,
      revisionId: submitted.revisionId,
      publishAttachment: true,
      comment: null,
    });
    expect(approved).toMatchObject({ status: 'PUBLISHED' });
    const documentId = approved.documentId;
    expect(documentId).not.toBeNull();
    if (documentId === null) {
      throw new Error('approve 结果 documentId 为 null，发布断言无法继续');
    }

    // —— 正式资料事实：标题来自快照、来源回链、组织归属、四列文件组 ——
    const document = await documentRepository.findOneByOrFail({ id: documentId });
    expect(document).toMatchObject({
      title: snapshot.titleSnapshot,
      ingestMethod: 'REVIEWED_SUBMISSION',
      sourceSubmissionId: submissionId,
      sourceRevisionId: submitted.revisionId,
      ownerOrganizationId: primaryOrganizationId,
      originalFilename: 'v9-report.txt',
      mimeType: 'text/plain',
      storageBackend: 'local',
    });

    // —— 案例可读正文由同一份冻结字段生成（与明细同源）——
    expect(document.contentText).toContain('错误码：V9-ERR-100');
    expect(document.contentText).toContain('故障现象：\n曝光期间同步误差超限。');
    expect(document.contentText).toContain('复现步骤：\n1. 复现同步误差；2. 记录趋势。');
    expect(document.contentText).toContain('处理状态：已解决');
    expect(document.contentText).toContain('处理结果：\n更换线缆后连续 5 批无异常。');

    // —— 结构化案例明细与送审快照一致 ——
    const caseDetail = await caseDetailRepository.findOneByOrFail({ documentId });
    expect(caseDetail).toMatchObject({
      errorCode: 'V9-ERR-100',
      handlingStatus: 'RESOLVED',
      phenomenon: '曝光期间同步误差超限。',
      reproductionSteps: '1. 复现同步误差；2. 记录趋势。',
      resolution: '更换线缆后连续 5 批无异常。',
    });
    expect(snapshot.payloadSnapshot).toMatchObject({
      errorCode: caseDetail.errorCode,
      handlingStatus: caseDetail.handlingStatus,
      phenomenon: caseDetail.phenomenon,
      reproductionSteps: caseDetail.reproductionSteps,
      resolution: caseDetail.resolution,
    });

    // —— 正式文件为发布时新副本：引用与冻结原件不同、字节一致；原件保留 ——
    expect(document.storageReference).not.toBe(originalRow.storageReference);
    expect(document.storageReference).not.toBeNull();
    expect(readStoredBytes(document.storageReference as string).toString()).toBe(
      'v9-original-bytes',
    );
    expect(readStoredBytes(originalRow.storageReference).toString()).toBe('v9-original-bytes');

    // —— 发布事实：投稿 PUBLISHED 且发布时间非空 ——
    const publishedRow = await submissionRepository.findOneByOrFail({ id: submissionId });
    expect(publishedRow.status).toBe('PUBLISHED');
    const publishedAtBefore = publishedRow.publishedAt;
    expect(publishedAtBefore).not.toBeNull();

    // —— 软删正式资料：不物理删除文件、不改源投稿发布状态 ——
    await softDeleteDocument.execute({ session: adminSession, documentId });
    const softDeleted = await documentRepository.findOneByOrFail({ id: documentId });
    expect(softDeleted.deprecated).toBe(true);
    expect(softDeleted.deletedAt).not.toBeNull();
    const rowAfterSoftDelete = await submissionRepository.findOneByOrFail({ id: submissionId });
    expect(rowAfterSoftDelete.status).toBe('PUBLISHED');
    expect(rowAfterSoftDelete.publishedAt?.getTime()).toBe(publishedAtBefore?.getTime());
    expect(readStoredBytes(document.storageReference as string).toString()).toBe(
      'v9-original-bytes',
    );

    // —— 不可再发布：已发布投稿再次审核被拒（状态不为待审），正式资料仍仅一份 ——
    await expect(
      approve.execute({
        session: adminSession,
        submissionId,
        revisionId: submitted.revisionId,
        publishAttachment: true,
        comment: null,
      }),
    ).rejects.toMatchObject({
      name: 'DomainError',
      code: CONTENT_SUBMISSION_ERROR.STATE_NOT_EDITABLE,
    });
    expect(
      await documentRepository.find({ where: { sourceSubmissionId: submissionId } }),
    ).toHaveLength(1);
  });

  it('N03-A 两请求先各自生成真实副本再竞争：恰一次发布、败者副本精确清理、原件保留', async () => {
    // 与 V7-4 的区别：V7-4 走随机并发（可能一方在另一方形副本前就失败），
    // 本用例用测试层存储委托把「两份真实副本都已落盘、尚未进入审批事务」
    // 变成确定性前置条件，再放行真实行锁竞争。
    const submissionId = await createMaterialDraft(
      'N03-A 确定性并发发布附件样本',
      'N03-A 并发发布正文。',
    );
    const attachment = await uploadTextAttachment(
      submissionId,
      'n03-a.txt',
      'n03-a-original-bytes',
    );
    const originalRow = await attachmentRepository.findOneByOrFail({ id: attachment.attachmentId });
    const submitted = await submit.execute({
      session: engineerSession,
      submissionId,
      libraryNoticeConfirmed: true,
    });

    const filesBefore = storageFiles();
    storageBarrier.activate('dual');
    const requests: Array<Promise<unknown>> = [];
    let settled: PromiseSettledResult<unknown>[] | null = null;
    let barrierReferences: string[];

    try {
      requests.push(
        approve.execute({
          session: adminSession,
          submissionId,
          revisionId: submitted.revisionId,
          publishAttachment: true,
          comment: null,
        }),
        approve.execute({
          session: adminSession,
          submissionId,
          revisionId: submitted.revisionId,
          publishAttachment: true,
          comment: null,
        }),
      );

      // —— 硬门槛：两份真实副本都必须先落盘且可读，才允许进入竞争 ——
      await storageBarrier.waitForSaved(2);
      barrierReferences = [...storageBarrier.saved];
      expect(barrierReferences).toHaveLength(2);
      expect(new Set(barrierReferences).size).toBe(2);
      for (const reference of barrierReferences) {
        expect(reference).not.toBe(originalRow.storageReference);
        expect(readStoredBytes(reference).toString()).toBe('n03-a-original-bytes');
      }
      // 副本已落盘但事务尚未开始：此时不应存在正式资料（证明是「先复制后竞争」）
      expect(
        await documentRepository.find({ where: { sourceSubmissionId: submissionId } }),
      ).toHaveLength(0);

      // —— 统一放行：两请求使用真实 TransactionRunner 与真实行锁竞争 ——
      storageBarrier.releaseAll();
      settled = await Promise.allSettled(requests);
    } finally {
      storageBarrier.releaseAll();
      if (settled === null) {
        await Promise.allSettled(requests);
      }
    }

    if (settled === null) {
      throw new Error('N03-A 并发请求未能收敛，无法断言');
    }
    const successes = settled.filter(isFulfilled);
    const failures = settled.filter(isRejected);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toMatchObject({
      name: 'DomainError',
      code: CONTENT_SUBMISSION_ERROR.STATE_NOT_EDITABLE,
    });

    // 按正式资料引用识别胜者/败者（不假设先发请求一定获胜）
    const documents = await documentRepository.find({
      where: { sourceSubmissionId: submissionId },
    });
    expect(documents).toHaveLength(1);
    const publishedDocument = documents[0];
    if (publishedDocument.storageReference === null) {
      throw new Error('N03-A 发布未生成正式存储引用，断言无法继续');
    }
    const winnerReference = publishedDocument.storageReference;
    expect(barrierReferences).toContain(winnerReference);
    const loserReference = barrierReferences.find((reference) => reference !== winnerReference);
    if (loserReference === undefined) {
      throw new Error('N03-A 未找到败者副本引用，无法验证精确清理');
    }

    // 胜者副本可读且字节正确
    expect(readStoredBytes(winnerReference).toString()).toBe('n03-a-original-bytes');
    // 败者副本已删除（禁用删除时本断言必然失败）
    expect(fs.existsSync(path.join(e2eStorageRoot, loserReference))).toBe(false);
    // 冻结原件保留、字节不变
    expect(readStoredBytes(originalRow.storageReference).toString()).toBe('n03-a-original-bytes');

    // 发布事实唯一：一份正式资料、一条 APPROVE、投稿 PUBLISHED
    expect(
      await reviewRepository.find({ where: { submissionId, decision: 'APPROVE' } }),
    ).toHaveLength(1);
    const submissionRow = await submissionRepository.findOneByOrFail({ id: submissionId });
    expect(submissionRow.status).toBe('PUBLISHED');

    // 其他既有文件不删除：目录只新增胜者正式副本
    const filesAfter = storageFiles();
    expect(filesAfter.filter((name) => !filesBefore.includes(name))).toEqual([winnerReference]);
    expect(filesBefore.filter((name) => !filesAfter.includes(name))).toEqual([]);
  });

  it('N03-B 不发布文件的请求先成功：已复制副本的败者事务内重核后精确清理', async () => {
    const submissionId = await createMaterialDraft(
      'N03-B 不发布优先样本',
      'N03-B 不发布优先正文。',
    );
    const attachment = await uploadTextAttachment(
      submissionId,
      'n03-b.txt',
      'n03-b-original-bytes',
    );
    const originalRow = await attachmentRepository.findOneByOrFail({ id: attachment.attachmentId });
    const submitted = await submit.execute({
      session: engineerSession,
      submissionId,
      libraryNoticeConfirmed: true,
    });

    const filesBefore = storageFiles();
    // 单请求屏障：成功方（不发布附件）本来不会复制文件，不能等两个 save 到齐
    storageBarrier.activate('single');
    const requests: Array<Promise<unknown>> = [];
    let settled: PromiseSettledResult<unknown>[] | null = null;
    let loserReference: string | null;

    try {
      // B：发布附件，真实保存副本后停在屏障（尚未进入审批事务）
      requests.push(
        approve.execute({
          session: adminSession,
          submissionId,
          revisionId: submitted.revisionId,
          publishAttachment: true,
          comment: null,
        }),
      );
      await storageBarrier.waitForSaved(1);
      loserReference = storageBarrier.saved[0];
      expect(readStoredBytes(loserReference).toString()).toBe('n03-b-original-bytes');
      expect(
        await documentRepository.find({ where: { sourceSubmissionId: submissionId } }),
      ).toHaveLength(0);

      // A：不发布附件，先完成真实事务并提交成功
      const winner = await approve.execute({
        session: adminSession,
        submissionId,
        revisionId: submitted.revisionId,
        publishAttachment: false,
        comment: null,
      });
      expect(winner).toMatchObject({ status: 'PUBLISHED' });
      expect(winner.documentId).not.toBeNull();

      // 放行 B：其事务重核发现已处理，进入失败补偿
      storageBarrier.releaseAll();
      settled = await Promise.allSettled(requests);
    } finally {
      storageBarrier.releaseAll();
      if (settled === null) {
        await Promise.allSettled(requests);
      }
    }

    if (settled === null) {
      throw new Error('N03-B 并发请求未能收敛，无法断言');
    }
    expect(settled).toHaveLength(1);
    expect(isRejected(settled[0])).toBe(true);
    if (!isRejected(settled[0])) {
      throw new Error('N03-B 发布附件请求本应失败但成功了');
    }
    expect(settled[0].reason).toMatchObject({
      name: 'DomainError',
      code: CONTENT_SUBMISSION_ERROR.STATE_NOT_EDITABLE,
    });

    // 正式资料无文件引用（成功方未发布附件），仅一份资料/一条 APPROVE
    const documents = await documentRepository.find({
      where: { sourceSubmissionId: submissionId },
    });
    expect(documents).toHaveLength(1);
    expect(documents[0].storageReference).toBeNull();
    expect(
      await reviewRepository.find({ where: { submissionId, decision: 'APPROVE' } }),
    ).toHaveLength(1);

    // 败者副本删除、冻结原件保留、其他既有文件不变
    if (loserReference === null) {
      throw new Error('N03-B 未记录败者副本引用，无法验证精确清理');
    }
    expect(fs.existsSync(path.join(e2eStorageRoot, loserReference))).toBe(false);
    expect(readStoredBytes(originalRow.storageReference).toString()).toBe('n03-b-original-bytes');
    const filesAfter = storageFiles();
    expect(filesAfter.filter((name) => !filesBefore.includes(name))).toEqual([]);
    expect(filesBefore.filter((name) => !filesAfter.includes(name))).toEqual([]);
  });

  it('N03-C 正式副本已落盘后真实事务回滚：无成功残留、副本精确清理、原错误保留', async () => {
    const submissionId = await createMaterialDraft('N03-C 事务回滚样本', 'N03-C 事务回滚正文。');
    const attachment = await uploadTextAttachment(
      submissionId,
      'n03-c.txt',
      'n03-c-original-bytes',
    );
    const originalRow = await attachmentRepository.findOneByOrFail({ id: attachment.attachmentId });
    const submitted = await submit.execute({
      session: engineerSession,
      submissionId,
      libraryNoticeConfirmed: true,
    });

    // 定向失败注入：对现有写服务方法包装「真实写入后、返回成功前」抛错。
    // 不替换整个 TransactionRunner，也不使用假 repository 模拟回滚；
    // 该故障属「回调内失败、可确认回滚」，不是 COMMIT 确认丢失。
    const injectedError = new Error('N03-C 注入：事务内写入完成后失败');
    const originalMarkPublished = contentSubmissionService.markSubmissionPublished;
    let failureTriggered = false;

    storageBarrier.activate('record');
    const filesBefore = storageFiles();
    try {
      contentSubmissionService.markSubmissionPublished = async (params) => {
        await originalMarkPublished.call(contentSubmissionService, params);
        if (!failureTriggered) {
          failureTriggered = true;
          throw injectedError;
        }
      };

      await expect(
        approve.execute({
          session: adminSession,
          submissionId,
          revisionId: submitted.revisionId,
          publishAttachment: true,
          comment: null,
        }),
      ).rejects.toBe(injectedError);
    } finally {
      contentSubmissionService.markSubmissionPublished = originalMarkPublished;
      storageBarrier.releaseAll();
    }

    // 注入确实触发（未触发则本用例不能证明该路径）
    expect(failureTriggered).toBe(true);
    const formalReferences = [...storageBarrier.saved];
    expect(formalReferences).toHaveLength(1);
    const formalReference = formalReferences[0];
    // 正式副本内容来自冻结原件的真实字节（写入成功时记录指纹，不依赖事后文件仍在）
    expect(storageBarrier.fingerprints).toEqual([sha256Hex(Buffer.from('n03-c-original-bytes'))]);

    // 事务已回滚：无正式资料、无审核记录、投稿仍待审
    expect(
      await documentRepository.find({ where: { sourceSubmissionId: submissionId } }),
    ).toHaveLength(0);
    expect(await reviewRepository.find({ where: { submissionId } })).toHaveLength(0);
    const submissionRow = await submissionRepository.findOneByOrFail({ id: submissionId });
    expect(submissionRow.status).toBe('PENDING_REVIEW');

    // 本次正式副本已精确清理；冻结原件与其他既有文件不变
    expect(fs.existsSync(path.join(e2eStorageRoot, formalReference))).toBe(false);
    expect(readStoredBytes(originalRow.storageReference).toString()).toBe('n03-c-original-bytes');
    const filesAfter = storageFiles();
    expect(filesAfter.filter((name) => !filesBefore.includes(name))).toEqual([]);
    expect(filesBefore.filter((name) => !filesAfter.includes(name))).toEqual([]);
  });

  it('R1 审核队列真实排序：空队列、时间倒序、同一时间按ID倒序、退回重提后按最近送审时间排序', async () => {
    // 补齐 R1 验收遗漏的「真实数据库排序验证」：单测已覆盖排序常量，
    // 本用例在真实 MySQL 上验证空队列、时间倒序、同一时间按 ID 倒序、
    // 退回重提后按最近送审时间重排，以及 OFFSET 分页与总数口径。

    // —— 空队列：无匹配数据时 items 为空且 total=0（withTotal 需显式请求，缺省不返回）——
    const emptyQueue = await listReviewQueue.execute({
      session: adminSession,
      pagination: { mode: 'OFFSET', page: 1, pageSize: 20, withTotal: true },
      filter: { title: 'R1 排序-无匹配标题' },
    });
    expect(emptyQueue.items).toEqual([]);
    expect(emptyQueue.total).toBe(0);

    // —— 三条 MATERIAL 送审（主键自增保证 Alpha < Beta < Gamma）——
    const alphaId = await createMaterialDraft('R1 排序样本 Alpha', 'R1 Alpha 正文。');
    const betaId = await createMaterialDraft('R1 排序样本 Beta', 'R1 Beta 正文。');
    const gammaId = await createMaterialDraft('R1 排序样本 Gamma', 'R1 Gamma 正文。');
    const alphaSubmitted = await submit.execute({
      session: engineerSession,
      submissionId: alphaId,
      libraryNoticeConfirmed: true,
    });
    await submit.execute({
      session: engineerSession,
      submissionId: betaId,
      libraryNoticeConfirmed: true,
    });
    await submit.execute({
      session: engineerSession,
      submissionId: gammaId,
      libraryNoticeConfirmed: true,
    });

    // 固定送审时间为可控值（timestamp(3) 毫秒精度）：Alpha 最早；Beta 与 Gamma 同刻，
    // 须以 ID 倒序决胜（口径 7：last_submitted_at DESC, id DESC）
    await dataSource.query('UPDATE content_submission SET last_submitted_at = ? WHERE id = ?', [
      '2026-10-01 10:00:00.100',
      alphaId,
    ]);
    await dataSource.query(
      'UPDATE content_submission SET last_submitted_at = ? WHERE id IN (?, ?)',
      ['2026-10-01 10:00:00.300', betaId, gammaId],
    );

    const queryQueue = (page: number, pageSize: number) =>
      listReviewQueue.execute({
        session: adminSession,
        pagination: { mode: 'OFFSET', page, pageSize, withTotal: true },
        filter: { title: 'R1 排序样本' },
      });

    // —— 时间倒序 + 同一时间按 ID 倒序 ——
    const ordered = await queryQueue(1, 20);
    expect(ordered.items.map((item) => item.id)).toEqual([gammaId, betaId, alphaId]);
    expect(ordered.items.map((item) => item.title)).toEqual([
      'R1 排序样本 Gamma',
      'R1 排序样本 Beta',
      'R1 排序样本 Alpha',
    ]);
    expect(ordered.total).toBe(3);

    // —— 退回后重提：last_submitted_at 更新为最近送审时间，重排至最前 ——
    await returnSubmission.execute({
      session: adminSession,
      submissionId: alphaId,
      revisionId: alphaSubmitted.revisionId,
      comment: 'R1 排序验证：退回后重提。',
    });
    await submit.execute({
      session: engineerSession,
      submissionId: alphaId,
      libraryNoticeConfirmed: true,
    });

    const reordered = await queryQueue(1, 20);
    expect(reordered.items.map((item) => item.id)).toEqual([alphaId, gammaId, betaId]);

    // —— OFFSET 分页：pageSize=2 时 page1=[Alpha, Gamma]、page2=[Beta]，total 恒为 3 ——
    const page1 = await queryQueue(1, 2);
    const page2 = await queryQueue(2, 2);
    expect(page1.items.map((item) => item.id)).toEqual([alphaId, gammaId]);
    expect(page2.items.map((item) => item.id)).toEqual([betaId]);
    expect(page1.total).toBe(3);
    expect(page2.total).toBe(3);

    // —— withTotal 缺省 false：不返回 total（列表仍完整）——
    const withoutTotal = await listReviewQueue.execute({
      session: adminSession,
      pagination: { mode: 'OFFSET', page: 1, pageSize: 20 },
      filter: { title: 'R1 排序样本' },
    });
    expect(withoutTotal.total).toBeUndefined();
    expect(withoutTotal.items).toHaveLength(3);
  });

  // =====================================================================
  // R01：主表行锁之后的写前读取必须为事务内当前读（pessimistic_write）。
  // 以下 W 用例使用真实独立连接持锁 + 测试侧委托信号：持锁连接先完成一笔
  // 未提交写入，竞争 usecase 在建立 REPEATABLE-READ 旧快照并发起主行锁请求后，
  // 持锁连接才提交。不使用 mock，也不在 src 注入测试钩子。
  // =====================================================================

  it('W-RR 真实连接事务隔离级别为 REPEATABLE-READ（记录 R01 复现前提）', async () => {
    expect(await readTransactionIsolation()).toBe('REPEATABLE-READ');
  });

  it('W-RR+ 屏障两种先后顺序、多轮隔离与超时回收', async () => {
    const randomSubmissionId = -1;

    // 先 signal 后 wait：通知必须被保留，不能丢
    const signalFirst = expectLockAttempt(randomSubmissionId);
    signalLockAttempt(randomSubmissionId);
    await expect(signalFirst.wait(200)).resolves.toBeUndefined();

    // 先 wait 后 signal：正常唤醒
    const waitFirst = expectLockAttempt(randomSubmissionId);
    const pending = waitFirst.wait(2000);
    signalLockAttempt(randomSubmissionId);
    await expect(pending).resolves.toBeUndefined();

    // 多轮隔离：没有活动 waiter 时的 signal 不保留到达事实，不满足后续轮次
    signalLockAttempt(randomSubmissionId);
    const nextRound = expectLockAttempt(randomSubmissionId);
    await expect(nextRound.wait(50)).rejects.toThrow(/超时/);
    expect(lockAttemptWaiters).toHaveLength(0);

    // 超时后 waiter 被移除；后续 signal 不产生悬挂回调
    signalLockAttempt(randomSubmissionId);
    expect(lockAttemptWaiters).toHaveLength(0);
  });

  it('W01 资料标题/说明并发保存：主表锁后当前读合并，两列均保留', async () => {
    const submissionId = await createMaterialDraft('W01 初始标题', 'W01 正文。');
    await updateDraft.execute({
      session: engineerSession,
      submissionId,
      patch: { description: 'W01 初始说明' },
    });

    const holder = await openHeldSubmissionLock(submissionId);
    // 句柄必须先于竞争请求创建：锁尝试信号可能早于 wait() 到达
    const lockAttempt = expectLockAttempt(submissionId);
    const contention = guardSettlement(
      updateDraft.execute({
        session: engineerSession,
        submissionId,
        patch: { description: 'W01 并发保存说明' },
      }),
    );
    let outcome: Settled<unknown>;
    try {
      // 刻意延迟，放大「信号先于 waiter.wait()」窗口，验证通知不丢失
      await new Promise((resolve) => setTimeout(resolve, 120));
      // 持锁连接代表先完成的一笔并发保存：只改标题，提交后竞争事务才继续
      await holder.query(
        'UPDATE material_submission_detail SET title = ? WHERE submission_id = ?',
        ['W01 并发保存标题', submissionId],
      );
      await lockAttempt.wait();
      await holder.commitTransaction();
    } finally {
      await closeHeldSubmissionLock(holder);
      outcome = await contention;
    }

    if (outcome.status !== 'fulfilled') {
      throw outcome.reason;
    }
    const detail = await readMaterialDetailRow(submissionId);
    expect(detail).toMatchObject({
      title: 'W01 并发保存标题',
      description: 'W01 并发保存说明',
      contentText: 'W01 正文。',
    });
  });

  it('W02 案例错误码/触发条件并发保存：主表锁后当前读合并，两字段均保留', async () => {
    const draft = await createDraft.execute({
      session: engineerSession,
      kind: 'FAULT_CASE',
      fields: {
        title: 'W02 案例并发保存',
        equipmentModelText: '投稿集成测试机型',
        errorCode: 'W02-OLD',
        phenomenon: 'W02 故障现象。',
        conditionText: 'W02 初始触发条件。',
        reproductionSteps: 'W02 复现步骤。',
        handlingStatus: 'UNRESOLVED',
      },
    });
    const submissionId = draft.id;

    const holder = await openHeldSubmissionLock(submissionId);
    const lockAttempt = expectLockAttempt(submissionId);
    const contention = guardSettlement(
      updateDraft.execute({
        session: engineerSession,
        submissionId,
        patch: { conditionText: 'W02 并发保存触发条件。' },
      }),
    );
    let outcome: Settled<unknown>;
    try {
      await holder.query(
        'UPDATE fault_case_submission_detail SET error_code = ? WHERE submission_id = ?',
        ['W02-NEW', submissionId],
      );
      await lockAttempt.wait();
      await holder.commitTransaction();
    } finally {
      await closeHeldSubmissionLock(holder);
      outcome = await contention;
    }

    if (outcome.status !== 'fulfilled') {
      throw outcome.reason;
    }
    const rows: Array<{ error_code: string | null; condition_text: string | null }> =
      await dataSource.query(
        'SELECT error_code, condition_text FROM fault_case_submission_detail WHERE submission_id = ?',
        [submissionId],
      );
    expect(rows[0]).toMatchObject({
      error_code: 'W02-NEW',
      condition_text: 'W02 并发保存触发条件。',
    });
  });

  it('W03 保存→送审：冻结最新标题/正文，而非旧快照', async () => {
    const submissionId = await createMaterialDraft('W03 初始标题', 'W03 初始正文。');

    const holder = await openHeldSubmissionLock(submissionId);
    const lockAttempt = expectLockAttempt(submissionId);
    const contention = guardSettlement(
      submit.execute({
        session: engineerSession,
        submissionId,
        libraryNoticeConfirmed: true,
      }),
    );
    let outcome: Awaited<typeof contention>;
    try {
      await holder.query(
        'UPDATE material_submission_detail SET title = ?, content_text = ? WHERE submission_id = ?',
        ['W03 最新标题', 'W03 最新正文。', submissionId],
      );
      await lockAttempt.wait();
      await holder.commitTransaction();
    } finally {
      await closeHeldSubmissionLock(holder);
      outcome = await contention;
    }

    if (outcome.status !== 'fulfilled') {
      throw outcome.reason;
    }
    expect(outcome.value).toMatchObject({ revisionNo: 1, status: 'PENDING_REVIEW' });
    const revisions = await revisionRepository.find({ where: { submissionId } });
    expect(revisions).toHaveLength(1);
    expect(revisions[0].titleSnapshot).toBe('W03 最新标题');
    expect(revisions[0].payloadSnapshot).toMatchObject({
      title: 'W03 最新标题',
      contentText: 'W03 最新正文。',
    });
  });

  it('W04 案例保存→送审：冻结最新结构化字段，而非旧快照', async () => {
    const draft = await createDraft.execute({
      session: engineerSession,
      kind: 'FAULT_CASE',
      fields: {
        title: 'W04 案例送审',
        equipmentModelText: '投稿集成测试机型',
        errorCode: 'W04-OLD',
        phenomenon: 'W04 故障现象。',
        conditionText: 'W04 初始触发条件。',
        reproductionSteps: 'W04 复现步骤。',
        handlingStatus: 'UNRESOLVED',
      },
    });
    const submissionId = draft.id;

    const holder = await openHeldSubmissionLock(submissionId);
    const lockAttempt = expectLockAttempt(submissionId);
    const contention = guardSettlement(
      submit.execute({
        session: engineerSession,
        submissionId,
        libraryNoticeConfirmed: true,
      }),
    );
    let outcome: Awaited<typeof contention>;
    try {
      await holder.query(
        'UPDATE fault_case_submission_detail SET error_code = ?, condition_text = ? WHERE submission_id = ?',
        ['W04-NEW', 'W04 最新触发条件。', submissionId],
      );
      await lockAttempt.wait();
      await holder.commitTransaction();
    } finally {
      await closeHeldSubmissionLock(holder);
      outcome = await contention;
    }

    if (outcome.status !== 'fulfilled') {
      throw outcome.reason;
    }
    const revisions = await revisionRepository.find({ where: { submissionId } });
    expect(revisions).toHaveLength(1);
    expect(revisions[0].payloadSnapshot).toMatchObject({
      errorCode: 'W04-NEW',
      conditionText: 'W04 最新触发条件。',
    });
    expect(revisions[0].titleSnapshot).toBe('W04 案例送审');
  });

  it('W05 附件替换→送审：冻结新 CURRENT 的真实 id，不复用旧附件', async () => {
    const submissionId = await createMaterialDraft('W05 附件替换', 'W05 正文。');
    const oldAttachment = await uploadTextAttachment(submissionId, 'w05-old.txt', 'w05-old-bytes');

    const holder = await openHeldSubmissionLock(submissionId);
    const lockAttempt = expectLockAttempt(submissionId);
    const contention = guardSettlement(
      submit.execute({
        session: engineerSession,
        submissionId,
        libraryNoticeConfirmed: true,
      }),
    );
    let outcome: Awaited<typeof contention>;
    let newAttachmentId!: number;
    try {
      await holder.query(
        "UPDATE content_submission_attachment SET status = 'RETIRED', retired_at = CURRENT_TIMESTAMP(3) WHERE submission_id = ? AND status = 'CURRENT'",
        [submissionId],
      );
      const inserted: { insertId: number } = await holder.query(
        `INSERT INTO content_submission_attachment
          (submission_id, original_filename, mime_type, byte_size, storage_backend,
           storage_reference, uploaded_by_account_id, status, retired_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'CURRENT', NULL)`,
        [
          submissionId,
          'w05-new.txt',
          'text/plain',
          Buffer.from('w05-new-bytes').byteLength,
          'local',
          'w05-new-storage-reference',
          engineerSession.accountId,
        ],
      );
      newAttachmentId = Number(inserted.insertId);
      await lockAttempt.wait();
      await holder.commitTransaction();
    } finally {
      await closeHeldSubmissionLock(holder);
      outcome = await contention;
    }

    if (outcome.status !== 'fulfilled') {
      throw outcome.reason;
    }
    expect(newAttachmentId).toBeGreaterThan(0);
    const revisions = await revisionRepository.find({ where: { submissionId } });
    expect(revisions).toHaveLength(1);
    expect(revisions[0].attachmentId).toBe(newAttachmentId);
    expect(revisions[0].attachmentId).not.toBe(oldAttachment.attachmentId);

    const oldRow = await attachmentRepository.findOneByOrFail({
      id: oldAttachment.attachmentId,
    });
    expect(oldRow.status).toBe('RETIRED');
    const newRow = await attachmentRepository.findOneByOrFail({ id: newAttachmentId });
    expect(newRow).toMatchObject({ status: 'CURRENT', submissionId });
  });

  it('W06 附件移除→送审：不复用旧附件；仅文件资料按双空拒绝且零版本写入', async () => {
    const draft = await createDraft.execute({
      session: engineerSession,
      kind: 'MATERIAL',
      fields: {
        title: 'W06 附件移除',
        documentType: 'MAINTENANCE_GUIDE',
        equipmentModelText: '投稿集成测试机型',
      },
    });
    const submissionId = draft.id;
    const attachment = await uploadTextAttachment(submissionId, 'w06-only.txt', 'w06-only-bytes');

    const holder = await openHeldSubmissionLock(submissionId);
    const lockAttempt = expectLockAttempt(submissionId);
    const contention = guardSettlement(
      submit.execute({
        session: engineerSession,
        submissionId,
        libraryNoticeConfirmed: true,
      }),
    );
    let outcome: Awaited<typeof contention>;
    try {
      await holder.query(
        "UPDATE content_submission_attachment SET status = 'RETIRED', retired_at = CURRENT_TIMESTAMP(3) WHERE submission_id = ? AND status = 'CURRENT'",
        [submissionId],
      );
      await lockAttempt.wait();
      await holder.commitTransaction();
    } finally {
      await closeHeldSubmissionLock(holder);
      outcome = await contention;
    }

    expect(outcome.status).toBe('rejected');
    if (outcome.status !== 'rejected') {
      return;
    }
    expect(outcome.reason).toMatchObject({
      name: 'DomainError',
      code: CONTENT_SUBMISSION_ERROR.DRAFT_EMPTY,
    });
    expect(await revisionRepository.find({ where: { submissionId } })).toHaveLength(0);
    const row = await submissionRepository.findOneByOrFail({ id: submissionId });
    expect(row).toMatchObject({ status: 'DRAFT', currentRevisionNo: 0 });
    const attachmentRow = await attachmentRepository.findOneByOrFail({
      id: attachment.attachmentId,
    });
    expect(attachmentRow.status).toBe('RETIRED');
    expect(await attachmentCountForSubmission(submissionId)).toBe(1);
  });

  it('W06B 文本资料存在、附件被移除→送审成功且冻结 attachment=null', async () => {
    const draft = await createDraft.execute({
      session: engineerSession,
      kind: 'MATERIAL',
      fields: {
        title: 'W06B 文本资料',
        documentType: 'MAINTENANCE_GUIDE',
        equipmentModelText: '投稿集成测试机型',
        contentText: 'W06B 正文仍然存在。',
      },
    });
    const submissionId = draft.id;
    const attachment = await uploadTextAttachment(submissionId, 'w06b-old.txt', 'w06b-old-bytes');

    const holder = await openHeldSubmissionLock(submissionId);
    const lockAttempt = expectLockAttempt(submissionId);
    const contention = guardSettlement(
      submit.execute({
        session: engineerSession,
        submissionId,
        libraryNoticeConfirmed: true,
      }),
    );
    let outcome: Awaited<typeof contention>;
    try {
      await holder.query(
        "UPDATE content_submission_attachment SET status = 'RETIRED', retired_at = CURRENT_TIMESTAMP(3) WHERE submission_id = ? AND status = 'CURRENT'",
        [submissionId],
      );
      await lockAttempt.wait();
      await holder.commitTransaction();
    } finally {
      await closeHeldSubmissionLock(holder);
      outcome = await contention;
    }

    if (outcome.status !== 'fulfilled') {
      throw outcome.reason;
    }
    expect(outcome.value).toMatchObject({ revisionNo: 1, status: 'PENDING_REVIEW' });

    const revisions = await revisionRepository.find({ where: { submissionId } });
    expect(revisions).toHaveLength(1);
    expect(revisions[0].attachmentId).toBeNull();
    expect(revisions[0].payloadSnapshot).toMatchObject({
      title: 'W06B 文本资料',
      contentText: 'W06B 正文仍然存在。',
    });
    const retired = await attachmentRepository.findOneByOrFail({
      id: attachment.attachmentId,
    });
    expect(retired.status).toBe('RETIRED');
    const row = await submissionRepository.findOneByOrFail({ id: submissionId });
    expect(row).toMatchObject({ status: 'PENDING_REVIEW', currentRevisionNo: 1 });
  });

  it('W07 送审成功后晚到修改/替换：状态冲突且零业务/文件写入', async () => {
    const submissionId = await createMaterialDraft('W07 送审后晚到', 'W07 正文。');
    const attachment = await uploadTextAttachment(
      submissionId,
      'w07-original.txt',
      'w07-original-bytes',
    );

    // 真实交错：送审先持主行锁停住（park），晚到修改在其提交前建立旧快照并排队等锁；
    // 送审提交后晚到写才拿到锁，必须按「当前状态」拒绝。
    const parker = parkNextLockAttempt(submissionId);
    const submitting = guardSettlement(
      submit.execute({
        session: engineerSession,
        submissionId,
        libraryNoticeConfirmed: true,
      }),
    );
    let lateUpdate: Promise<Settled<unknown>> | null = null;
    let submitted: Settled<unknown>;
    let lateEdit!: Settled<unknown>;
    try {
      await parker.parked;
      // 句柄在启动晚到写之前创建，避免锁尝试信号先于 wait() 到达而丢失
      const lateAttempt = expectLockAttempt(submissionId);
      lateUpdate = guardSettlement(
        updateDraft.execute({
          session: engineerSession,
          submissionId,
          patch: { title: 'W07 晚到标题' },
        }),
      );
      await lateAttempt.wait();
      parker.release();
      submitted = await submitting;
      lateEdit = await lateUpdate;
    } finally {
      parker.release();
      // 放行/关闭后必须等两个请求都收敛，不能遗留测试在途操作
      submitted = await submitting;
      if (lateUpdate) {
        lateEdit = await lateUpdate;
      }
    }

    if (submitted.status !== 'fulfilled') {
      throw submitted.reason;
    }
    expect(submitted.value).toMatchObject({ revisionNo: 1, status: 'PENDING_REVIEW' });

    expect(lateEdit.status).toBe('rejected');
    if (lateEdit.status !== 'rejected') {
      throw new Error('送审后的晚到修改未被拒绝');
    }
    expect(lateEdit.reason).toMatchObject({
      name: 'DomainError',
      code: CONTENT_SUBMISSION_ERROR.STATE_NOT_EDITABLE,
    });

    const detailBefore = await readMaterialDetailRow(submissionId);
    const revisionsBefore = await revisionRepository.find({ where: { submissionId } });
    const attachmentsBefore = await attachmentRepository.find({ where: { submissionId } });
    const filesBefore = storageFiles();

    // 晚到替换附件：状态冲突发生在存储写入之前，文件零写入。
    await expect(
      uploadTextAttachment(submissionId, 'w07-late.txt', 'w07-late-bytes'),
    ).rejects.toMatchObject({
      name: 'DomainError',
      code: CONTENT_SUBMISSION_ERROR.STATE_NOT_EDITABLE,
    });

    expect(await readMaterialDetailRow(submissionId)).toEqual(detailBefore);
    expect(await revisionRepository.find({ where: { submissionId } })).toEqual(revisionsBefore);
    expect(await attachmentRepository.find({ where: { submissionId } })).toEqual(attachmentsBefore);
    expect(storageFiles()).toEqual(filesBefore);
    const row = await submissionRepository.findOneByOrFail({ id: submissionId });
    expect(row).toMatchObject({ status: 'PENDING_REVIEW', currentRevisionNo: 1 });
    const attachmentRow = await attachmentRepository.findOneByOrFail({
      id: attachment.attachmentId,
    });
    expect(attachmentRow.status).toBe('CURRENT');
  });
});
