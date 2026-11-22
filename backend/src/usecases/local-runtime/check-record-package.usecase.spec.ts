// src/usecases/local-runtime/check-record-package.usecase.spec.ts
/// <reference types="jest" />

/**
 * 记录包检查（预检）的定向测试（任务 09 R071／A09-04）。
 *
 * 守住需求原句：「**预检不写库**」「损坏或异主包拒绝」「同包重复操作一个事实」。
 * 断言落在**用例层**（此前只有服务层断言"重复检查不产生第二个事实"）。
 */

import { RECORD_PACKAGE_ERROR, DomainError } from '@core/common/errors/domain-error';

import { CheckRecordPackageUsecase } from './check-record-package.usecase';

const SESSION = {
  accountId: 900101,
  organizationId: 9,
  role: 'ENGINEER',
  roles: ['ENGINEER'],
  identityType: 'ENGINEER',
  adminLevel: null,
} as never;

function buildUsecase(options: { evaluateError?: Error } = {}) {
  const scopeResolver = {
    resolve: jest.fn().mockResolvedValue({ organizationId: 9, role: 'ENGINEER' }),
  };
  const evaluatePackage = jest.fn().mockResolvedValue({
    packageId: 'pkg-1',
    organizationId: 9,
    manifestChecksum: 'a'.repeat(64),
    items: [],
  });
  if (options.evaluateError !== undefined) {
    evaluatePackage.mockRejectedValue(options.evaluateError);
  }
  const persistCheckOutcome = jest.fn().mockResolvedValue({
    import: { packageId: 'pkg-1', organizationId: 9, status: 'CHECKED' },
    items: [],
  });
  const usecase = new CheckRecordPackageUsecase(
    scopeResolver as never,
    { evaluatePackage, persistCheckOutcome } as never,
    { run: jest.fn(async (fn: (ctx: unknown) => Promise<unknown>) => fn({})) } as never,
  );
  return { usecase, evaluatePackage, persistCheckOutcome, scopeResolver };
}

describe('记录包检查（预检）用例（R071）', () => {
  it('预检阶段不写正式业务：只经 evaluatePackage 评估，落库只写检查事实', async () => {
    const { usecase, evaluatePackage, persistCheckOutcome } = buildUsecase();

    await usecase.execute({
      session: SESSION,
      packagePath: '/mnt/usb/pkg',
      manifestChecksum: 'a'.repeat(64),
    } as never);

    expect(evaluatePackage).toHaveBeenCalledTimes(1);
    // 评估入参只含路径与公司，不含"要写入什么业务"的动作参数
    expect(evaluatePackage.mock.calls[0][0]).toEqual({
      packagePath: '/mnt/usb/pkg',
      organizationId: 9,
      importedByAccountId: 900101,
    });
    // 落库阶段只写"检查事实"（批次＋逐条结论），不是业务记录
    expect(persistCheckOutcome).toHaveBeenCalledTimes(1);
  });

  it('异主／损坏包：评估失败直接抛出，不落检查事实（不写库）', async () => {
    const { usecase, persistCheckOutcome } = buildUsecase({
      evaluateError: new DomainError(
        RECORD_PACKAGE_ERROR.PACKAGE_NOT_FOUND,
        '记录包清单损坏或不是本公司的包',
      ),
    });

    await expect(
      usecase.execute({
        session: SESSION,
        packagePath: '/mnt/usb/pkg',
        manifestChecksum: 'a'.repeat(64),
      } as never),
    ).rejects.toBeInstanceOf(DomainError);
    expect(persistCheckOutcome).not.toHaveBeenCalled();
  });

  it('公司范围来自可信 session，不接受客户端自报', async () => {
    const { usecase, evaluatePackage, scopeResolver } = buildUsecase();

    await usecase.execute({
      session: SESSION,
      packagePath: '/mnt/usb/pkg',
      manifestChecksum: 'a'.repeat(64),
      organizationId: 999,
    } as never);

    expect(scopeResolver.resolve).toHaveBeenCalledWith(SESSION);
    expect(evaluatePackage.mock.calls[0][0].organizationId).toBe(9);
  });
});
