<!-- docs/project-convention/local-backup-restore-runtime.md -->

# 本地备份与恢复：执行器配置、密钥引用与故障处置

> 适用范围：任务 09 的本地备份生成、云上传、受控清理与恢复预检。
> 本文件是**运维交接面**：写明"配置从哪来、密钥从哪来、坏了怎么办"。
> 能力边界以代码与事实为准：本文件不承诺尚未实现的能力。

## 0. 当前能力边界（先读这一节）

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 受保护备份包生成与校验 | 可用 | 目录形态 manifest＋payload.enc＋复制的原件 |
| 72 小时持久计划与补偿运行 | 可用 | Worker 周期扫描；重启后残留 RUNNING 改判 INTERRUPTED 并补一次 |
| 自动上云（上传尝试与退避重试） | **仅本机侧** | 真实接收端未接入（R-02）：无回执时如实停在"待上传"，不伪造成功 |
| 手动清理（完整回执后精确删除） | **仅本机侧** | 真实闭环依赖 R-02；无回执时零清理 |
| 恢复预检与保护副本 | 可用 | 只读核对＋保护副本，**不写正式业务** |
| 恢复执行（停写停传、恢复、回滚） | **有条件可用** | 受三道闸门约束：本机安装身份已初始化、本次恢复的保护副本就绪、备份包解密材料可得；缺任一即如实返回 `executionAvailable=false` 与原因码，**不做无条件可用承诺** |

## 1. 执行器配置清单

| 配置项 | 含义 | 默认值 | 读取点 | 缺失/错误的后果 |
| --- | --- | --- | --- | --- |
| `LOCAL_BACKUP_STORAGE_DIR` | 本机备份包根目录 | `var/local-backups` | `config.module.ts` → `localRuntime.backupStorageDir` | 落到默认目录；**必须与业务原件目录物理分离**，否则受控清理的路径闸门会挡下删除 |
| `LOCAL_BACKUP_PROTECTION_KEY` | 备份包加密密钥（hex/base64） | 无 | `config.module.ts` → `localRuntime.protectionKey`（**封包与恢复都消费**） | 封包按**失败关闭**处理（不产出可用包），服务仍可启动；恢复侧能力探针报 `PROTECTION_KEY` 闸门缺失（`executionAvailable=false`）；绝不退回硬编码密钥 |
| `LOCAL_BACKUP_PROTECTION_KEY_ID` | 密钥标识，落 `backup_asset.encryption_key_id` | 无 | 同上 | 资产行缺少密钥标识，轮换时无法定位旧密钥 |
| `DB_*` | 数据库连接 | — | 迁移与全部事实表 | 事实读写不可用 |
| `FIELD_ENCRYPTION_KEY` / `FIELD_ENCRYPTION_IV` | 业务字段加密密钥 | 无 | 字段加密订户 | 资料写入无法走与生产一致的加密列路径 |

配置读取只在 wiring 层（`src/infrastructure/config/config.module.ts`）；用例与服务不直接读环境变量。

### 1.1 恢复执行的三道闸门（可用条件）

恢复执行**不是无条件可用**。`executionAvailable` 由实际 capability/provider 与前置事实决定，
三道闸门全部就绪才为可用（`core/local-runtime/policy/restore-execution-capability.policy.ts`）：

| 闸门 | 判定事实 | 缺失原因码 | 缺失后果 |
| --- | --- | --- | --- |
| `WRITE_GATE` | 本机安装身份已初始化（`local_installation`） | `WRITE_GATE_UNAVAILABLE` | 恢复执行入口如实不可用；**不写任何恢复事实** |
| `FAILURE_COMPENSATION` | 本次恢复的保护副本资产就绪（未清理、有本地包引用） | `FAILURE_COMPENSATION_UNAVAILABLE` | 同上（缺回滚补偿 ⇒ 不允许开写） |
| `PROTECTION_KEY` | 备份包解密材料可得（`LOCAL_BACKUP_PROTECTION_KEY`） | `PROTECTION_KEY_UNAVAILABLE` | 同上 |

执行期这三道闸门会**按最新事实再判一次**（受理后保护副本可能被清理），
因此"受理时可用"不等于"执行时可用"。

## 2. 密钥引用

- **保护密钥只在封包与解包路径上消费**：配置层把密钥值放进 `localRuntime.protectionKey`，
  由 `ProtectedBackupService` 注入使用；密钥值**不进日志、不经 API 返回、不落包**。
- **密钥标识单独记录**：每个备份资产行记录 `encryption_key_id`；
  轮换时"新包用新密钥、旧包仍用旧密钥"，处置前先按该列确认旧密钥是否仍可取。
- **缺密钥不静默降级**：没有配置保护密钥时封包直接失败（不产出半个包），错误码落在
  备份运行行（`error_code` / `error_message`），运维从该行判断原因。
- **业务同步凭据与备份凭据是两套**：备份上传的用途授权凭据尚未落地（R-06），
  当前**不得**复用业务同步凭据充当备份用途授权。

## 3. 恢复故障操作说明

### 3.1 恢复预检失败

- **现象**：预检返回 `outcome='FAILED'`，并给出发现项清单（`findings[]`）。
- **常见原因与处置**：
  - `PACKAGE_UNREADABLE` / `MANIFEST_INVALID`：包文件不可读或清单不合法 → 重新生成备份包；
  - `FILE_MISSING` / `FILE_CHECKSUM_MISMATCH`：包内文件缺失或摘要不符 → 重新生成并核对传输完整性；
  - `TARGET_INSTALLATION_MISMATCH` / `TARGET_ORGANIZATION_MISMATCH`：不是本机或不是本公司 → 不要强推；
  - `LOCAL_PACKAGE_MISSING`：本机包已清理 → 改用仍在库内的包；
  - `PROTECTION_COPY_FAILED`：保护副本生成失败 → 先修好原件存储目录与备份根目录，再重跑预检。
- **预检不写正式业务**：预检只落 `backup_restore_run` 一行事实（`check_status` 与快照）。

### 3.2 恢复执行入口不可用（闸门未就绪）

- **现象**：`localRestoreCapability.executionAvailable=false`，并给出原因码与缺失闸门清单。
- **原因**：三道闸门（见 1.1）任一未就绪：写/同步闸门（本机安装身份）、
  失败回滚补偿（本次恢复的保护副本）、受保护包解密材料（备份密钥）。
  **不是**"恢复功能没实现"，而是**前置条件不满足**。
- **处置**：**不要**手工改库绕过；按 1.1 逐项核对前置：
  - 缺 `WRITE_GATE` ⇒ 先初始化本机安装身份；
  - 缺 `FAILURE_COMPENSION` ⇒ 重新预检生成保护副本（保护副本被清理后不可复用）；
  - 缺 `PROTECTION_KEY` ⇒ 补齐与封包**同一把**密钥（密钥轮换后旧包需旧密钥）。
- **入口语义**：闸门未就绪时恢复执行**零写入**受控拒绝（不建冻结、不写业务、不写成功事件）。

### 3.2.1 恢复执行失败（已受理后执行失败）

- **现象**：恢复终态为失败，`backup_restore_run.status='FAILED'`，并有一条终态审计事件
  （`operation='RESTORE_LOCAL_BUSINESS'`，`detail.stage` 标明阶段）。
- **阶段含义**：
  - `RESTORE_ROLLED_BACK`：业务数据已按保护副本回滚、冻结已解除 ⇒ 设备可恢复写传；
  - `RESTORE_ROLLBACK_FAILED`：按保护副本回滚**失败** ⇒ 数据与冻结都需人工处置；
  - `RESTORE_SUCCEEDED_HOLD_RETAINED`：数据确实恢复成功，但**冻结解除失败** ⇒
    终态仍是成功，设备继续停写停传（保守口径），等人工处置。
- **处置**：按 `detail.stage` 与 `reason_code` 判断是"回滚后待确认"还是"必须人工介入"；
  `RESTORE_ROLLBACK_FAILED` / `RESTORE_SUCCEEDED_HOLD_RETAINED` 两种情形下
  **冻结仍在**，不要手工把 `local_write_hold` 改成已释放。
- **审计事实**：终态事件里的 `actor_admin_level` 是**执行当时**的服务端复核等级
  （一级＝全局范围、二级＝本公司范围），缺等级时**失败关闭**拒绝执行，不静默记成一级。

### 3.3 清理被进程中断

- **现象**：资产行停在 `local_status='CLEANING'`，`deleted_at` 为空，`local_reference` 仍在。
- **判定**：清理可辨认时限为 10 分钟；超时未推进即视为"清理被进程中断"残留。
- **处置**：下一轮清理会先把它登记为中断（`local_cleanup_error='清理被进程中断，将在本轮重试'`）
  再继续清理；**不要**手工把状态改成 `CLEANED`（那会造出"已清理"的假事实）。
- **实测证据**：真实子进程被 SIGKILL 后的残留与续清见
  `docs/plan/task09/证据/R-08-真实进程中断注入-执行记录-20261122.md`（证据目录不纳入提交，续接时在工作区读取）。

### 3.4 上传在途残留

- **现象**：资产行 `cloud_status='UPLOADING'` 且长时间不动。
- **判定与处置**：上传在途超过 10 分钟即改判 `FAILED`（原因：上传过程被进程中断，将按退避重试同一备份包），
  随后按退避（5→10→20→40→60 分钟封顶）重试**同一个包**，不重新生成包。

### 3.5 备份运行中断（进程重启）

- **现象**：`local_backup_run.status='RUNNING'` 且长时间未结束。
- **判定与处置**：超过 60 分钟未结束即改判 `INTERRUPTED`（`error_code='BACKUP_INTERRUPTED_BY_RESTART'`），
  计划随后按"补一次"语义重新触发；这是**重启可辨认**的既有先例。

### 3.6 上云回执缺失导致零清理

- **现象**：手动清理返回 `available=false`，`cleaned=0`，包仍在原处。
- **原因与处置**：完整云回执是手动清理的**唯一**授权来源；回执缺失/不可解析/非成功语义时**零清理**。
  先确认云端接收端是否已回执（R-02 未解除前本机没有真实闭环），不要手工把包删掉。

## 4. 排障入口

- 事实表：`local_backup_run`（运行与清理状态）、`backup_asset`（资产与包事实）、
  `backup_restore_run`（预检与恢复事实）、`local_upload_task`（上传任务事实）。
- 顺序核对：`backup_asset` → `local_backup_run` → `local_company_setting`（外键 RESTRICT，删除要按此顺序）。
- 迁移与结构核对：`npm run migration:status`（只读）、`npm run migration:verify`（终态校验）。
