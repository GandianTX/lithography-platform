// 文件位置：src/modules/common/utils/sql-like-pattern.util.spec.ts

import { escapeLikePattern } from './sql-like-pattern.util';

describe('escapeLikePattern', () => {
  it('转义 LIKE 通配符与转义符本身', () => {
    expect(escapeLikePattern('100%_done\\now')).toBe('100\\%\\_done\\\\now');
  });

  it('普通字符与中文保持不变', () => {
    expect(escapeLikePattern('上海 光刻机 company')).toBe('上海 光刻机 company');
  });

  it('空串保持空串', () => {
    expect(escapeLikePattern('')).toBe('');
  });
});
