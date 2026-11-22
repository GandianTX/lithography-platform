// test/11-content-submission/content-submission-integration.e2e-spec.ts
//
// 投稿内容链路用例集成测试（PR0-S0-S5 修复计划 R6：V7/V8/V9 历史用例已按收口调整；
// R1 真实排序补充；W01-W07 行锁与冻结口径）
//
// 任务 07 收口（2026-11-20）：确认需求已关闭资料审核决定写路径
// （ReturnContentSubmissionUsecase / ApproveContentSubmissionUsecase 与
// reviewContentSubmissionDecision mutation 已移除）。以下用例因验证对象不存在而删除，
// 不是跳过：V6（退回重提）、V7-3/V7-4（并发审核通过）、V8（发布失败路径）、
// V9（发布与软删）、N03-A/B/C（发布副本竞争）。保留的 V7-1/V7-2 与 W 系列只覆盖
// 仍在产品内的草稿/附件/送审/行锁行为；R1 保留排序与分页，去掉「退回重提重排」子场景。
//
// 边界声明：本规格直接调用真实 usecase + 真实 TypeOrmTransactionRunner + 真实
// MySQL + 真实本地文件存储，验证用例层内部行为，不经协议层。投稿链路（草稿/
// 送审/版本/附件）的 GraphQL/REST 协议层真实请求验收见
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
import { ContentSubmissionRevisionEntity } from '@src/modules/lithography/entities/content-submission-revision.entity';
import { CreateContentSubmissionDraftUsecase } from '@src/usecases/content-submission/create-content-submission-draft.usecase';
import { ListReviewQueueUsecase } from '@src/usecases/content-submission/list-review-queue.usecase';
import { SubmitContentSubmissionUsecase } from '@src/usecases/content-submission/submit-content-submission.usecase';
import { UpdateContentSubmissionDraftUsecase } from '@src/usecases/content-submission/update-content-submission-draft.usecase';
import { UploadContentSubmissionAttachmentUsecase } from '@src/usecases/content-submission/upload-content-submission-attachment.usecase';

import { initGraphQLSchema } from '../../src/adapters/api/graphql/schema/schema.init';
import {
  createOwnedResourceLedger,
  runGuardedSpecCleanup,
  toResidueAccountFingerprint,
} from '../utils/e2e-scoped-cleanup';
import { captureEnvValue, restoreEnvValue, runE2eTeardown } from '../utils/e2e-teardown';
import { seedTestAccounts, testAccountsConfig } from '../utils/test-accounts';
import {
  buildSuiteOrganizationCodes,
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

  let createDraft: CreateContentSubmissionDraftUsecase;
  let updateDraft: UpdateContentSubmissionDraftUsecase;
  let uploadAttachment: UploadContentSubmissionAttachmentUsecase;
  let submit: SubmitContentSubmissionUsecase;
  let listReviewQueue: ListReviewQueueUsecase;
  let contentSubmissionService: ContentSubmissionService;

  // 规格专属测试组织（不借用开发库默认组织；编码带 E2E 前缀，清理以编码为界）
  const suiteOrganizationCodes = buildSuiteOrganizationCodes('CONTSUB');
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
    }).compile();

    app = moduleFixture.createNestApplication();
    dataSource = app.get(DataSource);
    contentSubmissionService = app.get(ContentSubmissionService);

    submissionRepository = dataSource.getRepository(ContentSubmissionEntity);
    attachmentRepository = dataSource.getRepository(ContentSubmissionAttachmentEntity);
    revisionRepository = dataSource.getRepository(ContentSubmissionRevisionEntity);

    createDraft = app.get(CreateContentSubmissionDraftUsecase);
    updateDraft = app.get(UpdateContentSubmissionDraftUsecase);
    uploadAttachment = app.get(UploadContentSubmissionAttachmentUsecase);
    submit = app.get(SubmitContentSubmissionUsecase);
    listReviewQueue = app.get(ListReviewQueueUsecase);

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

  it('R1 审核队列真实排序：空队列、时间倒序、同一时间按ID倒序与 OFFSET 分页', async () => {
    // 补齐 R1 验收遗漏的「真实数据库排序验证」：单测已覆盖排序常量，
    // 本用例在真实 MySQL 上验证空队列、时间倒序、同一时间按 ID 倒序、
    // 以及 OFFSET 分页与总数口径。审核决定写入口已下线，「退回重提」重排不再可验。

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
    await submit.execute({
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

    // —— OFFSET 分页：pageSize=2 时 page1=[Gamma, Beta]、page2=[Alpha]，total 恒为 3 ——
    const page1 = await queryQueue(1, 2);
    const page2 = await queryQueue(2, 2);
    expect(page1.items.map((item) => item.id)).toEqual([gammaId, betaId]);
    expect(page2.items.map((item) => item.id)).toEqual([alphaId]);
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
