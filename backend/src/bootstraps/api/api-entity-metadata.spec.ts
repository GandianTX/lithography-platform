// src/bootstraps/api/api-entity-metadata.spec.ts
import { AiProviderCallRecordEntity } from '@modules/ai-provider-call-record/ai-provider-call-record.entity';
import { AiMessageAnalysisEntity } from '@modules/lithography/entities/ai-message-analysis.entity';
import { BackupAssetEntity } from '@modules/lithography/entities/backup-asset.entity';
import { BackupRestoreRunEntity } from '@modules/lithography/entities/backup-restore-run.entity';
import { IntakeAnalysisAttemptEntity } from '@modules/lithography/entities/intake-analysis-attempt.entity';
import { LocalAccountAuthorizationEntity } from '@modules/lithography/entities/local-account-authorization.entity';
import { LocalCompanySettingEntity } from '@modules/lithography/entities/local-company-setting.entity';
import { MaintenanceReportFaultEntity } from '@modules/lithography/entities/maintenance-report-fault.entity';
import { ManagementAuditEventEntity } from '@modules/lithography/entities/management-audit-event.entity';
import { RecordPackageImportEntity } from '@modules/lithography/entities/record-package-import.entity';
import { RecordPackageItemEntity } from '@modules/lithography/entities/record-package-item.entity';
import { ReferenceDocumentRevisionEntity } from '@modules/lithography/entities/reference-document-revision.entity';
import { RepairProcessEntryEntity } from '@modules/lithography/entities/repair-process-entry.entity';
import { RepairRequestIntakeEntity } from '@modules/lithography/entities/repair-request-intake.entity';
import { RepairRequestRevisionEntity } from '@modules/lithography/entities/repair-request-revision.entity';
import { StoredFileEntity } from '@modules/lithography/entities/stored-file.entity';
import { SyncConflictEntity } from '@modules/lithography/entities/sync-conflict.entity';
import { SyncReceiptEntity } from '@modules/lithography/entities/sync-receipt.entity';
import { EntitiesMetadataStorage } from '@nestjs/typeorm/dist/entities-metadata.storage';
import { DataSource } from 'typeorm';
import { ApiModule } from './api.module';

/**
 * V13 新增实体（相对既有台账的增量）。
 * 这里只用于断言，不作为 DataSource 的 entities 输入：
 * 元数据输入必须来自真实模块图通过 forFeature 注册的实体闭包。
 */
const V13_NEW_ENTITIES = [
  AiMessageAnalysisEntity,
  BackupAssetEntity,
  BackupRestoreRunEntity,
  IntakeAnalysisAttemptEntity,
  LocalAccountAuthorizationEntity,
  LocalCompanySettingEntity,
  MaintenanceReportFaultEntity,
  ManagementAuditEventEntity,
  RecordPackageImportEntity,
  RecordPackageItemEntity,
  ReferenceDocumentRevisionEntity,
  RepairProcessEntryEntity,
  RepairRequestIntakeEntity,
  RepairRequestRevisionEntity,
  StoredFileEntity,
  SyncConflictEntity,
  SyncReceiptEntity,
] as const;

interface OfflineMetadataBuilder {
  buildMetadatas(): Promise<void>;
}

describe('ApiModule 实体元数据装配（离线，不连接数据库）', () => {
  it('真实模块图注册的实体闭包可构建完整 TypeORM 元数据', async () => {
    // 仅引用 ApiModule：模块文件加载时会执行真实 TypeOrmModule.forFeature 注册。
    expect(ApiModule).toBeDefined();

    const registeredEntities = EntitiesMetadataStorage.getEntitiesByDataSource('default');
    expect(registeredEntities.length).toBeGreaterThan(0);

    // 新增实体全部进入 API 实体闭包。
    expect(registeredEntities).toEqual(expect.arrayContaining([...V13_NEW_ENTITIES]));

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

    // 全部新增实体及字符串外键目标必须可解析。
    for (const entity of V13_NEW_ENTITIES) {
      const metadata = entityMetadatas.find((item) => item.target === entity);
      expect(metadata).toBeDefined();
      for (const foreignKey of metadata?.foreignKeys ?? []) {
        expect(entityMetadatas).toContain(foreignKey.referencedEntityMetadata);
      }
    }

    // IntakeAnalysisAttemptEntity 的两个引用目标必须同时在场。
    const intakeMetadata = entityMetadatas.find(
      (item) => item.target === IntakeAnalysisAttemptEntity,
    );
    expect(intakeMetadata).toBeDefined();
    const referencedTargets = (intakeMetadata?.foreignKeys ?? []).map(
      (foreignKey) => foreignKey.referencedEntityMetadata.target,
    );
    expect(referencedTargets).toEqual(
      expect.arrayContaining([RepairRequestIntakeEntity, AiProviderCallRecordEntity]),
    );
  });
});
