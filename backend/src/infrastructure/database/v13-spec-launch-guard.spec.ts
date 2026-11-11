// src/infrastructure/database/v13-spec-launch-guard.spec.ts
//
// 本轮实库专项启动守卫的离线回归：文件集合必须与预期完全一致，
// 缺文件、多文件、数量不符都必须在执行前失败关闭。

import * as fs from 'fs';
import * as path from 'path';

import {
  assertExactSpecSet,
  parseListTestsOutput,
  resolveSpecPaths,
  V13_SPEC_GROUPS,
} from '../../../test/utils/v13-spec-set-guard';

const BACKEND_ROOT = path.resolve(__dirname, '../../..');

describe('V13 实库专项启动守卫（离线）', () => {
  const expected = ['/repo/src/a.spec.ts', '/repo/src/b.spec.ts'];

  it('集合完全一致时通过（顺序无关、去重）', () => {
    expect(() =>
      assertExactSpecSet(expected, [
        '/repo/src/b.spec.ts',
        '/repo/src/a.spec.ts',
        '/repo/src/a.spec.ts',
      ]),
    ).not.toThrow();
  });

  it('缺少文件时拒绝并列出缺失项', () => {
    expect(() => assertExactSpecSet(expected, ['/repo/src/a.spec.ts'])).toThrow(
      /缺少.*b\.spec\.ts/,
    );
  });

  it('多出文件时拒绝并列出多出项', () => {
    expect(() => assertExactSpecSet(expected, [...expected, '/repo/src/c.spec.ts'])).toThrow(
      /多出.*c\.spec\.ts/,
    );
  });

  it('数量相同但集合不同时拒绝', () => {
    expect(() =>
      assertExactSpecSet(expected, ['/repo/src/a.spec.ts', '/repo/src/x.spec.ts']),
    ).toThrow(/测试文件集合不一致/);
  });

  it('--listTests 输出只接受绝对路径行并去重排序', () => {
    const stdout = [
      '',
      '  /repo/src/b.spec.ts  ',
      'console noise',
      '/repo/src/a.spec.ts',
      '/repo/src/a.spec.ts',
    ].join('\n');
    expect(parseListTestsOutput(stdout)).toEqual(['/repo/src/a.spec.ts', '/repo/src/b.spec.ts']);
  });

  it('相对路径按 rootDir 归一化为绝对路径', () => {
    const paths = resolveSpecPaths('/repo', ['src/a.spec.ts', './src/b.spec.ts']);
    expect(paths).toEqual(['/repo/src/a.spec.ts', '/repo/src/b.spec.ts']);
  });

  it('delivery 与 upgrade 清单互不重叠且文件真实存在', () => {
    const delivery = resolveSpecPaths(BACKEND_ROOT, V13_SPEC_GROUPS.delivery.specs);
    const upgrade = resolveSpecPaths(BACKEND_ROOT, V13_SPEC_GROUPS.upgrade.specs);

    expect(delivery).toHaveLength(3);
    expect(upgrade).toHaveLength(1);
    expect(delivery.filter((item) => upgrade.includes(item))).toEqual([]);
    for (const specPath of [...delivery, ...upgrade]) {
      expect(fs.existsSync(specPath)).toBe(true);
    }
  });
});
