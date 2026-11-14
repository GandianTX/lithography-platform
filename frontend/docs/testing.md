<!-- docs/testing.md -->

# Testing

- Use Vitest for unit tests close to pure logic.
- Keep route and UI tests focused on the behavior being changed.
- For narrow changes, prefer `npx tsc --noEmit` and `npm run lint`.
- For larger shell or routing changes, add browser-level coverage before production use.

## TypeScript 门禁边界（tsc 覆盖范围）

`npx tsc --noEmit` **只检查根项目**（`tsconfig.json` 的 `files: []` + 引用），
不覆盖 `e2e/`、`e2e-real/` 与 `playwright*.config.ts`。因此：

| 命令                                | 覆盖范围                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------- |
| `npx tsc --noEmit`                  | 仅根项目（等价于 `tsconfig.app.json` 的显式入口，不含 e2e）                     |
| `npx tsc -b`                        | **全量**：`tsconfig.app.json` + `tsconfig.node.json` + `tsconfig.e2e.json`      |
| `tsconfig.e2e.json`（project 引用） | `e2e/**/*.ts`、`e2e-real/**/*.ts`、`playwright*.config.ts`（`types: ["node"]`） |

改动落在 `e2e/` 或 `e2e-real/` 时，必须用 `npx tsc -b` 而不是 `npx tsc --noEmit` 作为门禁，
否则新增的 e2e 代码不会被类型检查（本 PR5 阶段已把 `tsconfig.e2e.json` 加入
`tsconfig.json` 的 `references`，使 `npm run build` / `npx tsc -b` 覆盖 e2e）。

## 专用真实联调（test:e2e:account-real / test:e2e:pr5-real）

入口配置 `playwright.account-settings-real.config.ts` 同时承载两条真实链路，二者共用同一套
专用库 / 专用后端 / 专用前端 / `global-setup`：

- `e2e-real/account-settings-real.spec.ts` —— 账号设置联调，`npm run test:e2e:account-real`（7 用例）；
- `e2e-real/pr5-real-flow.spec.ts` —— PR5 真实权限与业务闭环，`npm run test:e2e:pr5-real`（6 用例）。

配置以 `testMatch` **数组**并列两个文件（目录内另有 vitest 单测，不能被 Playwright 收集），
因此：

- 两个 npm script 均以命令行位置参数只定位自己的文件；
- **不带位置参数**直接 `npx playwright test --config=playwright.account-settings-real.config.ts`
  会一次收集 **2 个文件共 13 个用例**（一套 webServer / `global-setup`，全量串行），
  这是「同源一套证据」的推荐跑法。

该链路会对专用库执行破坏性操作（清空表 → 全量迁移 → Mock Seed），物理清理授权
必须由执行者显式提供，脚本与代码均不设默认值。

前置条件（全部满足才允许运行）：

- 数据库连接五项（`DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASS`/`DB_NAME`）来自进程环境或
  `backend/env/.env.development`（本地文件，不入库），由
  `e2e-real/dedicated-e2e-environment.ts` 一次性解析并校验；
- `DB_NAME` 必须严格等于 `lithography_work_e2e`：专用配置在加载期以「**外部未设置才注入专用值、
  外部值非空且与专用值冲突即硬失败**」写入（不再依赖 npm script 的 `cross-env`），
  且必须早于 `resolveDedicatedE2EDatabase()` 的解析与校验；`E2E_BACKEND_ORIGIN`
  同为该口径（专用后端 `http://127.0.0.1:3100`）。
- 本机 MySQL 中已创建空库 `lithography_work_e2e`（链路只清空表，不创建库）。

**入口边界（本节的自注入仅限本配置；PR4 工程师链路的入口不在此列）**

- 上文「`DB_NAME` / `E2E_BACKEND_ORIGIN` 在配置加载期自注入、不再依赖 npm script 的
  `cross-env`」**只适用于** `playwright.account-settings-real.config.ts` 承载的
  `account-real` 与 `pr5-real`。
- PR4 的工程师真实联调是**另一个入口** `playwright.engineer-repair-request-real.config.ts`
  （`npm run test:e2e:repair-request-real`）：它**不自注入**，仍由 npm script 用 `cross-env`
  注入 `DB_NAME` 与 `E2E_BACKEND_ORIGIN`，因此 `frontend/package.json` 保留 `cross-env` 依赖。
- 两种入口都必须经过 `e2e-real/dedicated-e2e-environment.ts` 的
  `resolveDedicatedE2EDatabase()` 专用库失败关闭校验，均不能绕开隔离库门禁。
- 本轮（PR5 视觉收尾）不改动 PR4 入口，也不删除 `cross-env`。

并发与串行约束：

- `global-setup` 会对专用库加**跨进程执行锁**（`os.tmpdir()` 下的
  `lithography-e2e-<db>.lock`，`O_EXCL` 创建 + `pid` 存活探测，teardown 释放）。
  同一专用库同时只允许一个执行体：并发启动时后到者**硬失败**而非并行清库；
  若上次进程异常退出留下死锁文件，下一次启动会探测到 `pid` 已死并自动接管（仅一次重试）。
- 因此两个入口**不得并行**执行；需要一次拿到两个文件的全量证据时，用上文「不带位置参数」
  的单次串行跑法。

Linux / macOS：

```bash
E2E_ALLOW_PHYSICAL_CLEANUP=1 npm run test:e2e:account-real
```

Windows PowerShell：

```powershell
$env:E2E_ALLOW_PHYSICAL_CLEANUP = "1"
npm run test:e2e:account-real
Remove-Item Env:E2E_ALLOW_PHYSICAL_CLEANUP
```

硬性约束：

- 只能连接专用 `lithography_work_e2e`，不得连接开发库、验收库或真实数据环境；
  配置模块对外部继承的 `MIGRATION_DRILL_DATABASE`（指向其他库）、
  `MIGRATION_DRILL_CREATE_TEMP_DB=true`、`MIGRATION_DRILL_DOTENV`、`SEED_DOTENV`
  一律失败关闭；
- `E2E_ALLOW_PHYSICAL_CLEANUP` 不写入任何 npm script，必须由执行者在启动前显式设置；
- `--list` 只验证入口跨平台可启动，不代表真实联调通过。

## 视觉截图统一入口与局部截图例外登记（PR5 P2-2）

全视口视觉证据截图**必须**经 `e2e/helpers/visual-evidence.ts` 的 `captureStableViewport()`：
其内部依次执行工作区干净断言（P2-1，脏工作区失败关闭，禁止伪关联 SHA）、字体就绪、
滚动复位（`scrollY = 0`）、页头/侧栏品牌可见、有限动画排空、布局稳定，并在截图后
断言 `scrollY === 0` 且无整页横向溢出，返回 `scrollX/scrollY/视口/页面模式/gitSha` 元数据。

机械约束（`eslint.config.js` 的两个 `no-restricted-syntax` 块，`npm run lint` 生效）：

- `e2e/**/*.spec.ts`、`e2e-real/**/*.spec.ts` 禁止直接调用 `page.screenshot()`；
- admin 知识库视觉 spec 按下方登记表放行**带 `clip` 的** `page.screenshot()`（无 `clip` 仍禁止）；
- helper 位于 `e2e/helpers/`（非 spec），是 `page.screenshot` 的唯一收口，不在约束范围；
- 元素级 `locator.screenshot()`（含 ref-lib 搜索框）不被该选择器约束，但仅限下方已登记的
  局部例外，且截图前必须复用 `prepareStableViewport()`（滚动复位 + 布局稳定）。

局部截图例外登记表（新增例外必须先在此登记，再按需在 `eslint.config.js` override 放行）：

| 文件                                         | 截图产物                                      | 类型                                      | 例外理由                                                                                              |
| -------------------------------------------- | --------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `e2e/admin-document-database-visual.spec.ts` | `kb-local-{宽x高}-header/summary/toolbar.png` | 元素截图（`locator.screenshot`）          | 元素 1:1 局部图（物理尺寸 = 元素 CSS 尺寸），供与原型并排人工对照，非全视口证据                       |
| `e2e/admin-document-database-visual.spec.ts` | `kb-local-{宽x高}-thead-first-row.png`        | clip 合成图（`page.screenshot` + `clip`） | 表头 + 一行正文跨元素连续区域；`clip` 由相邻元素 `boundingBox()` 合成，机械约束中唯一放行的 clip 例外 |
| `e2e/reference-library-visual.spec.ts`       | `reference-library-search-filled-*.png`       | 元素截图（`locator.screenshot`）          | 搜索框填充态局部细节图，非全视口证据                                                                  |

以上例外截图前均调用 `prepareStableViewport()`；全视口证据不得以登记表例外替代。
