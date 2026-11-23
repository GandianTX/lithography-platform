// backend/scripts/task09-script-utils.spec.ts

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DataSource } from 'typeorm';

import {
  createAssertionCollector,
  loadEnvFile,
  readInstallationId,
  readServerUuid,
  text,
} from './task09-script-utils';

/**
 * 共享脚本工具的**行为锁定**。
 *
 * 这些 helper 之前在四个脚本里各存一份；收敛成一份之后，任何改动都必须
 * 先过这份用例，否则"某个脚本的输出文本变了"会被无声地引入证据链。
 */
describe('任务 09 取证脚本共享工具', () => {
  describe('text()', () => {
    it('字符串原样返回', () => {
      expect(text('abc')).toBe('abc');
    });

    it('数字／布尔按字面量转文本', () => {
      expect(text(42)).toBe('42');
      expect(text(true)).toBe('true');
      expect(text(false)).toBe('false');
    });

    it('空值返回空串（不得出现 "undefined"／"null"）', () => {
      expect(text(null)).toBe('');
      expect(text(undefined)).toBe('');
    });

    it('对象／数组按 JSON 序列化（不得退化成 [object Object]）', () => {
      expect(text({ id: 1 })).toBe('{"id":1}');
      expect(text([1, 2])).toBe('[1,2]');
    });
  });

  describe('createAssertionCollector()', () => {
    it('按调用顺序收集断言条目', () => {
      const { assertions, check } = createAssertionCollector();
      check('第一条', true, 'ok');
      check('第二条', false, '不通过');
      expect(assertions).toEqual([
        { name: '第一条', passed: true, detail: 'ok' },
        { name: '第二条', passed: false, detail: '不通过' },
      ]);
    });

    it('每次调用返回独立收集器（互不串味）', () => {
      const first = createAssertionCollector();
      const second = createAssertionCollector();
      first.check('仅第一条', true, 'ok');
      expect(first.assertions).toHaveLength(1);
      expect(second.assertions).toHaveLength(0);
    });
  });

  describe('loadEnvFile()', () => {
    it('把 env 文件的键值写入 process.env', () => {
      const dir = mkdtempSync(join(tmpdir(), 'task09-utils-'));
      const file = join(dir, 'sample.env');
      writeFileSync(file, 'TASK09_UTILS_SAMPLE=hello\nTASK09_UTILS_OTHER=world\n', 'utf8');
      const previous = process.env['TASK09_UTILS_SAMPLE'];
      try {
        loadEnvFile(file);
        expect(process.env['TASK09_UTILS_SAMPLE']).toBe('hello');
        expect(process.env['TASK09_UTILS_OTHER']).toBe('world');
      } finally {
        if (previous === undefined) {
          delete process.env['TASK09_UTILS_SAMPLE'];
        } else {
          process.env['TASK09_UTILS_SAMPLE'] = previous;
        }
        delete process.env['TASK09_UTILS_OTHER'];
      }
    });
  });

  describe('readInstallationId()／readServerUuid()', () => {
    const dataSource = (rows: unknown): DataSource =>
      ({ query: jest.fn().mockResolvedValue(rows) }) as unknown as DataSource;

    it('读取安装标识', async () => {
      await expect(readInstallationId(dataSource([{ installationId: 'inst-1' }]))).resolves.toBe(
        'inst-1',
      );
    });

    it('空结果返回 null（不得抛错）', async () => {
      await expect(readInstallationId(dataSource([]))).resolves.toBeNull();
    });

    it('读取实例 UUID', async () => {
      await expect(readServerUuid(dataSource([{ serverUuid: 'uuid-1' }]))).resolves.toBe('uuid-1');
      await expect(readServerUuid(dataSource([]))).resolves.toBeNull();
    });
  });
});
