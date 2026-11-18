/// <reference types="jest" />
import type { Provider } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { LoggerModule } from 'nestjs-pino';
import { RepairProcessEntryEntity } from './entities/repair-process-entry.entity';
import { RepairRequestIntakeEntity } from './entities/repair-request-intake.entity';
import { LithographyModule } from './lithography.module';
import { ManagementAuditService } from './management-audit.service';
import { RepairProcessEntryQueryService } from './queries/repair-process-entry.query.service';
import { RepairRequestQueryService } from './queries/repair-request.query.service';

/**
 * 真实 LithographyModule 的依赖装配回归（不连接数据库）。
 *
 * 替身边界：只替换 `TypeOrmModule.forFeature()` 生成的 Repository provider，
 * 不替换任何业务服务；显式注册静默日志模块，提供正式装配所需的全局日志依赖。
 * DataSource 不注册、不初始化，Repository 工厂也不会执行。
 * 因而本规格只证明模块内 provider 与构造依赖可被 Nest 解析，不证明 SQL 行为。
 */
const repositoryTokensOfModule = (): unknown[] => {
  const imports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, LithographyModule) ??
    []) as unknown[];
  const tokens: unknown[] = [];
  for (const entry of imports) {
    if (typeof entry !== 'object' || entry === null || !('providers' in entry)) continue;
    const providers = (entry as { providers?: Provider[] }).providers ?? [];
    for (const provider of providers) {
      if (typeof provider === 'object' && provider !== null && 'provide' in provider) {
        tokens.push(provider.provide);
      }
    }
  }
  return tokens;
};

describe('LithographyModule 依赖装配（离线）', () => {
  it('真实 module 注册 intake 仓储且可解析 RepairRequestQueryService 五参依赖链', async () => {
    const repositoryTokens = repositoryTokensOfModule();
    expect(repositoryTokens).toContain(getRepositoryToken(RepairRequestIntakeEntity));
    expect(repositoryTokens).toContain(getRepositoryToken(RepairProcessEntryEntity));

    const builder = Test.createTestingModule({
      imports: [LoggerModule.forRoot({ pinoHttp: { level: 'silent' } }), LithographyModule],
    });
    for (const token of repositoryTokens) {
      builder.overrideProvider(token).useValue({});
    }
    const moduleRef = await builder.compile();
    try {
      expect(moduleRef.get(ManagementAuditService)).toBeInstanceOf(ManagementAuditService);
      expect(moduleRef.get(RepairRequestQueryService)).toBeInstanceOf(RepairRequestQueryService);
      expect(moduleRef.get(RepairProcessEntryQueryService)).toBeInstanceOf(
        RepairProcessEntryQueryService,
      );
    } finally {
      await moduleRef.close();
    }
  });
});
