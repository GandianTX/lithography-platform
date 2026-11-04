import {
  CAPABILITY_ERROR,
  DomainError,
  INPUT_NORMALIZE_ERROR,
  ORGANIZATION_ERROR,
  REFERENCE_DOCUMENT_ERROR,
  REPAIR_REQUEST_ERROR,
} from '@core/common/errors';
import {
  BadRequestException,
  HttpException,
  ValidationPipe,
  type ArgumentsHost,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { IsInt, Min } from 'class-validator';
import { GraphQLError } from 'graphql';
import { GqlAllExceptionsFilter } from './graphql-exception.filter';

describe(GqlAllExceptionsFilter.name, () => {
  it('maps capability availability to an internal category instead of authorization failure', () => {
    const configService = {
      get: jest.fn().mockReturnValue('production'),
    } as unknown as ConfigService;
    const host = {
      getType: () => 'graphql',
      getArgs: () => [undefined, {}, {}, { fieldName: 'testField' }],
    } as unknown as ArgumentsHost;
    const filter = new GqlAllExceptionsFilter(configService);

    const error = filter.catch(
      new DomainError(CAPABILITY_ERROR.UNAVAILABLE, 'Capability unavailable'),
      host,
    ) as GraphQLError;

    expect(error.extensions).toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      errorCode: CAPABILITY_ERROR.UNAVAILABLE,
    });
  });

  it.each([
    [REPAIR_REQUEST_ERROR.EQUIPMENT_MODEL_NOT_FOUND, 'NOT_FOUND'],
    [REPAIR_REQUEST_ERROR.EQUIPMENT_MODEL_DISABLED, 'BAD_USER_INPUT'],
    [REPAIR_REQUEST_ERROR.INVALID_PARAMS, 'BAD_USER_INPUT'],
    // 系统侧故障不得误报为输入错误
    [REPAIR_REQUEST_ERROR.CREATION_FAILED, 'INTERNAL_SERVER_ERROR'],
    [REPAIR_REQUEST_ERROR.REQUEST_NO_CONFLICT, 'INTERNAL_SERVER_ERROR'],
    // 读取/删除/接单：不可访问统一 NOT_FOUND，已接单互斥 CONFLICT，写入失败属系统故障
    [REPAIR_REQUEST_ERROR.NOT_FOUND, 'NOT_FOUND'],
    [REPAIR_REQUEST_ERROR.ALREADY_ACCEPTED, 'CONFLICT'],
    [REPAIR_REQUEST_ERROR.ACCEPT_FAILED, 'INTERNAL_SERVER_ERROR'],
    [REPAIR_REQUEST_ERROR.DELETION_FAILED, 'INTERNAL_SERVER_ERROR'],
    // 回复：未接单属业务状态冲突 CONFLICT，回复落库失败属系统侧故障
    [REPAIR_REQUEST_ERROR.NOT_ACCEPTED, 'CONFLICT'],
    [REPAIR_REQUEST_ERROR.RESPONSE_FAILED, 'INTERNAL_SERVER_ERROR'],
  ])('maps repair request error %s to GraphQL code %s', (errorCode, gqlCode) => {
    const configService = {
      get: jest.fn().mockReturnValue('production'),
    } as unknown as ConfigService;
    const host = {
      getType: () => 'graphql',
      getArgs: () => [undefined, {}, {}, { fieldName: 'testField' }],
    } as unknown as ArgumentsHost;
    const filter = new GqlAllExceptionsFilter(configService);

    const error = filter.catch(new DomainError(errorCode, '维修申请错误'), host) as GraphQLError;

    expect(error.extensions).toMatchObject({
      code: gqlCode,
      errorCode,
    });
  });

  it.each([
    // AI 参考资料库：型号不存在属目标不存在；非法输入 BAD_USER_INPUT；
    // 不存在/已软删统一 NOT_FOUND；落库失败属系统侧故障
    [REFERENCE_DOCUMENT_ERROR.EQUIPMENT_MODEL_NOT_FOUND, 'NOT_FOUND'],
    [REFERENCE_DOCUMENT_ERROR.INVALID_PARAMS, 'BAD_USER_INPUT'],
    [REFERENCE_DOCUMENT_ERROR.NOT_FOUND, 'NOT_FOUND'],
    [REFERENCE_DOCUMENT_ERROR.CREATION_FAILED, 'INTERNAL_SERVER_ERROR'],
    [REFERENCE_DOCUMENT_ERROR.UPDATE_FAILED, 'INTERNAL_SERVER_ERROR'],
    [REFERENCE_DOCUMENT_ERROR.DELETION_FAILED, 'INTERNAL_SERVER_ERROR'],
  ])('maps reference document error %s to GraphQL code %s', (errorCode, gqlCode) => {
    const configService = {
      get: jest.fn().mockReturnValue('production'),
    } as unknown as ConfigService;
    const host = {
      getType: () => 'graphql',
      getArgs: () => [undefined, {}, {}, { fieldName: 'testField' }],
    } as unknown as ArgumentsHost;
    const filter = new GqlAllExceptionsFilter(configService);

    const error = filter.catch(new DomainError(errorCode, '参考资料错误'), host) as GraphQLError;

    expect(error.extensions).toMatchObject({
      code: gqlCode,
      errorCode,
    });
  });

  // 可信组织上下文（A-PR0 §2.1）：成员事实缺失/歧义是已认证用户的权限类拒绝，
  // 不得塌缩为 UNAUTHENTICATED（前端会误判 Session 失效）或输入错误
  it.each([
    [ORGANIZATION_ERROR.NO_ACTIVE_MEMBERSHIP, 'FORBIDDEN'],
    [ORGANIZATION_ERROR.AMBIGUOUS_MEMBERSHIP, 'FORBIDDEN'],
  ])('maps organization context error %s to GraphQL code %s', (errorCode, gqlCode) => {
    const configService = {
      get: jest.fn().mockReturnValue('production'),
    } as unknown as ConfigService;
    const host = {
      getType: () => 'graphql',
      getArgs: () => [undefined, {}, {}, { fieldName: 'testField' }],
    } as unknown as ArgumentsHost;
    const filter = new GqlAllExceptionsFilter(configService);

    const error = filter.catch(new DomainError(errorCode, '组织上下文错误'), host) as GraphQLError;

    expect(error.extensions).toMatchObject({
      code: gqlCode,
      errorCode,
    });
  });

  // 生产环境错误分类关键路径：弱密码等输入类拒绝走 DomainError 路径时，其
  // BAD_USER_INPUT 分类在生产环境保持不变
  it('maps input normalize error to BAD_USER_INPUT in production via the DomainError path', () => {
    const configService = {
      get: jest.fn().mockReturnValue('production'),
    } as unknown as ConfigService;
    const host = {
      getType: () => 'graphql',
      getArgs: () => [undefined, {}, {}, { fieldName: 'changeMyPassword' }],
    } as unknown as ArgumentsHost;
    const filter = new GqlAllExceptionsFilter(configService);

    const error = filter.catch(
      new DomainError(
        INPUT_NORMALIZE_ERROR.INVALID_TEXT,
        '新密码不符合安全要求: 密码长度至少为 8 位',
      ),
      host,
    ) as GraphQLError;

    expect(error.extensions).toMatchObject({
      code: 'BAD_USER_INPUT',
      errorCode: INPUT_NORMALIZE_ERROR.INVALID_TEXT,
    });
  });

  // 校验管道（`ValidateInput` 的 ValidationPipe）抛出的 400 在生产环境必须仍是
  // BAD_USER_INPUT：只隐藏 errorCode / errorMessage 细节，不改变错误大类。
  // 若折叠为 INTERNAL_SERVER_ERROR，前端会把「参数非法」误判为服务端故障。
  it.each([
    [400, 'BAD_USER_INPUT'],
    [401, 'UNAUTHENTICATED'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [409, 'CONFLICT'],
  ])('keeps HTTP %i classified as %s in production', (status, code) => {
    const configService = {
      get: jest.fn().mockReturnValue('production'),
    } as unknown as ConfigService;
    const host = {
      getType: () => 'graphql',
      getArgs: () => [undefined, {}, {}, { fieldName: 'reviewEngineerRegistration' }],
    } as unknown as ArgumentsHost;
    const filter = new GqlAllExceptionsFilter(configService);

    const error = filter.catch(
      new HttpException('validation failed', status),
      host,
    ) as GraphQLError;

    expect(error.extensions).toMatchObject({ code, httpStatus: status });
    // 生产环境不向外暴露响应体细节与自由文本
    expect(error.message).toBe('请求失败');
    expect(error.extensions).not.toHaveProperty('errorCode');
    expect(error.extensions).not.toHaveProperty('errorMessage');
  });

  it('classifies a validation BadRequestException as BAD_USER_INPUT in production', () => {
    const configService = {
      get: jest.fn().mockReturnValue('production'),
    } as unknown as ConfigService;
    const host = {
      getType: () => 'graphql',
      getArgs: () => [undefined, {}, {}, { fieldName: 'reviewEngineerRegistration' }],
    } as unknown as ArgumentsHost;
    const filter = new GqlAllExceptionsFilter(configService);

    // 与 `ValidateInput` 的 exceptionFactory 同形态：BadRequestException(格式化文本)
    const error = filter.catch(
      new BadRequestException('applicationId 必须为大于 0 的整数'),
      host,
    ) as GraphQLError;

    expect(error.extensions).toMatchObject({ code: 'BAD_USER_INPUT', httpStatus: 400 });
    expect(error.message).toBe('请求失败');
  });

  // 生产输入链路回归：真实 `ValidationPipe` + 生产过滤器。
  // 复现输入形态与审核入口一致（`applicationId` 为 Int 且 >= 1）；生产环境曾把这类
  // 校验 400 折叠为 INTERNAL_SERVER_ERROR。这里从管道抛错一路走到过滤器输出，
  // 证明 `applicationId: 0` 仍是 BAD_USER_INPUT 而非系统错误。
  it('keeps a real ValidationPipe rejection classified as BAD_USER_INPUT in production', async () => {
    // 与 `ReviewEngineerRegistrationInput.applicationId` 同一约束形态（不跨层导入 DTO）
    class ReviewInputProbe {
      @IsInt()
      @Min(1)
      applicationId!: number;
    }

    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      disableErrorMessages: false,
      stopAtFirstError: false,
      validationError: { target: false, value: false },
      // 与 `ValidateInput` 的 exceptionFactory 同形态：把校验失败转为 400
      exceptionFactory: (errors) =>
        new BadRequestException(
          errors
            .map((error) => Object.values(error.constraints ?? {}).join('; '))
            .filter(Boolean)
            .join('; '),
        ),
    });

    let rejected: unknown;
    try {
      await pipe.transform({ applicationId: 0 }, { type: 'body', metatype: ReviewInputProbe });
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toBeInstanceOf(BadRequestException);

    const configService = {
      get: jest.fn().mockReturnValue('production'),
    } as unknown as ConfigService;
    const host = {
      getType: () => 'graphql',
      getArgs: () => [undefined, {}, {}, { fieldName: 'reviewEngineerRegistration' }],
    } as unknown as ArgumentsHost;
    const filter = new GqlAllExceptionsFilter(configService);

    const error = filter.catch(rejected, host) as GraphQLError;

    expect(error.extensions).toMatchObject({ code: 'BAD_USER_INPUT', httpStatus: 400 });
    expect(error.message).toBe('请求失败');
    expect(error.extensions).not.toHaveProperty('errorCode');
  });

  it('keeps HttpException errorCode in the response body outside production', () => {
    const configService = {
      get: jest.fn().mockReturnValue('development'),
    } as unknown as ConfigService;
    const host = {
      getType: () => 'graphql',
      getArgs: () => [undefined, {}, {}, { fieldName: 'testField' }],
    } as unknown as ArgumentsHost;
    const filter = new GqlAllExceptionsFilter(configService);

    const error = filter.catch(
      new HttpException({ code: 'BAD_USER_INPUT', errorCode: 'X', errorMessage: '细节' }, 400),
      host,
    ) as GraphQLError;

    expect(error.extensions).toMatchObject({
      code: 'BAD_USER_INPUT',
      errorCode: 'X',
      errorMessage: '细节',
    });
    expect(error.message).toBe('细节');
  });
});
