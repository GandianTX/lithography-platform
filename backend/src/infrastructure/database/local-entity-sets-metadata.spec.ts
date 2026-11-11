// src/infrastructure/database/local-entity-sets-metadata.spec.ts
import { DataSource } from 'typeorm';
import {
  ACCOUNT_QUERY_FIXTURE_ENTITIES,
  REPAIR_REQUEST_ORG_READ_FIXTURE_ENTITIES,
} from '../../../test/utils/local-entity-sets';

interface OfflineMetadataBuilder {
  buildMetadatas(): Promise<void>;
}

type EntityClass = new (...args: never[]) => unknown;

/**
 * 用规格实际使用的同一实体集合构建离线元数据。
 *
 * - 输入直接来自 `test/utils/local-entity-sets.ts`，即被测规格 import 的同一常量，
 *   不在回归里额外手动补实体；
 * - 只调用 `buildMetadatas()`，不 `initialize()`、不连接数据库、不启动 Nest；
 * - 本回归只证明实体闭包可装配，不代替真实 Nest 启动与业务测试。
 */
const buildOfflineDataSource = async (entities: readonly EntityClass[]): Promise<DataSource> => {
  const dataSource = new DataSource({
    type: 'mysql',
    host: '127.0.0.1',
    port: 3306,
    username: 'metadata_only',
    password: 'metadata_only',
    database: 'metadata_only',
    entities: [...entities],
    synchronize: false,
  });

  await (dataSource as unknown as OfflineMetadataBuilder).buildMetadatas();
  return dataSource;
};

const expectAllForeignKeysResolvable = (dataSource: DataSource): void => {
  const entityMetadatas = dataSource.entityMetadatas;
  for (const metadata of entityMetadatas) {
    for (const foreignKey of metadata.foreignKeys) {
      expect(entityMetadatas).toContain(foreignKey.referencedEntityMetadata);
    }
  }
};

const referencedTableNamesOf = (dataSource: DataSource, tableName: string): string[] => {
  const metadata = dataSource.entityMetadatas.find((item) => item.tableName === tableName);
  expect(metadata).toBeDefined();
  return (metadata?.foreignKeys ?? []).map(
    (foreignKey) => foreignKey.referencedEntityMetadata.tableName,
  );
};

describe('规格本地实体集合元数据装配（离线，不连接数据库）', () => {
  it('分页/搜索规格集合可解析 UserInfoEntity 的 OrganizationEntity 外键目标', async () => {
    const dataSource = await buildOfflineDataSource(ACCOUNT_QUERY_FIXTURE_ENTITIES);

    expect(dataSource.entityMetadatas.map((item) => item.tableName)).toEqual(
      expect.arrayContaining(['base_user_account', 'base_user_info', 'organization']),
    );
    expectAllForeignKeysResolvable(dataSource);
    expect(referencedTableNamesOf(dataSource, 'base_user_info')).toContain('organization');
  });

  it('维修申请组织范围规格集合可解析 V13 新增外键链目标', async () => {
    const dataSource = await buildOfflineDataSource(REPAIR_REQUEST_ORG_READ_FIXTURE_ENTITIES);

    expectAllForeignKeysResolvable(dataSource);
    expect(referencedTableNamesOf(dataSource, 'repair_request')).toContain('repair_request_intake');
    expect(referencedTableNamesOf(dataSource, 'repair_request_intake')).toContain('stored_file');
  });
});
