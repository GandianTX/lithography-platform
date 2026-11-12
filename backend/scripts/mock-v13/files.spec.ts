// scripts/mock-v13/files.spec.ts

/**
 * 离线文件测试：记录包校验和、文件复用/异主冲突、失败回收范围、凭据文件不覆盖。
 * 全部使用系统临时目录，不接触仓库与真实参考资料目录。
 */

/// <reference types="jest" />

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { MockConflictError } from './errors';
import {
  FileRegistry,
  buildMockPackage,
  canonicalJson,
  corruptMockPackage,
  mockPng,
  mockTextDocument,
  sha256Hex,
  verifyMockPackageContent,
  writeCredentialsFile,
} from './files';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mock-v13-files-'));
}

describe('canonicalJson', () => {
  it('键顺序不影响结果', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it('嵌套对象与数组保持稳定序列化', () => {
    expect(canonicalJson({ a: [{ y: 1, x: 2 }] })).toBe('{"a":[{"x":2,"y":1}]}');
  });
});

describe('记录包', () => {
  const build = () =>
    buildMockPackage({
      packageId: 'MOCK-V13-PKG-1',
      organizationCode: 'MOCK-V13-A',
      generatedAt: '2026-11-06T00:00:00.000Z',
      items: [
        {
          record_uuid: 'a1',
          resource_type: 'REPAIR_REQUEST',
          version_no: 1,
          payload: { requestNo: 'MOCK-V13-REQ-A-001' },
        },
      ],
    });

  it('合法包内容校验通过', () => {
    const result = verifyMockPackageContent(JSON.stringify(build()));
    expect(result.ok).toBe(true);
    expect(result.computed).toBe(result.expected);
  });

  it('篡改内容但保留旧校验和时校验失败', () => {
    const corrupted = corruptMockPackage(build());
    const result = verifyMockPackageContent(JSON.stringify(corrupted));
    expect(result.ok).toBe(false);
    expect(result.computed).not.toBe(result.expected);
  });

  it('缺少校验字段时拒绝解析', () => {
    expect(() => verifyMockPackageContent(JSON.stringify({ items: [] }))).toThrow(
      MockConflictError,
    );
  });
});

describe('FileRegistry', () => {
  let tempDir: string;
  let registry: FileRegistry;

  beforeEach(() => {
    tempDir = createTempDir();
    registry = new FileRegistry([tempDir]);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('首次写入返回 CREATED，同内容重跑返回 REUSED', () => {
    const target = path.join(tempDir, 'a.png');
    const content = mockPng();
    expect(registry.ensure(target, content)).toBe('CREATED');
    expect(registry.ensure(target, content)).toBe('REUSED');
    expect(registry.createdCount()).toBe(1);
  });

  it('同路径不同内容视为异主文件，拒绝覆盖', () => {
    const target = path.join(tempDir, 'a.txt');
    registry.ensure(target, mockTextDocument('标题', '原始内容'));
    expect(() => registry.ensure(target, mockTextDocument('标题', '被篡改内容'))).toThrow(
      MockConflictError,
    );
  });

  it('受控目录之外直接拒绝', () => {
    expect(() =>
      registry.ensure(path.join(os.tmpdir(), 'mock-v13-outside.png'), mockPng()),
    ).toThrow(MockConflictError);
  });

  it('回收只删除本次创建的文件，不动既有文件', () => {
    const existing = path.join(tempDir, 'existing.txt');
    fs.writeFileSync(existing, '人工放置', 'utf8');
    const created = path.join(tempDir, 'created.png');
    registry.ensure(created, mockPng());
    registry.cleanupCreated();

    expect(fs.existsSync(created)).toBe(false);
    expect(fs.existsSync(existing)).toBe(true);
    expect(registry.createdCount()).toBe(0);
  });
});

describe('writeCredentialsFile', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const content = {
    generated_at: '2026-11-06T00:00:00.000Z',
    mock: true as const,
    warning: '仅限开发联调；请通过受控渠道交付，不得提交到 Git。',
    password: 'MockV13#Passw0rd',
    accounts: [],
  };

  it('首次写入成功后权限为 0600', () => {
    const target = path.join(tempDir, 'credentials.json');
    expect(writeCredentialsFile(target, content)).toBe(true);
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    expect(sha256Hex(fs.readFileSync(target))).toBe(sha256Hex(fs.readFileSync(target)));
  });

  it('已存在时不覆盖，保留原内容', () => {
    const target = path.join(tempDir, 'credentials.json');
    expect(writeCredentialsFile(target, content)).toBe(true);
    expect(writeCredentialsFile(target, { ...content, password: 'DifferentPassword#1' })).toBe(
      false,
    );
    expect(fs.readFileSync(target, 'utf8')).toContain('MockV13#Passw0rd');
  });
});
