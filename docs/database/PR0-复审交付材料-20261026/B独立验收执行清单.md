# B 独立验收执行清单

更新：2026-10-28。本清单针对 A01/A04 修复后的当前候选。**只使用 A 后续实际提交并推送、双方明确约定的新完整 SHA。不要用 d4535bc、f39a8f9 或其他修复前提交单独运行本轮完整 core。** 本轮代码与证据已提交推送 `853cda382f466ab6ca09c2564f12fa1f04dcbd08`；后续正文/交接修订以PR实际最新head及交付消息为准。旧f39a8f9仅是此前审查基准，不包含这些修复。

最新执行与证据见[本轮收尾执行回执](../PR0-B审查core清理安全修复计划-20261026/A01-A04交付收尾与KEEP补证执行回执-20261028.md)。旧 622 项两轮等记录保留为历史；当前已知测试清单为 **48 规格/625 项**，实际结果以新回执和新 SHA 为准。A 的结果不能代签 B。

## 1. 版本、运行平台和安全环境

- 核对 `git rev-parse HEAD` 与 A 提供的新完整 SHA 一致；没有改变运行结果的本地源码改动。Node 使用仓库 `.nvmrc`，当前 22.19.0；按 lock 安装依赖。
- 受控启动器读取 Linux `/proc/<pid>/cmdline`，当前执行路径为 **Linux 或 WSL**。原生 Windows/PowerShell 不能直接提供这项进程事实；前端 Windows CI 通过也不能证明后端启动器原生 Windows 可运行。
- 使用 B 自己明确可丢弃的独占 MySQL/Redis，绑定回环地址和非默认端口；禁止访问共享/保留库、B 故障现场和甲方真实资料。
- 服务实例目录位于源码仓库之外。需要无私人 env 的副本时，建议 `<验收根目录>/source/backend` 放代码，MySQL/Redis 数据放同根目录的独立子目录；实例根目录不要落在 `source/` 内。不要复制私人 `backend/env/`、上传或数据库文件。
- 完整运行只使用下面的显式配置，不要求存在 `backend/env/.env.e2e`。所有秘密用 B 本机临时合成值，不提交、不索取 A 的密钥。
- 当前仅运行 core 及已明确的本地定向规格，不选 smoke 或 `99-third-party-live-smoke`。这是约定使用范围，不能宣称启动器已经实现参数自动白名单（A02 后续）。只读预检关闭诊断增强 A03 也未实现。

## 2. 首次空库与旧库升级分开

旧库按[正式增量升级说明](../增量升级操作说明-20261026.md)执行：确认目标/停写/备份 → status → run → verify → 再 run。确认 14→24、二次执行 0、原正文/文件引用/软删及回填保留。未升级的旧前缀 verify 非零可能是预期，不能要求先完整 verify 才 run。

首次空库使用项目首次建库路径；正式增量入口没有历史时拒绝是安全行为。空库初始化命令具有清表副作用，只能用于刚新建且明确可丢弃的空目标。`lithography_e2e` 不含 test/drill/ci，项目 drill 要求另作显式目标确认；不得把该确认复制到保留库，也不代表允许运行其他破坏性专项。

保留旧数据的升级副本不用于完整 core；另建可丢弃 E2E 环境。以下默认门禁不运行 Seed、31 项破坏性迁移实库专项或真实外部服务。已有 B 旧库验收事实保留，不重复冒签。

## 3. 准备完整显式配置

先准备自己实例和当前结构。以下操作在 Linux/WSL 的 `backend/` 目录，用新建仓库外目录保存配置；占位符必须替换为自己实例事实。

```bash
b_accept_dir=$(mktemp -d /tmp/pr0-b-acceptance.XXXXXX)
b_config="$b_accept_dir/acceptance.env"
cat > "$b_config" <<'EOF'
DB_HOST=127.0.0.1
DB_PORT=<独占端口，不能为3306>
DB_USER=<测试用户>
DB_PASS=<密码，可为空>
DB_NAME=lithography_e2e
DB_SYNCHRONIZE=false
DB_TIMEZONE=+08:00
DB_POOL_SIZE=10
DB_LOGGING=false
REDIS_HOST=127.0.0.1
REDIS_PORT=<独占端口，不能为6379>
REDIS_DB=<专用逻辑库，0..15>
REDIS_PASSWORD=<可为空>
REDIS_TLS=false
E2E_SKIP_DB_CLEANUP=true
E2E_ALLOW_DB_CLEANUP=0
E2E_ALLOW_PHYSICAL_CLEANUP=1
E2E_ALLOWED_DB_NAMES=lithography_e2e
ACCEPTANCE_INSTANCE_ROOT=<仓库外的实例专用目录>
ACCEPTANCE_MYSQL_DATA_DIR=<实际@@datadir，须在实例目录内>
ACCEPTANCE_MYSQL_PID=<本实例mysqld进程PID>
ACCEPTANCE_MYSQL_SERVER_UUID=<实际@@server_uuid>
ACCEPTANCE_REDIS_PID=<本实例redis进程PID>
ACCEPTANCE_REDIS_RUN_ID=<实际INFO server中的run_id>
JWT_SECRET=<本机临时合成非空值>
PAGINATION_HMAC_SECRET=<本机临时合成非空值>
FIELD_ENCRYPTION_KEY=<本机临时合成16个ASCII字符>
FIELD_ENCRYPTION_IV=<本机临时合成16个ASCII字符>
AI_PROVIDER_MODE=mock
EOF
chmod 600 "$b_config"
```

若使用回执附录的 KEEP 脚本，把**同一份配置**保存为该脚本目录的 `acceptance.env`；`b_config` 也指向这份文件，不能种数和 core 各用一份配置。

MySQL 实例事实可以在确认的端口查询 `SELECT @@port, @@datadir, @@server_uuid`；Redis 查询 `INFO server`。不要仅凭端口/名字声称归属，PID 与实例数据目录都要匹配。父终端若有冲突的 DB/Redis 值，用新的干净终端，不关闭守卫或绕过启动器。

## 4. 预置非夹具 KEEP，然后完整 core 一轮

1. 先执行只读预检，确认 `PR0_ACCEPT_PRECHECK=ok`，实例事实与配置相符。失败即停。
2. 在 B 自己的可丢弃环境预置合成非夹具 KEEP，保存运行前逐字段/文件摘要；使用[收尾回执附录](../PR0-B审查core清理安全修复计划-20261026/A01-A04交付收尾与KEEP补证执行回执-20261028.md)中的可复制核验脚本或等效方法。不得在真实保留库试验。脚本要求干净的当前结构，已有不明数据就停止。
3. KEEP 至少覆盖账号、含可解密 meta_digest 的 user_info、组织+成员、停用机型、软删申请+工程师回复、验证记录、第三方绑定、软删资料+文件引用；另保留文件哨兵。资料/申请软删、机型停用，以免改变正常列表测试的业务预期。
4. 通过受控入口运行一次完整 core，并同轮导出样例；随后只读核对所有 KEEP/文件不变与正常夹具零残留。

```bash
(
  set -e
  node test/run-pr0-acceptance.js --config "$b_config" --phase preflight-only
  # 此处先完成第2步 KEEP 预置和运行前快照，再运行下面命令。
  node test/run-pr0-acceptance.js --config "$b_config" core --samples-out "$b_accept_dir/s7-samples.json"
  node -e 'const fs=require("node:fs"); const rows=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(!Array.isArray(rows)||rows.length!==39) throw new Error("应有39条样例"); console.log("样例数量39");' "$b_accept_dir/s7-samples.json"
  # 此处执行 KEEP 前后比较及夹具/文件残留核验；不以手动清库凑零。
)
```

**不是默认双跑。** 仅在发现新失败、候选变化或缺少必要命题证据时按影响补跑；完整 core 已包括两条业务样例链，不再为同一次签收重复执行。

## 5. 从 Windows 进入同一 WSL 路径

在 PowerShell 先启动项目所在的 WSL：`wsl.exe -d <发行版名>`，在 WSL 内进入已核对的源码目录，执行第 3—4 节同一套 Bash 模板。Windows 原生 PID、MySQL/Redis 进程和数据目录不能混用成 WSL 实例归属。

本清单不提供第二套独立配置模板，避免字段漂移；不声称原生 Windows 后端启动器已经验收。PowerShell 入口描述只做静态核对，B 须记录自己的实际系统结果。

## 6. 必须同时满足的判据

- 新完整 SHA、运行配置与实例事实明确；全局 TRUNCATE 关闭（skip=true/allow=false），物理夹具清理另有显式授权。
- 按当前 runner 的完整清单运行：当前 48 规格、625 passed/0 failed/0 skipped，runner exit 0；以后代码变动则按实际数量，不为凑数字删测试。
- 普通资料链 26 样例、案例链 13 样例，共 39。受控失败样例按 errors/状态核验，不把 HTTP200 等同业务成功。
- afterAll/runner 真实成功；KEEP 记录逐字段及文件摘要不变，本轮正常数据库/文件夹具零残留、探针库零残留。默认组织 CLIENT_DEFAULT 与迁移历史属于初始化记录，不能当夹具删除。
- 故意未知分支的台账与残留单列，按创建凭据由拥有者有界处理；不能把手工删掉未决资源写成系统自动回收通过。
- 旧库升级/首次空库的适用性分别记录；无真实结果就填未验证。B 自己的结果与 A 的回执分开。

## 7. B 签收记录

| 项目 | B 填写 |
| --- | --- |
| 新完整 SHA、系统、Node/依赖版本 | 待填写 |
| MySQL/Redis 独占及配置/进程事实（不写密钥） | 未验证 |
| 预检成功及无私人 env 的运行条件 | 未验证 |
| 旧库升级保留/二次0条，或首次空库适用性 | 未验证 |
| 一轮完整 core：命令、规格数、passed/failed/skipped、退出码 | 未验证 |
| 两条业务链/39 样例 | 未验证 |
| 非夹具记录与文件前后不变 | 未验证 |
| 正常本轮数据库/文件/探针残留 | 未验证 |
| 问题、Review 和本人签收结论 | 待填写 |

必要 CI、B 本人签收及 Review 完成前不合并。A/执行 AI 不代签，不使用旧 SHA 的 CI 替代新候选。
