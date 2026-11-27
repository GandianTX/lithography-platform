// src/modules/lithography/protected-backup.service.package-path.spec.ts

/**
 * 备份包落点唯一性（真实恢复链暴露的缺陷修复的回归护栏）。
 *
 * 缺陷：落点时间戳只到**毫秒**。同一毫秒内"手动备份"与"恢复预检生成保护副本"
 * 会算出同一个目录 ⇒ 保护副本**覆盖待恢复包**：既毁掉恢复源，也让"按保护副本回滚"
 * 必然失败（独立验收在一次性隔离库上实测到该现象）。
 *
 * 修复：落点并入备份运行号，并叠加一次落点存在性探测 ⇒ 每次调用都产生独立目录。
 */

/// <reference types="jest" />
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProtectedBackupService } from './protected-backup.service';

type PathResolver = {
  resolvePackageTargetPath(
    organizationId: number,
    trigger: 'MANUAL' | 'SCHEDULED',
    now: Date,
    runId?: number | null,
  ): string;
  backupStorage: { baseDir: string };
};

function createService(baseDir: string): PathResolver {
  const service = Object.create(ProtectedBackupService.prototype) as unknown as PathResolver;
  service.backupStorage = { baseDir };
  return service;
}

describe('ProtectedBackupService.resolvePackageTargetPath · 落点唯一性', () => {
  let baseDir = '';

  beforeEach(() => {
    baseDir = join(mkdtempSync(join(tmpdir(), 'task09-package-path-')), 'backups');
    mkdirSync(baseDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(join(baseDir, '..'), { recursive: true, force: true });
  });

  it('同一毫秒内的两次调用（不同运行号）落点互不相同', () => {
    const service = createService(baseDir);
    const now = new Date('2026-11-23T08:41:03.422Z');
    const source = service.resolvePackageTargetPath(4, 'MANUAL', now, 11);
    const protection = service.resolvePackageTargetPath(4, 'MANUAL', now, 12);
    expect(source).not.toBe(protection);
  });

  it('不传运行号时也靠存在性探测避开既有落点（绝不覆盖既有包）', () => {
    const service = createService(baseDir);
    const now = new Date('2026-11-23T08:41:03.422Z');
    const first = service.resolvePackageTargetPath(4, 'MANUAL', now);
    mkdirSync(first, { recursive: true });
    writeFileSync(join(first, 'manifest.json'), '{"kept":true}', 'utf8');
    const second = service.resolvePackageTargetPath(4, 'MANUAL', now);
    expect(second).not.toBe(first);
    expect(readFileSync(join(first, 'manifest.json'), 'utf8')).toBe('{"kept":true}');
  });

  it('落点按 <备份根>/<公司ID>/<触发方式>-<时间戳> 组织，且为绝对路径', () => {
    const service = createService(baseDir);
    const path = service.resolvePackageTargetPath(
      4,
      'SCHEDULED',
      new Date('2026-11-23T08:41:03.422Z'),
      7,
    );
    expect(path.startsWith(join(baseDir, '4'))).toBe(true);
    expect(path.endsWith('-r7')).toBe(true);
    expect(path).toContain('scheduled-');
  });
});
