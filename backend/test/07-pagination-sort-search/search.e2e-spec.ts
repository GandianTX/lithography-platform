// test/07-pagination-sort-search/search.e2e-spec.ts
import { AccountStatus, IdentityTypeEnum } from '@app-types/models/account.types';
import {
  SubjectType,
  VerificationRecordStatus,
  VerificationRecordType,
} from '@app-types/models/verification-record.types';
import type { SearchOptions } from '@core/search/search.types';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppConfigModule } from '@src/infrastructure/config/config.module';
import { DatabaseModule } from '@src/infrastructure/database/database.module';
import { AccountEntity } from '@src/modules/account/base/entities/account.entity';
import { SearchModule, SearchService } from '@src/modules/common/search.module';
import { VerificationRecordEntity } from '@src/modules/verification-record/verification-record.entity';
import { randomBytes } from 'crypto';
import { DataSource, type SelectQueryBuilder } from 'typeorm';
import { ACCOUNT_QUERY_FIXTURE_ENTITIES } from '../utils/local-entity-sets';

describe('TypeOrmSearch 功能测试 (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let searchService: SearchService;
  let seededAccountIds: number[] = [];
  let appInitialized = false;

  const searchPrefix = 'SE_CASE_';
  const groupedPrefix = 'LS_CASE_';

  const buildOptions = (): SearchOptions => ({
    searchColumns: ['account.login_name'],
    minQueryLength: 2,
    allowedSorts: ['loginName', 'id', 'updatedAt', 'identityHint'],
    defaultSorts: [
      { field: 'loginName', direction: 'ASC' },
      { field: 'id', direction: 'ASC' },
    ],
    cursorKey: { primary: 'loginName', tieBreaker: 'id' },
    resolveColumn: resolveAccountColumn,
    allowedFilters: ['identityHint'],
  });

  const resolveAccountColumn = (field: string): string | null => {
    switch (field) {
      case 'id':
        return 'account.id';
      case 'loginName':
        return 'account.login_name';
      case 'updatedAt':
        return 'account.updated_at';
      case 'identityHint':
        return 'account.identity_hint';
      case 'ids':
        return 'account.id';
      default:
        return null;
    }
  };

  const resolveAccountPropertyPath = (field: string): string | null => {
    switch (field) {
      case 'id':
        return 'account.id';
      case 'loginName':
        return 'account.loginName';
      case 'updatedAt':
        return 'account.updatedAt';
      case 'identityHint':
        return 'account.identityHint';
      case 'ids':
        return 'account.id';
      default:
        return null;
    }
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        AppConfigModule,
        DatabaseModule,
        SearchModule,
        TypeOrmModule.forFeature([...ACCOUNT_QUERY_FIXTURE_ENTITIES]),
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    appInitialized = true;
    dataSource = moduleFixture.get<DataSource>(DataSource);
    searchService = moduleFixture.get<SearchService>(SearchService);

    const accounts = await seedAccounts({
      count: 8,
      prefix: searchPrefix,
      role: IdentityTypeEnum.CUSTOMER,
    });
    await seedVerificationRecords(accounts, 2);
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
      throw new AggregateError(cleanupErrors, '搜索规格收尾失败（清理与应用关闭均报错）');
    }
  });

  it('OFFSET：文本搜索 + 过滤 + 排序白名单', async () => {
    const result = await searchService.search<AccountEntity>({
      qb: createAccountQb(searchPrefix),
      params: {
        query: searchPrefix,
        filters: { identityHint: IdentityTypeEnum.CUSTOMER },
        pagination: { mode: 'OFFSET', page: 2, pageSize: 3, withTotal: true },
      },
      options: buildOptions(),
    });

    expect(result.items.length).toBe(3);
    expect(result.total).toBe(8);
    const names = result.items.map((row) => row.loginName);
    expect(names[0]).toBe('SE_CASE_03');
    expect(names[2]).toBe('SE_CASE_05');
  });

  it('CURSOR：after 翻页（手工提供 cursorToken）', async () => {
    const options = buildOptions();
    const page1 = await searchService.search<AccountEntity>({
      qb: createAccountQb(searchPrefix),
      params: { query: searchPrefix, pagination: { mode: 'CURSOR', limit: 5 } },
      options,
    });
    expect(page1.items.length).toBe(5);
    expect(page1.pageInfo?.hasNext).toBe(true);

    const last = page1.items[4];
    const token = {
      key: 'loginName',
      primaryValue: last.loginName ?? '',
      tieField: 'id',
      tieValue: last.id,
    };

    const page2 = await searchService.search<AccountEntity>({
      qb: createAccountQb(searchPrefix),
      params: { query: searchPrefix, pagination: { mode: 'CURSOR', limit: 5, after: 'token' } },
      options: { ...options, cursorToken: token },
    });

    expect(page2.items.length).toBe(3);
    expect(page2.pageInfo?.hasNext).toBe(false);
    expect(page2.items[0].loginName).toBe('SE_CASE_05');
    expect(page2.items[2].loginName).toBe('SE_CASE_07');
  });

  it('CURSOR：before 翻页（手工提供 cursorToken）', async () => {
    const options = buildOptions();
    const page1 = await searchService.search<AccountEntity>({
      qb: createAccountQb(searchPrefix),
      params: { query: searchPrefix, pagination: { mode: 'CURSOR', limit: 5 } },
      options,
    });
    const last = page1.items[4];
    const page2 = await searchService.search<AccountEntity>({
      qb: createAccountQb(searchPrefix),
      params: { query: searchPrefix, pagination: { mode: 'CURSOR', limit: 5, after: 'token' } },
      options: {
        ...options,
        cursorToken: {
          key: 'loginName',
          primaryValue: last.loginName ?? '',
          tieField: 'id',
          tieValue: last.id,
        },
      },
    });

    const firstOfPage2 = page2.items[0];
    const prevPage = await searchService.search<AccountEntity>({
      qb: createAccountQb(searchPrefix),
      params: { query: searchPrefix, pagination: { mode: 'CURSOR', limit: 5, before: 'token' } },
      options: {
        ...options,
        cursorToken: {
          key: 'loginName',
          primaryValue: firstOfPage2.loginName ?? '',
          tieField: 'id',
          tieValue: firstOfPage2.id,
        },
      },
    });

    expect(prevPage.items.map((row) => row.loginName)).toEqual(
      page1.items.map((row) => row.loginName),
    );
    expect(prevPage.pageInfo?.hasPrev).toBe(false);
    expect(prevPage.pageInfo?.hasNext).toBeUndefined();
  });

  it('OFFSET：最小查询长度短路，忽略过短查询', async () => {
    const result = await searchService.search<AccountEntity>({
      qb: createAccountQb(searchPrefix),
      params: {
        query: 'S',
        filters: { identityHint: IdentityTypeEnum.CUSTOMER },
        pagination: { mode: 'OFFSET', page: 1, pageSize: 10, withTotal: true },
      },
      options: buildOptions(),
    });

    expect(result.total).toBe(8);
    expect(result.items.length).toBe(8);
  });

  it('过滤器白名单：未知过滤器被忽略且不报错', async () => {
    const result = await searchService.search<AccountEntity>({
      qb: createAccountQb(searchPrefix),
      params: {
        query: searchPrefix,
        filters: { unknown: 'x' },
        pagination: { mode: 'OFFSET', page: 1, pageSize: 20 },
      },
      options: buildOptions(),
    });

    expect(result.items.length).toBe(8);
  });

  it('文本搜索转义：query 为 % 返回 0 行', async () => {
    const result = await searchService.search<AccountEntity>({
      qb: createAccountQb(searchPrefix),
      params: { query: '%', pagination: { mode: 'OFFSET', page: 1, pageSize: 10 } },
      options: { ...buildOptions(), minQueryLength: 1 },
    });

    expect(result.items.length).toBe(0);
  });

  it('文本搜索转义：query 为 _ 返回 8 行', async () => {
    const result = await searchService.search<AccountEntity>({
      qb: createAccountQb(searchPrefix),
      params: { query: '_', pagination: { mode: 'OFFSET', page: 1, pageSize: 10 } },
      options: { ...buildOptions(), minQueryLength: 1 },
    });

    expect(result.items.length).toBe(8);
    expect(result.items[0].loginName).toContain('_');
  });

  it('OFFSET：countDistinctBy 在联表重复行下返回准确总数', async () => {
    const qb = dataSource
      .getRepository(AccountEntity)
      .createQueryBuilder('account')
      .innerJoin(
        VerificationRecordEntity,
        'vr',
        'vr.subjectType = :stype AND vr.subjectId = account.id',
        { stype: SubjectType.ACCOUNT },
      )
      .where('account.login_name LIKE :prefix', {
        prefix: `${searchPrefix}%`,
      });

    const optionsA = { ...buildOptions(), resolveColumn: resolveAccountPropertyPath };
    const resA = await searchService.search<AccountEntity>({
      qb,
      params: {
        query: searchPrefix,
        pagination: { mode: 'OFFSET', page: 1, pageSize: 5, withTotal: true },
      },
      options: optionsA,
    });
    expect(resA.total).toBe(8);
    expect(resA.items.length).toBe(5);

    const optionsB: SearchOptions = { ...optionsA, countDistinctBy: 'vr.id' };
    const resB = await searchService.search<AccountEntity>({
      qb,
      params: {
        query: searchPrefix,
        pagination: { mode: 'OFFSET', page: 1, pageSize: 5, withTotal: true },
      },
      options: optionsB,
    });
    expect(resB.total).toBe(16);
    expect(resB.items.length).toBe(5);
  });

  it('OFFSET：AND 模式文本搜索（多列同时命中）', async () => {
    const result = await searchService.search<AccountEntity>({
      qb: createAccountQb(searchPrefix),
      params: {
        query: searchPrefix.toLowerCase(),
        pagination: { mode: 'OFFSET', page: 1, pageSize: 20 },
      },
      options: {
        ...buildOptions(),
        searchColumns: ['account.login_name', 'account.login_email'],
        searchMode: 'AND',
      },
    });

    expect(result.items.length).toBe(8);
  });

  it('OFFSET：buildTextSearch 自定义钩子（前缀匹配）', async () => {
    const result = await searchService.search<AccountEntity>({
      qb: createAccountQb(searchPrefix),
      params: { query: searchPrefix, pagination: { mode: 'OFFSET', page: 1, pageSize: 20 } },
      options: {
        ...buildOptions(),
        buildTextSearch: ({ query }) => ({
          clause: 'account.login_name LIKE :prefix',
          params: { prefix: query.endsWith('_') ? `${query}%` : `${query}_%` },
        }),
      },
    });

    expect(result.items.length).toBe(8);
  });

  it('过滤：normalizeFilterValue 与 buildFilter 组合（IN 列表）', async () => {
    const repo = dataSource.getRepository(AccountEntity);
    const firstThree = await repo
      .createQueryBuilder('account')
      .where('account.login_name LIKE :prefix', { prefix: `${searchPrefix}%` })
      .andWhere('account.identity_hint = :identityHint', {
        identityHint: IdentityTypeEnum.CUSTOMER,
      })
      .orderBy('account.id', 'ASC')
      .take(3)
      .getMany();
    const ids = firstThree.map((row) => row.id);

    const result = await searchService.search<AccountEntity>({
      qb: createAccountQb(searchPrefix),
      params: {
        filters: { ids: ids.join(',') },
        pagination: { mode: 'OFFSET', page: 1, pageSize: 10 },
      },
      options: {
        ...buildOptions(),
        allowedFilters: ['ids'],
        resolveColumn: resolveAccountColumn,
        normalizeFilterValue: ({ field, raw }) => {
          if (field === 'ids') return typeof raw === 'string' ? raw : String(raw);
          return raw;
        },
        buildFilter: ({ field, column, value }) => {
          if (field === 'ids' && typeof value === 'string') {
            const list = value
              .split(',')
              .map((item) => Number(item.trim()))
              .filter((item) => Number.isFinite(item));
            return { clause: `${column} IN (:...ids)`, params: { ids: list } };
          }
          return null;
        },
      },
    });

    expect(result.items.length).toBe(ids.length);
    expect(result.items.map((row) => row.id).sort((a, b) => a - b)).toEqual(
      [...ids].sort((a, b) => a - b),
    );
  });

  it('排序：allowedSorts 与 resolveColumn 不一致时抛出错误', async () => {
    await expect(
      searchService.search<AccountEntity>({
        qb: createAccountQb(searchPrefix),
        params: { pagination: { mode: 'OFFSET', page: 1, pageSize: 1 } },
        options: {
          searchColumns: ['account.login_name'],
          allowedSorts: ['badField'],
          defaultSorts: [{ field: 'badField', direction: 'ASC' }],
          resolveColumn: (field: string): string | null => {
            if (field === 'loginName') return 'account.login_name';
            return null;
          },
        },
      }),
    ).rejects.toThrow(/排序白名单与列解析不一致/);
  });

  it('排序：addSortColumnsToSelect 开启后一致性', async () => {
    const result = await searchService.search<AccountEntity>({
      qb: createAccountQb(searchPrefix),
      params: { query: searchPrefix, pagination: { mode: 'OFFSET', page: 1, pageSize: 20 } },
      options: { ...buildOptions(), addSortColumnsToSelect: true },
    });

    expect(result.items.length).toBe(8);
  });

  describe('Accounts 搜索实践测试 (e2e)', () => {
    beforeAll(async () => {
      await seedAccounts({
        count: 4,
        prefix: `${groupedPrefix}A_`,
        role: IdentityTypeEnum.ENGINEER,
      });
      await seedAccounts({
        count: 2,
        prefix: `${groupedPrefix}B_`,
        role: IdentityTypeEnum.CUSTOMER,
      });
    });

    it('OFFSET：过滤 identityHint 应只返回该角色账号', async () => {
      const result = await searchService.search<AccountEntity>({
        qb: createAccountQb(groupedPrefix),
        params: {
          query: groupedPrefix,
          filters: { identityHint: IdentityTypeEnum.ENGINEER },
          pagination: { mode: 'OFFSET', page: 1, pageSize: 10, withTotal: true },
        },
        options: buildOptions(),
      });

      expect(result.total).toBe(4);
      expect(result.items[0].loginName).toBe('LS_CASE_A_00');
      expect(result.items[3].loginName).toBe('LS_CASE_A_03');
      result.items.forEach((row) => expect(row.identityHint).toBe(IdentityTypeEnum.ENGINEER));
    });

    it('CURSOR：after 翻页，跨角色聚合 + 默认排序', async () => {
      const options = buildOptions();
      const page1 = await searchService.search<AccountEntity>({
        qb: createAccountQb(groupedPrefix),
        params: { query: groupedPrefix, pagination: { mode: 'CURSOR', limit: 3 } },
        options,
      });
      expect(page1.items.length).toBe(3);

      const last = page1.items[2];
      const page2 = await searchService.search<AccountEntity>({
        qb: createAccountQb(groupedPrefix),
        params: { query: groupedPrefix, pagination: { mode: 'CURSOR', limit: 3, after: 'token' } },
        options: {
          ...options,
          cursorToken: {
            key: 'loginName',
            primaryValue: last.loginName ?? '',
            tieField: 'id',
            tieValue: last.id,
          },
        },
      });

      expect(page2.items.length).toBe(3);
      expect(page2.items[0].loginName).toBe('LS_CASE_A_03');
      expect(page2.items[1].loginName).toBe('LS_CASE_B_00');
      expect(page2.items[2].loginName).toBe('LS_CASE_B_01');
    });

    it('过滤组合：ids 与 identityHint 交集', async () => {
      const repo = dataSource.getRepository(AccountEntity);
      const staff = await repo.findOne({ where: { loginName: 'LS_CASE_A_00' } });
      const guest = await repo.findOne({ where: { loginName: 'LS_CASE_B_00' } });
      if (!staff || !guest) throw new Error('Accounts 种子不存在');

      const result = await searchService.search<AccountEntity>({
        qb: createAccountQb(groupedPrefix),
        params: {
          filters: { ids: `${staff.id},${guest.id}`, identityHint: IdentityTypeEnum.ENGINEER },
          pagination: { mode: 'OFFSET', page: 1, pageSize: 10 },
        },
        options: {
          ...buildOptions(),
          allowedFilters: ['ids', 'identityHint'],
          resolveColumn: resolveAccountColumn,
          normalizeFilterValue: ({ field, raw }) => {
            if (field === 'ids') return typeof raw === 'string' ? raw : String(raw);
            return raw;
          },
          buildFilter: ({ field, column, value }) => {
            if (field === 'ids' && typeof value === 'string') {
              const list = value
                .split(',')
                .map((item) => Number(item.trim()))
                .filter((item) => Number.isFinite(item));
              return { clause: `${column} IN (:...ids)`, params: { ids: list } };
            }
            return null;
          },
        },
      });

      expect(result.items.length).toBe(1);
      expect(result.items[0].id).toBe(staff.id);
      expect(result.items[0].identityHint).toBe(IdentityTypeEnum.ENGINEER);
    });
  });

  function createAccountQb(prefix: string): SelectQueryBuilder<AccountEntity> {
    return dataSource
      .getRepository(AccountEntity)
      .createQueryBuilder('account')
      .where('account.login_name LIKE :prefix', { prefix: `${prefix}%` });
  }

  async function seedAccounts(params: {
    readonly count: number;
    readonly prefix: string;
    readonly role: IdentityTypeEnum;
  }): Promise<AccountEntity[]> {
    const repo = dataSource.getRepository(AccountEntity);
    await dataSource
      .createQueryBuilder()
      .delete()
      .from(AccountEntity)
      .where('login_name LIKE :prefix', { prefix: `${params.prefix}%` })
      .execute();

    const rows = await repo.save(
      Array.from({ length: params.count }).map((_, index) =>
        repo.create({
          loginName: `${params.prefix}${String(index).padStart(2, '0')}`,
          loginEmail: `${params.prefix.toLowerCase()}${index}@example.test`,
          loginPassword: 'hashed',
          status: AccountStatus.ACTIVE,
          recentLoginHistory: null,
          identityHint: params.role,
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
      await dataSource
        .createQueryBuilder()
        .delete()
        .from(VerificationRecordEntity)
        .where('subjectType = :subjectType', { subjectType: SubjectType.ACCOUNT })
        .andWhere('subjectId IN (:...ids)', { ids: uniqueIds })
        .execute();
    }

    await dataSource
      .createQueryBuilder()
      .delete()
      .from(AccountEntity)
      .where('login_name LIKE :prefix', { prefix: 'SE_%' })
      .orWhere('login_name LIKE :groupedPrefix', { groupedPrefix: 'LS_CASE_%' })
      .execute();
  }
});
