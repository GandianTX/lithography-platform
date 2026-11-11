// test/07-pagination-sort-search/sort.e2e-spec.ts
import { AccountStatus, IdentityTypeEnum } from '@app-types/models/account.types';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppConfigModule } from '@src/infrastructure/config/config.module';
import { DatabaseModule } from '@src/infrastructure/database/database.module';
import { TypeOrmSort } from '@src/infrastructure/typeorm/sort/typeorm-sort';
import { AccountEntity } from '@src/modules/account/base/entities/account.entity';
import { DataSource } from 'typeorm';
import { ACCOUNT_WRITE_FIXTURE_ENTITIES } from '../utils/test-accounts';

describe('TypeOrmSort 独立使用 (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        AppConfigModule,
        DatabaseModule,
        TypeOrmModule.forFeature([...ACCOUNT_WRITE_FIXTURE_ENTITIES]),
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    dataSource = moduleFixture.get<DataSource>(DataSource);

    await seedAccountsForSort();
  });

  afterAll(async () => {
    try {
      if (dataSource && dataSource.isInitialized) {
        await dataSource
          .createQueryBuilder()
          .delete()
          .from(AccountEntity)
          .where('login_name LIKE :prefix', { prefix: 'SORT_CASE_%' })
          .execute();
      }
    } finally {
      if (app) {
        await app.close();
      }
    }
  });

  it('白名单过滤与列解析：非法字段被拒绝', async () => {
    const sort = new TypeOrmSort(['loginName', 'id'], {
      loginName: 'account.loginName',
      id: 'account.id',
    });

    const qb = dataSource.getRepository(AccountEntity).createQueryBuilder('account');

    expect(sort.resolveColumn('createdAt')).toBeNull();

    const normalized = sort.normalizeSorts({
      sorts: [
        { field: 'createdAt', direction: 'DESC' },
        { field: 'loginName', direction: 'ASC' },
      ],
      allowed: ['loginName', 'id'],
      defaults: [
        { field: 'loginName', direction: 'ASC' },
        { field: 'id', direction: 'ASC' },
      ],
    });

    expect(normalized.length).toBe(1);
    expect(normalized[0].field).toBe('loginName');

    normalized.forEach((s, idx) => {
      const col = sort.resolveColumn(s.field);
      expect(col).toBeTruthy();
      if (idx === 0) qb.orderBy(col!, s.direction);
      else qb.addOrderBy(col!, s.direction);
    });

    const rows = await qb.limit(5).getMany();
    expect(Array.isArray(rows)).toBe(true);
  });

  it('游标模式补齐 tieBreaker：确保 primary 与 tie 排前两位', () => {
    const sort = new TypeOrmSort(['loginName', 'id', 'updatedAt'], {
      loginName: 'account.loginName',
      id: 'account.id',
      updatedAt: 'account.updatedAt',
    });

    const normalized = sort.normalizeSorts({
      sorts: [{ field: 'loginName', direction: 'DESC' }],
      allowed: ['loginName', 'id', 'updatedAt'],
      defaults: [
        { field: 'loginName', direction: 'ASC' },
        { field: 'id', direction: 'ASC' },
      ],
      tieBreaker: { primary: 'loginName', tieBreaker: 'id' },
    });

    expect(normalized[0]).toEqual({ field: 'loginName', direction: 'DESC' });
    expect(normalized[1]).toEqual({ field: 'id', direction: 'DESC' });
  });

  it('禁止 primary 与 tieBreaker 相同，抛出 INVALID_CURSOR', () => {
    const sort = new TypeOrmSort(['loginName', 'id'], {
      loginName: 'account.loginName',
      id: 'account.id',
    });
    expect(() =>
      sort.normalizeSorts({
        allowed: ['loginName', 'id'],
        defaults: [
          { field: 'loginName', direction: 'ASC' },
          { field: 'id', direction: 'ASC' },
        ],
        tieBreaker: { primary: 'loginName', tieBreaker: 'loginName' },
      }),
    ).toThrow();
  });

  async function seedAccountsForSort(): Promise<void> {
    await dataSource
      .createQueryBuilder()
      .delete()
      .from(AccountEntity)
      .where('login_name LIKE :prefix', { prefix: 'SORT_CASE_%' })
      .execute();

    const repo = dataSource.getRepository(AccountEntity);
    await repo.save(
      Array.from({ length: 8 }).map((_, i) =>
        repo.create({
          loginName: `SORT_CASE_${i}`,
          loginEmail: `sort-case-${i}@example.test`,
          loginPassword: 'hashed',
          status: AccountStatus.ACTIVE,
          recentLoginHistory: null,
          identityHint: IdentityTypeEnum.CUSTOMER,
        }),
      ),
    );
  }
});
