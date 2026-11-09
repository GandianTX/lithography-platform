// src/bootstraps/worker/worker-entity-metadata.spec.ts
import { AiProviderCallRecordEntity } from '@modules/ai-provider-call-record/ai-provider-call-record.entity';
import { AiWorkflowContextEntity } from '@modules/ai-workflow-context/ai-workflow-context.entity';
import { AsyncTaskRecordEntity } from '@modules/async-task-record/async-task-record.entity';
import { EntitiesMetadataStorage } from '@nestjs/typeorm/dist/entities-metadata.storage';
import { DataSource } from 'typeorm';
import { WorkerModule } from './worker.module';

/**
 * Worker 实体闭包断言集合。
 * 只用于断言，不作为 DataSource 的 entities 输入：
 * 元数据输入必须来自真实模块图通过 forFeature 注册的实体闭包。
 */
const WORKER_ENTITIES = [
  AiProviderCallRecordEntity,
  AsyncTaskRecordEntity,
  AiWorkflowContextEntity,
] as const;

interface OfflineMetadataBuilder {
  buildMetadatas(): Promise<void>;
}

describe('WorkerModule 实体元数据装配（离线，不连接数据库）', () => {
  it('真实模块图注册的实体闭包可构建完整 TypeORM 元数据', async () => {
    // 仅引用 WorkerModule：模块文件加载时会执行真实 TypeOrmModule.forFeature 注册。
    expect(WorkerModule).toBeDefined();

    const registeredEntities = EntitiesMetadataStorage.getEntitiesByDataSource('default');
    expect(registeredEntities).toEqual(expect.arrayContaining([...WORKER_ENTITIES]));

    const dataSource = new DataSource({
      type: 'mysql',
      host: '127.0.0.1',
      port: 3306,
      username: 'metadata_only',
      password: 'metadata_only',
      database: 'metadata_only',
      entities: registeredEntities,
      synchronize: false,
    });

    // 只构建元数据，不建立连接、不启动 Nest、不启用队列。
    await (dataSource as unknown as OfflineMetadataBuilder).buildMetadatas();

    const entityMetadatas = dataSource.entityMetadatas;
    for (const entity of WORKER_ENTITIES) {
      const metadata = entityMetadatas.find((item) => item.target === entity);
      expect(metadata).toBeDefined();
      for (const foreignKey of metadata?.foreignKeys ?? []) {
        expect(entityMetadatas).toContain(foreignKey.referencedEntityMetadata);
      }
    }
  });
});
