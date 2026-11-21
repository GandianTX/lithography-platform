// src/usecases/ai-worker/ai-workflow-worker-usecases.module.spec.ts
/// <reference types="jest" />

import type { DynamicModule, Provider, Type } from '@nestjs/common';
import {
  GLOBAL_MODULE_METADATA,
  MODULE_METADATA,
  PARAMTYPES_METADATA,
  SELF_DECLARED_DEPS_METADATA,
} from '@nestjs/common/constants';
import { WorkerModule } from '@src/bootstraps/worker/worker.module';
import { AiWorkflowContextModule } from '@src/modules/ai-workflow-context/ai-workflow-context.module';
import { AI_CONVERSATION_EXECUTION_LOOKUP } from '@src/usecases/common/ports/ai-conversation-execution.contract';

import { AiConversationReplyWorkflowHandler } from './ai-conversation-reply-workflow.handler';
import { AiWorkflowWorkerUsecasesModule } from './ai-workflow-worker-usecases.module';

/**
 * F11 装配回归检查。
 *
 * G1 的失败不是 handler 逻辑问题，而是 `AiWorkflowWorkerUsecasesModule` 没有导入提供
 * `AI_CONVERSATION_EXECUTION_LOOKUP` 的 owner 模块：Worker 启动即抛 UnknownDependenciesException。
 * 这里从正式 Worker 根模块出发，按 Nest 的可见性规则（自身 providers + 各导入模块 exports +
 * 全局模块 exports）核对 Worker 用例模块每个 provider 的构造依赖，使同类回归在单测阶段就失败。
 * 真实进程启动与队列消费另由 `test/08-qm-worker` 的 e2e 覆盖，本用例不替代它。
 */
describe('AiWorkflowWorkerUsecasesModule 模块装配', () => {
  const workerGraph = collectModuleGraph(WorkerModule);

  it('Worker 用例模块中每个 provider 的构造依赖在正式 Worker 模块图内可解析', () => {
    const unresolved = findUnresolvedDependencies(
      AiWorkflowWorkerUsecasesModule,
      buildVisibleTokens(AiWorkflowWorkerUsecasesModule, workerGraph),
    );

    expect(unresolved).toEqual([]);
  });

  it('执行身份端口由数据 owner 模块提供，Worker 用例模块通过导入该模块取得', () => {
    const visibleTokens = buildVisibleTokens(AiWorkflowWorkerUsecasesModule, workerGraph);

    expect(visibleTokens.has(AI_CONVERSATION_EXECUTION_LOOKUP)).toBe(true);
    expect(readImports(AiWorkflowWorkerUsecasesModule)).toContain(AiWorkflowContextModule);
    expect(readExportedTokens(AiWorkflowContextModule)).toContain(AI_CONVERSATION_EXECUTION_LOOKUP);
  });

  it('拿掉执行身份端口后该检查会在目标依赖处失败（证明断言有效）', () => {
    const visibleTokens = buildVisibleTokens(AiWorkflowWorkerUsecasesModule, workerGraph);
    visibleTokens.delete(AI_CONVERSATION_EXECUTION_LOOKUP);

    const unresolved = findUnresolvedDependencies(AiWorkflowWorkerUsecasesModule, visibleTokens);

    expect(unresolved).toEqual([
      {
        provider: AiConversationReplyWorkflowHandler,
        index: 4,
        token: AI_CONVERSATION_EXECUTION_LOOKUP,
      },
    ]);
  });
});

type ModuleEntry = Type<unknown> | DynamicModule;

type UnresolvedDependency = {
  readonly provider: Type<unknown>;
  readonly index: number;
  readonly token: unknown;
};

type ModuleGraph = {
  readonly modules: ModuleEntry[];
  readonly globalExportedTokens: Set<unknown>;
};

function buildVisibleTokens(module: ModuleEntry, graph: ModuleGraph): Set<unknown> {
  const visible = new Set<unknown>(readOwnProviderTokens(module));
  for (const imported of readImports(module)) {
    for (const token of readExportedTokens(imported)) {
      visible.add(token);
    }
  }
  for (const token of graph.globalExportedTokens) {
    visible.add(token);
  }
  return visible;
}

function findUnresolvedDependencies(
  module: ModuleEntry,
  visibleTokens: Set<unknown>,
): UnresolvedDependency[] {
  const unresolved: UnresolvedDependency[] = [];
  for (const provider of readProviders(module)) {
    if (typeof provider !== 'function') {
      continue;
    }
    resolveConstructorTokens(provider).forEach((token, index) => {
      if (token === undefined || visibleTokens.has(token)) {
        return;
      }
      unresolved.push({ provider, index, token });
    });
  }
  return unresolved;
}

function collectModuleGraph(root: ModuleEntry): ModuleGraph {
  const modules: ModuleEntry[] = [];
  const globalExportedTokens = new Set<unknown>();

  const visit = (entry: ModuleEntry): void => {
    if (modules.includes(entry)) {
      return;
    }
    modules.push(entry);
    if (isGlobalModule(entry)) {
      for (const token of readExportedTokens(entry)) {
        globalExportedTokens.add(token);
      }
    }
    for (const child of readImports(entry)) {
      visit(child);
    }
  };

  visit(root);
  return { modules, globalExportedTokens };
}

function readProviders(entry: ModuleEntry): Provider[] {
  return isDynamicModule(entry)
    ? (entry.providers ?? [])
    : readDecoratorMetadata<Provider[]>(entry, MODULE_METADATA.PROVIDERS);
}

function readImports(entry: ModuleEntry): ModuleEntry[] {
  return isDynamicModule(entry)
    ? ((entry.imports ?? []) as ModuleEntry[])
    : readDecoratorMetadata<ModuleEntry[]>(entry, MODULE_METADATA.IMPORTS);
}

function readExportedTokens(entry: ModuleEntry): unknown[] {
  return isDynamicModule(entry)
    ? (entry.exports ?? [])
    : readDecoratorMetadata<unknown[]>(entry, MODULE_METADATA.EXPORTS);
}

function readOwnProviderTokens(entry: ModuleEntry): unknown[] {
  return readProviders(entry)
    .filter((provider) => provider !== undefined)
    .map((provider) =>
      typeof provider === 'function' ? provider : (provider as { provide: unknown }).provide,
    );
}

function readDecoratorMetadata<T = Provider[]>(entry: ModuleEntry, key: string): T {
  const target = isDynamicModule(entry) ? entry.module : entry;
  return (Reflect.getMetadata(key, target) as T | undefined) ?? ([] as unknown as T);
}

function isDynamicModule(entry: unknown): entry is DynamicModule {
  return typeof entry === 'object' && entry !== null && 'module' in entry;
}

function isGlobalModule(entry: ModuleEntry): boolean {
  const target = isDynamicModule(entry) ? entry.module : entry;
  return Boolean(Reflect.getMetadata(GLOBAL_MODULE_METADATA, target));
}

function resolveConstructorTokens(target: Type<unknown>): unknown[] {
  const declared =
    (Reflect.getMetadata(PARAMTYPES_METADATA, target) as unknown[] | undefined) ?? [];
  const injected =
    (Reflect.getMetadata(SELF_DECLARED_DEPS_METADATA, target) as
      Array<{ index: number; param: unknown }> | undefined) ?? [];

  const tokens = [...declared];
  for (const item of injected) {
    tokens[item.index] = item.param;
  }
  return tokens;
}
