// test/07-pagination-sort-search/pagination.e2e-spec.ts
import { AccountStatus, IdentityTypeEnum } from '@app-types/models/account.types';
import {
  SubjectType,
  VerificationRecordStatus,
  VerificationRecordType,
} from '@app-types/models/verification-record.types';
import { DomainError, PAGINATION_ERROR } from '@core/common/errors/domain-error';
import type { ICursorSigner } from '@core/pagination/pagination.contract';
import type { SortParam } from '@core/pagination/pagination.types';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppConfigModule } from '@src/infrastructure/config/config.module';
import { DatabaseModule } from '@src/infrastructure/database/database.module';
import { AccountEntity } from '@src/modules/account/base/entities/account.entity';
import { PaginationModule } from '@src/modules/common/pagination.module';
import { PaginationService } from '@src/modules/common/pagination.service';
import { PAGINATION_TOKENS } from '@src/modules/common/tokens/pagination.tokens';
import { VerificationRecordEntity } from '@src/modules/verification-record/verification-record.entity';
import { randomBytes } from 'crypto';
import { DataSource, In, Like } from 'typeorm';
import { ACCOUNT_QUERY_FIXTURE_ENTITIES } from '../utils/local-entity-sets';

describe('分页工具 (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let paginationService: PaginationService;
  let seededAccountIds: number[] = [];
  let appInitialized = false;

  const accountPrefix = 'PAG_CASE_';
  const joinPrefix = 'PAG_JOIN_';
  const allowedSorts: ReadonlyArray<string> = ['loginName', 'id'];
  const defaultSorts: ReadonlyArray<SortParam> = [
    { field: 'loginName', direction: 'ASC' },
    { field: 'id', direction: 'ASC' },
  ];

  const resolveColumn = (field: string): string | null => {
    switch (field) {
      case 'id':
        return 'account.id';
      case 'loginName':
        return 'account.login_name';
      default:
        return null;
    }
  };

  const resolvePropertyPath = (field: string): string | null => {
    switch (field) {
      case 'id':
        return 'account.id';
      case 'loginName':
        return 'account.loginName';
      default:
        return null;
    }
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        AppConfigModule,
        DatabaseModule,
        PaginationModule,
        TypeOrmModule.forFeature([...ACCOUNT_QUERY_FIXTURE_ENTITIES]),
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    appInitialized = true;

    dataSource = app.get(DataSource);
    paginationService = app.get(PaginationService);

    await seedAccounts(30, accountPrefix);
  });

  afterAll(async () => {
    const cleanupErrors: unknown[] = [];

    // 仅在本应用成功初始化后才清理；初始化失败时不得继续 getRepository 掩盖原始错误。
    if (appInitialized) {
      try {
        await cleanupSeededRows();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    if (app) {
      try {
        await app.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    if (cleanupErrors.length === 1) {
      throw cleanupErrors[0];
    }
    if (cleanupErrors.length > 1) {
      throw new AggregateError(cleanupErrors, '分页规格收尾失败（清理与应用关闭均报错）');
    }
  });

  const createBaseQb = () =>
    dataSource
      .getRepository(AccountEntity)
      .createQueryBuilder('account')
      .where('account.login_name LIKE :prefix', { prefix: `${accountPrefix}%` });

  it('OFFSET 模式返回正确的分页与总数', async () => {
    const result = await paginationService.paginateQuery<AccountEntity>({
      qb: createBaseQb(),
      params: { mode: 'OFFSET', page: 2, pageSize: 10, withTotal: true },
      allowedSorts,
      defaultSorts,
      resolveColumn,
    });

    expect(result.items.length).toBe(10);
    expect(result.total).toBe(30);
    expect(result.page).toBe(2);
    expect(result.pageSize).toBe(10);

    const names = result.items.map((row) => row.loginName);
    expect(names[0]).toBe('PAG_CASE_10');
    expect(names[9]).toBe('PAG_CASE_19');
  });

  it('CURSOR 模式分页与 nextCursor 正确衔接', async () => {
    const page1 = await paginationService.paginateQuery<AccountEntity>({
      qb: createBaseQb(),
      params: {
        mode: 'CURSOR',
        limit: 10,
        sorts: [
          { field: 'loginName', direction: 'ASC' },
          { field: 'id', direction: 'ASC' },
        ],
      },
      allowedSorts,
      defaultSorts,
      cursorKey: { primary: 'loginName', tieBreaker: 'id' },
      resolveColumn,
    });

    expect(page1.items.length).toBe(10);
    expect(page1.pageInfo?.hasNext).toBe(true);
    expect(page1.pageInfo?.nextCursor).toBeDefined();

    const page2 = await paginationService.paginateQuery<AccountEntity>({
      qb: createBaseQb(),
      params: {
        mode: 'CURSOR',
        limit: 10,
        after: page1.pageInfo?.nextCursor,
        sorts: [
          { field: 'loginName', direction: 'ASC' },
          { field: 'id', direction: 'ASC' },
        ],
      },
      allowedSorts,
      defaultSorts,
      cursorKey: { primary: 'loginName', tieBreaker: 'id' },
      resolveColumn,
    });

    const page3 = await paginationService.paginateQuery<AccountEntity>({
      qb: createBaseQb(),
      params: {
        mode: 'CURSOR',
        limit: 10,
        after: page2.pageInfo?.nextCursor,
        sorts: [
          { field: 'loginName', direction: 'ASC' },
          { field: 'id', direction: 'ASC' },
        ],
      },
      allowedSorts,
      defaultSorts,
      cursorKey: { primary: 'loginName', tieBreaker: 'id' },
      resolveColumn,
    });

    expect(page2.items.length).toBe(10);
    expect(page3.items.length).toBe(10);
    expect(page3.pageInfo?.hasNext).toBe(false);

    const ids = new Set<number>();
    [...page1.items, ...page2.items, ...page3.items].forEach((row) => ids.add(row.id));
    expect(ids.size).toBe(30);
  });

  it('CURSOR 模式支持 DESC 并自动补齐 tieBreaker', async () => {
    const page1 = await paginationService.paginateQuery<AccountEntity>({
      qb: createBaseQb(),
      params: {
        mode: 'CURSOR',
        limit: 10,
        sorts: [{ field: 'loginName', direction: 'DESC' }],
      },
      allowedSorts,
      defaultSorts,
      cursorKey: { primary: 'loginName', tieBreaker: 'id' },
      resolveColumn,
    });

    const page2 = await paginationService.paginateQuery<AccountEntity>({
      qb: createBaseQb(),
      params: {
        mode: 'CURSOR',
        limit: 10,
        after: page1.pageInfo?.nextCursor,
        sorts: [{ field: 'loginName', direction: 'DESC' }],
      },
      allowedSorts,
      defaultSorts,
      cursorKey: { primary: 'loginName', tieBreaker: 'id' },
      resolveColumn,
    });

    const page3 = await paginationService.paginateQuery<AccountEntity>({
      qb: createBaseQb(),
      params: {
        mode: 'CURSOR',
        limit: 10,
        after: page2.pageInfo?.nextCursor,
        sorts: [{ field: 'loginName', direction: 'DESC' }],
      },
      allowedSorts,
      defaultSorts,
      cursorKey: { primary: 'loginName', tieBreaker: 'id' },
      resolveColumn,
    });

    expect(page3.pageInfo?.hasNext).toBe(false);
    expect(page1.items.map((row) => row.loginName).slice(0, 2)).toEqual([
      'PAG_CASE_29',
      'PAG_CASE_28',
    ]);
  });

  it('CURSOR before 分支正确后退并返回 prevCursor', async () => {
    const page1 = await paginationService.paginateQuery<AccountEntity>({
      qb: createBaseQb(),
      params: {
        mode: 'CURSOR',
        limit: 10,
        sorts: [
          { field: 'loginName', direction: 'ASC' },
          { field: 'id', direction: 'ASC' },
        ],
      },
      allowedSorts,
      defaultSorts,
      cursorKey: { primary: 'loginName', tieBreaker: 'id' },
      resolveColumn,
    });

    const page2 = await paginationService.paginateQuery<AccountEntity>({
      qb: createBaseQb(),
      params: {
        mode: 'CURSOR',
        limit: 10,
        after: page1.pageInfo?.nextCursor,
        sorts: [
          { field: 'loginName', direction: 'ASC' },
          { field: 'id', direction: 'ASC' },
        ],
      },
      allowedSorts,
      defaultSorts,
      cursorKey: { primary: 'loginName', tieBreaker: 'id' },
      resolveColumn,
    });

    const signer = app.get<ICursorSigner>(PAGINATION_TOKENS.CURSOR_SIGNER);
    const firstOfPage2 = page2.items[0];
    const beforeCursor = signer.sign({
      key: 'loginName',
      primaryValue: firstOfPage2.loginName ?? '',
      tieValue: firstOfPage2.id,
    });

    const prevPage = await paginationService.paginateQuery<AccountEntity>({
      qb: createBaseQb(),
      params: {
        mode: 'CURSOR',
        limit: 10,
        before: beforeCursor,
        sorts: [
          { field: 'loginName', direction: 'ASC' },
          { field: 'id', direction: 'ASC' },
        ],
      },
      allowedSorts,
      defaultSorts,
      cursorKey: { primary: 'loginName', tieBreaker: 'id' },
      resolveColumn,
    });

    expect(prevPage.items.map((row) => row.loginName)).toEqual(
      page1.items.map((row) => row.loginName),
    );
    expect(prevPage.pageInfo?.hasPrev).toBe(false);
    expect(prevPage.pageInfo?.prevCursor).toBeUndefined();
  });

  it('非法排序字段将被忽略并回退到默认排序', async () => {
    const result = await paginationService.paginateQuery<AccountEntity>({
      qb: createBaseQb(),
      params: {
        mode: 'OFFSET',
        page: 1,
        pageSize: 10,
        sorts: [{ field: 'createdAt', direction: 'ASC' }],
      },
      allowedSorts,
      defaultSorts,
      resolveColumn,
    });

    expect(result.items.length).toBe(10);
    expect(result.items[0].loginName).toBe('PAG_CASE_00');
    expect(result.items[9].loginName).toBe('PAG_CASE_09');
  });

  it('非法游标签名被拒绝', async () => {
    await expect(
      paginationService.paginateQuery<AccountEntity>({
        qb: createBaseQb(),
        params: { mode: 'CURSOR', limit: 10, after: 'invalid_cursor' },
        allowedSorts,
        defaultSorts,
        cursorKey: { primary: 'loginName', tieBreaker: 'id' },
        resolveColumn,
      }),
    ).rejects.toMatchObject({ code: PAGINATION_ERROR.INVALID_CURSOR });
  });

  it('游标签名不匹配触发 INVALID_CURSOR 错误码', async () => {
    const page1 = await paginationService.paginateQuery<AccountEntity>({
      qb: createBaseQb(),
      params: {
        mode: 'CURSOR',
        limit: 10,
        sorts: [
          { field: 'loginName', direction: 'ASC' },
          { field: 'id', direction: 'ASC' },
        ],
      },
      allowedSorts,
      defaultSorts,
      cursorKey: { primary: 'loginName', tieBreaker: 'id' },
      resolveColumn,
    });

    const validCursor = page1.pageInfo?.nextCursor;
    if (!validCursor) throw new Error('未生成测试游标');
    const decoded = Buffer.from(validCursor, 'base64').toString('utf8');
    const obj = JSON.parse(decoded) as { p: string; m: string };
    const token = JSON.parse(obj.p) as {
      key: string;
      tieField?: string;
      tieValue: string | number;
    };
    const tamperedPayload = JSON.stringify({
      key: token.key,
      tieField: token.tieField,
      primaryValue: 'PAG_CASE_HACK',
      tieValue: token.tieValue,
    });
    const tamperedCursor = Buffer.from(
      JSON.stringify({ p: tamperedPayload, m: obj.m }),
      'utf8',
    ).toString('base64');

    let caught: unknown;
    try {
      await paginationService.paginateQuery<AccountEntity>({
        qb: createBaseQb(),
        params: {
          mode: 'CURSOR',
          limit: 10,
          after: tamperedCursor,
          sorts: [
            { field: 'loginName', direction: 'ASC' },
            { field: 'id', direction: 'ASC' },
          ],
        },
        allowedSorts,
        defaultSorts,
        cursorKey: { primary: 'loginName', tieBreaker: 'id' },
        resolveColumn,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DomainError);
    expect((caught as DomainError).code).toBe(PAGINATION_ERROR.INVALID_CURSOR);
  });

  it('JOIN 放大下可用 COUNT(DISTINCT) 返回联表行总数', async () => {
    const accounts = await seedAccounts(5, joinPrefix);
    await seedVerificationRecords(accounts, 2);

    const qb = dataSource
      .getRepository(AccountEntity)
      .createQueryBuilder('account')
      .innerJoin(
        VerificationRecordEntity,
        'vr',
        'vr.subjectType = :stype AND vr.subjectId = account.id',
        { stype: SubjectType.ACCOUNT },
      )
      .where('account.login_name LIKE :prefix', { prefix: `${joinPrefix}%` });

    const result = await paginationService.paginateQuery<AccountEntity>({
      qb,
      params: { mode: 'OFFSET', page: 1, pageSize: 3, withTotal: true },
      allowedSorts,
      defaultSorts,
      resolveColumn: resolvePropertyPath,
      countDistinctBy: 'vr.id',
    });

    expect(result.items.length).toBe(3);
    expect(result.total).toBe(10);
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(3);
  });

  it('游标主键一致性校验：跨端点复用游标应被拒绝', async () => {
    await seedAccounts(15, 'PAG_KEY_');

    const page1 = await paginationService.paginateQuery<AccountEntity>({
      qb: dataSource
        .getRepository(AccountEntity)
        .createQueryBuilder('account')
        .where('account.login_name LIKE :prefix', { prefix: 'PAG_KEY_%' }),
      params: {
        mode: 'CURSOR',
        limit: 5,
        sorts: [
          { field: 'id', direction: 'ASC' },
          { field: 'loginName', direction: 'ASC' },
        ],
      },
      allowedSorts,
      defaultSorts,
      cursorKey: { primary: 'id', tieBreaker: 'loginName' },
      resolveColumn,
    });

    await expect(
      paginationService.paginateQuery<AccountEntity>({
        qb: dataSource
          .getRepository(AccountEntity)
          .createQueryBuilder('account')
          .where('account.login_name LIKE :prefix', { prefix: 'PAG_KEY_%' }),
        params: {
          mode: 'CURSOR',
          limit: 5,
          after: page1.pageInfo?.nextCursor,
          sorts: [
            { field: 'loginName', direction: 'ASC' },
            { field: 'id', direction: 'ASC' },
          ],
        },
        allowedSorts,
        defaultSorts,
        cursorKey: { primary: 'loginName', tieBreaker: 'id' },
        resolveColumn,
      }),
    ).rejects.toEqual(new DomainError(PAGINATION_ERROR.INVALID_CURSOR, '游标主键不匹配'));
  });

  async function seedAccounts(count: number, prefix: string): Promise<AccountEntity[]> {
    const repo = dataSource.getRepository(AccountEntity);
    await repo.delete({ loginName: Like(`${prefix}%`) });

    const rows = await repo.save(
      Array.from({ length: count }).map((_, i) =>
        repo.create({
          loginName: `${prefix}${String(i).padStart(2, '0')}`,
          loginEmail: `${prefix.toLowerCase()}${i}@example.test`,
          loginPassword: 'hashed',
          status: AccountStatus.ACTIVE,
          recentLoginHistory: null,
          identityHint: IdentityTypeEnum.CUSTOMER,
        }),
      ),
    );
    seededAccountIds = [...seededAccountIds, ...rows.map((row) => row.id)];
    return rows;
  }

  async function seedVerificationRecords(
    accounts: ReadonlyArray<AccountEntity>,
    perAccount: number,
  ): Promise<void> {
    const repo = dataSource.getRepository(VerificationRecordEntity);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await repo.save(
      accounts.flatMap((account) =>
        Array.from({ length: perAccount }).map(() =>
          repo.create({
            type: VerificationRecordType.PASSWORD_RESET,
            tokenFp: randomBytes(32),
            status: VerificationRecordStatus.ACTIVE,
            expiresAt,
            notBefore: null,
            targetAccountId: account.id,
            subjectType: SubjectType.ACCOUNT,
            subjectId: account.id,
            payload: null,
            issuedByAccountId: null,
            consumedByAccountId: null,
            consumedAt: null,
          }),
        ),
      ),
    );
  }

  async function cleanupSeededRows(): Promise<void> {
    const uniqueIds = Array.from(new Set(seededAccountIds));
    if (uniqueIds.length > 0) {
      await dataSource.getRepository(VerificationRecordEntity).delete({
        subjectType: SubjectType.ACCOUNT,
        subjectId: In(uniqueIds),
      });
    }

    await dataSource.getRepository(AccountEntity).delete({ loginName: Like('PAG_%') });
  }
});
