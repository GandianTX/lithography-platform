// scripts/mock-v13/packs.ts

/**
 * 数据包注册表。顺序即默认执行顺序，后置包依赖前置包已存在的数据。
 */

import { PACK_IDS, PACK_TITLES, PackId } from './manifest';
import { PackContext } from './packs-shared';
import {
  runDocumentsPack,
  runEquipmentPack,
  runOrgAccountsPack,
  runRepairPack,
  runReportsPack,
} from './packs-p0';
import { runAiPack, runBackupPack, runLocalPack, runPackagesPack } from './packs-p1';
import { GuardViolationError } from './errors';

export interface PackDefinition {
  readonly id: PackId;
  readonly title: string;
  readonly run: (context: PackContext) => Promise<void>;
}

/* eslint-disable @typescript-eslint/naming-convention -- 数据包 ID 是命令行稳定标识，固定使用连字符 */
const REGISTRY: Record<PackId, PackDefinition> = {
  'p0-org-accounts': {
    id: 'p0-org-accounts',
    title: PACK_TITLES['p0-org-accounts'],
    run: runOrgAccountsPack,
  },
  'p0-equipment': {
    id: 'p0-equipment',
    title: PACK_TITLES['p0-equipment'],
    run: runEquipmentPack,
  },
  'p0-repair': {
    id: 'p0-repair',
    title: PACK_TITLES['p0-repair'],
    run: runRepairPack,
  },
  'p0-reports': {
    id: 'p0-reports',
    title: PACK_TITLES['p0-reports'],
    run: async (context) => {
      await runReportsPack(context);
    },
  },
  'p0-documents': {
    id: 'p0-documents',
    title: PACK_TITLES['p0-documents'],
    run: runDocumentsPack,
  },
  'p1-ai': {
    id: 'p1-ai',
    title: PACK_TITLES['p1-ai'],
    run: runAiPack,
  },
  'p1-local': {
    id: 'p1-local',
    title: PACK_TITLES['p1-local'],
    run: runLocalPack,
  },
  'p1-packages': {
    id: 'p1-packages',
    title: PACK_TITLES['p1-packages'],
    run: runPackagesPack,
  },
  'p1-backup': {
    id: 'p1-backup',
    title: PACK_TITLES['p1-backup'],
    run: runBackupPack,
  },
};
/* eslint-enable @typescript-eslint/naming-convention */

export const ALL_PACKS: readonly PackDefinition[] = PACK_IDS.map((id) => REGISTRY[id]);

/**
 * 各数据包的前置包。未同时选择的前置包必须在目标库中已存在，
 * 否则在事务开始前以退出码 2 拒绝，避免把“缺前置”误报成事务内写入失败。
 */
/* eslint-disable @typescript-eslint/naming-convention -- 数据包 ID 是命令行稳定标识 */
export const PACK_PREREQUISITES: Readonly<Record<PackId, readonly PackId[]>> = {
  'p0-org-accounts': [],
  'p0-equipment': [],
  'p0-repair': ['p0-org-accounts', 'p0-equipment'],
  'p0-reports': ['p0-org-accounts', 'p0-equipment', 'p0-repair'],
  'p0-documents': ['p0-org-accounts', 'p0-equipment', 'p0-reports'],
  'p1-ai': ['p0-org-accounts'],
  'p1-local': ['p0-org-accounts'],
  'p1-packages': ['p0-org-accounts'],
  'p1-backup': ['p0-org-accounts'],
};
/* eslint-enable @typescript-eslint/naming-convention */

export function selectPacks(selection: readonly string[]): PackDefinition[] {
  if (selection.length === 1 && selection[0] === 'all') {
    return [...ALL_PACKS];
  }
  const unknown = selection.filter((id) => !(PACK_IDS as readonly string[]).includes(id));
  if (unknown.length > 0) {
    throw new GuardViolationError(
      `未知数据包: ${unknown.join(', ')}；可选值: all, ${PACK_IDS.join(', ')}`,
    );
  }
  const allowed = new Set(selection);
  return ALL_PACKS.filter((pack) => allowed.has(pack.id));
}
