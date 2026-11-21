// src/usecases/repair-request/repair-request-usecases.module.ts

import { Module } from '@nestjs/common';
import { AccountInstallerModule } from '@src/modules/account/account-installer.module';
import { AsyncTaskRecordModule } from '@src/modules/async-task-record/async-task-record.module';
import { LithographyModule } from '@src/modules/lithography/lithography.module';
import { IntakeAnalysisQueueModule } from '@src/modules/lithography/queue/intake-analysis-queue.module';
import { AcceptRepairRequestUsecase } from './accept-repair-request.usecase';
import { BindRepairProcessOriginalUsecase } from './bind-repair-process-original.usecase';
import { BindRepairRequestOriginalUsecase } from './bind-repair-request-original.usecase';
import { CloseRepairRequestUsecase } from './close-repair-request.usecase';
import { CreateEngineerResponseUsecase } from './create-engineer-response.usecase';
import { CreateRepairProcessEntryUsecase } from './create-repair-process-entry.usecase';
import { CreateRepairRequestUsecase } from './create-repair-request.usecase';
import { DeleteMyRepairRequestUsecase } from './delete-my-repair-request.usecase';
import { DeliverIntakeAnalysisUsecase } from './deliver-intake-analysis.usecase';
import { GetEngineerRepairRequestDetailUsecase } from './get-engineer-repair-request-detail.usecase';
import { GetEngineerRepairRequestRevisionDetailUsecase } from './get-engineer-repair-request-revision-detail.usecase';
import { GetEngineerRepairRequestRevisionHistoryUsecase } from './get-engineer-repair-request-revision-history.usecase';
import { GetMyRepairRequestDetailUsecase } from './get-my-repair-request-detail.usecase';
import { InterruptRepairRequestUsecase } from './interrupt-repair-request.usecase';
import { ListEquipmentModelsUsecase } from './list-equipment-models.usecase';
import { ListEngineerRepairRequestsUsecase } from './list-engineer-repair-requests.usecase';
import { ListMyRepairRequestsUsecase } from './list-my-repair-requests.usecase';
import { SaveRepairRequestMaintenanceUsecase } from './save-repair-request-maintenance.usecase';
import { RetryIntakeAnalysisUsecase } from './retry-intake-analysis.usecase';
import { SearchRepairServiceOrganizationsUsecase } from './search-repair-service-organizations.usecase';
import { UpdateRepairProcessEntryUsecase } from './update-repair-process-entry.usecase';

@Module({
  imports: [
    LithographyModule,
    AccountInstallerModule,
    AsyncTaskRecordModule,
    IntakeAnalysisQueueModule,
  ],
  providers: [
    AcceptRepairRequestUsecase,
    BindRepairProcessOriginalUsecase,
    BindRepairRequestOriginalUsecase,
    CloseRepairRequestUsecase,
    CreateEngineerResponseUsecase,
    CreateRepairProcessEntryUsecase,
    CreateRepairRequestUsecase,
    DeliverIntakeAnalysisUsecase,
    DeleteMyRepairRequestUsecase,
    GetEngineerRepairRequestDetailUsecase,
    GetEngineerRepairRequestRevisionDetailUsecase,
    GetEngineerRepairRequestRevisionHistoryUsecase,
    GetMyRepairRequestDetailUsecase,
    InterruptRepairRequestUsecase,
    ListEquipmentModelsUsecase,
    ListEngineerRepairRequestsUsecase,
    ListMyRepairRequestsUsecase,
    SaveRepairRequestMaintenanceUsecase,
    RetryIntakeAnalysisUsecase,
    SearchRepairServiceOrganizationsUsecase,
    UpdateRepairProcessEntryUsecase,
  ],
  exports: [
    AcceptRepairRequestUsecase,
    BindRepairProcessOriginalUsecase,
    BindRepairRequestOriginalUsecase,
    CloseRepairRequestUsecase,
    CreateEngineerResponseUsecase,
    CreateRepairProcessEntryUsecase,
    CreateRepairRequestUsecase,
    DeliverIntakeAnalysisUsecase,
    DeleteMyRepairRequestUsecase,
    GetEngineerRepairRequestDetailUsecase,
    GetEngineerRepairRequestRevisionDetailUsecase,
    GetEngineerRepairRequestRevisionHistoryUsecase,
    GetMyRepairRequestDetailUsecase,
    InterruptRepairRequestUsecase,
    ListEquipmentModelsUsecase,
    ListEngineerRepairRequestsUsecase,
    ListMyRepairRequestsUsecase,
    SaveRepairRequestMaintenanceUsecase,
    RetryIntakeAnalysisUsecase,
    SearchRepairServiceOrganizationsUsecase,
    UpdateRepairProcessEntryUsecase,
  ],
})
export class RepairRequestUsecasesModule {}
