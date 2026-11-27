// src/adapters/api/graphql/equipment-model/equipment-model.resolver.ts

import { JwtPayload } from '@app-types/jwt.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import { UseGuards } from '@nestjs/common';
import { Query, Resolver } from '@nestjs/graphql';
import { currentUser } from '@src/adapters/api/graphql/decorators/current-user.decorator';
import { Roles } from '@src/adapters/api/graphql/decorators/roles.decorator';
import { JwtAuthGuard } from '@src/adapters/api/graphql/guards/jwt-auth.guard';
import { RolesGuard } from '@src/adapters/api/graphql/guards/roles.guard';
import { ListEquipmentModelsUsecase } from '@src/usecases/repair-request/list-equipment-models.usecase';
import { EquipmentModelDTO } from './dto/equipment-model.dto';

/**
 * 设备型号 GraphQL 解析器
 * 提供设备型号下拉数据（当前消费方：客户创建维修申请、历史维修记录库表单/筛选）
 */
@Resolver(() => EquipmentModelDTO)
export class EquipmentModelResolver {
  constructor(private readonly listEquipmentModelsUsecase: ListEquipmentModelsUsecase) {}

  /**
   * 查询启用设备型号列表（按显示排序值升序）
   *
   * 角色演进：初版仅 CUSTOMER（最小权限，仅服务客户创建维修申请页）；
   * 0907.docx 任务二（历史维修记录库）起，超管创建/编辑资料表单与工程师列表
   * 型号筛选也需要本基础数据，故追加 ENGINEER/SUPER_ADMIN（追加式扩展，
   * 对既有 CUSTOMER 消费方零影响）；usecase 无角色断言，守卫为唯一闸门。
   */
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(IdentityTypeEnum.CUSTOMER, IdentityTypeEnum.ENGINEER, IdentityTypeEnum.SUPER_ADMIN)
  @Query(() => [EquipmentModelDTO], {
    name: 'equipmentModels',
    description: '查询启用设备型号列表',
  })
  async equipmentModels(@currentUser() _user: JwtPayload): Promise<EquipmentModelDTO[]> {
    const models = await this.listEquipmentModelsUsecase.execute();
    return models.map((model) => ({
      id: model.id,
      modelCode: model.modelCode,
      modelName: model.modelName,
    }));
  }
}
