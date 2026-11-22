/// <reference types="jest" />
/**
 * 本机运行数据用例模块的**装配可解析性**门禁。
 *
 * 背景：Nest 的模块封装要求"被注入的 provider 必须由导入模块 exports 暴露"。
 * 只在 providers 里注册、忘了写 exports，会让**整个 GraphQL 适配层启动失败**，
 * 而纯 `new` 出来的单测发现不了（真实装配需要隔离库，默认 skip）。
 * 这条门禁用模块元数据反射把这类缺陷挡在单测阶段。
 *
 * 判定口径：
 * - 依赖解析**可传递**（A 导入 B、B 导入 C 时，C 的 exports 也算可用）；
 * - `@Inject(token)` 形态的依赖其类型元数据被擦除为 `Object`，无法静态判定，**跳过**；
 * - 自定义 provider（`{ provide, useExisting }`）由 Nest 自行解析，**跳过**。
 */
import { MODULE_METADATA } from '@nestjs/common/constants';

import { LocalRuntimeStorageModule } from '@src/infrastructure/file-storage/local-runtime-storage.module';
import { AccountInstallerModule } from '@src/modules/account/account-installer.module';
import { LithographyModule } from '@src/modules/lithography/lithography.module';

import { LocalRuntimeUsecasesModule } from './local-runtime-usecases.module';
import { ModuleRef } from '@nestjs/core';

type ClassLike = new (...args: never[]) => unknown;

const readMetadata = (key: string, target: object): unknown[] =>
  (Reflect.getMetadata(key, target) as unknown[] | undefined) ?? [];

const readProviders = (target: object): unknown[] =>
  readMetadata(MODULE_METADATA.PROVIDERS, target);
const readImports = (target: object): object[] =>
  readMetadata(MODULE_METADATA.IMPORTS, target) as object[];
const readExports = (target: object): unknown[] => readMetadata(MODULE_METADATA.EXPORTS, target);

/**
 * 读取模块的 exports：既支持 class（Nest 反射元数据），也支持动态模块对象
 * （`AccountModule.forRoot()` 这类对象直接带 `exports` 数组）。
 */
const readModuleExports = (target: object): unknown[] => {
  const dynamic = target as { exports?: unknown[] };
  if (Array.isArray(dynamic.exports)) {
    return dynamic.exports;
  }
  return readExports(target);
};

/** 读取模块的 imports：动态模块对象直接带 `imports` 数组 */
const readModuleImports = (target: object): object[] => {
  const dynamic = target as { imports?: unknown[] };
  if (Array.isArray(dynamic.imports)) {
    return dynamic.imports as object[];
  }
  return readImports(target);
};

/**
 * 传递收集可达模块的 exports（类形式）。
 *
 * 传播规则与 Nest 一致：模块的 **exports 中若包含另一个模块**，该模块自身的 exports
 * 也随之可用（再导出）；同时沿 imports 传播。
 */
const collectExportedTypes = (roots: readonly object[]): unknown[] => {
  // 按仓库约定用只读数组 + includes 去重（不用手工 Set）
  const exported: unknown[] = [];
  const visited: object[] = [];
  const queue = [...roots];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || visited.includes(current)) {
      continue;
    }
    visited.push(current);
    for (const exportedItem of readModuleExports(current)) {
      if (typeof exportedItem === 'function' && !exported.includes(exportedItem)) {
        exported.push(exportedItem);
        // 导出的模块会把自身 exports 一并带出来（再导出）
        queue.push(exportedItem);
      }
    }
    queue.push(...readModuleImports(current));
  }
  return exported;
};

describe('LocalRuntimeUsecasesModule 装配可解析性', () => {
  it('每个用例注入的依赖都能由同模块 providers 或导入模块的 exports 解析', () => {
    const providers = readProviders(LocalRuntimeUsecasesModule);
    const imports = readImports(LocalRuntimeUsecasesModule);

    const localProviders = providers.filter(
      (provider): provider is ClassLike => typeof provider === 'function',
    );
    const exportedTypes = collectExportedTypes(imports);

    const unresolved: string[] = [];
    for (const provider of providers) {
      if (typeof provider !== 'function') {
        // 自定义 provider（{ provide, useExisting }）由 Nest 自己解析，不在此处校验
        continue;
      }
      const dependencies =
        (Reflect.getMetadata('design:paramtypes', provider) as unknown[] | undefined) ?? [];
      for (const dependency of dependencies) {
        if (dependency === undefined || dependency === null || dependency === Object) {
          // `@Inject(token)` 形态的类型元数据被擦除为 Object，无法静态判定
          continue;
        }
        if (dependency === ModuleRef) {
          // Nest 内建依赖：ModuleRef 由框架在任意模块内注入，无需在 providers/exports 登记
          continue;
        }
        if (
          localProviders.includes(dependency as ClassLike) ||
          exportedTypes.includes(dependency)
        ) {
          continue;
        }
        unresolved.push(
          `${(provider as ClassLike).name} 依赖 ${(dependency as ClassLike).name}：同模块未提供，导入模块也未导出`,
        );
      }
    }

    expect(unresolved).toEqual([]);
  });

  it('导入的模块都登记了 exports（确保依赖可解析的来源真实存在）', () => {
    const imports = readImports(LocalRuntimeUsecasesModule);

    expect(imports).toEqual(
      expect.arrayContaining([
        LithographyModule,
        AccountInstallerModule,
        LocalRuntimeStorageModule,
      ]),
    );
    for (const imported of imports) {
      expect(readModuleExports(imported).length).toBeGreaterThan(0);
    }
  });
});
