# B独立验收执行清单

日期：2026-10-26。已核验代码基准：`d4535bc2d18a833f52d65ef361a7f2d3f9d9b8e2`。本清单是其后的本地文档补充，提交推送前不会出现在B的克隆中；若交付了新SHA，以双方确认的新候选为准。

目的：把“P1门禁”落实为可执行默认路径，不新增业务功能、测试或数据库改动，不预填B签收。

## 1. 先确认版本与环境

- `git rev-parse HEAD`等于双方约定的完整候选SHA；工作区无会影响结果的本地代码改动。
- Node按根目录.nvmrc，当前22.19.0；按锁文件安装依赖。
- MySQL为B自己的可丢弃隔离环境，目标`lithography_e2e`已准备当前迁移结构；Redis为明确可清空的专用实例/逻辑库。不要对共享库、开发保留库或甲方库运行E2E。
- `backend/env/.env.e2e`存在，DB/Redis/JWT/加密等配置正确。配置不完整就记未验证，不索取或提交真实密钥。
- 使用专用终端，停止其他使用同名夹具或相同Redis的测试。本清单命令会写夹具并物理清理；Redis全局收尾可能FLUSHDB。
- 命令在仓库根目录执行，按实际系统选择一组；不要同时运行两组。

## 2. 数据库到达步骤：与回归分开

已有旧库先按[正式增量升级与恢复说明](../增量升级操作说明-20261026.md)执行：

确认目标/停写/备份 → status → run（显式配置和双重目标确认）→ verify → 再run。

本轮正常14条旧历史应到24条，pending为0，二次run执行0条；核对旧资料正文、文件引用、软删事实和归属/入库方式回填。旧前缀尚未升级时verify非0是预期，不能把它当run前置。遇结构漂移、部分DDL或历史不确定就停止，按说明保存现场和恢复，不盲重试。

首次空库按首次初始化流程准备结构，记录“本环境不是旧库”，不伪填旧库保留验证通过；不对带数据旧库运行drill。正式升级后的库如仍包含需保留业务数据，应再准备可丢弃E2E副本，而不是直接在保留库跑测试。

**下面的默认门禁不包含会清库的31项迁移专项，不运行Seed、不运行drill。** 需要另复核31项时必须用独立可丢弃目标，并按升级说明的破坏性授权单独执行。

## 3. 默认门禁范围

尚无双方固定P1规格清单时，采用仓库现有完整core组作为默认验收，避免让接手人猜测文件集合。这个默认范围更广，但已在A侧实际运行；没有新增测试或要求B开发页面。

| 检查族 | core内实际入口 |
| --- | --- |
| 身份、角色、账号写入及绑定 | test/01-auth、03-roles-guard、04-user-info及相关core规格 |
| 原资料与聚合、production拒绝 | test/09-reference-document、10-admin-document-database |
| 草稿/冻结/附件/审批、真实并发与补偿 | test/11-content-submission/content-submission-integration.e2e-spec.ts |
| 真实GraphQL/REST权限与输入 | test/11-content-submission/content-submission-graphql.e2e-spec.ts |
| 正式案例更正和并发锁 | test/12-reference-document-case/reference-document-case.e2e-spec.ts |
| 夹具环境、所有权、引用闭包及部分失败 | test/utils相关core规格和各域ownership/cleanup规格 |
| 两条独立业务链与39条响应样例 | test/11-content-submission/frontend-response-samples.e2e-spec.ts |
| 其他已收录基础回归 | test/jest-e2e.js中core.specs，其余条目按标准runner执行 |

当前d4535bc的完整core为41规格、557项测试。全部必须实际通过，无隐藏skip；以后候选若收录改变，按实际runner核对，不为凑旧数字删测试。

如果双方已有明确且确认的P1清单，可将文件、命令和结果逐项列入签收，不把本默认方案冒称原约定，也不强制再双跑同一组。只跑2项样例不能替代权限/数据安全门禁。

## 4. Bash／WSL：完整core默认路径

在仓库根目录、确认第1—2节后执行。子shell失败即停；不会把前一步失败后的样例存在误判为通过。

```bash
(
  set -e
  cd backend
  test -f env/.env.e2e
  unset E2E_SPECS E2E_GROUP E2E_NEEDS
  export E2E_DOTENV="$PWD/env/.env.e2e"
  export DB_NAME=lithography_e2e
  export DB_SYNCHRONIZE=false
  export E2E_SKIP_DB_CLEANUP=true
  export E2E_ALLOW_DB_CLEANUP=0
  export E2E_ALLOW_PHYSICAL_CLEANUP=1
  export RUN_REAL_AI_E2E=false
  export RUN_REAL_AI_AUTH_FAIL_E2E=false
  task_b_acceptance_dir=$(mktemp -d /tmp/pr0-b-acceptance.XXXXXX)
  export S7_SAMPLES_OUT="$task_b_acceptance_dir/s7-samples.json"
  printf '本次样例文件：%s\n' "$S7_SAMPLES_OUT"
  npm run test:e2e:core
  node -e 'const fs=require("node:fs"); const s=JSON.parse(fs.readFileSync(process.env.S7_SAMPLES_OUT,"utf8")); if(!Array.isArray(s)||s.length!==39) throw new Error("响应样例应为39条"); console.log("样例数量核验通过：39");'
)
```

每个规格由标准runner依次执行，失败即退出。观察最后退出码及全部41条成功摘要，不能只看最后一条passed。上述子shell成功后可通过当前终端的`echo $?`立即记录退出码；先执行其他命令会覆盖它。

## 5. Windows PowerShell：同一路径

```powershell
Push-Location backend
try {
  if (-not (Test-Path 'env/.env.e2e')) { throw '缺少env/.env.e2e' }
  Remove-Item Env:E2E_SPECS, Env:E2E_GROUP, Env:E2E_NEEDS -ErrorAction SilentlyContinue
  $env:E2E_DOTENV = Join-Path (Get-Location).Path 'env/.env.e2e'
  $env:DB_NAME = 'lithography_e2e'
  $env:DB_SYNCHRONIZE = 'false'
  $env:E2E_SKIP_DB_CLEANUP = 'true'
  $env:E2E_ALLOW_DB_CLEANUP = '0'
  $env:E2E_ALLOW_PHYSICAL_CLEANUP = '1'
  $env:RUN_REAL_AI_E2E = 'false'
  $env:RUN_REAL_AI_AUTH_FAIL_E2E = 'false'
  $task_b_acceptance_dir = Join-Path ([System.IO.Path]::GetTempPath()) ("pr0-b-acceptance-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $task_b_acceptance_dir -ErrorAction Stop | Out-Null
  $env:S7_SAMPLES_OUT = Join-Path $task_b_acceptance_dir 's7-samples.json'
  Write-Output ("本次样例文件：" + $env:S7_SAMPLES_OUT)
  npm run test:e2e:core
  $task_b_exit = $LASTEXITCODE
  if ($task_b_exit -ne 0) { throw "core失败，退出码=$task_b_exit" }
  $task_b_samples = @(Get-Content -Raw $env:S7_SAMPLES_OUT -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop)
  if ($task_b_samples.Count -ne 39) { throw "样例不完整：$($task_b_samples.Count)/39" }
  Write-Output 'core退出码0，响应样例数量39；请另核对全部规格摘要。'
} finally {
  Pop-Location
}
```

PowerShell步骤本次仅做静态核对，不声称在Windows实际运行过这组命令；需要B在其系统真实执行后记录。命令结束后关闭专用终端，避免环境变量残留。输出目录只保留在本机，不提交原始响应或日志。

## 6. 判定、两条链和残留

完整core已经包含样例规格：普通资料链1项、26条样例；案例链1项、13条样例，共2项、39条。成功跑完整core并核对这些结果后，不要求再为了同一签收重复跑样例规格；需要单独定位时才用[技术交接说明](../PR0a-技术交接说明-20261025.md)第五节的定向命令。

必须核对：

1. 正式升级/结构验证通过，旧库与首次空库的适用性分别记录。
2. core全部实际通过；d4535bc基准为41规格/557项，退出0，0失败/0跳过。
3. 响应样例JSON是完整数组，39项；GraphQL业务失败按errors/extensions判定，不能只看HTTP200。
4. 清理/afterAll无异常，终端无清理失败；失败不能凭部分样例补签成功。
5. 在B自己的隔离库核对投稿/明细/附件/版本/审核/正式案例及本规格创建的账号、组织、机型、资料无夹具残留。库中若有此前保留的合成记录，只比较本规格归属；不要求整表计数归零，也不手动清库凑0。
6. 默认组织CLIENT_DEFAULT属于迁移初始化，可保留；不作为测试残留清除。
7. 若需要独立对照，运行前后保留脱敏的本规格归属行/引用摘要；记录而不导出真实业务内容。

## 7. 签收记录

| 项目 | B填写 |
| --- | --- |
| 完整候选SHA、系统/Node版本 | 待填写 |
| MySQL/Redis隔离及当前结构 | 待确认，不写敏感值 |
| 旧库升级/数据保留/再次0条；或首次空库适用性 | 未验证 |
| 完整core或已有明确P1清单、命令和通过/失败/skip数字 | 未验证 |
| 普通资料链、案例链、39样例 | 未验证 |
| afterAll及本规格夹具/外部保留数据 | 未验证 |
| 问题与结论 | 待填写 |

本清单不表示B已验收；A侧历史结果与当前B实际结果必须分开。B签收、必要CI与Review完成前不合并。
