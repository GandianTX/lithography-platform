// src/adapters/api/graphql/admin-operation-records/validate-management-audit-input.decorator.ts

import { formatValidationErrors } from '@adapters/api/graphql/common/validation.formatter';
import { DomainError, MANAGEMENT_AUDIT_ERROR } from '@core/common/errors/domain-error';
import { UsePipes, ValidationPipe } from '@nestjs/common';
import { ValidationError } from 'class-validator';

/**
 * 关键操作记录模块局部输入校验入口（任务 10）。
 *
 * 为什么不复用通用 `ValidateInput`：通用入口的 exceptionFactory 抛
 * `BadRequestException`，生产环境的 `GqlAllExceptionsFilter` 会把 HttpException
 * 一律降级为 `INTERNAL_SERVER_ERROR` 并隐藏 message，导致用户可修复的分页参数问题
 * 被误判为系统故障。本入口改抛
 * `DomainError(MANAGEMENT_AUDIT_ERROR.INVALID_PARAMS)`，经全局过滤器显式映射，
 * 在 production 仍稳定返回 `BAD_USER_INPUT`。
 *
 * 边界：`exceptionFactory` 只会收到 DTO 校验产生的 `ValidationError[]`；
 * 严禁在此做 catch-all 兜底，把数据库或程序错误伪装成参数错误。
 */
// eslint-disable-next-line @typescript-eslint/naming-convention
export const ValidateManagementAuditInput = () =>
  UsePipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      disableErrorMessages: false,
      stopAtFirstError: false,
      validationError: {
        target: false,
        value: false,
      },
      exceptionFactory: (errors: ValidationError[]) => {
        const message = formatValidationErrors(errors);
        return new DomainError(MANAGEMENT_AUDIT_ERROR.INVALID_PARAMS, message);
      },
    }),
  );
