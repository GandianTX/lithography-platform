// e2e/helpers/real-backend.ts
//
// 真实后端 e2e 的共享工具（自 repair-request-create.spec.ts 提取，供多个 spec 复用）。
// 前置处理按入口区分：普通 Playwright 入口在本地真实后端、环境文件或浏览器通道不可用时可跳过；
// 专用隔离入口开启严格模式，前置不满足必须失败，不能以 skipped 代替真实链路验收。
// 普通入口的本地前提：
// 1. dev 后端运行于 127.0.0.1:3000，且 APP_CORS_ORIGINS 放行 http://127.0.0.1:4173；
// 2. backend/env/.env.development 存在（本地文件，不入库），本机可用 mysql CLI；
// 3. frontend/env/.env.development.local 提供 VITE_GRAPHQL_ENDPOINT，或 Vite 配置了 /graphql 代理。
// 专用入口的数据库授权、隔离库与连接一致性由专用 Playwright 配置和 global setup 强制校验。
// 真实链路用例产生的数据由用例自行清理或恢复，不污染共享开发库基线。

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEDICATED_BACKEND_ORIGIN,
  DEDICATED_E2E_DB_NAME,
  DEDICATED_E2E_PHYSICAL_CLEANUP_ENV,
  DEDICATED_E2E_STRICT_MODE_ENV,
} from '../../e2e-real/dedicated-e2e-environment';

// 后端源（origin）收口：默认仍指向本地 dev 后端 127.0.0.1:3000（既有真实链路 spec 口径不变）。
// 专用账号设置联调（playwright.account-settings-real.config.ts）经进程级环境变量
// E2E_BACKEND_ORIGIN 指向专用后端（http://127.0.0.1:3100），浏览器 / Node GraphQL helper /
// SQL helper 由此共享同一目标；来源必须是无路径的 http(s) origin，否则在连接前直接失败。
const BACKEND_ORIGIN_PATTERN = /^https?:\/\/[a-z0-9._-]+(:\d+)?$/i;

function resolveBackendOrigin(): string {
  const configured = process.env.E2E_BACKEND_ORIGIN?.trim();

  if (configured === undefined || configured === '') {
    return 'http://127.0.0.1:3000';
  }

  if (!BACKEND_ORIGIN_PATTERN.test(configured)) {
    throw new Error(
      `E2E_BACKEND_ORIGIN 不是合法的无路径 origin，拒绝连接：${JSON.stringify(configured)}`,
    );
  }

  return configured;
}

const BACKEND_ORIGIN = resolveBackendOrigin();

export const BACKEND_GRAPHQL = `${BACKEND_ORIGIN}/graphql`;
export const BACKEND_HEALTH = `${BACKEND_ORIGIN}/health`;
export const BACKEND_REST_UPLOAD = `${BACKEND_ORIGIN}/api/reference-documents/upload`;
export function backendRestDownloadUrl(id: number): string {
  return `${BACKEND_ORIGIN}/api/reference-documents/${id}/download`;
}

const BACKEND_ENV_FILE = fileURLToPath(
  new URL('../../../backend/env/.env.development', import.meta.url),
);
const FRONTEND_LOCAL_ENV_FILE = fileURLToPath(
  new URL('../../env/.env.development.local', import.meta.url),
);
const FRONTEND_VITE_CONFIG_FILE = fileURLToPath(new URL('../../vite.config.ts', import.meta.url));

// 后端生成的申请编号格式：RR + 14 位时间戳 + 6 位加密随机字符（与后端单测断言一致），
// 仅白名单匹配的编号才允许进入 SQL 拼接（由受保护 helper 强制，见下方守卫说明）。
export const REQUEST_NO_PATTERN = /^RR\d{14}[A-Z0-9]{6}$/;

// 数据库连接键允许进程级运行时覆盖（仅这 5 个键，其他键仍只读文件值）：
// 真实 E2E 需要在不改写任何 .env 文件的前提下，把 mysqlQuery / 物理清理安全门
// 与应用后端指向同一个独立测试库。空白值不覆盖，避免 `DB_NAME=` 误清空文件值；
// 覆盖后的 DB_NAME 依旧要过 assertPhysicalCleanupAllowed 的显式 opt-in + 测试库命名门。
const DB_CONNECTION_KEYS = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASS', 'DB_NAME'] as const;

export function readBackendEnv(): Record<string, string> {
  const entries: Record<string, string> = {};

  for (const line of readFileSync(BACKEND_ENV_FILE, 'utf-8').split('\n')) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) {
      entries[match[1]] = match[2];
    }
  }

  for (const key of DB_CONNECTION_KEYS) {
    const runtimeValue = process.env[key];

    if (runtimeValue !== undefined && runtimeValue.trim() !== '') {
      entries[key] = runtimeValue;
    }
  }

  return entries;
}

// env 文件缺失或不可读时返回 null，让用例走 skip 分支而不是直接失败（该文件是本地文件，不入库）。
export function readBackendEnvOrNull(): Record<string, string> | null {
  try {
    return readBackendEnv();
  } catch {
    return null;
  }
}

// 前端侧真实通道前提（两种任一成立即可）：
// 1. .env.development.local 配置 VITE_GRAPHQL_ENDPOINT（浏览器直连后端，需后端 CORS 放行）；
// 2. vite dev server 配置了 '/graphql' 同源转发（默认转发到 http://127.0.0.1:3000，
//    无跨域，端口映射域名亦可用，当前为本机默认模式）。
// 两者都不成立时浏览器侧请求落到相对路径 /graphql 且无转发，到不了后端。
// 两个通道必须独立探测：可选的本地 env 文件缺失只表示直连通道不存在，
// 不能短路 proxy 通道的判断（负责人 0909 修复要求；否则全新 clone 的
// 默认环境里真实后端用例会被错误跳过，报告绿但没有执行真实链路）。
export function hasFrontendGraphQLEndpoint(): boolean {
  try {
    if (/VITE_GRAPHQL_ENDPOINT\s*=\s*\S+/.test(readFileSync(FRONTEND_LOCAL_ENV_FILE, 'utf-8'))) {
      return true;
    }
  } catch {
    // 直连通道不存在（本地文件可缺失），继续探测 proxy 通道
  }

  try {
    // 同源转发通道：vite.config.ts 含 '/graphql' 键的 proxy 配置即视为可用
    return /['"]\/graphql['"]\s*:/.test(readFileSync(FRONTEND_VITE_CONFIG_FILE, 'utf-8'));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 真实后端预检策略（共享，唯一判定源）
//
// 四个真实 spec 的前置条件完全一致，此前各自复写三连 test.skip，容易出现
// 「某条路径漏改、严格入口仍静默 skip」的缺口。此处集中为：
// - decideRealBackendPrerequisite：纯函数判定，可直接单测（配置缺失 / 通道不可达 /
//   后端不可用 三类原因 + 普通/严格两种模式）；
// - resolveRealBackendPrerequisite：IO 包装，采集三态后交给纯函数判定；
// - 专用入口由 playwright 配置注入 DEDICATED_E2E_STRICT_MODE_ENV=1 开启严格模式，
//   前提不满足时抛错让用例 failed，绝不以 skipped 掩盖；普通入口不注入，
//   继续返回跳过原因，保持既有 skip 语义。
// 严格模式的错误文本只含原因常量，不含 env 值、密码或 Token。
// ---------------------------------------------------------------------------

const ENV_FILE_MISSING_REASON =
  'backend/env/.env.development 缺失（本地文件，不入库），跳过真实后端用例';
const FRONTEND_CHANNEL_MISSING_REASON =
  '前端真实通道不可达（未配置 VITE_GRAPHQL_ENDPOINT 且 vite dev server 无 /graphql 转发），跳过真实后端用例';
const BACKEND_UNAVAILABLE_REASON = '本地后端不可用或不可登录，跳过真实后端用例';

export interface RealBackendPrerequisiteState {
  readonly envAvailable: boolean;
  readonly frontendChannelAvailable: boolean;
  readonly backendAvailable: boolean;
}

export interface RealBackendPrerequisiteOptions {
  /** 是否需要浏览器侧真实通道：纯后端契约用例（如授权矩阵）可置 false */
  readonly requireFrontendChannel?: boolean;
  /** 严格模式：前提不满足时抛错而非返回跳过原因；缺省取进程开关 */
  readonly strict?: boolean;
}

/** 严格模式开关：专用 playwright 配置注入 '1' 时开启；普通入口不注入即为关闭 */
export function isRealBackendStrictMode(): boolean {
  return process.env[DEDICATED_E2E_STRICT_MODE_ENV] === '1';
}

/**
 * 纯判定：三态预检结果 → 就绪返回 null；普通模式返回跳过原因；严格模式抛错。
 * 判定顺序与既有 beforeEach 完全一致：env 文件 → 前端通道 → 后端探针。
 */
export function decideRealBackendPrerequisite(
  state: RealBackendPrerequisiteState,
  options: RealBackendPrerequisiteOptions = {},
): string | null {
  const { requireFrontendChannel = true, strict = isRealBackendStrictMode() } = options;

  let reason: string | null = null;

  if (!state.envAvailable) {
    reason = ENV_FILE_MISSING_REASON;
  } else if (requireFrontendChannel && !state.frontendChannelAvailable) {
    reason = FRONTEND_CHANNEL_MISSING_REASON;
  } else if (!state.backendAvailable) {
    reason = BACKEND_UNAVAILABLE_REASON;
  }

  if (reason === null) {
    return null;
  }

  if (strict) {
    throw new Error(
      `真实后端预检失败（专用失败关闭严格模式，拒绝以 skipped 掩盖）：${reason}；` +
        '请确认专用后端已在隔离端口就绪、专用库连接可用后重试。',
    );
  }

  return reason;
}

/**
 * IO 包装：采集「env 文件 / 前端通道 / 后端健康与登录探针」三态后交给纯判定。
 * env 文件缺失时不再发起后端探针，避免无意义网络等待。
 */
export async function resolveRealBackendPrerequisite(
  options: RealBackendPrerequisiteOptions = {},
): Promise<string | null> {
  const env = readBackendEnvOrNull();
  const backendAvailable = env === null ? false : await isRealBackendAvailable(env);

  return decideRealBackendPrerequisite(
    {
      backendAvailable,
      envAvailable: env !== null,
      frontendChannelAvailable: hasFrontendGraphQLEndpoint(),
    },
    options,
  );
}

// 专用真实链路同一性检查（R4 复核修正轮 P2）：当 E2E_BACKEND_ORIGIN 指向专用后端时，
// SQL helper 的 DB_NAME 必须等于专用库，杜绝「浏览器/Node GraphQL 打到专用后端，
// SQL 清理却连接其他库」的错位。普通真实链路（默认 127.0.0.1:3000）不受影响。
function assertDedicatedLinkDatabaseConsistency(env: Record<string, string>): void {
  if (BACKEND_ORIGIN !== DEDICATED_BACKEND_ORIGIN) {
    return;
  }

  if (env.DB_NAME !== DEDICATED_E2E_DB_NAME) {
    throw new Error(
      `专用真实链路配置不一致：E2E_BACKEND_ORIGIN 指向专用后端，但 SQL helper DB_NAME=${JSON.stringify(env.DB_NAME)} ≠ ${JSON.stringify(DEDICATED_E2E_DB_NAME)}，拒绝访问数据库`,
    );
  }
}

export function mysqlQuery(sql: string): string {
  const env = readBackendEnv();
  assertDedicatedLinkDatabaseConsistency(env);

  return execFileSync(
    'mysql',
    ['-h', env.DB_HOST, '-P', env.DB_PORT, `-u${env.DB_USER}`, env.DB_NAME, '-N', '-B', '-e', sql],
    // 密码经 MYSQL_PWD 注入（不出现在进程参数列表），并抑制 stderr，
    // 避免 mysql CLI 的密码告警污染测试输出。
    {
      encoding: 'utf-8',
      env: { ...process.env, MYSQL_PWD: env.DB_PASS },
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  ).trim();
}

// requestNo 白名单守卫：expect 断言不是安全边界，页面文本异常时断言抛错后 finally
// 仍会拿同一字符串执行 SQL。因此任何 requestNo 进入 SQL 前都必须在 helper 内部、
// 访问数据库之前强制校验；失败直接抛错且绝不启动 mysql 进程（含 finally 兜底路径）。
function assertWhitelistedRequestNo(requestNo: string): void {
  if (!REQUEST_NO_PATTERN.test(requestNo)) {
    throw new Error(`requestNo 未通过白名单校验，拒绝访问数据库：${JSON.stringify(requestNo)}`);
  }
}

/**
 * 按白名单 requestNo 查询维修申请行。
 * selectExpression 必须是代码内静态字面量（如 'id'、'COUNT(*)'），不得拼接外部输入。
 */
export function findRepairRequestByRequestNo(requestNo: string, selectExpression: string): string {
  assertWhitelistedRequestNo(requestNo);

  return mysqlQuery(
    `SELECT ${selectExpression} FROM repair_request WHERE request_no = '${requestNo}'`,
  );
}

// 参考资料 real spec 自建行标题前缀（与 reference-document-real.spec 创建标题共用）。
// 仅用于创建标题与列表定位断言；清理一律以本次运行记录的精确 ID 为边界，
// 禁止按标题前缀批量删除——固定前缀不是数据身份，共享库中他人数据可能碰巧同前缀，
// 并行运行也可能互删（负责人 0909 阻塞项 1）。
export const REFERENCE_DOCUMENT_E2E_TITLE_PREFIX = 'E2E 参考资料验收行';

// 服务端生成的存储引用格式（与 backend local-storage 实现同口径白名单）：
// 32 位小写 hex + 白名单扩展名，天然无路径语义；任何白名单外的引用都拒绝清理。
// 导出供 PR5 归属核验 helper 复用同一白名单（避免两套口径漂移）。
export const STORAGE_REFERENCE_PATTERN = /^[0-9a-f]{32}\.[a-z0-9]{1,8}$/;

// 物理清理安全门：物理 DELETE 只允许发生在「显式 opt-in + 库名属测试库」的配置上。
// 共享开发库（DB_NAME 不含 e2e/test 标记）一律在启动 mysql 进程前拒绝；
// 宁可残留软删行（对列表/详情不可见，由库策略另行清理），也不按前缀物理删除。
// 授权变量与专用 E2E 配置模块共用同一常量，杜绝两套口径各自漂移。
export const PHYSICAL_CLEANUP_OPT_IN_ENV = DEDICATED_E2E_PHYSICAL_CLEANUP_ENV;
const TEST_DATABASE_NAME_PATTERN = /(^|[_-])(e2e|test)([_-]|\d|$)/i;

export function assertPhysicalCleanupAllowed(env: Record<string, string>): void {
  if (process.env[PHYSICAL_CLEANUP_OPT_IN_ENV] !== '1') {
    throw new Error(
      `物理清理被拒绝：缺少 ${PHYSICAL_CLEANUP_OPT_IN_ENV}=1 显式 opt-in，共享开发库禁止物理删除`,
    );
  }

  const dbName = env.DB_NAME ?? '';

  if (!TEST_DATABASE_NAME_PATTERN.test(dbName)) {
    throw new Error(
      `物理清理被拒绝：DB_NAME=${JSON.stringify(dbName)} 不属于测试库命名（需含 e2e/test 段），拒绝物理删除`,
    );
  }
}

/**
 * 物理清理是否可用于当前环境：目标库严格为专用隔离库 lithography_e2e 且执行者显式授权。
 * 调用方据此决定是否进入物理清理分支（共享开发库只走软删边界）；
 * 受保护 helper 仍会在访问数据库前独立复查，不依赖调用方或全局 setup 已经检查过。
 */
export function isPhysicalCleanupEnabled(env: Record<string, string>): boolean {
  return env.DB_NAME === DEDICATED_E2E_DB_NAME && process.env[PHYSICAL_CLEANUP_OPT_IN_ENV] === '1';
}

/**
 * 从创建响应体解析本轮创建的精确资料 ID（GraphQL data.createReferenceDocument.id /
 * REST data.id）；非正整数即抛错。调用方在点击创建前注册响应监听、创建响应一返回即调用本函数
 * 记录清理边界，早于成功页 / 详情页任何断言——即使后续断言失败，清理仍能按该 ID 执行；
 * 拿不到 ID 时用例失败并提示本轮创建可能已落库、需人工核对残留（不按标题猜测归属）。
 */
export function requirePositiveReferenceDocumentId(id: unknown, source: string): number {
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
    throw new Error(
      `${source}未返回精确资料 ID，无法建立清理边界，拒绝继续；本轮创建可能已落库，需人工核对残留：${JSON.stringify(id)}`,
    );
  }

  return id;
}

/**
 * 软删计划：软删目标只取本轮创建响应记录的精确 ID（归属由创建响应确立），
 * 标题反查结果仅用于报告「未记录却命中本轮关键字」的遗漏行，绝不并入软删目标——
 * 同标题异主行必须保持原样，不因反查而被删除。
 */
export function planReferenceDocumentSoftDelete(
  recordedIds: readonly number[],
  discoveredIds: readonly number[],
): { readonly softDeleteIds: readonly number[]; readonly unexpectedIds: readonly number[] } {
  const recorded = new Set(recordedIds);

  return {
    softDeleteIds: [...recorded],
    unexpectedIds: discoveredIds.filter((id) => !recorded.has(id)),
  };
}

/**
 * 存储引用登记状态（评审 P3）：明确区分「尚未取得」（pending，未知）与「确认无引用」（none）。
 * 未知绝不降级为 none——否则清理会把引用未知的资料当作纯文本跳过文件核验，掩盖归属不明。
 * resolved 表示引用已取得且通过服务端格式白名单校验。
 */
export type StorageReferenceRegistration =
  | { readonly status: 'pending' }
  | { readonly status: 'none' }
  | { readonly status: 'resolved'; readonly reference: string };

/**
 * 本轮登记的参考资料记录：id 与创建时立即记录的事实（标题 / 创建人 / 文件元数据 / 存储引用状态）。
 * 物理清理与上传文件清理的预期事实均取自本记录，绝不从目标行反读（否则核验退化为自证）。
 */
export interface RegisteredReferenceDocument {
  readonly id: number;
  /** 标题可写：主链路创建后会改标题，清理核验的是库中当前标题 */
  title: string;
  readonly createdByAccountId: number;
  readonly originalFilename: string | null;
  readonly mimeType: string | null;
  storageReference: StorageReferenceRegistration;
}

/**
 * 上传创建登记（评审 P3）：取得精确 ID 后**立即登记**（引用先置 pending），再解析引用并补回该记录。
 *
 * 关键顺序：登记先于解析——存储引用查询抛错或返回白名单外引用时，记录仍保留该精确 ID（状态停留
 * pending），清理据此失败关闭并报告该 ID，绝不按标题前缀 / 反查结果扩大删除范围。
 * 解析失败不回滚登记本身，故本函数不抛错。
 *
 * @returns 登记后的记录（与 registry 中同一对象，引用状态可能仍为 pending）
 */
export function registerUploadedReferenceDocument(
  registry: RegisteredReferenceDocument[],
  facts: Omit<RegisteredReferenceDocument, 'storageReference'>,
  resolve: () => string | null,
): RegisteredReferenceDocument {
  const record: RegisteredReferenceDocument = { ...facts, storageReference: { status: 'pending' } };

  registry.push(record);

  try {
    const value = resolve();

    record.storageReference =
      value === null
        ? { status: 'none' }
        : STORAGE_REFERENCE_PATTERN.test(value)
          ? { status: 'resolved', reference: value }
          : { status: 'pending' };
  } catch {
    // 引用未知：保持 pending，精确 ID 已登记，由清理侧失败关闭并报告
  }

  return record;
}

/**
 * 取登记中已确认的存储引用：pending（未知）即抛错并带上精确 ID，拒绝继续清理；
 * none → null（纯文本资料）；resolved → 引用。禁止把 pending 当作 none 跳过文件核验。
 */
export function requireResolvedStorageReference(
  registration: StorageReferenceRegistration,
  id: number,
): string | null {
  if (registration.status === 'pending') {
    throw new Error(
      `自建资料 ${id} 的存储引用尚未取得（未知），无法证明归属，拒绝清理并保留现场；该精确 ID 已登记，需人工核对残留`,
    );
  }

  return registration.status === 'none' ? null : registration.reference;
}

// ---- 参考资料物理清理：统一安全入口（精确 ID + 本轮预期事实事务核验） ----

/**
 * 参考资料物理清理目标：id 必须来自本轮创建响应的精确 ID；
 * expected 必须是本轮测试自身掌握 / 创建时立即记录的事实（标题 / 创建人账号 / 存储引用），
 * 不接受「按标题反查所得的行」充当删除目标，也不接受从目标行反读回来的值充当预期，
 * 否则核验退化为自证：同标题异主 / 归属不符的行永远不会被发现。
 */
export interface ReferenceDocumentCleanupTarget {
  readonly id: number;
  readonly expected: {
    readonly title: string;
    readonly createdByAccountId: number;
    /** 纯文本资料为 null；仅文件资料为服务端生成的存储引用 */
    readonly storageReference: string | null;
  };
}

// 标题进 SQL 前必须命中白名单（列宽 varchar(255)）：排除单引号（字符串字面量终止符）与
// 反斜杠（MySQL 默认转义符）两个可越界字符；其余内容（含中文、空格、全角括号）照常放行。
const CLEANUP_DOCUMENT_TITLE_PATTERN = /^[^'\\]{1,255}$/;

// 事务内守卫表与约束名（会话级临时表，断开即消失，不触碰持久结构）。
const CLEANUP_GUARD_TABLE_REFERENCE_DOCUMENT = 'e2e_reference_document_cleanup_guard';

/**
 * 严格库名门（在 assertPhysicalCleanupAllowed 的「测试库命名」之上再收紧一道）：
 * 参考资料物理清理只允许发生在专用隔离库 lithography_e2e，默认连共享开发库
 * （lithography_drill）时失败关闭、不执行删除，也不降级到别的库上删除。
 */
function assertDedicatedReferenceDocumentCleanupDatabase(env: Record<string, string>): void {
  if (env.DB_NAME !== DEDICATED_E2E_DB_NAME) {
    throw new Error(
      `参考资料物理清理被拒绝：DB_NAME=${JSON.stringify(env.DB_NAME)} 不是专用隔离库 ${JSON.stringify(DEDICATED_E2E_DB_NAME)}，失败关闭，不执行删除`,
    );
  }
}

function assertReferenceDocumentCleanupTargets(
  targets: readonly ReferenceDocumentCleanupTarget[],
): void {
  const seenIds = new Set<number>();

  for (const { id, expected } of targets) {
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new Error(`物理清理目标 ID 未通过正整数校验，拒绝执行：${JSON.stringify(id)}`);
    }

    if (seenIds.has(id)) {
      throw new Error(`物理清理目标 ID 重复，拒绝执行：${id}`);
    }

    seenIds.add(id);

    if (!CLEANUP_DOCUMENT_TITLE_PATTERN.test(expected.title)) {
      throw new Error(
        `物理清理预期标题未通过白名单校验，拒绝访问数据库：${JSON.stringify(expected.title)}`,
      );
    }

    if (!Number.isSafeInteger(expected.createdByAccountId) || expected.createdByAccountId <= 0) {
      throw new Error(
        `物理清理预期创建人账号未通过正整数校验，拒绝执行：${JSON.stringify(expected.createdByAccountId)}`,
      );
    }

    if (
      expected.storageReference !== null &&
      !STORAGE_REFERENCE_PATTERN.test(expected.storageReference)
    ) {
      throw new Error(
        `物理清理预期存储引用未通过白名单校验，拒绝访问数据库：${JSON.stringify(expected.storageReference)}`,
      );
    }
  }
}

/**
 * 组装「同一连接、同一事务」的核验 + 删除脚本（与维修申请清理同范式）：
 * - 逐 ID 绑定本轮预期事实（标题 / 创建人账号 / 存储引用），任一项不符即计入 field_mismatch_rows；
 * - 外部引用（external_ref_rows）：核对架构上不存在引用 reference_document 的外键
 *   （当前 baseline 为 0）。出现任何外部引用即视为本 helper 未覆盖的子表，失败关闭中止，
 *   绝不带子记录删除，也绝不静默级联；
 * - 删除仅按本轮精确 ID，提交前核验残留为 0，任一违例即中止回滚（零删除）。
 */
function buildReferenceDocumentCleanupSql(
  targets: readonly ReferenceDocumentCleanupTarget[],
): string {
  const idList = targets.map(({ id }) => id).join(',');
  const idPredicate = `id IN (${idList})`;
  const expectedFacts = targets
    .map(({ id, expected }) => {
      const facts = [
        `id = ${id}`,
        `title = '${expected.title}'`,
        `created_by_account_id = ${expected.createdByAccountId}`,
        // 可空字段用 NULL 安全比较（<=>）：预期非 NULL 而实际为 NULL 时 `=` 求值为 NULL，
        // NOT(NULL) 仍为 NULL，不计入 field_mismatch_rows，会放行删除；<=> 才判为不符。
        expected.storageReference === null
          ? 'storage_reference IS NULL'
          : `storage_reference <=> '${expected.storageReference}'`,
      ];

      return `(${facts.join(' AND ')})`;
    })
    .join(' OR ');
  const existingRows = `(SELECT COUNT(*) FROM reference_document WHERE ${idPredicate})`;
  const fieldMismatchRows = `(SELECT COUNT(*) FROM reference_document WHERE ${idPredicate} AND NOT (${expectedFacts}))`;
  const externalRefRows = `(SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE WHERE REFERENCED_TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME = 'reference_document')`;
  const guardViolations = [
    `(DATABASE() <> '${DEDICATED_E2E_DB_NAME}')`,
    `(${targets.length} - ${existingRows})`,
    fieldMismatchRows,
    externalRefRows,
  ].join(' + ');

  return [
    'START TRANSACTION',
    `CREATE TEMPORARY TABLE ${CLEANUP_GUARD_TABLE_REFERENCE_DOCUMENT} (violations INT NOT NULL, CONSTRAINT e2e_reference_document_cleanup_must_be_zero CHECK (violations = 0))`,
    `SELECT id, title, created_by_account_id, storage_reference FROM reference_document WHERE ${idPredicate} ORDER BY id FOR UPDATE`,
    `SELECT CONCAT('database=', DATABASE(), ' expected_rows=${targets.length}', ' existing_rows=', ${existingRows}, ' field_mismatch_rows=', ${fieldMismatchRows}, ' external_ref_rows=', ${externalRefRows})`,
    `INSERT INTO ${CLEANUP_GUARD_TABLE_REFERENCE_DOCUMENT} (violations) SELECT ${guardViolations}`,
    `DELETE FROM reference_document WHERE ${idPredicate}`,
    `SELECT CONCAT('residue_rows=', ${existingRows})`,
    `INSERT INTO ${CLEANUP_GUARD_TABLE_REFERENCE_DOCUMENT} (violations) SELECT ${existingRows}`,
    'COMMIT',
  ].join(';\n');
}

/**
 * 独立复查 CLI 回读的核验诊断（防御「CHECK 约束被静默忽略」与「拿不到诊断却当作成功」）：
 * 库名 / 期望行数 / 实际行数 / 字段不符 / 外部引用 / 残留任一不达标即抛错。
 */
function assertReferenceDocumentCleanupDiagnostics(output: string, expectedRows: number): void {
  const diagnostics: Record<string, string> = {};

  for (const match of output.matchAll(/([a-z_]+)=(\S+)/g)) {
    diagnostics[match[1]] = match[2];
  }

  const expectedDiagnostics: Array<[string, string]> = [
    ['database', DEDICATED_E2E_DB_NAME],
    ['expected_rows', String(expectedRows)],
    ['existing_rows', String(expectedRows)],
    ['field_mismatch_rows', '0'],
    ['external_ref_rows', '0'],
    ['residue_rows', '0'],
  ];
  const mismatched = expectedDiagnostics.filter(([key, value]) => diagnostics[key] !== value);

  if (mismatched.length > 0) {
    throw new Error(
      `参考资料物理清理核验失败：${mismatched
        .map(
          ([key, value]) => `${key} 期望 ${value} 实际 ${JSON.stringify(diagnostics[key] ?? null)}`,
        )
        .join('；')}`,
    );
  }
}

/**
 * 按本次运行记录的精确 ID 物理清理参考资料行（统一安全入口）。
 *
 * 安全性质：
 * - 入口内独立执行「显式授权门 + 测试库命名门 + 严格 lithography_e2e 库名门」，任一门不通过即抛错
 *   且 mysql 进程绝不启动；不再有「仅凭 ID 列表直接 DELETE」的路径，也不按标题前缀/行数匹配；
 * - 目标 ID 与预期事实（标题 / 创建人账号 / 存储引用）先过 Node 侧白名单，先于任何 SQL 组装；
 * - 同一连接、同一事务内完成：库名核验 → FOR UPDATE 锁定目标行 → 逐项核对预期字段与外部引用
 *   → 全部门通过才按精确 ID 删除 → 提交前核验残留为 0 → COMMIT；任一不符即中止回滚（零删除）
 *   并让用例转红；
 * - ID 列表为空时 no-op，不启动 mysql 进程。
 */
export function deleteE2EReferenceDocumentRowsByIds(
  targets: readonly ReferenceDocumentCleanupTarget[],
): void {
  if (targets.length === 0) {
    return;
  }

  assertReferenceDocumentCleanupTargets(targets);

  const env = readBackendEnv();

  assertPhysicalCleanupAllowed(env);
  assertDedicatedReferenceDocumentCleanupDatabase(env);

  const output = runCleanupTransactionSql(
    env,
    buildReferenceDocumentCleanupSql(targets),
    '参考资料物理清理事务中止',
  );

  assertReferenceDocumentCleanupDiagnostics(output, targets.length);
}

/**
 * 组装「软删前归属预检」只读脚本（单次只读查询）：逐 ID 核对目标行是否存在，
 * 标题 / 创建人 / 存储引用是否与本轮记录一致。只 SELECT，绝不 UPDATE / DELETE。
 * 行是否已软删不参与判定（软删行仍在表中且字段不变），核验的是「这一行确实是本轮自建」。
 */
function buildReferenceDocumentOwnershipVerificationSql(
  targets: readonly ReferenceDocumentCleanupTarget[],
): string {
  const idPredicate = `id IN (${targets.map(({ id }) => id).join(',')})`;
  const expectedFacts = targets
    .map(
      ({ id, expected }) =>
        [
          `(id = ${id}`,
          `title = '${expected.title}'`,
          `created_by_account_id = ${expected.createdByAccountId}`,
          // 可空字段同用 NULL 安全比较（<=>）：实际为 NULL 而预期非 NULL 时必须计入不符
          expected.storageReference === null
            ? 'storage_reference IS NULL'
            : `storage_reference <=> '${expected.storageReference}'`,
        ].join(' AND ') + ')',
    )
    .join(' OR ');

  return `SELECT CONCAT('database=', DATABASE(), ' expected_rows=${targets.length}', ' existing_rows=', (SELECT COUNT(*) FROM reference_document WHERE ${idPredicate}), ' field_mismatch_rows=', (SELECT COUNT(*) FROM reference_document WHERE ${idPredicate} AND NOT (${expectedFacts})))`;
}

/**
 * 独立复查归属预检诊断：期望行数 / 实际行数 / 字段不符任一不达标即抛错。
 * 抛出即代表「已在软删 / 物理删除之前停止，未改动任何行，保留现场」。
 * 不核验 database：本预检为只读查询，普通链路（共享开发库）同样需要先证明归属再软删。
 */
function assertReferenceDocumentOwnershipDiagnostics(output: string, expectedRows: number): void {
  const diagnostics: Record<string, string> = {};

  for (const match of output.matchAll(/([a-z_]+)=(\S+)/g)) {
    diagnostics[match[1]] = match[2];
  }

  const expectedDiagnostics: Array<[string, string]> = [
    ['expected_rows', String(expectedRows)],
    ['existing_rows', String(expectedRows)],
    ['field_mismatch_rows', '0'],
  ];
  const mismatched = expectedDiagnostics.filter(([key, value]) => diagnostics[key] !== value);

  if (mismatched.length > 0) {
    throw new Error(
      `参考资料归属预检失败（在软删 / 物理删除之前停止，保留现场）：${mismatched
        .map(
          ([key, value]) => `${key} 期望 ${value} 实际 ${JSON.stringify(diagnostics[key] ?? null)}`,
        )
        .join('；')}`,
    );
  }
}

/**
 * 软删前的只读归属预检（评审 P2）：按本轮记录的精确 ID 核对目标行存在且标题 / 创建人 / 存储引用
 * 与本轮记录一致。任一目标缺失或字段不符即抛错——在修改任何行（含软删除）之前停止清理流程，
 * 保留现场；不按标题前缀或反查结果扩大范围。
 *
 * 只读：本函数只执行一次 SELECT，绝不 DELETE / UPDATE；不要求物理清理授权（普通链路的软删前
 * 同样必须先证明归属），故不设专用库门。
 */
export function assertE2EReferenceDocumentOwnershipBeforeCleanup(
  targets: readonly ReferenceDocumentCleanupTarget[],
): void {
  if (targets.length === 0) {
    return;
  }

  assertReferenceDocumentCleanupTargets(targets);

  const output = mysqlQuery(buildReferenceDocumentOwnershipVerificationSql(targets));

  assertReferenceDocumentOwnershipDiagnostics(output, targets.length);
}

// ---- 维修申请物理清理：统一安全入口（负责人最小修复计划 P1/P2） ----

/**
 * 物理清理目标：ID 必须是本次运行记录的精确 ID，expected 必须是本轮测试自身掌握的预期事实
 * （申请编号 / 客户账号 / 故障码 / 设备型号 / 故障描述）——不接受「从目标行反读回来的值」充当预期，
 * 否则核验退化为自证。五项事实一律必填、缺一项即拒绝清理（负责人最小修复计划 P1），
 * 全部命中该 ID 才允许进入删除语句。
 */
export interface RepairRequestCleanupTarget {
  readonly id: number;
  readonly expected: {
    readonly requestNo: string;
    readonly customerAccountId: number;
    readonly errorCode: string;
    readonly equipmentModelId: number;
    readonly faultDescription: string;
    /**
     * 已接单申请的接单工程师账号（可选）：提供后核验表达式追加
     * is_accepted = 1 与 accepted_by_engineer_account_id 归属核对，
     * 缺省时维持既有五项事实口径，不放宽任何既有校验。
     */
    readonly acceptedEngineerAccountId?: number;
  };
  /**
   * 本轮为该申请创建的工程师回复（精确 ID + 本轮事实，负责人单卡片计划 P3）。
   *
   * - 缺省（不提供）：维持既有最强守卫 —— 该申请不得存在任何 engineer_response 子记录，
   *   存在即整批中止回滚，绝不级联删除；
   * - 提供后守卫收紧为「该申请下的 engineer_response 必须恰为本轮这些精确 ID 且字段逐项相符」，
   *   清理时先删本轮回复行、再删申请行（外键 ON DELETE RESTRICT，顺序不可颠倒），
   *   绝不按申请批量删回复、绝不删除未在本轮记录内的回复行。
   */
  readonly expectedResponses?: readonly RepairRequestCleanupResponseTarget[];
}

/**
 * 本轮自建工程师回复的精确清理目标：
 * id 必须来自本轮创建回复返回的 id，expected 必须来自本轮提交的事实
 * （归属申请 / 回复工程师账号 / 接收客户账号 / 处理状态 / 回复正文），
 * 逐项全部命中才允许删除该回复行；不接受从目标行反读回来的值充当预期。
 */
export interface RepairRequestCleanupResponseTarget {
  readonly id: number;
  readonly expected: {
    readonly requestId: number;
    readonly engineerAccountId: number;
    readonly customerAccountId: number;
    readonly resolutionStatus: EngineerResponseResolutionStatus;
    readonly responseText: string;
  };
}

/** 与 engineer_response.resolution_status 枚举严格一致（第三套状态值不允许） */
export type EngineerResponseResolutionStatus = 'PENDING' | 'RESOLVED';

// 故障码进 SQL 前必须命中白名单（列宽 varchar(100)，白名单只含无引号、无反斜杠的字符）；
// 白名单外的值直接抛错，绝不转义拼接；申请编号沿用 REQUEST_NO_PATTERN 同口径。
const CLEANUP_ERROR_CODE_PATTERN = /^[A-Za-z0-9._:-]{1,100}$/;

// 故障描述进 SQL 前同样必须命中白名单：列类型 text，本轮自建描述只可能是短文本，
// 白名单排除单引号（字符串字面量终止符）与反斜杠（MySQL 默认转义符）两个可越界字符，
// 其余内容（含中文与空格）照常放行；长度上限按本轮自建描述的实际规模收紧。
const CLEANUP_FAULT_DESCRIPTION_PATTERN = /^[^'\\]{1,255}$/;

// 回复正文进 SQL 前同样必须命中白名单（列类型 text）：本轮自建回复只可能是短文本，
// 白名单同样排除单引号与反斜杠两个可越界字符，长度上限按本轮自建回复的实际规模收紧。
const CLEANUP_RESPONSE_TEXT_PATTERN = /^[^'\\]{1,255}$/;

// 处理状态必须落在 engineer_response.resolution_status 枚举值域内（白名单，不拼接外部枚举）
const CLEANUP_RESOLUTION_STATUSES: readonly EngineerResponseResolutionStatus[] = [
  'PENDING',
  'RESOLVED',
];

// 事务内守卫表与约束名（脚本中 CREATE TEMPORARY TABLE，会话级，断开即消失，不触碰持久结构）。
// MySQL 8.0.16+ 真实强制 CHECK 约束（本项目 baseline Migration 亦依赖 CHECK）：
// 违例即 ERROR 3819 中止批处理，未 COMMIT 的事务随连接中止回滚（本机实测确认）。
const CLEANUP_GUARD_TABLE = 'e2e_repair_request_cleanup_guard';

/**
 * 严格库名门（在 assertPhysicalCleanupAllowed 的「测试库命名」之上再收紧一道）：
 * 维修申请物理清理只允许发生在专用隔离库 lithography_e2e。默认连共享开发库
 * （lithography_drill）时失败关闭、不执行删除，也不降级成在别的库上删除。
 */
function assertDedicatedRepairRequestCleanupDatabase(env: Record<string, string>): void {
  if (env.DB_NAME !== DEDICATED_E2E_DB_NAME) {
    throw new Error(
      `维修申请物理清理被拒绝：DB_NAME=${JSON.stringify(env.DB_NAME)} 不是专用隔离库 ${JSON.stringify(DEDICATED_E2E_DB_NAME)}，失败关闭，不执行删除`,
    );
  }
}

function assertRepairRequestCleanupTargets(targets: readonly RepairRequestCleanupTarget[]): void {
  const seenIds = new Set<number>();
  const seenResponseIds = new Set<number>();

  for (const { id, expected, expectedResponses = [] } of targets) {
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new Error(`物理清理目标 ID 未通过正整数校验，拒绝执行：${JSON.stringify(id)}`);
    }

    if (seenIds.has(id)) {
      throw new Error(`物理清理目标 ID 重复，拒绝执行：${id}`);
    }

    seenIds.add(id);

    if (!REQUEST_NO_PATTERN.test(expected.requestNo)) {
      throw new Error(
        `物理清理预期申请编号未通过白名单校验，拒绝访问数据库：${JSON.stringify(expected.requestNo)}`,
      );
    }

    if (!Number.isSafeInteger(expected.customerAccountId) || expected.customerAccountId <= 0) {
      throw new Error(
        `物理清理预期客户账号未通过正整数校验，拒绝执行：${JSON.stringify(expected.customerAccountId)}`,
      );
    }

    if (!CLEANUP_ERROR_CODE_PATTERN.test(expected.errorCode)) {
      throw new Error(
        `物理清理预期故障码未通过白名单校验，拒绝访问数据库：${JSON.stringify(expected.errorCode)}`,
      );
    }

    if (!Number.isSafeInteger(expected.equipmentModelId) || expected.equipmentModelId <= 0) {
      throw new Error(
        `物理清理预期设备型号未通过正整数校验，拒绝执行：${JSON.stringify(expected.equipmentModelId)}`,
      );
    }

    if (!CLEANUP_FAULT_DESCRIPTION_PATTERN.test(expected.faultDescription)) {
      throw new Error(
        `物理清理预期故障描述未通过白名单校验，拒绝访问数据库：${JSON.stringify(expected.faultDescription)}`,
      );
    }

    if (
      expected.acceptedEngineerAccountId !== undefined &&
      (!Number.isSafeInteger(expected.acceptedEngineerAccountId) ||
        expected.acceptedEngineerAccountId <= 0)
    ) {
      throw new Error(
        `物理清理预期接单工程师账号未通过正整数校验，拒绝执行：${JSON.stringify(expected.acceptedEngineerAccountId)}`,
      );
    }

    for (const response of expectedResponses) {
      assertRepairRequestCleanupResponseTarget(response, id, seenResponseIds);
    }
  }
}

function assertRepairRequestCleanupResponseTarget(
  response: RepairRequestCleanupResponseTarget,
  requestId: number,
  seenResponseIds: Set<number>,
): void {
  if (!Number.isSafeInteger(response.id) || response.id <= 0) {
    throw new Error(`物理清理回复 ID 未通过正整数校验，拒绝执行：${JSON.stringify(response.id)}`);
  }

  if (seenResponseIds.has(response.id)) {
    throw new Error(`物理清理回复 ID 重复，拒绝执行：${response.id}`);
  }

  seenResponseIds.add(response.id);

  // 回复必须归属本轮那条申请：跨申请的回复 ID 一旦混入，会删掉不属于本目标的记录
  if (response.expected.requestId !== requestId) {
    throw new Error(
      `物理清理回复归属申请与清理目标不一致，拒绝执行：回复 ${response.id} 声明归属 ${JSON.stringify(response.expected.requestId)}，实际目标 ${requestId}`,
    );
  }

  if (
    !Number.isSafeInteger(response.expected.engineerAccountId) ||
    response.expected.engineerAccountId <= 0
  ) {
    throw new Error(
      `物理清理预期回复工程师账号未通过正整数校验，拒绝执行：${JSON.stringify(response.expected.engineerAccountId)}`,
    );
  }

  if (
    !Number.isSafeInteger(response.expected.customerAccountId) ||
    response.expected.customerAccountId <= 0
  ) {
    throw new Error(
      `物理清理预期回复客户账号未通过正整数校验，拒绝执行：${JSON.stringify(response.expected.customerAccountId)}`,
    );
  }

  if (!CLEANUP_RESOLUTION_STATUSES.includes(response.expected.resolutionStatus)) {
    throw new Error(
      `物理清理预期处理状态不在枚举值域内，拒绝执行：${JSON.stringify(response.expected.resolutionStatus)}`,
    );
  }

  if (!CLEANUP_RESPONSE_TEXT_PATTERN.test(response.expected.responseText)) {
    throw new Error(
      `物理清理预期回复正文未通过白名单校验，拒绝访问数据库：${JSON.stringify(response.expected.responseText)}`,
    );
  }
}

/**
 * 组装「同一连接、同一事务」的核验 + 删除脚本（本机实测结论）：
 * - 单次 mysql -e 多语句即同一连接，可 START TRANSACTION ... COMMIT；
 * - 守卫表 CHECK 违例让 CLI 在违例语句处中止（exit≠0），事务未 COMMIT 即回滚；
 * - CLI 已产出的 stdout（锁定行快照 + 诊断行）保留在错误的 stdout 中，作为失败诊断。
 */
function buildRepairRequestCleanupSql(targets: readonly RepairRequestCleanupTarget[]): string {
  const idList = targets.map(({ id }) => id).join(',');
  const idPredicate = `id IN (${idList})`;
  // 逐 ID 预期事实：每个 ID 绑定自己的本轮事实（编号 / 客户账号 / 故障码 / 设备型号 / 故障描述，
  // 已接单目标追加 is_accepted 与接单工程师归属），
  // 任一项与目标行不符都会被 field_mismatch_rows 计入，核验门随即中止批处理并回滚（不提交删除）。
  const expectedFacts = targets
    .map(({ id, expected }) => {
      const facts = [
        `id = ${id}`,
        `request_no = '${expected.requestNo}'`,
        `customer_account_id = ${expected.customerAccountId}`,
        `error_code = '${expected.errorCode}'`,
        `equipment_model_id = ${expected.equipmentModelId}`,
        `fault_description = '${expected.faultDescription}'`,
      ];

      if (expected.acceptedEngineerAccountId !== undefined) {
        facts.push(
          'is_accepted = 1',
          `accepted_by_engineer_account_id = ${expected.acceptedEngineerAccountId}`,
        );
      }

      return `(${facts.join(' AND ')})`;
    })
    .join(' OR ');
  const existingRows = `(SELECT COUNT(*) FROM repair_request WHERE ${idPredicate})`;
  const fieldMismatchRows = `(SELECT COUNT(*) FROM repair_request WHERE ${idPredicate} AND NOT (${expectedFacts}))`;

  // 本轮自建回复（负责人单卡片计划 P3）：逐 ID 绑定本轮事实；
  // 未提供回复的目标其预期条数为 0，此时下方各项退化为既有「零子记录」口径，守卫不放宽。
  const responseTargets = targets.flatMap(({ id, expectedResponses = [] }) =>
    expectedResponses.map((response) => ({ requestId: id, ...response })),
  );
  const expectedResponseRows = responseTargets.length;
  const responseIdList = responseTargets.map(({ id }) => id).join(',');
  const responseRows = `(SELECT COUNT(*) FROM engineer_response WHERE request_id IN (${idList}))`;
  const responseFieldMismatchRows =
    expectedResponseRows === 0
      ? '0'
      : `(SELECT COUNT(*) FROM engineer_response WHERE id IN (${responseIdList}) AND NOT (${responseTargets
          .map(
            ({ id, requestId, expected }) =>
              `(id = ${id} AND request_id = ${requestId} AND engineer_account_id = ${expected.engineerAccountId} AND customer_account_id = ${expected.customerAccountId} AND resolution_status = '${expected.resolutionStatus}' AND response_text = '${expected.responseText}')`,
          )
          .join(' OR ')}))`;
  // 预期回复 ID 缺失：声明了本轮回复却在库里找不到对应行（陈旧 / 错误的 ID）。
  // ID 去重由 Node 侧白名单保证，故实际命中行数恒不超过预期条数，本项恒为非负违例值。
  const foundExpectedResponseRows =
    expectedResponseRows === 0
      ? '0'
      : `(SELECT COUNT(*) FROM engineer_response WHERE id IN (${responseIdList}))`;
  const missingResponseRows = `(${expectedResponseRows} - ${foundExpectedResponseRows})`;
  // 多余回复子记录：该申请集合下的回复行数超出本轮预期条数的部分。
  // GREATEST 兜底保证非负：负值会在 childRows 求和时抵消「申请字段不符」等正向违例，
  // 使 CHECK 在核验未通过时误判为 0，从而让 DELETE 照常提交（数据已丢才由诊断发现）。
  const unexpectedResponseRows = `GREATEST(${responseRows} - ${expectedResponseRows}, 0)`;
  // 其他子表均以 ON DELETE RESTRICT 指向 repair_request，存在引用即整批中止交人工核对，绝不级联清理。
  const otherChildRows = [
    `(SELECT COUNT(*) FROM ai_conversation WHERE request_id IN (${idList}))`,
    `(SELECT COUNT(*) FROM ai_report WHERE request_id IN (${idList}))`,
  ].join(' + ');
  const childRows = [
    missingResponseRows,
    unexpectedResponseRows,
    responseFieldMismatchRows,
    otherChildRows,
  ].join(' + ');
  const guardViolations = [
    `(DATABASE() <> '${DEDICATED_E2E_DB_NAME}')`,
    `(${targets.length} - ${existingRows})`,
    fieldMismatchRows,
    childRows,
  ].join(' + ');

  const statements = [
    'START TRANSACTION',
    `CREATE TEMPORARY TABLE ${CLEANUP_GUARD_TABLE} (violations INT NOT NULL, CONSTRAINT e2e_repair_request_cleanup_must_be_zero CHECK (violations = 0))`,
    `SELECT id, request_no, customer_account_id, equipment_model_id, error_code, fault_description, is_accepted, accepted_by_engineer_account_id FROM repair_request WHERE ${idPredicate} ORDER BY id FOR UPDATE`,
    `SELECT CONCAT('database=', DATABASE(), ' expected_rows=${targets.length}', ' existing_rows=', ${existingRows}, ' field_mismatch_rows=', ${fieldMismatchRows}, ' child_rows=', ${childRows}, ' expected_response_rows=${expectedResponseRows}', ' missing_response_rows=', ${missingResponseRows}, ' unexpected_response_rows=', ${unexpectedResponseRows})`,
    `INSERT INTO ${CLEANUP_GUARD_TABLE} (violations) SELECT ${guardViolations}`,
  ];

  // 先删本轮精确回复行，再删申请行：外键 ON DELETE RESTRICT 决定顺序不可颠倒，
  // 且回复行只按本轮记录的精确 ID 删除，绝不按申请批量删回复。
  if (expectedResponseRows > 0) {
    statements.push(`DELETE FROM engineer_response WHERE id IN (${responseIdList})`);
  }

  statements.push(
    `DELETE FROM repair_request WHERE ${idPredicate}`,
    `SELECT CONCAT('residue_rows=', ${existingRows}, ' response_residue_rows=', ${responseRows})`,
    `INSERT INTO ${CLEANUP_GUARD_TABLE} (violations) SELECT ${responseRows}`,
    `INSERT INTO ${CLEANUP_GUARD_TABLE} (violations) SELECT ${existingRows}`,
    'COMMIT',
  );

  return statements.join(';\n');
}

/**
 * 执行受保护清理脚本（单次 mysql 进程 = 同一连接）。失败时抛出携带诊断的错误：
 * 密码只经 MYSQL_PWD 注入，既不在进程参数也不在诊断文本中；
 * 原始错误整条作 cause 会把完整 SQL 与 CLI 输出复制进异常链，故以副本作 cause。
 * 维修申请与参考资料清理共用同一执行器，仅事务对象名不同（label）。
 */
function runCleanupTransactionSql(env: Record<string, string>, sql: string, label: string): string {
  try {
    return execFileSync(
      'mysql',
      [
        '-h',
        env.DB_HOST,
        '-P',
        env.DB_PORT,
        `-u${env.DB_USER}`,
        env.DB_NAME,
        '-N',
        '-B',
        '-e',
        sql,
      ],
      {
        encoding: 'utf-8',
        env: { ...process.env, MYSQL_PWD: env.DB_PASS },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch (error) {
    const failure = error as { stderr?: string; stdout?: string };
    const stderrLine = (failure.stderr ?? '').trim().split('\n')[0] ?? '';
    const diagnostics = (failure.stdout ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.includes('='))
      .join(' | ');
    const message =
      `${label}（已回滚，未执行删除）：${stderrLine === '' ? '未知错误' : stderrLine}` +
      (diagnostics === '' ? '' : `；核验诊断：${diagnostics}`);

    throw new Error(message, {
      // eslint-disable-next-line preserve-caught-error -- 原始错误含完整 SQL 与 CLI 输出，一律以副本作为 cause
      cause: new Error(message),
    });
  }
}

function runRepairRequestCleanupSql(env: Record<string, string>, sql: string): string {
  return runCleanupTransactionSql(env, sql, '维修申请物理清理事务中止');
}

/**
 * 独立复查 CLI 回读的核验诊断（防御「CHECK 约束在旧版本 MySQL 上被静默忽略」的情形，
 * 也避免把「拿不到或读不懂诊断」当成清理成功）：库名 / 期望行数 / 实际行数 / 字段不符 /
 * 子记录 / 本轮回复条数 / 申请残留 / 回复残留任一不达标即抛错。
 * 本轮回复条数必须与调用方声明一致：声明了回复却没有对应的核验行，说明脚本或库口径不对，
 * 同样按失败处理（不因为「诊断缺失」而放行）。
 */
function assertRepairRequestCleanupDiagnostics(
  output: string,
  expectedRows: number,
  expectedResponseRows: number,
): void {
  const diagnostics: Record<string, string> = {};

  for (const match of output.matchAll(/([a-z_]+)=(\S+)/g)) {
    diagnostics[match[1]] = match[2];
  }

  const expectedDiagnostics: Array<[string, string]> = [
    ['database', DEDICATED_E2E_DB_NAME],
    ['expected_rows', String(expectedRows)],
    ['existing_rows', String(expectedRows)],
    ['field_mismatch_rows', '0'],
    ['child_rows', '0'],
    ['expected_response_rows', String(expectedResponseRows)],
    ['response_residue_rows', '0'],
    ['residue_rows', '0'],
  ];
  const mismatched = expectedDiagnostics.filter(([key, value]) => diagnostics[key] !== value);

  if (mismatched.length > 0) {
    throw new Error(
      `维修申请物理清理核验失败：${mismatched
        .map(
          ([key, value]) => `${key} 期望 ${value} 实际 ${JSON.stringify(diagnostics[key] ?? null)}`,
        )
        .join('；')}`,
    );
  }
}

/**
 * 按本次运行记录的精确 ID 物理清理维修申请行（统一安全入口，创建 / 管理 / 分页夹具共用）。
 *
 * 安全性质（负责人最小修复计划 P1/P2，负责人单卡片计划 P3 扩展回复清理）：
 * - 入口内独立执行「显式授权门 + 测试库命名门 + 严格 lithography_e2e 库名门」，
 *   任一门不通过即抛错且 mysql 进程绝不启动（不依赖调用方或全局 setup 已经检查过）；
 * - 目标 ID 与五项预期事实先过 Node 侧白名单（编号 / 客户账号 / 故障码 / 设备型号 / 故障描述），
 *   先于任何 SQL 组装；不再有「仅凭编号格式直接 DELETE」的路径，也不按前缀/行数/猜测 ID 匹配；
 * - 同一连接、同一事务内完成：库名核验 → FOR UPDATE 锁定并读取目标行 → 逐项核对预期字段、
 *   客户账号、设备型号、故障描述（已接单目标再核对 is_accepted 与接单工程师归属）
 *   → 核对子记录引用 → 全部门通过才先删本轮精确回复行、再删申请行
 *   → 提交前核验申请残留与回复残留均为 0 → COMMIT；任一门不通过即中止回滚（删除作废）并让用例转红。
 * - 未声明 expectedResponses 时维持既有最强守卫：申请存在任何 engineer_response 子记录即整批中止，
 *   绝不因为「要让用例通过」而放宽。
 * - ID 列表为空时 no-op，不启动 mysql 进程。
 */
export function deleteRepairRequestRowsByIds(targets: readonly RepairRequestCleanupTarget[]): void {
  if (targets.length === 0) {
    return;
  }

  assertRepairRequestCleanupTargets(targets);

  const env = readBackendEnv();

  assertPhysicalCleanupAllowed(env);
  assertDedicatedRepairRequestCleanupDatabase(env);

  const expectedResponseRows = targets.reduce(
    (total, { expectedResponses = [] }) => total + expectedResponses.length,
    0,
  );

  const output = runRepairRequestCleanupSql(env, buildRepairRequestCleanupSql(targets));

  assertRepairRequestCleanupDiagnostics(output, targets.length, expectedResponseRows);
}

/** 客户软删自己的未接单申请（幂等成功）——真实链路用例的统一清理通道（可逆，先于物理清理） */
const DELETE_MY_REPAIR_REQUEST_MUTATION = `
  mutation DeleteMyRepairRequestForCleanup($id: Int!) {
    deleteMyRepairRequest(id: $id) { id requestNo }
  }
`;

/**
 * 真实链路维修申请用例的统一清理入口（创建 / 管理 / 已回复工程师链路三个 spec 共用，
 * 替代旧 deleteRepairRequestByRequestNo 的「仅凭编号格式直接 DELETE」路径）：
 * 1. 编号先过白名单（非法编号在任何数据库访问前被拒绝）；
 * 2. 按编号解析本次自建行的精确 ID（行已不存在则 no-op，幂等成立）；
 * 3. 未接单申请经产品自身通道软删（可逆）：共享开发库与专用隔离库都执行，保持基线可见面干净；
 *    已接单并含本轮回复的申请在业务上不可被客户软删（deleteMyRepairRequest 对已接单申请拒绝），
 *    此时跳过软删并直接走受保护物理清理；
 * 4. 仅当环境为专用隔离库 lithography_e2e 且执行者显式授权时，再按「精确 ID + 本轮预期事实
 *    + 本轮回复精确 ID」走受保护物理清理（同一连接同一事务核验后先删回复再删申请，任一残留非零即失败）；
 *    共享开发库保持既有软删边界，不做物理删除。
 * 任一门不通过即抛错：清理失败必须是可观测的失败，而不是静默残留。
 *
 * 五项预期事实（编号 / 客户账号 / 故障码 / 设备型号 / 故障描述）全部必填：调用方必须传入
 * 本轮测试自身掌握的事实（创建 Mutation 实际发送/返回的值），不得用从目标行反查所得的值充当预期。
 * 已接单用例再传 acceptedEngineerAccountId（归属核对）与 expectedResponses（本轮回复精确清理目标）。
 */
export async function cleanupE2ERepairRequest(options: {
  env: Record<string, string>;
  requestNo: string;
  customerAccountId: number;
  errorCode: string;
  equipmentModelId: number;
  faultDescription: string;
  customerLoginName?: string;
  /** 已接单申请的接单工程师账号（可选，提供后核验 is_accepted 与接单归属） */
  acceptedEngineerAccountId?: number;
  /** 本轮为该申请创建的工程师回复（精确 ID + 本轮事实）；非空即表示申请已接单、不可软删 */
  expectedResponses?: readonly RepairRequestCleanupResponseTarget[];
}): Promise<void> {
  assertWhitelistedRequestNo(options.requestNo);

  const id = findRepairRequestByRequestNo(options.requestNo, 'id');

  if (id === '') {
    return;
  }

  const numericId = Number(id);

  if (!Number.isSafeInteger(numericId) || numericId <= 0) {
    throw new Error(`自建维修申请 ID 解析失败，拒绝清理：${JSON.stringify(id)}`);
  }

  const expectedResponses = options.expectedResponses ?? [];
  const isAcceptedRun = expectedResponses.length > 0;
  const physicalCleanupEnabled = isPhysicalCleanupEnabled(options.env);

  if (isAcceptedRun) {
    // 已接单/已回复申请无法经产品通道软删（业务上客户不得删除已接单申请）：
    // 此时必须先确认物理清理可用，否则拒绝静默把本轮自建数据留在库里。
    if (!physicalCleanupEnabled) {
      throw new Error(
        `自建维修申请 ${options.requestNo} 已接单并含本轮回复，无法经产品通道软删；物理清理未启用（缺 E2E_ALLOW_PHYSICAL_CLEANUP=1），拒绝静默留下本轮自建数据`,
      );
    }
  } else {
    const { body } = await realGraphqlCall(
      options.env,
      DELETE_MY_REPAIR_REQUEST_MUTATION,
      { id: numericId },
      options.customerLoginName ?? 'mock_customer_alpha',
    );

    if ((body as { errors?: unknown[] }).errors !== undefined) {
      throw new Error(`自建维修申请 ${options.requestNo} 软删失败，拒绝声称清理完成`);
    }

    if (!physicalCleanupEnabled) {
      return;
    }
  }

  deleteRepairRequestRowsByIds([
    {
      expected: {
        customerAccountId: options.customerAccountId,
        equipmentModelId: options.equipmentModelId,
        errorCode: options.errorCode,
        faultDescription: options.faultDescription,
        requestNo: options.requestNo,
        ...(options.acceptedEngineerAccountId === undefined
          ? {}
          : { acceptedEngineerAccountId: options.acceptedEngineerAccountId }),
      },
      expectedResponses,
      id: numericId,
    },
  ]);
}

// ---- 文件上传 / 下载 REST 链路（0909 第二轮阻塞项 1 的 e2e 支撑） ----

/** 以指定账号真实登录换取 accessToken（Node 侧 REST 调用复用 realLogin 收口） */
async function realAccessTokenOrThrow(
  env: Record<string, string>,
  loginName: string,
): Promise<string> {
  const { accessToken } = await realLogin(env, loginName);

  return accessToken;
}

/**
 * Node 侧真实 multipart 上传（绕过 UI 直接打 REST 边界，用于权限/错误分支断言；
 * UI 主链路走 setInputFiles 走浏览器真实通道）。返回完整响应体（统一信封）。
 */
export async function realRestUpload(
  env: Record<string, string>,
  file: { name: string; contentType: string; bytes: Uint8Array },
  fields: Record<string, string>,
  loginName = 'mock_super_admin',
): Promise<{ status: number; body: unknown }> {
  const accessToken = await realAccessTokenOrThrow(env, loginName);
  const formData = new FormData();

  formData.append(
    'file',
    new Blob([file.bytes as BlobPart], { type: file.contentType }),
    file.name,
  );
  for (const [key, value] of Object.entries(fields)) {
    formData.append(key, value);
  }

  const response = await fetch(BACKEND_REST_UPLOAD, {
    body: formData,
    headers: { Authorization: `Bearer ${accessToken}` },
    method: 'POST',
  });

  return { status: response.status, body: await response.json().catch(() => null) };
}

/**
 * Node 侧真实流式下载（断言 Content-Type / Content-Disposition / 字节内容）。
 * 返回 buffer 而非 text：下载对象是二进制文件。
 */
export async function realRestDownload(
  env: Record<string, string>,
  id: number,
  loginName = 'mock_super_admin',
): Promise<{
  status: number;
  contentType: string | null;
  contentDisposition: string | null;
  buffer: ArrayBuffer;
  body: unknown;
}> {
  const accessToken = await realAccessTokenOrThrow(env, loginName);
  const response = await fetch(backendRestDownloadUrl(id), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const contentType = response.headers.get('content-type');
  const contentDisposition = response.headers.get('content-disposition');

  if (!response.ok) {
    return {
      status: response.status,
      contentType,
      contentDisposition,
      buffer: new ArrayBuffer(0),
      body: await response.json().catch(() => null),
    };
  }

  return {
    status: response.status,
    contentType,
    contentDisposition,
    buffer: await response.arrayBuffer(),
    body: null,
  };
}

/** 按精确 ID 读取存储引用（SELECT 只读，不涉及清理安全门；无引用/无行返回 null） */
export function findReferenceDocumentStorageReferenceById(id: number): string | null {
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`存储引用查询目标 ID 未通过正整数校验：${JSON.stringify(id)}`);
  }

  const value = mysqlQuery(
    `SELECT IFNULL(storage_reference, '') FROM reference_document WHERE id = ${id}`,
  );

  return value.length > 0 ? value : null;
}

/**
 * 解析存储目录内某个引用的精确文件路径（与 deleteE2EReferenceDocumentStorageFileByReference 同一口径）：
 * 存储目录取自 env（缺省 var/reference-documents），并执行同一「解析后仍在存储目录内」的越界防御。
 * 仅供真实 E2E 夹具在删除前写入 / 核对目标文件，避免测试侧另写一套路径口径造成漂移。
 */
export function resolveReferenceDocumentStorageFilePath(
  env: Record<string, string>,
  reference: string,
): string {
  const storageDir = path.resolve(
    fileURLToPath(new URL('../../../backend', import.meta.url)),
    env.REFERENCE_DOCUMENT_STORAGE_DIR || 'var/reference-documents',
  );
  const filePath = path.resolve(storageDir, reference);

  // 双保险：断言解析后的精确路径仍在存储目录内（与后端 resolve 防御同口径）
  if (!filePath.startsWith(`${storageDir}${path.sep}`)) {
    throw new Error(`存储文件路径越界，拒绝删除：${JSON.stringify(filePath)}`);
  }

  return filePath;
}

/**
 * 按精确存储引用删除单个物理文件（PR5 归属核验后调用：先核验行归属并取引用，再删文件）。
 * 引用必须命中服务端生成格式白名单，且解析后必须落在存储目录内，否则拒绝删除。
 * 返回解析后的精确文件路径，供调用方在删除后复核零残留。
 *
 * 同等保护（评审 P1）：本函数是真正执行 `rmSync` 的底层原语，存在独立调用路径（PR5 清理编排），
 * 故删除前必须由本函数自行通过「显式授权门 + 严格专用隔离库门」，不因调用方已检查而放宽；
 * 逐字段归属核验与实际 `DATABASE()` 一致性由受保护入口（deleteE2EReferenceDocumentStorageFiles）
 * 在同一次核验 SQL 内复查。任何一门不通过即抛错，绝不执行删除。
 */
export function deleteE2EReferenceDocumentStorageFileByReference(reference: string): string {
  if (!STORAGE_REFERENCE_PATTERN.test(reference)) {
    throw new Error(`存储文件引用未通过白名单校验，拒绝删除：${JSON.stringify(reference)}`);
  }

  const env = readBackendEnv();

  assertPhysicalCleanupAllowed(env);
  assertDedicatedReferenceDocumentCleanupDatabase(env);
  const filePath = resolveReferenceDocumentStorageFilePath(env, reference);

  if (existsSync(filePath)) {
    rmSync(filePath, { force: true });
  }

  return filePath;
}

/**
 * 存储物理文件清理目标：id 与「创建时立即记录」的事实一并保存。
 * 删除目标一律取本轮记录的精确引用，绝不重新读取当前行引用——否则核验退化为自证，
 * 行被改写 / 引用被指向他人文件时无从发现；expected 另含文件元数据，删除前逐项核对。
 */
export interface ReferenceDocumentStorageFileCleanupTarget {
  readonly id: number;
  readonly expected: {
    readonly title: string;
    readonly createdByAccountId: number;
    readonly storageReference: string;
    readonly originalFilename: string;
    readonly mimeType: string;
  };
}

function assertStorageFileCleanupTargets(
  targets: readonly ReferenceDocumentStorageFileCleanupTarget[],
): void {
  const seenIds = new Set<number>();

  for (const { id, expected } of targets) {
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new Error(`存储文件清理目标 ID 未通过正整数校验，拒绝执行：${JSON.stringify(id)}`);
    }

    if (seenIds.has(id)) {
      throw new Error(`存储文件清理目标 ID 重复，拒绝执行：${id}`);
    }

    seenIds.add(id);

    if (!STORAGE_REFERENCE_PATTERN.test(expected.storageReference)) {
      throw new Error(
        `存储文件清理预期引用未通过白名单校验，拒绝访问数据库：${JSON.stringify(expected.storageReference)}`,
      );
    }

    if (!Number.isSafeInteger(expected.createdByAccountId) || expected.createdByAccountId <= 0) {
      throw new Error(
        `存储文件清理预期创建人账号未通过正整数校验，拒绝执行：${JSON.stringify(expected.createdByAccountId)}`,
      );
    }

    const textFacts: Array<readonly [string, string]> = [
      ['标题', expected.title],
      ['原始文件名', expected.originalFilename],
      ['文件类型', expected.mimeType],
    ];

    for (const [label, value] of textFacts) {
      if (!CLEANUP_DOCUMENT_TITLE_PATTERN.test(value)) {
        throw new Error(
          `存储文件清理预期${label}未通过白名单校验，拒绝访问数据库：${JSON.stringify(value)}`,
        );
      }
    }
  }
}

/**
 * 组装「删除前核验」只读脚本（单次 mysql 进程）：逐 ID 核对目标行是否存在，标题 / 创建人 /
 * 存储引用 / 原始文件名 / 文件类型是否与本轮记录一致，并核对该引用未被其他行占用。
 * 任一不符即计数非零，Node 侧断言失败并保留文件（先核验，再删文件）。
 */
function buildStorageFileCleanupVerificationSql(
  targets: readonly ReferenceDocumentStorageFileCleanupTarget[],
): string {
  const idPredicate = `id IN (${targets.map(({ id }) => id).join(',')})`;
  const expectedFacts = targets
    .map(({ id, expected }) =>
      [
        `(id = ${id}`,
        `title = '${expected.title}'`,
        `created_by_account_id = ${expected.createdByAccountId}`,
        // 三个可空字段一律用 NULL 安全比较（<=>）：实际被改成 NULL 时必须计入 field_mismatch_rows
        `storage_reference <=> '${expected.storageReference}'`,
        `original_filename <=> '${expected.originalFilename}'`,
        `mime_type <=> '${expected.mimeType}')`,
      ].join(' AND '),
    )
    .join(' OR ');
  const existingRows = `(SELECT COUNT(*) FROM reference_document WHERE ${idPredicate})`;
  const fieldMismatchRows = `(SELECT COUNT(*) FROM reference_document WHERE ${idPredicate} AND NOT (${expectedFacts}))`;
  const sharedReferenceRows = targets
    .map(
      ({ id, expected }) =>
        `(SELECT COUNT(*) FROM reference_document WHERE storage_reference = '${expected.storageReference}' AND id <> ${id})`,
    )
    .join(' + ');

  return `SELECT CONCAT('database=', DATABASE(), ' expected_files=${targets.length}', ' existing_rows=', ${existingRows}, ' field_mismatch_rows=', ${fieldMismatchRows}, ' shared_reference_rows=', ${sharedReferenceRows})`;
}

/**
 * 独立复查删除前核验诊断：期望文件数 / 实际行数 / 字段不符 / 引用被他人占用任一不达标即抛错。
 * 抛出即代表「保留文件、未执行删除」。
 */
function assertStorageFileCleanupDiagnostics(output: string, expectedFiles: number): void {
  const diagnostics: Record<string, string> = {};

  for (const match of output.matchAll(/([a-z_]+)=(\S+)/g)) {
    diagnostics[match[1]] = match[2];
  }

  const expectedDiagnostics: Array<[string, string]> = [
    // 实际连接库名（同一 SQL 核验连接回读的 DATABASE()）：只检查进程 env 的 DB_NAME 不够，
    // 必须核对真正连上的库就是专用隔离库（评审 P1）。
    ['database', DEDICATED_E2E_DB_NAME],
    ['expected_files', String(expectedFiles)],
    ['existing_rows', String(expectedFiles)],
    ['field_mismatch_rows', '0'],
    ['shared_reference_rows', '0'],
  ];
  const mismatched = expectedDiagnostics.filter(([key, value]) => diagnostics[key] !== value);

  if (mismatched.length > 0) {
    throw new Error(
      `存储文件删除前核验失败（保留文件，不执行删除）：${mismatched
        .map(
          ([key, value]) => `${key} 期望 ${value} 实际 ${JSON.stringify(diagnostics[key] ?? null)}`,
        )
        .join('；')}`,
    );
  }
}

/**
 * 按本轮记录并核验过的精确引用清理存储物理文件（先核验，再删除）。
 *
 * 安全性质：
 * - 入口内独立执行「显式授权门（E2E_ALLOW_PHYSICAL_CLEANUP=1）+ 严格专用隔离库门（DB_NAME）」
 *   与「同一核验 SQL 回读的实际 DATABASE()」复查，任一不通过即抛错，绝不进入文件删除；
 * - 删除目标一律取本轮创建时记录的引用，绝不重新读取当前行引用作为删除目标；
 * - 删除前经单次只读 SQL 逐 ID 核对行字段（标题 / 创建人 / 存储引用 / 原始文件名 / 文件类型）
 *   与该引用未被其他行占用，任一不符即抛错并保留文件（不删他人文件）；
 * - 引用必须命中服务端生成格式白名单且解析后落在存储目录内，删除后复核零残留；
 * - 目标为空时 no-op，不访问数据库。
 * 必须先于按 ID 物理删行调用：删除前核验需要目标行仍存在。
 */
export function deleteE2EReferenceDocumentStorageFiles(
  targets: readonly ReferenceDocumentStorageFileCleanupTarget[],
): void {
  if (targets.length === 0) {
    return;
  }

  assertStorageFileCleanupTargets(targets);

  const env = readBackendEnv();

  // 入口自证（评审 P1）：本入口自行执行「显式授权门 + 严格专用隔离库门（配置侧 DB_NAME）」，
  // 任一不通过即抛错，既不会组装核验 SQL，也不会调用任何文件删除函数。
  assertPhysicalCleanupAllowed(env);
  assertDedicatedReferenceDocumentCleanupDatabase(env);

  const diagnosticsOutput = mysqlQuery(buildStorageFileCleanupVerificationSql(targets));

  // 同一核验 SQL 回读实际 DATABASE() 并逐项复查（含逐字段归属与引用唯一性）：
  // 只有授权、配置库名、实际库名与全部字段核验都通过，才进入下面的文件删除。
  assertStorageFileCleanupDiagnostics(diagnosticsOutput, targets.length);

  const residue: string[] = [];

  for (const { expected } of targets) {
    const filePath = deleteE2EReferenceDocumentStorageFileByReference(expected.storageReference);

    if (existsSync(filePath)) {
      residue.push(expected.storageReference);
    }
  }

  if (residue.length > 0) {
    throw new Error(`存储物理文件清理后仍存在残留，拒绝声称清理完成：${residue.join(',')}`);
  }
}

// ---- 真实 E2E 夹具写入：统一安全入口 + 先核验后恢复（仅测试夹具使用） ----

/** 夹具可写列白名单：只允许这几列，杜绝把任意列名拼进 SQL */
export type ReferenceDocumentFixtureColumn =
  | 'storage_reference'
  | 'storage_backend'
  | 'content_text'
  | 'original_filename'
  | 'mime_type';

const FIXTURE_COLUMNS: readonly ReferenceDocumentFixtureColumn[] = [
  'storage_reference',
  'storage_backend',
  'content_text',
  'original_filename',
  'mime_type',
];

// 夹具值进 SQL 前的字面量白名单：排除单引号（终止符）与反斜杠（默认转义符），并限长。
const FIXTURE_SQL_LITERAL_PATTERN = /^[^'\\]{0,4096}$/;
const FIXTURE_RESTORE_GUARD_TABLE = 'e2e_reference_document_fixture_restore_guard';
const FIXTURE_RESTORE_GUARD_CONSTRAINT = 'e2e_reference_document_fixture_restore_must_be_zero';

function fixtureSqlLiteral(value: string | null): string {
  if (value === null) {
    return 'NULL';
  }

  if (!FIXTURE_SQL_LITERAL_PATTERN.test(value)) {
    throw new Error(`真实 E2E 夹具值未通过白名单校验，拒绝拼接：${JSON.stringify(value)}`);
  }

  return `'${value}'`;
}

/**
 * 真实 E2E 夹具写入的统一安全入口（仅测试夹具使用）：复用既有「显式物理清理授权门 +
 * 测试库命名门 + 严格 lithography_e2e 库名门」，并额外核对执行连接实际连上的 DATABASE()
 * 必须为 lithography_e2e。mysql 每次调用都是独立进程，故先独立回读实际库名再执行写入；
 * 任一门不通过即抛错，且绝不启动写入 SQL 的 mysql 进程。
 *
 * 只应传入代码内静态字面量的夹具 SQL（插入 / 故意改 NULL / 恢复），不得拼接外部输入。
 */
export function runGuardedFixtureWrite(env: Record<string, string>, sql: string): string {
  assertPhysicalCleanupAllowed(env);
  assertDedicatedReferenceDocumentCleanupDatabase(env);

  const actualDatabase = mysqlQuery('SELECT DATABASE()');

  if (actualDatabase !== DEDICATED_E2E_DB_NAME) {
    throw new Error(
      `真实 E2E 夹具写入被拒绝：执行连接实际 DATABASE()=${JSON.stringify(actualDatabase)} 不是专用隔离库 ${JSON.stringify(DEDICATED_E2E_DB_NAME)}，失败关闭，不执行写入`,
    );
  }

  return mysqlQuery(sql);
}

/** 夹具单列的本轮制造状态与原登记值 */
export interface ReferenceDocumentFixtureColumnMutation {
  readonly column: ReferenceDocumentFixtureColumn;
  /** 本轮制造的状态（当前值仍应等于它，否则说明已被意外改动） */
  readonly manufacturedValue: string | null;
  /** 登记原值（恢复目标） */
  readonly originalValue: string | null;
}

/** 夹具「先核验后恢复」目标：标题 / 创建人 + 逐列制造状态必须在同一事务内命中才恢复 */
export interface ReferenceDocumentFixtureRestoreTarget {
  readonly id: number;
  readonly title: string;
  readonly createdByAccountId: number;
  readonly mutations: readonly ReferenceDocumentFixtureColumnMutation[];
}

/** 独立复查夹具恢复诊断：库名 / 命中行 / 制造状态不符 / 已恢复行任一不达标即抛错（保留行与文件） */
function assertFixtureRestoreDiagnostics(output: string): void {
  const diagnostics: Record<string, string> = {};

  for (const match of output.matchAll(/([a-z_]+)=(\S+)/g)) {
    diagnostics[match[1]] = match[2];
  }

  const expectedDiagnostics: Array<[string, string]> = [
    ['database', DEDICATED_E2E_DB_NAME],
    ['existing_rows', '1'],
    ['restored_rows', '1'],
  ];
  const mismatched = expectedDiagnostics.filter(([key, value]) => diagnostics[key] !== value);

  if (mismatched.length > 0) {
    throw new Error(
      `夹具恢复核验失败（保留行与文件）：${mismatched
        .map(
          ([key, value]) => `${key} 期望 ${value} 实际 ${JSON.stringify(diagnostics[key] ?? null)}`,
        )
        .join('；')}`,
    );
  }
}

/**
 * 夹具「先核验后恢复」：把本轮故意改成 NULL 的列恢复为登记原值，仅当标题 / 创建人 / 各列当前值
 * 仍等于本轮制造的状态时才执行。核验与恢复在同一事务（同一 mysql 进程）：先按精确 ID 锁定目标行
 * （SELECT ... FOR UPDATE），在 UPDATE 之前用守卫表 CHECK 核验库名 / 身份 / 逐列制造值，更新后再以
 * 影响行数（恰好 1）经第二道守卫把关，任一不符都在 COMMIT 前中止并回滚（零写入）；抛出后调用方
 * 必须保留行与文件。
 */
export function restoreMutatedReferenceDocumentFixtureRow(
  env: Record<string, string>,
  target: ReferenceDocumentFixtureRestoreTarget,
): void {
  if (!Number.isSafeInteger(target.id) || target.id <= 0 || target.mutations.length === 0) {
    throw new Error(
      `夹具恢复目标非法（需正整 ID 与至少一列制造状态），拒绝执行：${JSON.stringify(target.id)}`,
    );
  }

  if (!CLEANUP_DOCUMENT_TITLE_PATTERN.test(target.title)) {
    throw new Error(
      `夹具恢复预期标题未通过白名单校验，拒绝访问数据库：${JSON.stringify(target.title)}`,
    );
  }

  if (!Number.isSafeInteger(target.createdByAccountId) || target.createdByAccountId <= 0) {
    throw new Error(
      `夹具恢复预期创建人账号未通过正整数校验，拒绝执行：${JSON.stringify(target.createdByAccountId)}`,
    );
  }

  for (const { column } of target.mutations) {
    if (!FIXTURE_COLUMNS.includes(column)) {
      throw new Error(`夹具恢复列名未通过白名单校验，拒绝拼接：${JSON.stringify(column)}`);
    }
  }

  const identity = `id = ${target.id} AND title = '${target.title}' AND created_by_account_id = ${target.createdByAccountId}`;
  const manufacturedPredicate = target.mutations
    .map(({ column, manufacturedValue }) => `${column} <=> ${fixtureSqlLiteral(manufacturedValue)}`)
    .join(' AND ');
  const restoreAssignments = target.mutations
    .map(({ column, originalValue }) => `${column} = ${fixtureSqlLiteral(originalValue)}`)
    .join(', ');
  // 身份 + 逐列制造值须恰好命中 1 行：行缺失 / 标题或创建人被改 / 任一列已变动都会令其为 0
  const rowByManufacturedState = `(SELECT COUNT(*) FROM reference_document WHERE ${identity} AND (${manufacturedPredicate}))`;

  const sql = [
    'START TRANSACTION',
    `CREATE TEMPORARY TABLE ${FIXTURE_RESTORE_GUARD_TABLE} (violations INT NOT NULL, CONSTRAINT ${FIXTURE_RESTORE_GUARD_CONSTRAINT} CHECK (violations = 0))`,
    // 按精确 ID 锁定现有行：核验与更新期间不允许并发改动（行不存在时锁定不命中，由下方核验守卫拒绝）
    `SELECT id FROM reference_document WHERE id = ${target.id} LIMIT 1 FOR UPDATE`,
    // 写入前完成库名 / 身份 / 逐列制造值核验：不符即在此中止回滚，绝不执行 UPDATE
    `INSERT INTO ${FIXTURE_RESTORE_GUARD_TABLE} (violations) SELECT (DATABASE() <> '${DEDICATED_E2E_DB_NAME}') + (1 - ${rowByManufacturedState})`,
    // UPDATE 的 WHERE 再次包含身份与逐列 <=> 条件，与预检口径一致
    `UPDATE reference_document SET ${restoreAssignments} WHERE ${identity} AND (${manufacturedPredicate})`,
    'SET @restored_rows = ROW_COUNT()',
    // 更新后要求恰好 1 行：不是 1 即在 COMMIT 前经第二道守卫中止回滚
    `INSERT INTO ${FIXTURE_RESTORE_GUARD_TABLE} (violations) SELECT (1 - @restored_rows)`,
    `SELECT CONCAT('database=', DATABASE(), ' existing_rows=', (SELECT COUNT(*) FROM reference_document WHERE id = ${target.id}), ' restored_rows=', @restored_rows)`,
    'COMMIT',
  ].join(';\n');

  const output = runGuardedFixtureWrite(env, sql);

  assertFixtureRestoreDiagnostics(output);
}

// 可用性探针：健康检查 + 用真实 Mock 账号登录（同时验证后端已种子且登录链路可用）。
// CORS 不在 Node 侧预检（fetch 不允许设置 Origin 等受限头），留给浏览器用例自身暴露。
export async function isRealBackendAvailable(env: Record<string, string>): Promise<boolean> {
  try {
    const health = await fetch(BACKEND_HEALTH);

    if (!health.ok) {
      return false;
    }

    await realLoginAccountId(env);

    return true;
  } catch {
    return false;
  }
}

// 真实登录（单一实现）：以真实 Mock 账号换取 accessToken 与 accountId。
// 所有需要登录态的 Node 侧调用都经此收口，登录契约变化只改这一处。
async function realLogin(
  env: Record<string, string>,
  loginName: string,
): Promise<{ accessToken: string; accountId: number }> {
  const response = await fetch(BACKEND_GRAPHQL, {
    body: JSON.stringify({
      query:
        'mutation LoginWithPassword($input: AuthLoginInput!) { login(input: $input) { accessToken accountId role } }',
      variables: {
        input: {
          audience: 'SSTSWEB',
          loginName,
          loginPassword: env.MOCK_SEED_PASSWORD,
          type: 'PASSWORD',
        },
      },
    }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });

  const body = (await response.json()) as {
    data?: { login?: { accountId: number; accessToken?: string } };
  };

  if (!body.data?.login?.accessToken) {
    throw new Error('real login failed in e2e setup');
  }

  return { accessToken: body.data.login.accessToken, accountId: body.data.login.accountId };
}

// 真实登录拿账号 ID：落库断言以真实后端返回的 accountId 为准，不硬编码种子 ID。
// loginName 缺省用客户甲（mock_customer_alpha）；密码统一取种子口令 env。
export async function realLoginAccountId(
  env: Record<string, string>,
  loginName = 'mock_customer_alpha',
): Promise<number> {
  const { accountId } = await realLogin(env, loginName);

  return accountId;
}

/** 以真实账号身份调用受保护 GraphQL（Node 侧，用于 API 级断言），返回完整响应体。 */
export async function realGraphqlCall(
  env: Record<string, string>,
  query: string,
  variables: Record<string, unknown>,
  loginName = 'mock_customer_alpha',
): Promise<{ status: number; body: unknown }> {
  const { accessToken } = await realLogin(env, loginName);

  const response = await fetch(BACKEND_GRAPHQL, {
    body: JSON.stringify({ query, variables }),
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    method: 'POST',
  });

  return { status: response.status, body: await response.json() };
}
