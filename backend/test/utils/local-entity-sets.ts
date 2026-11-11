// test/utils/local-entity-sets.ts
import { AccountEntity } from '@src/modules/account/base/entities/account.entity';
import { UserInfoEntity } from '@src/modules/account/base/entities/user-info.entity';
import { EngineerResponseEntity } from '@src/modules/lithography/entities/engineer-response.entity';
import { EquipmentModelEntity } from '@src/modules/lithography/entities/equipment-model.entity';
import { OrganizationEntity } from '@src/modules/lithography/entities/organization.entity';
import { RepairRequestEntity } from '@src/modules/lithography/entities/repair-request.entity';
import { RepairRequestIntakeEntity } from '@src/modules/lithography/entities/repair-request-intake.entity';
import { StoredFileEntity } from '@src/modules/lithography/entities/stored-file.entity';
import { VerificationRecordEntity } from '@src/modules/verification-record/verification-record.entity';
import { ACCOUNT_WRITE_FIXTURE_ENTITIES } from './test-accounts';

/**
 * 账号读侧规格（分页/搜索）本地 TypeOrmModule.forFeature 实体集合。
 *
 * 在账号写入最小闭包之上追加验证记录实体；`UserInfoEntity` 的
 * `@ForeignKey('OrganizationEntity', ...)` 是字符串引用，组织实体必须同组登记，
 * 否则 `DataSource.buildMetadatas()` 直接抛 `Entity metadata for UserInfoEntity was not found`。
 */
export const ACCOUNT_QUERY_FIXTURE_ENTITIES = [
  ...ACCOUNT_WRITE_FIXTURE_ENTITIES,
  VerificationRecordEntity,
] as const;

/**
 * 维修申请组织范围实库规格（repair-request.organization.integration.spec.ts）
 * 本地 DataSource 的实体闭包。
 *
 * `RepairRequestEntity` 经 V13 新增外键引用 `RepairRequestIntakeEntity`，
 * 后者又引用 `StoredFileEntity`；三者必须同组登记，否则初始化构建元数据即失败。
 */
export const REPAIR_REQUEST_ORG_READ_FIXTURE_ENTITIES = [
  RepairRequestEntity,
  EngineerResponseEntity,
  EquipmentModelEntity,
  OrganizationEntity,
  AccountEntity,
  UserInfoEntity,
  RepairRequestIntakeEntity,
  StoredFileEntity,
] as const;
