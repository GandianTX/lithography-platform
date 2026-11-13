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
  private readonly verifiedAccountLogins = new Set<string>();
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

  /** 记录本次创建或已核验的账号；凭据文件只导出这些账号。 */
  markAccountVerified(loginName: string): void {
    this.verifiedAccountLogins.add(loginName);
  }

  verifiedAccountLoginNames(): readonly string[] {
    return [...this.verifiedAccountLogins];
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
    readonly timezone: string | null;
  },
): string {
  const lines: string[] = [];
  lines.push(`${'='.repeat(78)}`);
  lines.push(`V13 Mock 数据运行结果 | 模式=${headers.mode} | 库=${headers.database}`);
  lines.push(
    `实例 UUID=${headers.instanceUuid} | 时区=${headers.timezone ?? '未设置'} | 耗时=${headers.durationMs}ms`,
  );
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
    '    [--json-out /secure/path/mock-v13-run-20261113-01.json] [--fail-after-pack <packId>]',
    '',
    '默认是 dry-run：只做守卫与目标核对，不写入。',
    '--write 还需要环境文件内写入 MOCK_V13_WRITE_ACK 确认短语。',
    '--allow-database 可重复传入；--mock-file-dir 与 --reference-storage-dir 必须是',
    '彼此不同且互不嵌套、且不位于 backend/src、backend/node_modules、backend/dist 或 .git',
    '的独立目录（默认分别为 var/mock-v13 与 var/reference-documents）；路径中任何已存在的',
    '符号链接组件都会在首次写入前被拒绝。',
    '两个原件根会分别写入持久归属标记（实例 UUID + 库名 + 根用途）；标记先在受控位置',
    '完整写入并关闭，再以不覆盖既有标记的方式原子发布。标记不随业务回滚删除。已认领的根',
    '只允许同一实例、同一库复用；已有内容却没有可信归属标记的旧目录会被拒绝，不自动认领也不清理。',
    '--json-out 是每次运行专属的新统计文件：路径已存在时会在写入前以退出码 2 拒绝，',
    '请换用新的文件名或省略该参数；落盘仍使用排他创建，绝不覆盖。',
    '--credentials-out 同样只接受新文件：目标已占用时会在连库、建目录或写文件前退出 2；',
    '请改用新文件名，或重跑时省略该参数。',
    'DB_TIMEZONE 必须与实际运行的开发后端一致（模板使用 +08:00）；字段加密配置',
    '必须与开发后端同源，预检只输出生效时区，不输出密钥。',
    '',
    '可用数据包（按默认顺序）：',
    '  p0-org-accounts, p0-equipment, p0-repair, p0-reports, p0-documents,',
    '  p1-ai, p1-local, p1-packages, p1-backup',
    '',
    '数据包前置：p0-repair 需要 p0-org-accounts + p0-equipment；',
    '  p0-reports 需要 p0-org-accounts + p0-equipment + p0-repair；',
    '  p0-documents 需要 ... + p0-reports；p1-* 需要 p0-org-accounts。',
    '单独执行某包时，未选择的前置包必须在目标库中已存在，否则在写入前拒绝。',
    '--credentials-out 只能与 p0-org-accounts 同时使用，且只导出本次创建或已核验的账号。',
    '--credentials-out 和 --json-out 必须位于两个原件根目录之外，且不能占用原件目录的父路径。',
    '各业务包复用已有数据前，会按该包实际引用的客户/工程师/管理员复核账号状态、资料状态、',
    '角色与可信归属；异常时在该包写行或写文件前拒绝，不自动启用、不重置密码、不覆盖昵称。',
    '已有原件仅在归属、用途、绑定状态、目标、库内 SHA-256 与磁盘内容一致时复用；',
    '只有本事务新建且仍未绑定的原件行会被条件更新绑定。',
    '',
    '退出码：0 成功/无需写入；2 守卫拒绝；3 异主冲突；',
    '        4 事务未开始，或回滚已确认；身份无法确认的文件会保留，并报告路径。',
    '          4 不表示一定发生过回滚；',
    '        5 定向校验失败（含分包复用前的账号事实校验）；',
    '        6 事务已提交但收尾文件写入失败（数据不回滚）；',
    '        7 COMMIT 已发出但结果未知（保留本轮文件，需独立连接只读核对）；',
    '        8 事务启动结果不明或写入失败且回滚未确认（保留本轮文件，不得声称已回滚）；',
    '        连接/关闭错误只做诊断，不覆盖 7 或 8 的事务结论。',
  ].join('\n');
}
