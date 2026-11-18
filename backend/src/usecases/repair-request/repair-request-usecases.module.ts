// src/usecases/repair-request/repair-request-usecases.module.ts

import { Module } from '@nestjs/common';
import { AccountInstallerModule } from '@src/modules/account/account-installer.module';
import { LithographyModule } from '@src/modules/lithography/lithography.module';
import { AcceptRepairRequestUsecase } from './accept-repair-request.usecase';
import { BindRepairProcessOriginalUsecase } from './bind-repair-process-original.usecase';
import { CloseRepairRequestUsecase } from './close-repair-request.usecase';
import { CreateEngineerResponseUsecase } from './create-engineer-response.usecase';
import { CreateRepairProcessEntryUsecase } from './create-repair-process-entry.usecase';
import { CreateRepairRequestUsecase } from './create-repair-request.usecase';
import { DeleteMyRepairRequestUsecase } from './delete-my-repair-request.usecase';
import { GetEngineerRepairRequestDetailUsecase } from './get-engineer-repair-request-detail.usecase';
import { GetMyRepairRequestDetailUsecase } from './get-my-repair-request-detail.usecase';
import { ListEquipmentModelsUsecase } from './list-equipment-models.usecase';
import { ListEngineerRepairRequestsUsecase } from './list-engineer-repair-requests.usecase';
import { ListMyRepairRequestsUsecase } from './list-my-repair-requests.usecase';
import { SearchRepairServiceOrganizationsUsecase } from './search-repair-service-organizations.usecase';
import { UpdateRepairProcessEntryUsecase } from './update-repair-process-entry.usecase';

@Module({
  imports: [LithographyModule, AccountInstallerModule],
  providers: [
    AcceptRepairRequestUsecase,
    BindRepairProcessOriginalUsecase,
    CloseRepairRequestUsecase,
    CreateEngineerResponseUsecase,
    CreateRepairProcessEntryUsecase,
    CreateRepairRequestUsecase,
    DeleteMyRepairRequestUsecase,
    GetEngineerRepairRequestDetailUsecase,
    GetMyRepairRequestDetailUsecase,
    ListEquipmentModelsUsecase,
    ListEngineerRepairRequestsUsecase,
    ListMyRepairRequestsUsecase,
    SearchRepairServiceOrganizationsUsecase,
    UpdateRepairProcessEntryUsecase,
  ],
  exports: [
    AcceptRepairRequestUsecase,
    BindRepairProcessOriginalUsecase,
    CloseRepairRequestUsecase,
    CreateEngineerResponseUsecase,
    CreateRepairProcessEntryUsecase,
    CreateRepairRequestUsecase,
    DeleteMyRepairRequestUsecase,
    GetEngineerRepairRequestDetailUsecase,
    GetMyRepairRequestDetailUsecase,
    ListEquipmentModelsUsecase,
    ListEngineerRepairRequestsUsecase,
    ListMyRepairRequestsUsecase,
    SearchRepairServiceOrganizationsUsecase,
    UpdateRepairProcessEntryUsecase,
  ],
})
export class RepairRequestUsecasesModule {}
