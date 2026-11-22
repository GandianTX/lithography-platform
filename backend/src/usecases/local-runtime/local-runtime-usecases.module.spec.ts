// src/usecases/local-runtime/local-runtime-usecases.module.spec.ts

/**
 * 本地运行域用例装配的边界断言（任务 09 验收矩阵 A09-11）。
 *
 * 需求口径（R088／R089 协作）：「普通备份／同步不新增管理审计记录」。
 * 这条口径目前由“没有写入路径”被动成立——本用例把它固化为显式回归：
 * 本地运行域用例装配里不得出现管理审计服务依赖，
 * 否则备份／同步路径一旦接入审计写入，就会静默多出记录类型。
 */

import { ManagementAuditService } from '@src/modules/lithography/management-audit.service';
import { LocalRuntimeUsecasesModule } from './local-runtime-usecases.module';

describe('本地运行域用例装配边界', () => {
  it('装配中不引入管理审计服务：普通备份／同步不新增管理审计记录', () => {
    const providers = Reflect.getMetadata('providers', LocalRuntimeUsecasesModule) as unknown[];

    expect(Array.isArray(providers)).toBe(true);
    expect(providers).not.toContain(ManagementAuditService);
    expect(
      providers.some(
        (provider) =>
          typeof provider === 'object' &&
          provider !== null &&
          'provide' in provider &&
          provider.provide === ManagementAuditService,
      ),
    ).toBe(false);
  });
});
