// src/adapters/api/graphql/verification-record/verification-record.resolver.ts

import { JwtPayload } from '@app-types/jwt.types';
import { IdentityTypeEnum } from '@app-types/models/account.types';
import {
  CreatableVerificationRecordType,
  VerificationRecordType,
} from '@app-types/models/verification-record.types';
import { DomainError, VERIFICATION_RECORD_ERROR } from '@core/common/errors/domain-error';
import { UseGuards } from '@nestjs/common';
import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';
import { currentUser } from '@src/adapters/api/graphql/decorators/current-user.decorator';
import { Public } from '@src/adapters/api/graphql/decorators/public.decorator';
import { JwtAuthGuard } from '@src/adapters/api/graphql/guards/jwt-auth.guard';
import { SessionRestrictionGuard } from '@src/adapters/api/graphql/guards/session-restriction.guard';
import { ConsumeVerificationRecordUsecase } from '@src/usecases/verification-record/consume-verification-record.usecase';
import { CreateVerificationRecordUsecase } from '@src/usecases/verification-record/create-verification-record.usecase';
import { FindVerificationRecordUsecase } from '@src/usecases/verification-record/find-verification-record.usecase';
import { ConsumeVerificationFlowUsecase } from '@src/usecases/verification/consume-verification-flow.usecase';
import { ConsumeVerificationRecordInput } from './dto/consume-verification-record.input';
import { CreateVerificationRecordInput } from './dto/create-verification-record.input';
import { FindVerificationRecordInput } from './dto/find-verification-record.input';
import { PublicVerificationRecordDTO } from './dto/public-verification-record.dto';
import { RevokeVerificationRecordInput } from './dto/revoke-verification-record.input';
import { VerificationRecordDTO } from './dto/verification-record.dto';
import {
  CreateVerificationRecordResult,
  UpdateVerificationRecordResult,
} from './dto/verification-record.result';

/**
 * 验证记录 GraphQL 解析器
 * 提供验证记录的创建、查找、消费等 GraphQL 接口
 */
@Resolver(() => VerificationRecordDTO)
export class VerificationRecordResolver {
  constructor(
    private readonly createVerificationRecordUsecase: CreateVerificationRecordUsecase,
    private readonly findVerificationRecordUsecase: FindVerificationRecordUsecase,
    private readonly consumeVerificationRecordUsecase: ConsumeVerificationRecordUsecase,
    private readonly consumeVerificationFlowUsecase: ConsumeVerificationFlowUsecase,
  ) {}

  /**
   * 创建验证记录
   */
  @Mutation(() => CreateVerificationRecordResult, { description: '创建验证记录' })
  @UseGuards(JwtAuthGuard, SessionRestrictionGuard)
  async createVerificationRecord(
    @Args('input') input: CreateVerificationRecordInput,
    @currentUser() user: JwtPayload,
  ): Promise<CreateVerificationRecordResult> {
    try {
      const result = await this.createVerificationRecordUsecase.execute({
        type: this.mapCreatableType(input.type),
        customToken: input.token,
        tokenLength: input.tokenLength,
        generateNumericCode: input.generateNumericCode,
        numericCodeLength: input.numericCodeLength,
        targetAccountId: input.targetAccountId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        payload: input.payload,
        expiresAt: input.expiresAt,
        notBefore: input.notBefore,
        issuedByAccountId: user.sub,
      });

      // 服务端权限判断：只有 SUPER_ADMIN 和 ENGINEER 角色在服务端生成 token 时才能获取明文 token
      // 统一转换为小写进行比较，与 RolesGuard 保持一致
      const normalizedUserRoles =
        user.accessGroup?.map((role) =>
          typeof role === 'string' ? role.toLowerCase() : String(role).toLowerCase(),
        ) || [];

      const canReturnToken =
        (normalizedUserRoles.includes(IdentityTypeEnum.SUPER_ADMIN.toLowerCase()) ||
          normalizedUserRoles.includes(IdentityTypeEnum.ENGINEER.toLowerCase())) &&
        result.generatedByServer === true;

      return {
        success: true,
        data: {
          id: result.record.id,
          type: result.record.type,
          status: result.record.status,
          expiresAt: result.record.expiresAt,
          notBefore: result.record.notBefore,
          targetAccountId: result.record.targetAccountId,
          subjectType: result.record.subjectType,
          subjectId: result.record.subjectId,
          payload: result.record.payload,
          issuedByAccountId: result.record.issuedByAccountId,
          consumedByAccountId: result.record.consumedByAccountId,
          consumedAt: result.record.consumedAt,
          createdAt: result.record.createdAt,
          updatedAt: result.record.updatedAt,
        },
        token: input.returnToken && canReturnToken ? result.token : null,
        message: null,
      };
    } catch (error) {
      return {
        success: false,
        data: null,
        message: error instanceof Error ? error.message : '创建验证记录失败',
      };
    }
  }

  /**
   * 创建输入类型映射为内部验证记录类型
   */
  private mapCreatableType(type: CreatableVerificationRecordType): VerificationRecordType {
    switch (type) {
      case CreatableVerificationRecordType.PASSWORD_RESET:
        return VerificationRecordType.PASSWORD_RESET;
    }

    throw new DomainError(VERIFICATION_RECORD_ERROR.OPERATION_NOT_SUPPORTED, '不支持的创建类型');
  }

  /**
   * 查找验证记录
   * 公开接口，但需要提供有效的 token 才能查询
   */
  @Public()
  @Query(() => PublicVerificationRecordDTO, { nullable: true, description: '查找验证记录' })
  async findVerificationRecord(
    @Args('input') input: FindVerificationRecordInput,
  ): Promise<PublicVerificationRecordDTO | null> {
    if (!input.token) {
      return null;
    }

    try {
      const result = await this.findVerificationRecordUsecase.findActiveConsumableByToken({
        token: input.token,
        expectedType: input.expectedType,
        ignoreTargetRestriction: input.ignoreTargetRestriction,
      });

      if (!result) {
        return null;
      }

      return {
        id: result.id,
        type: result.type,
        status: result.status,
        expiresAt: result.expiresAt,
        notBefore: result.notBefore,
        subjectType: result.subjectType,
        subjectId: result.subjectId,
        publicPayload: result.publicPayload ?? null,
      };
    } catch {
      return null;
    }
  }

  /**
   * 消费验证记录
   */
  @Mutation(() => UpdateVerificationRecordResult, { description: '消费验证记录' })
  @UseGuards(JwtAuthGuard, SessionRestrictionGuard)
  async consumeVerificationRecord(
    @Args('input') input: ConsumeVerificationRecordInput,
    @currentUser() user: JwtPayload,
  ): Promise<UpdateVerificationRecordResult> {
    try {
      // 使用 ConsumeVerificationFlowUsecase 处理验证记录消费
      await this.consumeVerificationFlowUsecase.execute({
        token: input.token,
        consumedByAccountId: user.sub,
        expectedType: input.expectedType,
      });

      return {
        success: true,
        data: null,
        message: '验证记录消费成功',
      };
    } catch (error) {
      // console.error('ConsumeVerificationFlowUsecase 执行失败:', error);
      return {
        success: false,
        data: null,
        message: error instanceof Error ? error.message : '消费验证记录失败',
      };
    }
  }

  /**
   * 撤销验证记录
   */
  @Mutation(() => UpdateVerificationRecordResult, { description: '撤销验证记录' })
  @UseGuards(JwtAuthGuard, SessionRestrictionGuard)
  async revokeVerificationRecord(
    @Args('input') input: RevokeVerificationRecordInput,
    @currentUser() _user: JwtPayload,
  ): Promise<UpdateVerificationRecordResult> {
    try {
      const result = await this.consumeVerificationRecordUsecase.revokeRecord({
        recordId: input.recordId,
      });

      return {
        success: true,
        data: {
          id: result.id,
          type: result.type,
          status: result.status,
          expiresAt: result.expiresAt,
          notBefore: result.notBefore,
          targetAccountId: result.targetAccountId,
          subjectType: result.subjectType,
          subjectId: result.subjectId,
          payload: result.payload,
          issuedByAccountId: result.issuedByAccountId,
          consumedByAccountId: result.consumedByAccountId,
          consumedAt: result.consumedAt,
          createdAt: result.createdAt,
          updatedAt: result.updatedAt,
        },
        message: null,
      };
    } catch (error) {
      return {
        success: false,
        data: null,
        message: error instanceof Error ? error.message : '撤销验证记录失败',
      };
    }
  }
}
