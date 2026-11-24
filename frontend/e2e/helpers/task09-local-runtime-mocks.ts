// e2e/helpers/task09-local-runtime-mocks.ts
//
// 任务 09 候选页面的**单一真源**：页面清单 ＋ 视口清单 ＋ GraphQL mock。
//
// 为什么要有这个文件（上一轮口径不一致的修复）：
// - `task09-visual-metrics.spec.ts` 度量**四页**，
//   `task09-local-pages-visual.spec.ts` 截图此前只覆盖**两页**；
//   两份页面清单各写一份 ⇒ "度量过的页面"与"截图过的页面"长期可能不一致，
//   属于**潜在假通过**（页面结构变了、截图侧没跟上，无人发现）。
// - 本文件把「页面清单（含卡片面声明与 V44 对照）」「视口清单」「mock」收敛为一份，
//   两个 spec 各自导入 ⇒ 清单变更只需改一处。
//
// mock-only：不连真实后端、不写共享库（会话用 sessionStorage 预置，GraphQL 全部拦截）。
// 载荷形状必须与 GraphQL 契约一致，否则 adapter 会拒绝映射、页面落到失败态，
// 量到的就不是真实页面（见 `local-runtime-graphql-adapter.ts` 的形状校验）。

import type { Page, Route } from '@playwright/test';

export type Task09VisualViewport = {
  label: string;
  width: number;
  height: number;
};

export type Task09CardExpectation = 'REQUIRED' | 'NONE';

export type Task09VisualPage = {
  label: string;
  path: string;
  /** 卡片面声明：REQUIRED＝必须存在公共卡片面；NONE＝按设计没有（显式断言为 0） */
  card: Task09CardExpectation;
  cardNote: string;
  v44Counterpart: string;
  /**
   * 期望的卡片体内边距（G28 的实际判据）。
   * - V44_ALIGNED：目标页已按 V44 原型实测（`.ant-card-body` = 24px）局部对齐；
   * - REPO_DEFAULT：仓内卡片语言默认（16px），该页不属 V44 对齐范围。
   */
  cardPadding: 'V44_ALIGNED' | 'REPO_DEFAULT';
};

export const TASK09_VISUAL_VIEWPORTS: readonly Task09VisualViewport[] = [
  { label: '1440x900', width: 1440, height: 900 },
  { label: '1366x768', width: 1366, height: 768 },
  { label: '390x844', width: 390, height: 844 },
];

export const TASK09_VISUAL_PAGES: readonly Task09VisualPage[] = [
  {
    label: 'record-packages',
    path: '/engineer/record-packages',
    card: 'NONE',
    cardNote:
      '记录包页为 Tabs＋表单＋结果表格布局，不使用卡片面；V44 无对应页面（其入口在 #/engineer/data-center）',
    v44Counterpart: '#/engineer/data-center',
    cardPadding: 'REPO_DEFAULT',
  },
  {
    label: 'sync-conflicts',
    path: '/engineer/sync-conflicts',
    card: 'NONE',
    cardNote:
      '同步冲突页为清单＋抽屉布局，不使用卡片面；V44 真实冲突页入口是 #/engineer/conflicts/FR-2905（由 #/engineer/data-center 的「处理冲突」按钮跳转；直接访问 #/engineer/conflicts/ 会回落到工程师工作台）',
    v44Counterpart: '#/engineer/conflicts/FR-2905',
    cardPadding: 'REPO_DEFAULT',
  },
  {
    label: 'local-settings',
    path: '/local-settings',
    card: 'REQUIRED',
    cardNote: '本地设置页用公共 DataCard（.data-card）承载分区卡片；V44 对应页 #/local/settings',
    v44Counterpart: '#/local/settings',
    cardPadding: 'V44_ALIGNED',
  },
  {
    label: 'local-backup',
    path: '/local-backup',
    card: 'REQUIRED',
    cardNote:
      '备份与恢复页用公共 DataCard（.data-card）承载分区卡片；V44 对应页 #/admin/data-center（管理员流程「备份与恢复」，3 张卡）与 #/engineer/data-center（工程师流程，4 张卡）',
    v44Counterpart: '#/admin/data-center',
    cardPadding: 'V44_ALIGNED',
  },
];

/** V44 原型实测卡片体内边距（`.ant-card-body`，三视口一致） */
export const TASK09_V44_CARD_PADDING = '24px';
/** 仓内卡片语言默认卡片体内边距（`:root` 的 --panel-padding） */
export const TASK09_REPO_CARD_PADDING = '16px';

/**
 * 表格溢出的**判定口径**（度量规格与提交级截图规格共用的单一真源）。
 *
 * 口径：表格只允许在**自身可横向滚动的容器内**超宽
 * （窄屏按 V44 要求：表格在自身容器横向滚动，**页面不横溢**）；
 * 超宽且**找不到**可横向滚动的祖先 ⇒ 才是真实溢出（页面会被撑开）。
 *
 * 两个规格曾各写一份判定：度量规格识别了可滚动祖先，截图规格仍是
 * "table.scrollWidth - parent.clientWidth" 的旧口径 ⇒ 同一页面在两个规格里
 * 得出相反结论（截图侧假失败）。口径必须单一。
 *
 * 说明：Playwright 的 `page.evaluate` **不能序列化函数参数**
 * （实测报 `Attempting to serialize unexpected value: function`），
 * 因此浏览器侧改为读取下面的**策略常量**后内联判定；
 * Node 侧（本文件导出）保留等价纯函数，供单测与非浏览器场景使用。
 */
export const TASK09_TABLE_OVERFLOW_POLICY = {
  /** 允许"表格在自身可横向滚动容器内超宽"（V44 窄屏口径） */
  allowScrollableAncestor: true,
} as const;

/**
 * 浏览器侧判定函数的全局名（注入脚本使用）。
 *
 * 为什么要有这个注入脚本：Playwright 的 `page.evaluate` **不能序列化函数参数**
 * （实测 `Attempting to serialize unexpected value: function`），
 * 所以浏览器侧无法直接调用本文件的 Node 侧纯函数。
 * 以前的做法是"每个规格各内联一份判定"⇒ 同一口径在多个规格里各写一遍，
 * 曾经因此出现"度量规格通过、截图规格失败"的假失败。
 * 现在把浏览器侧实现收敛到**这一个注入脚本**，三个规格共用。
 */
export const TASK09_TABLE_OVERFLOW_JUDGE_GLOBAL = '__task09ClassifyTableOverflow';

/**
 * 安装浏览器侧表格溢出判定（**单一真源**）。
 *
 * 必须在页面导航之前调用（`addInitScript` 对后续导航生效）。
 */
export async function installTask09TableOverflowJudge(page: Page): Promise<void> {
  await page.addInitScript(
    (input: { policy: typeof TASK09_TABLE_OVERFLOW_POLICY; globalName: string }): void => {
      const target = window as unknown as Record<string, unknown>;
      target[input.globalName] = (overflow: number, hasScrollableAncestor: boolean): number => {
        if (overflow <= 0) {
          return 0;
        }
        if (input.policy.allowScrollableAncestor && hasScrollableAncestor) {
          return 0;
        }
        return overflow;
      };
    },
    {
      policy: TASK09_TABLE_OVERFLOW_POLICY,
      globalName: TASK09_TABLE_OVERFLOW_JUDGE_GLOBAL,
    },
  );
}

/**
 * 表格溢出的判定（Node 侧纯函数；浏览器侧由 `installTask09TableOverflowJudge` 注入）。
 *
 * 两侧是**两份实现**（跨执行环境无法共享同一个函数对象），
 * 因此由 e2e 用例"同一组输入 ⇒ 两侧结果一致"锁定等价性。
 *
 * @param overflow 表格相对其直接父容器的超宽像素
 * @param hasScrollableAncestor 是否存在 overflowX 为 auto/scroll 的祖先
 * @returns 0 表示可接受；正数表示真实溢出的像素数
 */
export function classifyTableOverflow(overflow: number, hasScrollableAncestor: boolean): number {
  if (overflow <= 0) {
    return 0;
  }
  if (TASK09_TABLE_OVERFLOW_POLICY.allowScrollableAncestor && hasScrollableAncestor) {
    return 0;
  }
  return overflow;
}

/** 超长文案（不换行压力测试用）：连续长串，无空格 */
const LONG_TEXT = '超长文案'.repeat(120);

/** 记录包页的 GraphQL 载荷（导出/预检/导入均为 mutation，页面加载时不自动触发 ⇒ 留空即可）。 */
const RECORD_PACKAGE_IMPORT_PREVIEW = {
  checkId: 'chk-1',
  packagePath: '/mnt/usb/package-1.zip',
  schemaVersion: 'v1',
  fileCount: 2,
  originalCount: 2,
  entries: [],
  warnings: [],
  blockers: [],
};

/**
 * 逐态覆盖的**覆盖项**（默认全部关闭 ⇒ 行为与基线完全一致）。
 *
 * 逐态对照规格靠这些开关构造"空态／错误态／长文案／旧响应晚到"，
 * 度量与截图规格不传任何覆盖项 ⇒ 基线行为不被影响。
 */
export type Task09MockOverrides = {
  /** 这些 GraphQL 操作改为返回 GraphQL 错误（模拟服务端失败） */
  failOperations?: string[];
  /** 这些操作注入超长文案（不换行压力测试） */
  longText?: boolean;
  /** 备份记录总条数（默认 1；分页场景需要 > pageSize） */
  backupRecordTotal?: number;
  /** 备份记录按页返回不同 backupId（用于"旧响应晚到"场景） */
  backupRecordIdByPage?: Record<number, string>;
  /** 这些操作的**第 N 次**请求延迟（用于"旧响应晚到"场景；N 从 1 起） */
  delayRequestIndexOf?: Record<string, number>;
  /** 延迟毫秒数（配合 `delayRequestIndexOf`） */
  delayMs?: number;
  /** 冲突清单条目数（默认 0＝空态；>0 时渲染「查看差异」入口，供抽屉焦点等场景验证） */
  syncConflictTotal?: number;
};

/**
 * 安装任务 09 候选页的 GraphQL 拦截器。
 *
 * 未覆盖的操作返回空对象（页面按真实空态渲染），**不**抛错：页面必须能展示
 * 空态／失败态的真实样子，而不是被拦截器本身打断。
 */
export async function installLocalRuntimeMocks(
  page: Page,
  overrides: Task09MockOverrides = {},
): Promise<void> {
  const failOperations = new Set(overrides.failOperations ?? []);
  const delayRequestIndexOf = new Map(
    Object.entries(overrides.delayRequestIndexOf ?? {}).map(([key, value]) => [key, value]),
  );
  const requestCounts = new Map<string, number>();

  await page.route('**/graphql', async (route: Route) => {
    const payload = route.request().postDataJSON() as {
      operationName?: string;
      variables?: Record<string, unknown>;
    };
    const operation = payload.operationName ?? '';

    // 指定次数的请求延迟（制造"旧响应晚到"：让较早那次更慢、后一次更快）
    const requestCount = (requestCounts.get(operation) ?? 0) + 1;
    requestCounts.set(operation, requestCount);
    if (delayRequestIndexOf.get(operation) === requestCount) {
      await new Promise((resolve) => setTimeout(resolve, overrides.delayMs ?? 1_000));
    }

    if (failOperations.has(operation)) {
      await route.fulfill({
        body: JSON.stringify({
          data: null,
          errors: [{ message: `任务09 隔离库：模拟 ${operation} 失败` }],
        }),
        contentType: 'application/json',
        status: 200,
      });
      return;
    }

    let data: Record<string, unknown> = {};

    if (operation === 'SyncConflicts') {
      const conflictTotal = overrides.syncConflictTotal ?? 0;
      data = {
        syncConflicts: {
          items:
            conflictTotal === 0
              ? []
              : Array.from({ length: conflictTotal }, (_, index) => ({
                  conflictId: `cf-${index + 1}`,
                  recordUuid: `uuid-cf-${index + 1}`,
                  resourceType: 'REFERENCE_DOCUMENT',
                  versionNo: 2,
                  localVersion: 1,
                  cloudVersion: 2,
                  displayedCloudVersion: 2,
                  decision: null,
                  status: 'PENDING',
                  conflictReason: '云端版本较新',
                  createdAt: '2026-11-23T08:00:00.000Z',
                })),
          total: conflictTotal,
          page: 1,
          pageSize: 10,
          truncated: false,
        },
      };
    } else if (operation === 'SyncConflict') {
      // 冲突详情：字段集必须与 GraphQL 选择集一致（缺字段会被 adapter 判为非法响应）
      data = {
        syncConflict: {
          conflictId: 'cf-1',
          recordUuid: 'uuid-cf-1',
          organizationId: 9,
          resourceType: 'REFERENCE_DOCUMENT',
          versionNo: 2,
          localVersion: 1,
          cloudVersion: 2,
          displayedCloudVersion: 2,
          decision: null,
          status: 'PENDING',
          localSnapshot: '本地版本快照正文',
          cloudSnapshot: '云端版本快照正文',
          conflictReason: '云端版本较新',
          diff: {
            entries: [
              { path: 'title', kind: 'CHANGED', localValue: '本地版本标题', cloudValue: '云端版本标题' },
            ],
            truncated: false,
            invalid: false,
          },
          sourceRecordId: 12,
          sourceReadOnly: false,
          sourceReadOnlyReason: null,
          canAdoptCloud: true,
          adoptionReadOnly: false,
          confirmedByAccountId: null,
          confirmedAt: null,
          createdAt: '2026-11-23T08:00:00.000Z',
        },
      };
    } else if (operation === 'LocalBackupRecords') {
      const requestedPage = Number(
        (payload.variables?.['pagination'] as { page?: number } | undefined)?.['page'] ?? 1,
      );
      const backupId =
        overrides.backupRecordIdByPage?.[requestedPage] ??
        overrides.backupRecordIdByPage?.[1] ??
        'bk-1';
      const backupTotal = overrides.backupRecordTotal ?? 1;
      data = {
        localBackupRecords: {
          items:
            backupTotal === 0
              ? []
              : [
                  {
                    backupId,
                    organizationId: 9,
                    runId: 1,
                    installationId: 'inst-1',
                    triggerType: 'MANUAL',
                    runStatus: 'SUCCEEDED',
                    startedAt: '2026-11-20T08:00:00.000Z',
                    finishedAt: '2026-11-20T08:01:00.000Z',
                    createdAt: '2026-11-20T08:00:00.000Z',
                    byteSize: '2048',
                    localStatus: 'AVAILABLE',
                    localPackageRetained: true,
                    cloudStatus: 'AVAILABLE',
                    cloudReceiptPresent: true,
                    manifestChecksum: 'a'.repeat(64),
                    verifiedAt: '2026-11-20T08:01:00.000Z',
                    retentionUntil: '2026-12-20T08:00:00.000Z',
                    failureReason: null,
                    localCleanupError: null,
                    attemptCount: 1,
                    lastAttemptAt: '2026-11-20T08:02:00.000Z',
                    deletedAt: null,
                  },
                ],
          total: backupTotal,
          page: requestedPage,
          pageSize: 10,
        },
      };
    } else if (operation === 'LocalBackupCloudPackages') {
      data = {
        localBackupCloudPackages: {
          organizationId: 9,
          packages: [
            {
              packageId: 'bk-1',
              organizationId: 9,
              backupId: 'bk-1',
              createdAt: '2026-11-20T08:02:00.000Z',
              byteSize: '2048',
              checksumSha256: 'a'.repeat(64),
            },
          ],
        },
      };
    } else if (operation === 'LocalBackupSettings') {
      data = {
        // 设置按"公司 × 设备"逐条返回（列表形态）
        localBackupSettings: [
          {
            organizationId: 9,
            installationId: 'inst-1',
            backupEnabled: true,
            backupIntervalHours: 72,
            nextBackupAt: '2026-11-23T08:00:00.000Z',
            lastAutoSuccessAt: '2026-11-20T08:00:00.000Z',
            lastAutoFailureAt: null,
            failureReason: null,
            autoUploadEnabled: false,
            planIntervalHours: 72,
            retentionDays: 30,
            lastRunStatus: 'SUCCEEDED',
            lastRunStartedAt: '2026-11-20T08:00:00.000Z',
            lastRunFinishedAt: '2026-11-20T08:01:00.000Z',
            lastAssetCloudStatus: 'PENDING',
            lastAssetLocalStatus: 'AVAILABLE',
          },
        ],
      };
    } else if (operation === 'LocalRestoreCapability') {
      data = { localRestoreCapability: { executionAvailable: false, reason: null } };
    } else if (operation === 'LocalRuntimeStatus') {
      // 载荷形状必须与 `localRuntimeStatus` 查询契约一致（否则 adapter 会拒绝映射，
      // 页面落到失败态 ⇒ 度量的是错误分支而不是真实页面）
      data = {
        localRuntimeStatus: {
          installationId: 'inst-1',
          // 超长文案场景：注入不换行压力文本（长站点名）
          localSiteName: overrides.longText === true ? LONG_TEXT : '任务09 隔离演示机',
          mappedOrganizationId: 9,
          mappedOrganizationCode: 'CLIENT_DEFAULT',
          viewerRole: 'ENGINEER',
          scopeOrganizationId: 9,
          service: {
            apiStatus: 'UP',
            databaseStatus: 'UP',
            taskFactSource: '本地数据库',
            taskRecovery: '本地数据库',
          },
          storage: {
            businessFileDirectory:
              overrides.longText === true ? LONG_TEXT : '/srv/lithography/business',
            businessFileDirectoryWritable: true,
            backupDirectory: overrides.longText === true ? LONG_TEXT : '/srv/lithography/backups',
            backupDirectoryWritable: true,
          },
          tasks: {
            pendingUploadCount: 0,
            uploadingUploadCount: 0,
            failedUploadCount: 0,
            succeededUploadCount: 0,
            runningBackupCount: 0,
            lastBackupStartedAt: null,
            lastBackupFinishedAt: null,
          },
          companies: [],
          authorizations: [],
          generatedAt: '2026-11-23T08:00:00.000Z',
        },
      };
    } else if (operation === 'CheckRecordPackage') {
      data = { checkRecordPackage: RECORD_PACKAGE_IMPORT_PREVIEW };
    }

    await route.fulfill({
      body: JSON.stringify({ data }),
      contentType: 'application/json',
      status: 200,
    });
  });
}
