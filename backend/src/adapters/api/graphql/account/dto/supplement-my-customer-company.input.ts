// src/adapters/api/graphql/account/dto/supplement-my-customer-company.input.ts

import { trimTextPure } from '@core/common/text/text.helper';
import { Field, InputType, Int } from '@nestjs/graphql';
import { Transform, type TransformFnParams } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  Min,
  registerDecorator,
  type ValidationArguments,
  type ValidationOptions,
} from 'class-validator';

/** 手填公司名称上限（与补录用例的收敛口径一致） */
const COMPANY_NAME_MAX_LENGTH = 100;

/**
 * 缺归属客户补录公司信息输入（任务 02.4）。
 *
 * `organizationId`（名单内受管公司）与 `organizationName`（手填公司名）**严格二选一**：
 * 同时提供或都不提供均 `BAD_USER_INPUT`。互斥在三层各自成立——UI 切换时清空另一侧、
 * 本 DTO 的 `isCustomerCompanySupplementChoice` 约束、Usecase 的 `resolveCompanyChoice()`；
 * DTO 只做形态与互斥，组织可用性仍由 Usecase 在事务内复核，绝不信任客户端自报。
 *
 * 刻意不含任何目标账号参数：目标账号只能来自已认证 Session。
 */
@InputType({ description: '缺归属客户补录公司信息输入' })
export class SupplementMyCustomerCompanyInput {
  @Field(() => Int, {
    description: '名单内公司组织 ID（与 organizationName 二选一）',
    nullable: true,
  })
  @IsOptional()
  @IsInt({ message: '公司 ID 必须是整数' })
  @Min(1, { message: '公司 ID 必须大于 0' })
  organizationId?: number | null;

  @Field(() => String, {
    description: '手填公司名称（与 organizationId 二选一）',
    nullable: true,
  })
  @Transform(({ value }: TransformFnParams) => trimTextPure(value))
  @isCustomerCompanySupplementChoice()
  organizationName?: string | null;
}

/**
 * 二选一约束：恰好提供一个分支即为合法。
 *
 * 放在 `organizationName` 上以便同时观察两个字段；`organizationId` 的形态检查仍由
 * `@IsInt` / `@Min` 负责。刻意不用 `@ValidateIf` + 单字段检查——那只能表达「提供时校验」，
 * 无法拒绝「同时提供 / 都不提供」。
 */
function isCustomerCompanySupplementChoice(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return (target: object, propertyKey: string | symbol) => {
    registerDecorator({
      name: 'isCustomerCompanySupplementChoice',
      target: target.constructor,
      propertyName: String(propertyKey),
      options: validationOptions,
      validator: {
        validate(_value: unknown, args: ValidationArguments): boolean {
          const input = args.object as SupplementMyCustomerCompanyInput;
          const hasOrganizationId =
            input.organizationId !== undefined && input.organizationId !== null;
          const organizationName =
            typeof input.organizationName === 'string' ? input.organizationName.trim() : '';
          const hasOrganizationName = organizationName.length > 0;
          if (hasOrganizationId === hasOrganizationName) {
            return false;
          }
          return organizationName.length <= COMPANY_NAME_MAX_LENGTH;
        },
        defaultMessage(args: ValidationArguments): string {
          const input = args.object as SupplementMyCustomerCompanyInput;
          const hasOrganizationId =
            input.organizationId !== undefined && input.organizationId !== null;
          const organizationName =
            typeof input.organizationName === 'string' ? input.organizationName.trim() : '';
          const hasOrganizationName = organizationName.length > 0;
          if (hasOrganizationId && hasOrganizationName) {
            return '只能选择名单内公司或手填公司名称，二者不能同时提交';
          }
          if (!hasOrganizationId && !hasOrganizationName) {
            return '请选择名单内公司或填写公司名称';
          }
          return `公司名称不能超过 ${COMPANY_NAME_MAX_LENGTH} 个字符`;
        },
      },
    });
  };
}
