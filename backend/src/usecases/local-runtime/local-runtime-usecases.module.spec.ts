// src/usecases/local-runtime/local-runtime-usecases.module.spec.ts

/**
 * 本地运行域用例装配的边界断言（任务 09 验收矩阵 A09-11）。
 *
 * 需求口径（R088／R089 协作）：「普通备份／同步不新增管理审计记录」。
 * 这条口径目前由"没有写入路径"被动成立——本用例把它固化为显式回归：
 * 本地运行域用例装配里不得出现管理审计服务依赖，
 * 否则备份／同步路径一旦接入审计写入，就会静默多出记录类型。
 *
 * 断言覆盖全部装配形式：直接以类登记、`{ provide, useClass }`、
 * `{ provide, useExisting }`、`{ provide, useValue }`——只查 `provide` 会漏掉
 * `useClass: ManagementAuditService` 这类写法。
 */

import { ManagementAuditService } from '@src/modules/lithography/management-audit.service';
import { LocalRuntimeUsecasesModule } from './local-runtime-usecases.module';

type ProviderLike = unknown;

const referencedClasses = (provider: ProviderLike): unknown[] => {
  if (typeof provider === 'function') {
    return [provider];
  }

  if (typeof provider !== 'object' || provider === null) {
    return [];
  }

  const record = provider as Record<string, unknown>;

  return [record.provide, record.useClass, record.useExisting, record.useValue].filter(
    (value) => typeof value === 'function',
  );
};

describe('本地运行域用例装配边界', () => {
  it('装配中不引入管理审计服务：普通备份／同步不新增管理审计记录', () => {
    const providers = Reflect.getMetadata(
      'providers',
      LocalRuntimeUsecasesModule,
    ) as ProviderLike[];

    expect(Array.isArray(providers)).toBe(true);
    // 有用例确实装配在此模块里（否则断言会空跑通过）
    expect(providers.length).toBeGreaterThan(0);

    const usesManagementAudit = providers.some((provider) =>
      referencedClasses(provider).includes(ManagementAuditService),
    );

    expect(usesManagementAudit).toBe(false);
    // 双向确认：该服务确实存在（避免因改名/移动导致断言指向空类而空跑）
    expect(typeof ManagementAuditService).toBe('function');
  });

  it('装配边界断言本身有效：能识别出以管理审计服务登记的装配项', () => {
    // 反向自检：同样的判定规则必须能命中管理审计服务
    const hit = [
      ManagementAuditService,
      { provide: 'TOKEN', useClass: ManagementAuditService },
      { provide: 'TOKEN2', useExisting: ManagementAuditService },
    ].some((provider) => referencedClasses(provider).includes(ManagementAuditService));

    expect(hit).toBe(true);
  });
});
