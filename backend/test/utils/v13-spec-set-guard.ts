// test/utils/v13-spec-set-guard.ts
//
// 本轮实库专项的文件集合守卫（纯函数，可离线回归）。
// 目的：执行任何实库命令前，先用完全相同的配置、环境和 --runTestsByPath 路径
// 运行 --listTests，并把实际文件集合与预期逐项比较；任何缺失、多出或数量不符
// 都必须在执行测试前失败关闭。

import * as path from 'path';

export interface V13SpecGroup {
  readonly name: 'delivery' | 'upgrade';
  readonly specs: readonly string[];
}

/** 固定的专项文件清单；新增或删除文件必须显式修改此处并重跑离线回归。 */
export const V13_SPEC_GROUPS: Readonly<Record<'delivery' | 'upgrade', V13SpecGroup>> = {
  delivery: {
    name: 'delivery',
    specs: [
      'src/infrastructure/database/v13-d3-constraint-acceptance.realdb.spec.ts',
      'src/infrastructure/database/e2e-scoped-cleanup.v13.realdb.spec.ts',
      'test/utils/e2e-owned-fixture.e2e-spec.ts',
    ],
  },
  upgrade: {
    name: 'upgrade',
    specs: ['src/infrastructure/database/repair-request-revision-previous-version.realdb.spec.ts'],
  },
};

export const resolveSpecPaths = (rootDir: string, specs: readonly string[]): string[] =>
  specs.map((spec) => path.normalize(path.resolve(rootDir, spec)));

/** 解析 `jest --listTests` 的 stdout；只接受绝对路径行。 */
export const parseListTestsOutput = (stdout: string): string[] => {
  const paths = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && path.isAbsolute(line))
    .map((line) => path.normalize(line));
  return Array.from(new Set(paths)).sort();
};

/**
 * 逐项比较预期与实际文件集合（顺序无关、去重后比较）。
 * 不一致时抛出包含缺失/多出列表的错误，调用方必须在此之后停止执行。
 */
export const assertExactSpecSet = (
  expected: readonly string[],
  actual: readonly string[],
): void => {
  const normalizedExpected = Array.from(
    new Set(expected.map((item) => path.normalize(item))),
  ).sort();
  const normalizedActual = Array.from(new Set(actual.map((item) => path.normalize(item)))).sort();
  const sameLength = normalizedExpected.length === normalizedActual.length;
  const sameOrder = normalizedExpected.every((item, index) => item === normalizedActual[index]);
  if (sameLength && sameOrder) {
    return;
  }
  const missing = normalizedExpected.filter((item) => !normalizedActual.includes(item));
  const extra = normalizedActual.filter((item) => !normalizedExpected.includes(item));
  throw new Error(
    `测试文件集合不一致：预期 ${normalizedExpected.length} 个，实际 ${normalizedActual.length} 个；` +
      `缺少 [${missing.join(', ') || '无'}]；多出 [${extra.join(', ') || '无'}]`,
  );
};
