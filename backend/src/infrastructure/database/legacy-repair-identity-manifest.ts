import { createHash } from 'crypto';
import * as fs from 'fs';

import type { QueryRunner } from 'typeorm';

/**
 * 历史维修申请身份清单（库外文件）。
 *
 * Git 只保存本文件的格式、校验器与合成样例；真实 31 态工单 ID/行指纹由获授权人
 * 在停写窗口导出并签字，不进入仓库。迁移只在清单命中且指纹一致时把行标记为历史，
 * 集合外一律按新行处理。
 */
export const LEGACY_REPAIR_IDENTITY_MANIFEST_FORMAT_VERSION = 1;

export const LEGACY_REPAIR_IDENTITY_MANIFEST_ENV = 'V13_LEGACY_REPAIR_REQUEST_MANIFEST';

export type LegacyRepairIdentitySource = 'V13_31_STATE' | 'V13_INCREMENTAL_EXECUTED';

export interface LegacyRepairIdentityRow {
  readonly id: number;
  readonly fingerprint: string;
}

export interface LegacyRepairIdentityManifest {
  readonly formatVersion: typeof LEGACY_REPAIR_IDENTITY_MANIFEST_FORMAT_VERSION;
  readonly source: LegacyRepairIdentitySource;
  readonly frozenAt: string;
  readonly rows: ReadonlyArray<LegacyRepairIdentityRow>;
}

/**
 * 指纹只覆盖稳定身份事实，不包含可变的备注、更新时间或业务正文；
 * 任意一项变化都意味着冻结清单与当前库不一致，迁移必须中止并要求重新冻结。
 */
export interface LegacyRepairIdentityFacts {
  readonly id: number;
  readonly intakeId: number | null;
  /** 处理状态事实（repair_request.handling_status）；31 态无 status 列，且未处理时为 NULL */
  readonly handlingStatus: string | null;
  readonly handlingResult: string | null;
}

const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const SOURCES: ReadonlySet<string> = new Set(['V13_31_STATE', 'V13_INCREMENTAL_EXECUTED']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readPositiveInteger = (value: unknown, field: string): number => {
  const parsed = typeof value === 'string' && value.trim().length > 0 ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`历史身份清单字段 ${field} 必须是正整数`);
  }
  return parsed;
};

const readOptionalInteger = (value: unknown, field: string): number | null => {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = typeof value === 'string' && value.trim().length > 0 ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isInteger(parsed)) {
    throw new Error(`历史身份清单字段 ${field} 必须是整数或 null`);
  }
  return parsed;
};

const readText = (value: unknown, field: string): string => {
  if (typeof value !== 'string') {
    throw new Error(`历史身份清单字段 ${field} 必须是字符串`);
  }
  return value;
};

/**
 * 规范化行指纹输入；MySQL 驱动可能把数值列返回为字符串。
 */
export function normalizeLegacyRepairIdentityFacts(
  facts: LegacyRepairIdentityFacts,
): LegacyRepairIdentityFacts {
  return {
    id: readPositiveInteger(facts.id, 'id'),
    intakeId: readOptionalInteger(facts.intakeId, 'intakeId'),
    handlingStatus:
      facts.handlingStatus === null || facts.handlingStatus === undefined
        ? null
        : readText(facts.handlingStatus, 'handlingStatus'),
    handlingResult:
      facts.handlingResult === null || facts.handlingResult === undefined
        ? null
        : readText(facts.handlingResult, 'handlingResult'),
  };
}

/**
 * 把数据库驱动的列值安全转成文本；NULL 保持 NULL。
 */
function toNullableText(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  throw new Error('历史身份清单读取到非文本列值');
}

export function fingerprintLegacyRepairRequestRow(facts: LegacyRepairIdentityFacts): string {
  const normalized = normalizeLegacyRepairIdentityFacts(facts);
  const canonical = JSON.stringify([
    normalized.id,
    normalized.intakeId,
    normalized.handlingStatus,
    normalized.handlingResult,
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function parseLegacyRepairIdentityManifest(raw: string): LegacyRepairIdentityManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('历史身份清单不是合法 JSON');
  }
  if (!isRecord(parsed)) {
    throw new Error('历史身份清单必须是 JSON 对象');
  }
  if (parsed['formatVersion'] !== LEGACY_REPAIR_IDENTITY_MANIFEST_FORMAT_VERSION) {
    throw new Error(
      `历史身份清单 formatVersion 必须是 ${String(LEGACY_REPAIR_IDENTITY_MANIFEST_FORMAT_VERSION)}`,
    );
  }
  const source = parsed['source'];
  if (typeof source !== 'string' || !SOURCES.has(source)) {
    throw new Error('历史身份清单 source 必须是 V13_31_STATE 或 V13_INCREMENTAL_EXECUTED');
  }
  const frozenAt = parsed['frozenAt'];
  if (typeof frozenAt !== 'string' || Number.isNaN(Date.parse(frozenAt))) {
    throw new Error('历史身份清单 frozenAt 必须是合法时间字符串');
  }
  const rawRows = parsed['rows'];
  if (!Array.isArray(rawRows)) {
    throw new Error('历史身份清单 rows 必须是数组');
  }

  const seen = new Set<number>();
  const rows: LegacyRepairIdentityRow[] = [];
  for (const [index, rawRow] of rawRows.entries()) {
    if (!isRecord(rawRow)) {
      throw new Error(`历史身份清单 rows[${String(index)}] 必须是对象`);
    }
    const id = readPositiveInteger(rawRow['id'], `rows[${String(index)}].id`);
    const fingerprint = readText(rawRow['fingerprint'], `rows[${String(index)}].fingerprint`);
    if (!FINGERPRINT_PATTERN.test(fingerprint)) {
      throw new Error(
        `历史身份清单 rows[${String(index)}].fingerprint 必须是 64 位小写十六进制 SHA-256`,
      );
    }
    if (seen.has(id)) {
      throw new Error(`历史身份清单存在重复工单 ID: ${String(id)}`);
    }
    seen.add(id);
    rows.push({ id, fingerprint });
  }

  return {
    formatVersion: LEGACY_REPAIR_IDENTITY_MANIFEST_FORMAT_VERSION,
    source: source as LegacyRepairIdentitySource,
    frozenAt,
    rows,
  };
}

export function loadLegacyRepairIdentityManifestFile(
  filePath: string,
): LegacyRepairIdentityManifest {
  if (!fs.existsSync(filePath)) {
    throw new Error(`历史身份清单不存在: ${filePath}`);
  }
  const content = fs.readFileSync(filePath, 'utf8');
  if (content.trim().length === 0) {
    throw new Error(`历史身份清单为空: ${filePath}`);
  }
  return parseLegacyRepairIdentityManifest(content);
}

let activeManifest: LegacyRepairIdentityManifest | null = null;

export function setLegacyRepairIdentityManifest(manifest: LegacyRepairIdentityManifest): void {
  activeManifest = manifest;
}

export function getLegacyRepairIdentityManifest(): LegacyRepairIdentityManifest | null {
  return activeManifest;
}

export function resetLegacyRepairIdentityManifest(): void {
  activeManifest = null;
}

const LEGACY_MARK_BATCH_SIZE = 500;

/**
 * 空表无需读取任何列：全新库在 1775501100000 执行前还没有 intake_id，
 * 直接 SELECT 该列会以 Unknown column 失败，使 init 无法从空库建成 41 态。
 */
async function isRepairRequestEmpty(queryRunner: QueryRunner): Promise<boolean> {
  const countRows = (await queryRunner.query(
    'SELECT COUNT(*) AS count FROM `repair_request`',
  )) as ReadonlyArray<Record<string, unknown>>;
  return Number(countRows[0]?.['count'] ?? 0) === 0;
}

/**
 * 31 态在 1775501100000 之前没有 intake_id；旧版增量已执行库才有。
 * 缺列时按 NULL 参与指纹，与历史行实际取值一致，不做任何猜测填充。
 */
async function resolveIntakeIdProjection(queryRunner: QueryRunner): Promise<string> {
  const intakeColumns = (await queryRunner.query(
    `SELECT \`COLUMN_NAME\`
       FROM \`information_schema\`.\`COLUMNS\`
      WHERE \`TABLE_SCHEMA\` = DATABASE()
        AND \`TABLE_NAME\` = 'repair_request'
        AND \`COLUMN_NAME\` = 'intake_id'`,
  )) as ReadonlyArray<Record<string, unknown>>;
  return intakeColumns.length > 0 ? '`intake_id`' : 'NULL AS `intake_id`';
}

/**
 * 读取并校验当前进程注入的库外冻结清单。
 *
 * - 表为空：不需要清单，返回 null；
 * - 31 态：清单必须与库内工单逐条一一对应，防止把新行误标为历史；
 * - 已执行旧版增量：清单内 ID 必须存在且指纹一致，集合外的行按新行保留。
 */
export async function resolveAndVerifyLegacyRepairManifest(
  queryRunner: QueryRunner,
): Promise<LegacyRepairIdentityManifest | null> {
  if (await isRepairRequestEmpty(queryRunner)) {
    return null;
  }
  const intakeExpression = await resolveIntakeIdProjection(queryRunner);

  const rows = (await queryRunner.query(
    `SELECT \`id\`, ${intakeExpression}, \`handling_status\`, \`handling_result\`
       FROM \`repair_request\`
      ORDER BY \`id\``,
  )) as ReadonlyArray<Record<string, unknown>>;
  if (rows.length === 0) {
    return null;
  }

  const manifest = getLegacyRepairIdentityManifest();
  if (manifest === null) {
    throw new Error(
      'repair_request 非空但未提供历史身份清单：禁止用 intake_id=NULL、' +
        'revision_no=0 或时间猜测历史身份。请通过 database:deploy ' +
        '--legacy-repair-manifest 注入库外冻结清单后重试。',
    );
  }

  const expectedById = new Map(manifest.rows.map((row) => [row.id, row.fingerprint]));
  const issues: string[] = [];
  for (const row of rows) {
    const id = Number(row['id']);
    const expectedFingerprint = expectedById.get(id);
    const actualFingerprint = fingerprintLegacyRepairRequestRow({
      id,
      intakeId:
        row['intake_id'] === null || row['intake_id'] === undefined
          ? null
          : Number(row['intake_id']),
      handlingStatus: toNullableText(row['handling_status']),
      handlingResult: toNullableText(row['handling_result']),
    });
    if (expectedFingerprint === undefined) {
      if (manifest.source === 'V13_31_STATE') {
        issues.push(`工单 ${String(id)} 不在 31 态冻结清单`);
      }
      continue;
    }
    if (expectedFingerprint !== actualFingerprint) {
      issues.push(`工单 ${String(id)} 行指纹与冻结清单不一致`);
    }
  }
  if (manifest.source === 'V13_31_STATE' && manifest.rows.length !== rows.length) {
    issues.push(
      `31 态冻结清单 ${String(manifest.rows.length)} 条与库内工单 ${String(rows.length)} 条不一致`,
    );
  }
  if (issues.length > 0) {
    throw new Error(
      '历史身份清单校验失败，未执行任何 ALTER：\n' +
        issues.map((issue) => `  - ${issue}`).join('\n'),
    );
  }
  return manifest;
}

export async function markHistoricalRepairRequests(
  queryRunner: QueryRunner,
  ids: ReadonlyArray<number>,
): Promise<void> {
  for (let index = 0; index < ids.length; index += LEGACY_MARK_BATCH_SIZE) {
    const chunk = ids.slice(index, index + LEGACY_MARK_BATCH_SIZE);
    await queryRunner.query(
      `UPDATE \`repair_request\`
          SET \`is_historical\` = 1
        WHERE \`id\` IN (${chunk.map(() => '?').join(', ')})`,
      chunk,
    );
  }
}
