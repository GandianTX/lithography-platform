<!-- docs/common/aggregate.rules.md -->

Purpose: Define aggregate root and child-entity write guardrails.
Read when: You are designing, reviewing, or refactoring entities, aggregate boundaries, or write paths that touch multiple records in one bounded context.
Do not read when: Your task only changes adapter DTO names or pure read-only projections.
Source of truth: This file defines aggregate write boundaries; examples elsewhere must not override it.

# Aggregate 规则

## 聚合根

- 聚合根是聚合内唯一允许被外部写入的入口。
- 聚合根负责保护聚合内不变量。
- 聚合根可以是领域模型、聚合根 service，或由 usecase 显式编排的聚合根写入口。
- 聚合根必须有清晰业务语义，不得因为表之间有关联就合并为一个聚合。

## 聚合内实体

- 聚合内实体不得被外部直接写入。
- 聚合内实体只能通过所属聚合根入口创建、更新、删除或整体替换。
- 聚合内实体可以被 QueryService 读取，用于投影、详情、列表或诊断视图。
- 聚合内实体的读取不得绕过写入规则。
- 若某实体需要被多个外部流程独立写入，应重新评估它是否应升级为独立聚合根。

## 外部写入定义

以下都属于外部直接写入，禁止：

- adapters 直接写聚合内实体。
- usecases 直接写聚合内实体 repository。
- 其他 bounded context 的 modules(service) 直接写聚合内实体。
- 同一 bounded context 内绕过聚合根 service 直接写子实体 repository。
- 为了方便批量修改，在普通业务 usecase 中直接写子实体表。

以下不属于外部直接写入：

- 聚合根 service 内部写自己的子实体。
- 聚合根 usecase 显式调用聚合根 service 写自己的子实体。
- QueryService 只读子实体并返回 View、ReadModel 或 Record snapshot；协议 DTO 由 adapter 映射。
- migration、baseline、受控修复脚本按数据库交付规则写表。

## Account / UserInfo 当前稳定边界

- `Account` 是 account 聚合根。
- `UserInfo` 与 `Account` 是 1:1 强关联资料，当前视为 `Account` 聚合内写入事实。
- `UserInfo` 允许存在单侧 CRUD / Query 意义，例如资料读取、可见资料更新、登录流程读取与安全校验。
- 这些单侧 CRUD / Query 是应用能力或读模型能力，不改变 `UserInfo` 的聚合归属。
- 只有当 `UserInfo` 开始承载跨主体、跨账号或独立生命周期事实时，才重新评估是否拆出独立聚合边界。
- `AccountService` 当前只承接 `Account` 聚合内能力。
- `identityHint`、`accessGroup`、`metaDigest` 属于 account 访问语义摘要。
- 访问语义摘要写入必须由 usecase 显式编排，不得由登录链路或 QueryService 顺手补写。
- 本项目账号语义只保留 `SUPER_ADMIN / ENGINEER / CUSTOMER`。
- `SUPER_ADMIN` 在角色层级中继承 `ENGINEER` 和 `CUSTOMER` 的访问能力。
- `ENGINEER` 与 `CUSTOMER` 互不继承。
- 公开注册按角色分流：`CUSTOMER` 选择有效组织后直接开通并绑定该组织 `CUSTOMER` 成员；`ENGINEER` 仅创建待审账号与 `PENDING` 申请，经所选组织管理员审核通过后，才由审批用例在同一事务内启用账号并建立 `ENGINEER` 成员关系。`SUPER_ADMIN` 不开放自助注册，仍由受控管理流程或 Seed 创建。
- 工程师注册申请是独立记录：拒绝后重提新增 `PENDING` 申请，原拒绝记录与审核意见保留，不覆盖历史，不新增角色。

## VerificationRecord 规则

- `VerificationRecord` 是独立聚合根。
- `VerificationRecordService` 是当前聚合写入口。
- 签发通过 issuer 生成 token 后调用 `VerificationRecordService.createRecord()`。
- 消费通过 `VerificationRecordService.consumeRecord()` 表达。
- 消费、target constraint、消费时 target 绑定必须属于同一个聚合写语义。
- 撤销通过 `VerificationRecordService.revokeRecord()` 表达。
- 状态机、公开失败原因、消费失败原因与 target constraint 解析应集中在同域纯规则中。
- `VerificationRecordQueryService` / `ConsumableQueryService` 只能读取和映射 View，不得修复状态或补写字段。
- 公开消费 handler 若为了阻断 token 重放需要强制消费记录，仍必须调用聚合写入口，不得直接写 repository。

## 事务与聚合

- 单聚合写入由聚合根入口保护不变量。
- 跨聚合写入由 usecase 编排。
- 跨聚合事务必须由 usecase 持有事务边界。
- modules(service) 不得为了跨聚合一致性开启事务。
- 若跨聚合流程不能强一致完成，usecase 必须选择失败处理、补偿、重试或审计策略。

## Code Review 必查项

- 新写路径是否从聚合根入口进入。
- 是否有 usecase 或 service 直接写了聚合内实体 repository。
- 子实体是否出现独立生命周期。
- 子实体是否被 QueryService 之外的读写服务随意暴露。
- 是否把数据库关系误当成聚合边界。
