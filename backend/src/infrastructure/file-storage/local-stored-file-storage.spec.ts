// src/infrastructure/file-storage/local-stored-file-storage.spec.ts

/// <reference types="jest" />
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { LocalReferenceDocumentStorage } from './local-reference-document-storage';
import { LocalStoredFileStorage } from './local-stored-file-storage';

const sha256 = (content: Buffer): string => createHash('sha256').update(content).digest('hex');

describe('LocalStoredFileStorage', () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stored-file-storage-unit-'));
  const makeStorage = () => {
    const base = new LocalReferenceDocumentStorage({ get: jest.fn(() => baseDir) } as never);
    return { base, storage: new LocalStoredFileStorage(base) };
  };

  afterAll(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it('verifyIntegrity：字节数与 SHA-256 一致返回 true', async () => {
    const { storage } = makeStorage();
    const content = Buffer.from('original-bytes-2026');
    const reference = await storage.save(content, 'pdf');

    await expect(
      storage.verifyIntegrity(reference, sha256(content), content.byteLength),
    ).resolves.toBe(true);
  });

  it('verifyIntegrity：同长度内容被替换（SHA-256 不符）返回 false', async () => {
    const { storage } = makeStorage();
    const content = Buffer.from('original-bytes-2026');
    const reference = await storage.save(content, 'pdf');
    const tampered = Buffer.from('tampered-bytes-2026');

    expect(tampered.byteLength).toBe(content.byteLength);
    fs.writeFileSync(path.join(baseDir, reference), tampered);
    await expect(
      storage.verifyIntegrity(reference, sha256(content), content.byteLength),
    ).resolves.toBe(false);
  });

  it('verifyIntegrity：文件被截断返回 false', async () => {
    const { storage } = makeStorage();
    const content = Buffer.from('original-bytes-2026');
    const reference = await storage.save(content, 'pdf');

    await expect(
      storage.verifyIntegrity(reference, sha256(content), content.byteLength + 1),
    ).resolves.toBe(false);
  });

  it('verifyIntegrity：存储对象缺失按契约抛错（由用例映射 INTEGRITY_FAILED）', async () => {
    const { storage } = makeStorage();
    const content = Buffer.from('bytes');

    await expect(
      storage.verifyIntegrity('00000000000000000000000000000000.pdf', sha256(content), 5),
    ).rejects.toBeTruthy();
  });

  it('verifyIntegrity：非法期望大小直接返回 false', async () => {
    const { storage } = makeStorage();

    await expect(storage.verifyIntegrity('any.pdf', 'checksum', 0)).resolves.toBe(false);
  });

  it('save/open/delete 委托同一存储实现', async () => {
    const { base, storage } = makeStorage();
    const saveSpy = jest.spyOn(base, 'save');
    const openSpy = jest.spyOn(base, 'open');
    const deleteSpy = jest.spyOn(base, 'delete');
    const content = Buffer.from('delegate');

    const reference = await storage.save(content, 'txt');
    await storage.delete(reference);

    expect(saveSpy).toHaveBeenCalledWith(content, 'txt');
    expect(deleteSpy).toHaveBeenCalledWith(reference);
    // 删除后 open 应抛错（引用不可用），契约不暴露路径
    await expect(storage.open(reference)).rejects.toBeTruthy();
    expect(openSpy).toHaveBeenCalledWith(reference);
  });
});
