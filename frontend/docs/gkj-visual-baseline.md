# gkj 共享视觉基准（PR1 修订）

> 本文档是 PR1「公共视觉底座」共享壳的可共享视觉基准，随仓库分发，任何开发者可直接依赖；
> 不依赖本机 `docs/plan` 下的过程文档，也不需要原始需求材料。
>
> - 基准来源：`gkj.html` 原型（仅视觉语言，不含演示业务与假数据）
> - 数值采集：Chromium headless `getComputedStyle` 实测（2026-09-16），原始 JSON 见 PR 证据目录
> - 修订依据：负责人 2026-09-16 Request changes 审查意见
> - 维护约定：**修改共享壳视觉值必须先更新本表**；本文档与实现不一致时以评审裁定为准

## 1. 对照环境锁定

| 项目     | 固定值                                                                          |
| -------- | ------------------------------------------------------------------------------- |
| 原型     | `gkj.html`，默认语言、默认配置、浏览器根字号 16px                               |
| 实现     | 真实 `ThemeProvider` + `AppLayout`，本地字体加载完成，字号档位 M                |
| 视口     | 1440×900、1366×768；同一 OS/浏览器，页面缩放 100%                               |
| 采集方式 | 完整原尺寸截图 + 1:1 局部裁切（不二次缩放）+ computed styles 数值断言           |
| 截图命名 | `{区域}-viewport-{宽}x{高}-scale-{档位}-role-{角色}-zoom-100-{日期}-{时分}.png` |

## 2. M 档（standard）基准数值

M 档的含义：**保留原型字号层级**（导航 12px、胶囊 10px、页头标题 24px、说明 14px），
不是把整站文字设成同一字号。以下数值为原型 computed style 实测值，是实现必须对齐的目标。

### 2.1 根字号

| 项     | 基准     | 说明                                                      |
| ------ | -------- | --------------------------------------------------------- |
| 根字号 | **16px** | M 档根字号必须等于原型基准；不得用 18px 使 rem 值整体放大 |

### 2.2 字号 / 字重 / 行高

| 区域             | fontSize | fontWeight | lineHeight               | color                           |
| ---------------- | -------- | ---------- | ------------------------ | ------------------------------- |
| 品牌主名         | 12px     | 700        | 16px                     | `#1e293b`                       |
| 品牌辅行（大写） | 9px      | **400**    | 13.5px                   | `#64748b`，letter-spacing 0.1em |
| 导航文字         | 12px     | 600        | 1.5                      | `#475569`                       |
| 页头标题         | 24px     | 700        | **32px**                 | `#1e293b`                       |
| 页头说明         | 14px     | 400        | **20px**，上间距 **4px** | `#64748b`                       |
| 状态胶囊         | 10px     | 700        | **1.5**（=15px）         | 按状态，见 2.4                  |
| 头像字符         | 12px     | 800        | 18px                     | `#1d4ed8`                       |

注意：原型「导航次级文字」(#475569) 与「说明/角色文字」(#64748b) 是**两个不同语义**，
实现必须拆分为两个变量，不能共用一个 secondary Token。

### 2.3 布局 / 留白

| 区域             | 基准                                                                                                                                                                                                                                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 侧栏             | 宽 **210px**，背景 `#f8fafc`，右边框 `#cbd5e1`，阴影 `8px 0 24px rgba(15,23,42,.08)`                                                                                                                                                                                                     |
| 品牌区           | padding `20px 48px 20px 20px`，**总高 88px**（右侧 48px 为控件保留区，对应原型 lang-toggle 的 absolute right:8px 区域），底部 1px 分隔线                                                                                                                                                 |
| 导航项           | padding `11px 12px`，行高 **1.5**（M 档 12px/18px，单项总高 40px），图标-文字间距 **10px**，圆角 8px，图标 16×16                                                                                                                                                                         |
| 底部用户区       | 左右内边距 **14px**，**总高 87.5px（min-height）**，背景 `#f8fafc`，上边框 1px 分隔线，头像在内容区垂直居中；字号档位控件为本项目声明式偏差，安置在用户区上方独立行，不占用该几何                                                                                                        |
| 用户卡           | 头像 38×38（radius 12px）与文字间距 **12px**；姓名 12px/700 `#1e293b`；角色 10px `#64748b`                                                                                                                                                                                               |
| 工程师信息条头像 | 复用用户卡同一头像配方（渐变 + `1px #93c5fd` 描边 + 12px 圆角 + 字符 12px/800 `#1d4ed8`），尺寸 **40×40**（原型 `.engineer-strip` 实测）；有真实 `avatarUrl` 才渲染图片，为空或加载失败回落昵称首字                                                                                      |
| 工程师信息条结构 | 横向卡片（对照原型 `.engineer-strip`）：左栏头像 + 昵称 + 角色，右侧「标签 + 值」分栏（标签 8px/800 `#94a3b8` + letter-spacing .12em，值 11px/700 `#334155`），右上角 28×28、radius 8px 设置入口；原型右侧 Position / Access Level / Region / Specialty 无数据契约，栏目数少于原型属预期 |
| 工作区           | 背景 **`linear-gradient(180deg, #f8fafc 0%, #eef2f7 100%)`**，padding `22px 26px 32px`                                                                                                                                                                                                   |
| 内容容器         | 工作区先占剩余宽度；**内层内容 `max-width: 1280px`**（两级容器，不得把 max-width 和 padding 混在同一层）                                                                                                                                                                                 |
| 页头             | 标题行**无下边框、无额外 padding-bottom**；文字块与右侧 extra 间距 **16px**（原型 `gap-4`）；可选 eyebrow（10px/700/0.18em/uppercase/#2563eb）仅工作台页传入                                                                                                                             |

### 2.6 共享组件映射与声明式偏差（负责人 0916 逐条复核裁定）

| 组件                       | 映射与基准                                                                                                                                                                                                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DataCard / TableContainer  | gkj `.panel-card`：半透明白底 `rgba(255,255,255,.92)`、1px `#e2e8f0`、14px 圆角、`0 10px 30px rgba(15,23,42,.06)` 投影                                                                                                                                            |
| StatCard                   | gkj `.metric-tile`：`linear-gradient(180deg,#fff,#f8fbff)`、1px `#dbeafe`、14px 圆角、padding 16px、**无投影**；统计卡片不是普通 panel-card                                                                                                                       |
| StatCard 文字层级          | 标签 `12px/400/#64748b`；数值 `30px/700/36px/#1e293b`；辅助文字 `11px/#94a3b8`、上间距 8px。不得混用原型 `.health-score` 的局部样式。                                                                                                                             |
| FilterBar                  | gkj `.platform-search` 的**容器语言**：底色 `#f8fafc`、1px `#dbe3ee`、10px 圆角、margin `12 0 14`；内含多个 AntD 筛选控件故高度自适应，不强制单框 36px                                                                                                            |
| EmptyState / ErrorState    | gkj `.platform-empty`：`#f8fafc` 底、1px dashed `#cbd5e1`、12px 圆角、padding `22px 14px`、`#94a3b8` 文本（原型源码字号 11px）                                                                                                                                    |
| 单行空态                   | 无说明/操作时采用 `11px/400/#94a3b8` 单行提示；标题+说明+操作为扩展态，不宣称与原型单行提示完全相同。                                                                                                                                                             |
| PageHeader eyebrow         | 可选 API；基准取原型**主壳静态页头** 10px/700/letter-spacing 0.18em/uppercase/#2563eb（`.atta-eyebrow` 的 800/.16em 属生成页另一套语言，不得引用）；仅在原型对应工作台页传入                                                                                      |
| 页头宽度上限（声明式偏差） | `.page-header-content` `max-width: 820px`、`.page-description` `max-width: 760px`：本项目可读性约束，原型无对应约束（逐项核查报告 20260928 §3 第 4、5 项）                                                                                                        |
| 导航项过渡（登记项）       | 原型为 `transition: all .2s ease`；实现收窄为 `background-color/color .2s`，仅缩小过渡属性范围，终态外观一致（不可见差异，逐项核查报告 20260928 §3 末条）                                                                                                         |
| 声明式偏差                 | ① S/M/L 字号档位控件（原型无此功能）：安置在用户区上方独立行；② 折叠导航控件（原型无此功能）：绝对定位于品牌区右侧 48px 保留区，不参与品牌链接 flex 宽度计算，折叠态侧栏宽 **64px**、品牌区仅保留折叠钮；③ 不渲染原型的 Access L4 / Online 演示徽标（假身份红线） |

### 2.4 颜色 / 背景 / 阴影

| 项                           | 基准值                                                                                                                                                                                                                                                                                    |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 主文字（标题/昵称/品牌主名） | `#1e293b`                                                                                                                                                                                                                                                                                 |
| 导航文字                     | `#475569`                                                                                                                                                                                                                                                                                 |
| 说明 / 角色文字              | `#64748b`                                                                                                                                                                                                                                                                                 |
| 导航 hover                   | 背景 `#e5e7eb`，文字 `#111827`                                                                                                                                                                                                                                                            |
| 导航 active                  | 背景 `#dbeafe`，文字 `#1d4ed8`                                                                                                                                                                                                                                                            |
| 工作区背景                   | `linear-gradient(180deg, #f8fafc 0%, #eef2f7 100%)`                                                                                                                                                                                                                                       |
| 用户头像                     | 渐变 `linear-gradient(145deg, #dbeafe, #bfdbfe)`，边框 `1px solid #93c5fd`                                                                                                                                                                                                                |
| 状态胶囊 ok                  | 背景 `#dcfce7`，文字 `#166534`                                                                                                                                                                                                                                                            |
| 状态胶囊 warn                | 背景 `#fef3c7`，文字 `#92400e`                                                                                                                                                                                                                                                            |
| 状态胶囊 critical            | 背景 `#fee2e2`，文字 `#b91c1c`                                                                                                                                                                                                                                                            |
| 公共面板（panel-card）       | 背景 `rgba(255,255,255,.92)`，边框 `1px solid #e2e8f0`，圆角 14px，阴影 `0 10px 30px rgba(15,23,42,.06)`                                                                                                                                                                                  |
| 状态胶囊外形                 | padding `4px 10px`，gap 6px，圆角 999px，letter-spacing 0.02em                                                                                                                                                                                                                            |
| 待接单条目（常态/悬停/选中） | 原型 `.activity-request`：常态 背景 `#f8fafc`；悬停 背景 `#eff6ff` + 边框 `#bfdbfe`；选中 背景 `#eaf2ff` + 边框 `#93c5fd` + 阴影 `0 0 0 2px rgba(59,130,246,.08)`；实现以 `aria-current="true"` 表达选中态                                                                                |
| 申请编号文字                 | `#1d4ed8`（原型 `.request-code`；即 AntD `colorPrimaryActive`，不是 `colorPrimary` `#2563eb`）                                                                                                                                                                                            |
| 中性工具控件文字             | 主搜索输入 12px `#334155`；工具按钮 12px `#475569`；搜索图标 / 占位 / 清除按钮 `#94a3b8`                                                                                                                                                                                                  |
| 快捷入口与信息条设置入口     | 快捷入口原型无对应卡片（声明式偏差）：与待接单条目共用同一组三态交互色与焦点环；信息条设置入口（原型 `.engineer-settings-btn`）常态 背景 `#f8fafc` + 边框 `#e2e8f0` + 图标 `#64748b`，悬停 文字 `#2563eb` + 背景 `#eff6ff` + 边框 `#bfdbfe`（沿用同一组交互色）；两者均仅作用于工程师页面 |

颜色集中管理规则：以上值定义在主题 Token 或受控全局语义变量中，组件只消费变量；
禁止把十六进制色值散落到 JSX；不依赖 AntD 自动派生色「看起来接近」。

AI 对话工作区页面级色板（05，正式路由 `#/engineer/ai/chat`；V44 实测，仅 05 局部消费）：

| Token                            | Light       | Dark        | 用途                                                                                |
| -------------------------------- | ----------- | ----------- | ----------------------------------------------------------------------------------- |
| `--ai-message-bg`                | `#ffffff`   | `#1e2b3e`   | AI 回答气泡背景                                                                     |
| `--ai-message-line`              | `#e0e8f2`   | `#33445f`   | AI 回答气泡边框                                                                     |
| `--ai-message-mine-bg`           | `#e6efff`   | `#223a5c`   | 用户提问气泡背景（V44 实测）                                                        |
| `--ai-message-mine-line`         | `#dae7ff`   | `#33507a`   | 用户提问气泡边框（V44 实测）                                                        |
| `--ai-panel-header-bg`           | `#ffffff`   | `#1e2b3e`   | 对话面板页头背景（暗色复用回答气泡背景，不新造色值）                                |
| `--ai-compose-bg`                | `#ffffff`   | `#1a2536`   | 输入区背景                                                                          |
| `--ai-scene-bg-start`            | `#f4f8fb`   | `#22304a`   | 场景区径向渐变起点（V44 `.ai36-shell .ai33-scene` 实测 5% 色标）                    |
| `--ai-scene-bg-mid`              | `#e8eff5`   | `#1a2536`   | 场景区径向渐变中点（V44 实测 65% 色标；暗色由起止色插值）                           |
| `--ai-scene-bg-end`              | `#dfe7ef`   | `#101722`   | 场景区径向渐变终点（V44 实测 100% 色标）                                            |
| `--ai-input-line`                | `#c9d7e6`   | `#2f4462`   | 输入框描边（V44 `.ai36-shell .ai33-compose textarea` 实测）                         |
| `--ai-input-bg`                  | `#fbfdff`   | `#141d2b`   | 输入框底色（V44 实测）                                                              |
| `--ai-failure-bg`                | `#fff2f0`   | `#3a1f22`   | 失败轮提示块背景（AntD errorBg 同语义）                                             |
| `--ai-failure-line`              | `#ffccc7`   | `#6b3237`   | 失败轮提示块边框（AntD errorBorder 同语义）                                         |
| `--ai-fault-card-bg`             | `#252d3e`   | `#1b2434`   | 故障定位短卡底色（V44 `.ai39-card` 实测）                                           |
| `--ai-fault-card-text`           | `#f5f8ff`   | `#e6ecf8`   | 故障定位短卡正文色（V44 实测）                                                      |
| `--ai-geo-part-normal-top`       | `#334458`   | `#46566b`   | 部件正常态顶面色（V44 原型 `colors.NORMAL[0]`）                                     |
| `--ai-geo-part-normal-side-a`    | `#1c293a`   | `#334052`   | 部件正常态奇数侧面色（V44 原型 `colors.NORMAL[1]`）                                 |
| `--ai-geo-part-normal-side-b`    | `#26374a`   | `#3d4b5e`   | 部件正常态偶数侧面色（V44 原型 `colors.NORMAL[2]`）                                 |
| `--ai-geo-part-highlight-top`    | `#158bb6`   | `#2aa1cf`   | 部件高亮态顶面色（V44 原型 `colors.HIGHLIGHT[0]`）                                  |
| `--ai-geo-part-highlight-side-a` | `#145e83`   | `#1d7ea6`   | 部件高亮态奇数侧面色（V44 原型 `colors.HIGHLIGHT[1]`）                              |
| `--ai-geo-part-highlight-side-b` | `#176f97`   | `#248fb9`   | 部件高亮态偶数侧面色（V44 原型 `colors.HIGHLIGHT[2]`）                              |
| `--ai-geo-part-warning-top`      | `#d99436`   | `#e0a04a`   | 部件警示态顶面色（V44 原型 `colors.WARNING[0]`）                                    |
| `--ai-geo-part-warning-side-a`   | `#91521b`   | `#a8711f`   | 部件警示态奇数侧面色（V44 原型 `colors.WARNING[1]`）                                |
| `--ai-geo-part-warning-side-b`   | `#b87223`   | `#c48830`   | 部件警示态偶数侧面色（V44 原型 `colors.WARNING[2]`）                                |
| `--ai-geo-part-fault-top`        | `#e86066`   | `#f07a80`   | 部件故障态顶面色（V44 原型 `colors.FAULT[0]`）                                      |
| `--ai-geo-part-fault-side-a`     | `#882f45`   | `#a93f4d`   | 部件故障态奇数侧面色（V44 原型 `colors.FAULT[1]`）                                  |
| `--ai-geo-part-fault-side-b`     | `#b33b50`   | `#cc5a61`   | 部件故障态偶数侧面色（V44 原型 `colors.FAULT[2]`）                                  |
| `--ai-geo-part-hidden`           | `#cbd5e1`   | `#3c4757`   | 隐藏部件面色（原型无对应档，沿用既有中性灰）                                        |
| `--ai-geo-outline`               | `#50869d`   | `#6f9bb0`   | 几何面片常规描边（V44 原型默认描边色）                                              |
| `--ai-geo-outline-warning`       | `#ffcd77`   | `#ffd68f`   | 警示态面片描边（V44 原型同值）                                                      |
| `--ai-geo-outline-fault`         | `#ff9aa1`   | `#ffb3b6`   | 故障态面片描边（V44 原型同值）                                                      |
| `--ai-geo-base-top`              | `#3b495d`   | `#47576c`   | 底座顶面色（V44 原型 `colors.BASE[0]`）                                             |
| `--ai-geo-base-side-a`           | `#283449`   | `#334052`   | 底座奇数侧面色（V44 原型 `colors.BASE[1]`）                                         |
| `--ai-geo-base-side-b`           | `#303e52`   | `#3d4c60`   | 底座偶数侧面色（V44 原型 `colors.BASE[2]`）                                         |
| `--ai-geo-grid`                  | `#65c9e7`   | `#7ad3ec`   | 场景技术网格线（V44 原型同值）                                                      |
| `--ai-geo-scan`                  | `#41ccef`   | `#62d4f5`   | 扫描脉冲线（V44 原型同值）                                                          |
| `--ai-geo-hatch`                 | `#65c9e754` | `#65c9e73d` | 面片斜向网格线（V44 原型 `#65c9e754` 同色低透明度）                                 |
| `--ai-geo-hatch-warning`         | `#ffcb7a80` | `#ffcb7a80` | 警示态面片斜线（V44 原型 `#ffcb7a80`）                                              |
| `--ai-geo-hatch-fault`           | `#ffc0c785` | `#ffc0c785` | 故障态面片斜线（V44 原型 `#ffc0c785`）                                              |
| `--ai-geo-hover-fill`            | `#73caff38` | `#73caff38` | 悬停高亮叠加填充（V44 原型同值）                                                    |
| `--ai-geo-outline-hover`         | `#91e0ff`   | `#91e0ff`   | 悬停高亮描边（V44 原型同值）                                                        |
| `--ai-ink`                       | `#19283e`   | `#e6ecf8`   | AI 工作区标题与正文墨色（V44 原型 `--ai-ink`）                                      |
| `--ai-muted`                     | `#5b6d84`   | `#9fb0c6`   | AI 工作区次要文字色（V44 原型 `--ai-muted`）                                        |
| `--ai-blue`                      | `#205bce`   | `#6fb6ef`   | AI 工作区强调蓝（V44 原型 `--ai-blue`）                                             |
| `--ai-accent`                    | `#245ed0`   | `#4f8ef0`   | AI 工作区主操作色（V44 原型 `--ai-accent`）                                         |
| `--ai-hover`                     | `#edf3fd`   | `#223a5c`   | AI 工作区选中/悬停底色（V44 原型 `--ai-hover`）                                     |
| `--ai-white`                     | `#ffffff`   | `#1a2536`   | AI 工作区面板白底（V44 原型 `--ai-white`）                                          |
| `--ai-nav-hover-bg`              | `#e7effe`   | `#223a5c`   | AI 局部导航悬停底色（V44 原型 `.ai36-shell .ai34-nav a:hover`）                     |
| `--ai-select-line`               | `#c9d7e6`   | `#2f4462`   | AI 场景/面板下拉描边（V44 原型 `.ai36-shell .ai33-workspace select`）               |
| `--ai-select-arrow`              | `#536c89`   | `#9fb0c6`   | AI 下拉右侧双三角箭头色（V44 原型 `.ai36-shell .ai33-workspace select` 渐变端点色） |
| `--ai-btn-line`                  | `#d4e0ed`   | `#2f4462`   | AI 工作区次要按钮描边（V44 原型 `.ai36-shell .ai33-workspace button`）              |
| `--ai-btn-ink`                   | `#254264`   | `#c6d4e6`   | AI 工作区次要按钮文字色（V44 原型同上）                                             |
| `--ai-btn-hover-bg`              | `#edf4ff`   | `#1b2739`   | AI 工作区次要按钮悬停底色（V44 原型同上）                                           |
| `--ai-btn-hover-line`            | `#8dafeb`   | `#729be3`   | AI 工作区次要按钮悬停描边（V44 原型同上）                                           |
| `--ai-btn-active-bg`             | `#dbe8fc`   | `#16202f`   | AI 工作区次要按钮按下底色（V44 原型同上）                                           |
| `--ai-accent-hover`              | `#174fbf`   | `#3f7ae0`   | AI 主按钮悬停底色（V44 原型 `button.ai33-send:hover`）                              |
| `--ai-accent-active`             | `#123d99`   | `#2f63b8`   | AI 主按钮按下底色（V44 原型 `button.ai33-send:active`）                             |
| `--ai-btn-disabled-bg`           | `#e7edf5`   | `#1b2739`   | AI 主按钮禁用底色（V44 原型 `button.ai33-send:disabled`）                           |
| `--ai-btn-disabled-ink`          | `#63738b`   | `#6b7f96`   | AI 主按钮禁用文字色（V44 原型同上）                                                 |
| `--ai-geo-hover-fill`            | `#73caff38` | `#73caff38` | 几何部件悬停高亮填充（V44 原型同值）                                                |
| `--ai-geo-outline-hover`         | `#91e0ff`   | `#91e0ff`   | 几何部件悬停高亮描边（V44 原型同值）                                                |

同族新增色值必须先在本表登记，再登记到 `scripts/lint-colors.mjs` 的受控 token 集合；
组件侧只允许 `var(--ai-*)`，不得直接写字面色值。

### 2.5 图标规范

| 项       | 基准                                                                                                                                                             |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 品牌标志 | 32×32px、背景 `#1e293b`、圆角 8px、白色字母标记；真实项目名称保留，不伪造演示名                                                                                  |
| 导航图标 | 16×16px 描边 SVG：`viewBox="0 0 24 24"`、`stroke-width="2"`、round linecap/linejoin、`stroke="currentColor"`；原型已有对应路径直接提取，新增入口沿用同一描边规范 |

禁止项：不补造原型中的虚构信息（L4 权限、Online、未读数、语言切换、假业务入口）。

## 3. S / L 字号缩放规则

- 基准：M 档（根字号 16px，即原型默认层级）。
- 规则：S / L 以 M 为基准按**统一比例**缩放根字号与 AntD fontSize，不得使用 CSS `zoom` / `transform` 整页缩放。
- 约定比例：S = M × 0.875（根 14px / antd 12）；L = M × 1.125（根 18px / antd 16）。
  已浏览器验证：AntD fontSize 实际为 S/M/L = 12/14/16px，根字号为 14/16/18px；
  固定 px 文本以 rem 表达，随根字号按同比例变动。
- 行为要求：选择持久化；无历史设置默认 M；S → M → L → M 往返后 M 恢复第 2 节数值；
  固定 px 文本（导航、品牌、胶囊、页头等）通过语义字号变量或 rem 接入同一调节机制，
  原生 CSS 文本与 AntD 控件同步变化；L 档不得出现遮挡或不可达的导航/退出入口。

## 4. 变量作用域约定（已知陷阱）

`:root` 中**不得**定义依赖 AntD CSS 变量的别名（如 `--workspace-bg: var(--ant-color-bg-layout)`）——
`app-theme` class 挂在 `.app-shell` 后代上，自定义属性在定义元素处解析后向下继承，
根节点读不到 AntD 变量，别名会静默失效（工作区/胶囊背景变 transparent）。

正确做法：

- 不依赖 AntD 的原型语义常量 → 受控全局语义变量区（`:root` 可用）；
- 依赖 AntD 派生值的别名 → 定义在真正拥有 `app-theme` class 的作用域，或组件直接消费 AntD 变量；
- 禁止用「每个业务组件手动复制 app-theme class」补洞。

验收必须读真实浏览器 computed style：工作区 `background-image` 含线性渐变；
ok/warn/critical 三种胶囊 `background-color` 均非 transparent。仅断言 className / Token 配置不够。

## 5. 证据环境

- 浏览器：Chromium（Playwright headless），OS：WSL2 Ubuntu 24.04；
- 实现：生产构建（`npm run build` + `vite preview`，含 `/graphql` 代理），真实登录（Mock 种子账号，密码不入库）；
- 字号档位：M（根字号 16px，与原型基准一致；修订前 18px 根的差异已修复并在 2.1 标注）；
- 原始 computed styles JSON 与按命名规范的截图（原图 + 1:1 局部裁切）见 PR 证据目录
  `docs/tmp/PR/PR1-证据-20260916-S0/`（S0 基线，双侧 × 双视口）。

## 6. 知识库页面级变体（PR3 R7）

> 原型对照节点：`gkj.html` 的 `#knowledge-base-page` / `.kb-card` / `.kb-table`。
> 它与第 2 节的 `.workspace-page` / `.panel-card` / `.platform-search` 通用工作台基准是
> **两套视觉语言**，不得混用；本节是两套基准的切换说明，不是对第 2 节的修改。
>
> **自动化真源（第三轮 Review S1 起）**：`e2e/admin-document-database-visual.spec.ts`
> 为无后端确定性视觉验收（GraphQL 走仓库内 mock，会话预置），数值基准以本节 +
> spec 内 `KB_BASELINE` 常量为入库真源；自动化**不在运行时读取原型文件、不访问远程
> CDN**。原型并排对照仅作为可选人工流程：在相同视口与 M 档下，将实现截图与本地原型
> `#knowledge-base-page` 并排核对（本文件不随附原型文件）。
>
> 适用范围：`/admin/document-database` 全量消费本节基准。开启方式：AppLayout 按**精确路由**加
> `.app-workspace--knowledge-base` / `.app-main--knowledge-base` modifier（不用前缀匹配），
> 页面内消费 `.kb-*` opt-in 类与 `--kb-*` 变量。其他页面一律保持第 1–4 节基准。
>
> 例外（PR4 收口）：工具区控件（主搜索 / 工具按钮）已提取为跨页共享中性原语
> `shared/ui/toolbar-controls`，外观值见 2.4「中性工具控件文字」；工程师维修申请列表直接
> 消费中性组件，知识库页由 `shared/ui/knowledge-base` 薄包装追加 `.kb-*` 覆盖层。
> 两处当前渲染结果相同，日后若分叉必须同步更新本节与 2.4，不得只改一边；
> `.kb-*` 类的适用范围仅限 `/admin/document-database`；`--kb-*` 变量另见下方紧凑控件白名单。
>
> **紧凑控件作用域白名单（本节为唯一登记处，PR5 S3-1 起；PR5 R1/R2 补全）**：`/reference-documents`
> （列表与详情）以**窄作用域**消费本节「紧凑几何 + `--kb-*` 受控变量」的**同一份定义**——
> 直接消费 `shared/ui/toolbar-controls` 的中性组件（DOM 保留中性基类），并传入
> `.reference-library-*` 页面作用域覆盖层类；不引入 `.kb-*` 壳类、也不加 workspace / page modifier。
> 允许的作用域类为：
>
> | 用途                  | 独立资料页（白名单）                                                                    | 与知识库页共用同一条 CSS 规则                                |
> | --------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
> | 卡壳                  | `.reference-library-card .ant-card`（祖先作用域，消费卡壳 token；替代 `.kb-card` 外壳） | 同一套 `--kb-card-*` token（`.kb-card`）                     |
> | 列表容器              | `.reference-library-list-body`、`.reference-library-card .ant-card-body`                | 独立页专属（知识库由 `.kb-card` 外壳直接承载，无 AntD Card） |
> | 工具区                | `.reference-library-toolbar`                                                            | 同几何（`.kb-toolbar`）                                      |
> | 主搜索框              | `.reference-library-search`                                                             | `.kb-search`                                                 |
> | 清除按钮              | `.reference-library-search-clear`                                                       | `.kb-search-clear`                                           |
> | 工具按钮（筛选/重置） | `.reference-library-toolbar-button`（`--active` 同源）                                  | `.kb-toolbar-button`（`--active`）                           |
> | 筛选展开区            | `.reference-library-filter-panel`（默认收起，由工具按钮展开）                           | `.kb-filter-panel`                                           |
> | 表格作用域            | `.reference-library-table-scope`（含表格顶角归零）                                      | `.kb-table-scope`                                            |
> | 卡底分页行            | `.reference-library-card-footer`                                                        | `.kb-card-footer`                                            |
> | 卡内状态区            | `.reference-library-card-state`                                                         | `.kb-card-state`                                             |
>
> 新增第三个作用域前缀前，必须先在本表登记，并同步 `src/index.css` 的成对规则与
> `scripts/lint-colors.mjs` 的 `--kb-*` 白名单；未登记前缀一律按越界处理。
> 除 `/admin/document-database`（知识库页）、`/reference-documents` **精确列表路由**
> （见 6.6）与上述白名单外，其他页面一律保持第 1–4 节基准。

### 6.1 工作区与页面节奏

| 项         | 基准                                                                                               |
| ---------- | -------------------------------------------------------------------------------------------------- |
| 工作区背景 | **纯色 `#f3f4f6`**（非渐变）                                                                       |
| 工作区留白 | `22px 26px 32px`（与通用相同）                                                                     |
| 内容宽度   | **占满侧栏后剩余区域（`max-width: none`）**；1920 下不得再居中回 1280px                            |
| 页面节奏   | 页头下距 20px（`mb-5`），汇总条下距 16px（`mb-4`）                                                 |
| 知识库卡   | 白底 `#ffffff`、1px `#e5e7eb`、**10px** 圆角、`0 1px 3px rgba(15,23,42,.05)`；外壳不额外加 padding |

### 6.2 页头（与第 2.2 节通用层级不同）

| 区域    | fontSize | fontWeight | lineHeight | 其他                                                      |
| ------- | -------- | ---------- | ---------- | --------------------------------------------------------- |
| eyebrow | 10px     | **700**    | 15px       | letter-spacing **0.18em**、uppercase、`#2563eb`、下距 4px |
| 标题    | **20px** | 700        | **28px**   | `#1e293b`                                                 |
| 说明    | **12px** | 400        | **16px**   | `#64748b`、上距 4px；文案面向使用者，不暴露实现细节       |

### 6.3 汇总条 / 工具区 / 紧凑表格 / 分页

| 区域       | 基准                                                                                                                                                                                                                                                                                                             |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 汇总条     | 单卡内四分区 grid（业务四类真实统计，原型三分区为演示元数据属登记偏差）；相邻分区 1px `#f1f5f9` 竖分隔；每分区 padding 16px；总高约 **67.5px**（label/value 行高 1.5）                                                                                                                                           |
| 汇总字级   | 标签 9px/uppercase/0.05em/`#94a3b8`；数值 12px/600/`#334155`、上距 4px、行高 1.5                                                                                                                                                                                                                                 |
| 工具区     | 与表格同卡；padding 12px、下边线 1px `#f1f5f9`、内部 gap 8px；总高约 **61px**                                                                                                                                                                                                                                    |
| 主搜索框   | 高 **36px**、圆角 **6px**、底 `#f8fafc`、边框 1px `#e2e8f0`、左右 padding 12px；图标 16×16 描边 SVG（stroke 2、round、`#94a3b8`、右距 8px）；输入文字 12/16 `#334155`                                                                                                                                            |
| 工具按钮   | 高 36px、圆角 6px、白底、边框 1px `#e2e8f0`、文字 12px `#475569`                                                                                                                                                                                                                                                 |
| 紧凑表格   | 正文 11px/1.5 `#334155`；表头 10px/1.5/600 `#64748b`、底 `#f8fafc`、下边线 1px `#e5e7eb`、`white-space: nowrap`；th/td 水平 padding `9px`；**表头高 35.5px、正文行高 38.5px（原型实测，固定高度 + 垂直居中承载块向间距，`StatusPill`/`size="small"` 按钮不再撑高行盒）**；行线 1px `#f1f5f9`；行 hover `#f8fbff` |
| 分页/底行  | padding `12px 16px`、10px `#94a3b8`、两端对齐                                                                                                                                                                                                                                                                    |
| 表格作用域 | 经 `.kb-table-scope` 后代选择器覆盖该卡内 AntD Table；**禁止全局覆盖 `.table-container` / `.ant-table`**                                                                                                                                                                                                         |

字号与间距以 rem 表达（10px=0.625rem、11px=0.6875rem、36px=2.25rem、10px 9px=0.625rem
0.5625rem 等），随 S/M/L 根字号同比例缩放（与第 3 节一致）；圆角、边框、阴影保持固定 px。
新颜色一律走 `--kb-*` 受控变量（`index.css :root`），组件不散落 raw hex/rgb。

### 6.4 声明式偏差与不复制项

1. 四 Tab（参考资料 / 维修申请 / AI 会话 / AI 报告）与四项真实统计是本项目业务要求，
   为有依据的必要偏差；四个 Tab 统一使用知识库字级 / 色彩紧凑化，不复制原型不存在的假功能。
2. 不复制原型非激活进度条占位的 48.5px、向量化 / 检索开关、分块数、批量操作与演示假数据。
3. 本页新增写操作仅沿用既有参考资料管理权限（仅默认 Tab 右上入口）；三个只读 Tab 不新增写能力。
4. 必要横滚只允许发生在表格内部（`.ant-table-content`），不得整页横滚、不得删字段。
5. 独立资料页（`/reference-documents`）与知识库页共用同一套卡壳（白底 / 1px `#e5e7eb` /
   10px 圆角 / `0 1px 3px rgba(15,23,42,.05)` / `overflow:hidden`，卡内 AntD Table 顶角归零）、
   紧凑表格与卡底分页语言；差异项：①筛选区**默认收起**（原型知识库无展开态，属业务扩展：
   主搜索之外的文档类型 / 设备型号条件，由工具区「筛选」按钮展开，收起不清值）；
   ②卡底分页行自 PR5 整页视觉计划（20260929，见 6.6）起收敛为 **39px**（7.5px 上下 padding
   承载 AntD 紧凑分页器 24px 行高），与原型实测一致，24px 点击目标不压缩。

### 6.5 按钮半径规则（全局，第三轮 Review S2 定 rules）

原型按钮半径实测：主按钮 `rounded-lg`=**8px**、工具区/搜索等紧凑控件 `rounded-md`=**6px**、
状态胶囊 `rounded-full`=**999px**、知识库卡 **10px**。禁止依赖 AntD 默认值或散落魔法数，
语义统一消费 Token/变量，两处镜像必须同步修改：

| 语义                                                    | 值    | AntD 侧（src/app/theme/index.ts） | 原生 CSS 侧（index.css `:root`）       |
| ------------------------------------------------------- | ----- | --------------------------------- | -------------------------------------- |
| 页面主要动作（主按钮）                                  | 8px   | `token.borderRadius`              | `--radius-action`                      |
| 搜索/筛选/表格操作/弹窗动作等紧凑控件（`size="small"`） | 6px   | `token.borderRadiusSM`            | `--radius-control`                     |
| 状态胶囊                                                | 999px | —                                 | `--radius-pill`（`.status-pill` 消费） |
| 知识库卡                                                | 10px  | —                                 | `--kb-card-radius`                     |

自动化断言：`e2e/admin-document-database-visual.spec.ts` 机械校验主按钮 8px、
搜索框/工具按钮 6px、状态胶囊 999px 与卡片 10px 的 computed style；四个 Tab 的表格内
操作按钮、列表失败态「重试」与 Drawer 弹层「重试」（均为 `size="small"`）按 6px 断言，
主按钮按 8px 断言（第三轮修复补齐 Drawer / 重试 / 各 Tab 覆盖）。

### 6.6 参考资料精确列表路由的整页骨架（PR5 整页视觉计划，20260929）

范围变更：本轮把 `/reference-documents` **精确列表路由**的验收从「表格局部一致」升级为
「整页骨架对齐 `gkj.html#knowledge-base-page`」。它替代旧结论「独立资料页必须保持通用渐变
工作区与默认 PageHeader」，但不改变其权限、数据契约与「禁止假字段」结论。

实现方式（类名与知识库页严格隔离，取值同源）：

| 落点         | 参考资料列表精确路由                         | 知识库页（6.1–6.3）                           |
| ------------ | -------------------------------------------- | --------------------------------------------- |
| 工作区变体   | `.app-workspace--reference-library`          | `.app-workspace--knowledge-base`              |
| 内容宽度变体 | `.app-main--reference-library`               | `.app-main--knowledge-base`                   |
| 页面根       | `.reference-library-page`                    | `.kb-page`                                    |
| 页头变体     | `.page-header--reference-library`            | `.page-header--kb`                            |
| 汇总条       | `.reference-library-summary`（三列真实统计） | `.kb-summary`（四分区真实统计）               |
| 顶部节奏     | `--reference-library-top-rhythm: 48.5px`     | 原型进度宿主 48.5px（本项目不复制假进度 DOM） |

数值契约（1440×900，M 档 / 16px 根字号，100% 缩放）：

| 项         | 目标值                                     | 说明                                                        |
| ---------- | ------------------------------------------ | ----------------------------------------------------------- |
| 页头 top   | `70.5±0.5px`                               | 22（工作区顶距）+ 48.5（顶部节奏，仅 >1024px）              |
| 页头高度   | `67px`                                     | eyebrow 15 + 下距 4 + 标题 28 + 说明(4 + 16)                |
| 页头下距   | `20px`                                     | 显式 `margin-bottom`，页面根 `gap: 0` 覆盖通用 `page-stack` |
| 汇总条 top | `157.5px`                                  | 70.5 + 67 + 20                                              |
| 汇总条高度 | `67.5px`（border-box）                     | 三列三等分、单元 padding 16px、列间 1px `#f1f5f9` 竖分隔    |
| 汇总条下距 | `16px`                                     |                                                             |
| 列表卡 top | `241±0.5px`                                | 22 + 48.5 + 67 + 20 + 67.5 + 16                             |
| 工作区背景 | 纯色 `#f3f4f6`（`background-image: none`） | 取消通用渐变                                                |
| 内容几何   | 左边界固定 236px；宽度 = 视口 − 262px      | 1920 → x236 / w1658，不再居中回 1280px                      |
| 卡底分页行 | `39px`（padding `7.5px 16px`）             | 保留 24px 真实分页器点击目标，不压缩                        |

汇总条取值出处（禁止固定数字与演示字段）：参考资料 = 列表状态机 `state.total`；
支持类型 = 后端契约枚举 `REFERENCE_DOCUMENT_TYPE_LABELS`；适用型号 =
`useReferenceEquipmentModels()` 的真实型号条数（loading / failed 显示对应状态）。
均复用列表组件已取得的现有状态源，**不新增第二次请求**，不引入 Embedding Model、向量化、
分块数、参与检索、Batch Actions、L4/Online 等无业务支持内容。

登记偏差（不作为失败）：

1. 搜索框宽度由真实按钮数量决定（原型含 Batch Actions，本项目无批量业务），保持 `flex: 1`，
   不得硬编码原型 977px；
2. 表格保留七列真实后端字段（原型十列为演示字段），只比较密度、边线、ellipsis 与内部横滚；
3. 右下角 AI 浮动入口属全局真实能力（原型知识库页无此入口），保留；375px 下需确认不遮挡
   分页与关键操作；
4. 375×667 不复制桌面 48.5px 节奏与原型「窄屏仍占 210px 侧栏」的不可用行为：保留 64px 折叠
   侧栏、工作区自身 30px 顶距，汇总条改单列堆叠（竖分隔线换横分隔线）。

自动化断言：`e2e/reference-library-visual.spec.ts`（整页坐标 / 汇总条 / 卡底 39px /
1366×768、1440×900、1920×1080、375×667 四视口无整页横滚）、
`src/pages/reference-documents/index.spec.tsx` 与
`src/features/reference-document/ui/reference-document-list.spec.tsx`（变体落点与四态取值）、
`src/app/layout/app-layout.spec.tsx`（精确列表路由 modifier，新增 / 详情不继承）、
`e2e/admin-document-database-visual.spec.ts`「共享外观回归」（该页不再断言渐变 + 1280px，
改断言自身变体齐备且知识库变体节点为 0）。
