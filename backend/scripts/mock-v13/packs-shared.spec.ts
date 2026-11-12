// scripts/mock-v13/packs-shared.spec.ts

/**
 * 离线补测：正式迁移生成的 local_installation 单例（随机 UUID、organization_id 为空）
 * 必须按实际 installation_id 复用，且整行不被修改。
 */

/// <reference types="jest" />

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { MockConflictError, MockWriteError } from './errors';
import { FileRegistry } from './files';
import { MockQueryRunner, Row } from './db';
import { PackContext, readInstallationIdentity, resolveInstallationIdentity } from './packs-shared';
import { RunReport } from './report';

class InstallationQueryRunner implements MockQueryRunner {
  readonly calls: { sql: string; parameters?: readonly unknown[] }[] = [];

  constructor(private readonly rows: Row[]) {}

  query(sql: string, parameters?: readonly unknown[]): Promise<unknown> {
    this.calls.push({ sql, parameters });
    return Promise.resolve(this.rows);
  }
}

describe('local_installation 单例复用', () => {
  const formalInstallationId = 'c4634e24-de81-11f1-bea8-00e0709ef3a9';

  function formalRow(): Row {
    return {
      id: 1,
      installation_id: formalInstallationId,
      organization_id: null,
      organization_code_snapshot: null,
      local_site_name: null,
      auto_upload_enabled: 1,
      backup_interval_days: 7,
      last_backup_completed_at: null,
      created_at: new Date('2026-11-12T10:13:55.000Z'),
      updated_at: new Date('2026-11-12T10:13:55.000Z'),
    };
  }

  it('随机 UUID、组织为空的正式单例按实际 UUID 复用，整行不变', async () => {
    const row = formalRow();
    const snapshot = { ...row };
    const queryRunner = new InstallationQueryRunner([row]);

    const identity = await readInstallationIdentity(queryRunner);

    expect(identity).toEqual({ installationId: formalInstallationId, organizationId: null });
    expect(row).toEqual(snapshot);
    expect(
      queryRunner.calls.some((call) => /^(UPDATE|INSERT|DELETE|REPLACE)\b/iu.test(call.sql)),
    ).toBe(false);
  });

  it('resolveInstallationIdentity 复用单例并记录未映射组织，不写库', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-v13-installation-'));
    const queryRunner = new InstallationQueryRunner([formalRow()]);
    const context: PackContext = {
      qr: queryRunner,
      report: new RunReport(),
      files: new FileRegistry([tempDir]),
      mockFileDir: tempDir,
      referenceStorageDir: tempDir,
      passwordHash: 'unused-in-offline-test',
      encryption: { encrypt: (plain: string) => plain, decrypt: (cipher: string) => cipher },
    };
    context.report.startPack('p1-local');

    try {
      const identity = await resolveInstallationIdentity(context);

      expect(identity.installationId).toBe(formalInstallationId);
      expect(identity.organizationId).toBeNull();
      expect(context.report.packStats()[0]?.notes.join('')).toContain('organization_id=未映射');
      expect(
        queryRunner.calls.some((call) => /^(UPDATE|INSERT|DELETE|REPLACE)\b/iu.test(call.sql)),
      ).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('installation_id 非 36 位 UUID 时按异主冲突拒绝', async () => {
    const queryRunner = new InstallationQueryRunner([
      { ...formalRow(), installation_id: 'not-a-uuid' },
    ]);

    await expect(readInstallationIdentity(queryRunner)).rejects.toBeInstanceOf(MockConflictError);
  });

  it('缺少正式单例行时拒绝自行创建', async () => {
    const queryRunner = new InstallationQueryRunner([]);

    await expect(readInstallationIdentity(queryRunner)).rejects.toBeInstanceOf(MockWriteError);
  });
});
