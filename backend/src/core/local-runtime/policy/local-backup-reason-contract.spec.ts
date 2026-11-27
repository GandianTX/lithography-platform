// src/core/local-runtime/policy/local-backup-reason-contract.spec.ts
/**
 * 前后端**受控原因码一致性守卫**（review 遗留 L4／A7）。
 *
 * 为什么要有这条守卫：
 * - 后端对外只给受控原因码，前端按码映射文案；两边此前是**纯手工对齐**，
 *   没有生成、也没有一致性测试 ⇒ 后端新增一个码，前端不会自动出现，
 *   页面上就显示「原因未登记」（最关键的一条：「备份清单登记了原件但包内缺字节」
 *   曾经就是这样被吞成通用兜底的）；
 * - 这类漂移已经在本分支**实际发生**（漏配 8 个 LOCAL_* 码 ＋ 2 个 RESTORE_* 码
 *   ＋ 6 个 CLOUD_* 远端码），因此需要一个**机制**而不是一次性补齐。
 *
 * 守卫口径：后端三份受控码清单（备份原因码／恢复执行原因码／上云链失败码）
 * 必须是前端码表键集合的**子集**；且前端码表引用的文案键在中英文词条表里都存在。
 *
 * 边界：前端目录不在（后端单独检出的场景）时**跳过**而不是误报失败；
 * 前端目录在但码表缺项时**必须失败**。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CLOUD_UPLOAD_FAILURE_CODES } from './local-backup-cloud-upload.policy';
import {
  LOCAL_BACKUP_FAILURE_REASON,
  LOCAL_RESTORE_EXECUTION_REASON_CODES,
} from './local-backup-failure-reason';

const REPO_ROOT = join(__dirname, '../../../../..');
const FRONTEND_DIR = join(REPO_ROOT, 'frontend');
const REASON_MAP_FILE = join(FRONTEND_DIR, 'src/shared/i18n/local-backup-reason.ts');
const ZH_MESSAGES_FILE = join(FRONTEND_DIR, 'src/shared/i18n/messages.zh-CN.ts');
const EN_MESSAGES_FILE = join(FRONTEND_DIR, 'src/shared/i18n/messages.en.ts');

/** 从前端码表里解析出键集合 */
function readFrontendReasonKeys(): Set<string> {
  const source = readFileSync(REASON_MAP_FILE, 'utf8');
  const keys = new Set<string>();
  for (const match of source.matchAll(/^\s{2}([A-Z][A-Z0-9_]*):/gm)) {
    keys.add(match[1]);
  }
  return keys;
}

/** 从前端码表里解析出「码 → 文案键」映射 */
function readFrontendReasonMessageKeys(): Map<string, string> {
  const source = readFileSync(REASON_MAP_FILE, 'utf8');
  const entries = new Map<string, string>();
  for (const match of source.matchAll(/^\s{2}([A-Z][A-Z0-9_]*):\s*'([^']+)'/gm)) {
    entries.set(match[1], match[2]);
  }
  return entries;
}

/** 从词条表里解析出已登记的文案键 */
function readMessageKeys(file: string): Set<string> {
  const source = readFileSync(file, 'utf8');
  const keys = new Set<string>();
  for (const match of source.matchAll(/'([a-z0-9A-Z.-]+)':/g)) {
    keys.add(match[1]);
  }
  return keys;
}

const frontendPresent = existsSync(REASON_MAP_FILE);
const describeIfFrontend = frontendPresent ? describe : describe.skip;

if (!frontendPresent) {
  // eslint-disable-next-line no-console
  console.warn(
    `[守卫跳过] 未找到前端码表（${REASON_MAP_FILE}）：后端单独检出的场景不做跨仓断言。`,
  );
}

describeIfFrontend('前后端受控原因码一致性守卫', () => {
  const backendCodes: string[] = [
    ...Object.values(LOCAL_BACKUP_FAILURE_REASON),
    ...Object.values(LOCAL_RESTORE_EXECUTION_REASON_CODES),
    ...Object.values(CLOUD_UPLOAD_FAILURE_CODES),
  ];

  it('后端受控码全部在前端码表中有映射', () => {
    const frontendKeys = readFrontendReasonKeys();
    const missing = backendCodes.filter((code) => !frontendKeys.has(code));
    expect(missing).toEqual([]);
  });

  it('前端码表引用的文案键在中英文词条表里都存在', () => {
    const entries = readFrontendReasonMessageKeys();
    const zhKeys = readMessageKeys(ZH_MESSAGES_FILE);
    const enKeys = readMessageKeys(EN_MESSAGES_FILE);
    const missingZh: string[] = [];
    const missingEn: string[] = [];
    for (const messageKey of entries.values()) {
      if (!zhKeys.has(messageKey)) {
        missingZh.push(messageKey);
      }
      if (!enKeys.has(messageKey)) {
        missingEn.push(messageKey);
      }
    }
    expect(missingZh).toEqual([]);
    expect(missingEn).toEqual([]);
  });
});
