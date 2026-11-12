// scripts/mock-v13/report.ts

/**
 * 运行统计与验收索引。所有输出都不包含测试密码或密文。
 */

import type { PackId } from './manifest';

export interface PackStat {
  readonly pack: PackId;
  inserted: number;
  reused: number;
  readonly notes: string[];
}

export interface ScenarioRecord {
  readonly kind:
    | 'account'
    | 'organization'
    | 'ticket'
    | 'intake'
    | 'report'
    | 'document'
    | 'file'
    | 'package'
    | 'backup';
  readonly key: string;
  readonly id: number | string;
  readonly detail: string;
}

export class RunReport {
  private readonly stats = new Map<PackId, PackStat>();
  private readonly scenarios: ScenarioRecord[] = [];
  private activePack: PackId | null = null;

  startPack(pack: PackId): void {
    this.activePack = pack;
    this.stats.set(pack, { pack, inserted: 0, reused: 0, notes: [] });
  }

  private current(): PackStat {
    if (!this.activePack) {
      throw new Error('尚未开始任何数据包');
    }
    const stat = this.stats.get(this.activePack);
    if (!stat) {
      throw new Error(`数据包 ${this.activePack} 未登记`);
    }
    return stat;
  }

  inserted(count = 1): void {
    this.current().inserted += count;
  }

  reused(count = 1): void {
    this.current().reused += count;
  }

  note(message: string): void {
    this.current().notes.push(message);
  }

  scenario(record: ScenarioRecord): void {
    this.scenarios.push(record);
  }

  packStats(): PackStat[] {
    return [...this.stats.values()];
  }

  scenarioIndex(): ScenarioRecord[] {
    return [...this.scenarios];
  }

  totalInserted(): number {
    return this.packStats().reduce((total, stat) => total + stat.inserted, 0);
  }

  totalReused(): number {
    return this.packStats().reduce((total, stat) => total + stat.reused, 0);
  }
}

export function formatSummary(
  report: RunReport,
  headers: {
    readonly database: string;
    readonly instanceUuid: string;
    readonly mode: 'dry-run' | 'write';
    readonly durationMs: number;
  },
): string {
  const lines: string[] = [];
  lines.push(`${'='.repeat(78)}`);
  lines.push(`V13 Mock 数据运行结果 | 模式=${headers.mode} | 库=${headers.database}`);
  lines.push(`实例 UUID=${headers.instanceUuid} | 耗时=${headers.durationMs}ms`);
  lines.push(`${'='.repeat(78)}`);
  lines.push('数据包                 新增   复用   备注');
  for (const stat of report.packStats()) {
    lines.push(
      `${stat.pack.padEnd(22)} ${String(stat.inserted).padStart(4)} ${String(stat.reused).padStart(6)}   ${stat.notes.join('；')}`,
    );
  }
  lines.push('-'.repeat(78));
  lines.push(`合计新增 ${report.totalInserted()} 行，复用 ${report.totalReused()} 行`);

  const scenarios = report.scenarioIndex();
  if (scenarios.length > 0) {
    lines.push('-'.repeat(78));
    lines.push('样例索引（登录名/编号 -> 主键）');
    for (const item of scenarios) {
      lines.push(`  [${item.kind}] ${item.key} -> ${item.id}  ${item.detail}`);
    }
  }
  return lines.join('\n');
}

export function formatHelp(): string {
  return [
    'V13 开发 Mock 数据入口',
    '',
    '用法：',
    '  npm run mock:v13 -- \\',
    '    --env-file /secure/path/mock-v13.env \\',
    '    --database lithography_v13_dev \\',
    '    --confirm-database lithography_v13_dev \\',
    '    --allow-database lithography_v13_dev \\',
    '    --expected-instance-uuid <@@server_uuid> \\',
    '    --mock-file-dir /secure/path/mock-v13-files \\',
    '    --reference-storage-dir /secure/path/reference-documents \\',
    '    --pack all \\',
    '    [--write] [--credentials-out /secure/path/mock-v13-credentials.json] \\',
    '    [--json-out /secure/path/mock-v13-run.json] [--fail-after-pack <packId>]',
    '',
    '默认是 dry-run：只做守卫与目标核对，不写入。',
    '--write 还需要环境文件内写入 MOCK_V13_WRITE_ACK 确认短语。',
    '--allow-database 可重复传入；--mock-file-dir 与 --reference-storage-dir 必须是',
    '彼此不同、位于仓库外的独立目录（默认分别为 var/mock-v13 与 var/reference-documents）。',
    '',
    '可用数据包（按默认顺序）：',
    '  p0-org-accounts, p0-equipment, p0-repair, p0-reports, p0-documents,',
    '  p1-ai, p1-local, p1-packages, p1-backup',
    '',
    '退出码：0 成功/无需写入；2 守卫拒绝；3 异主冲突；4 写入回滚；5 写入后校验失败；',
    '        6 事务已提交但收尾文件写入失败（数据不回滚）。',
  ].join('\n');
}
