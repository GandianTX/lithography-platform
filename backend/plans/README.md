<!-- 文件位置: plans/README.md -->

# Plans

本目录存放项目内仍在推进中的计划文档。

`plans` 的职责是回答：

- 接下来要推进什么
- 优先级如何排序
- 前置条件是什么
- 每一项希望产出什么

`plans` 不负责定义稳定规则。

若某条边界已经稳定，应进入 `docs/` 下对应 rule 文档，而不是继续留在 `plans/` 里反复描述。

## 读取顺序

先按根目录 `AGENTS.md` 与 `docs/README.md` 路由并加载当前任务适用的最小规则集，再阅读具体 plan。Plan 只定义目标、范围、优先级和产出物，不能省略、替代或覆盖适用规则。

1. 先读根目录 `AGENTS.md`
2. 再用 [docs/README.md](../docs/README.md) 路由到当前任务适用的最小规则集
3. 若多个 tracked rule 重叠或冲突，使用 [docs/common/rule-precedence.rules.md](../docs/common/rule-precedence.rules.md) 裁决
4. 再读当前 plan，确认目标、范围、优先级和产出物
5. 若任务需要真实后端字段、类型、权限或当前行为，再按需查看相关 schema、current 文档与实现文件

## 与 Docs 的关系

- `plans/`：记录尚在推进中的事项、阶段和待完成产出
- `docs/`：记录稳定规则、已接受边界、当前契约，以及明确的 non-goals / 已知限制
- 可执行待办、迁移步骤、优先级和未完成交付只进入 `plans/` / `followup`；不得以“开放项”名义留在 `docs/` 形成第二份 pending work list

常见情况：

- 若 plan 里写着“已移入规则的内容”，不要再把 plan 当成主规则来源
- 若需要判断正式边界，优先去 [docs/README.md](../docs/README.md) 查对应主题入口
- 完成 `AGENTS.md` / `docs/README.md` 的适用规则路由后，若只是执行 plan 中的单一事项，只需额外打开该事项直接引用的上下文文档
- 若需要后端契约，优先读取与当前任务直接相关的本地 schema、DTO、resolver 或 usecase，不做全文通读

## 命名约定

- `*-direction.md`：方向判断。
  回答“要不要做 / 朝哪做”。
  不承载 P0/P1/P2 执行清单；一旦可分阶段推进，应改名为 `*-plan.md`。
- `*-plan.md`：推进计划。
  回答“怎么做 / 按什么阶段做”。
  通常包含 P0/P1/P2、执行顺序、验收标准或明确产出物。
- `*-followup.md`：尾项跟踪。
  回答“主链路完成后还剩什么”。
  只保留未完成事项、阻塞原因、触发条件和下一步。
- 当前命名使用 `-followup`，不再新增 `-follow` 或 `-follow-up`。

## 生命周期

```text
direction -> plan -> docs / followup -> delete
```

- 方向确定后，`direction` 升级为 `plan`、沉淀到 `docs`，或删除。
- `plan` 完成后，稳定规则进 `docs`；值得保留背景的完成计划进 `docs/deprecated`；
  未完成尾项进 `followup`。
- `followup` 清空后删除。
- 历史来龙去脉默认不保留，除非它影响未完成事项判断。

## Token 友好建议

- 不要为了理解一个 plan，先全文阅读整个 `docs/` 目录
- 优先只读取：
- 根目录 `AGENTS.md`
- `docs/README.md` 为当前任务路由出的最小适用规则集
- 当前 plan 额外直接引用的上下文文档
- 若任务依赖后端契约，优先按需读取本地相关 schema、type、query、mutation、input
- 只有在规则重叠、冲突或边界不清时，再补读 [docs/common/rule-precedence.rules.md](../docs/common/rule-precedence.rules.md)
- `schema.graphql` 不是默认必读，只有当前任务确实依赖后端字段、类型或权限语义时，才按需打开

一句话原则：

- 先路由并读取适用 rule
- 再用 plan 确认本次执行范围
- 不做整库文档通读

## 当前优先级约定

若某份 plan 使用 `P0 / P1 / P2 / P3`，默认按以下语义理解：

- `P0`：不做就会阻塞主线落地
- `P1`：不阻塞主线，但应尽早补齐，否则实现容易继续发散
- `P2`：需要相关页面、模块或上下文先稳定下来后再推进
- `P3`：需要更多真实使用模式或更成熟前置条件后再展开

## 当前计划

- [V13 数据库一键部署交付收口计划](./database-v13-deployment-delivery-plan.md)：当前执行入口；验收最终表／字段／约束、默认6管理员、显式开发客户／工程师账号及可重复的一键部署，不以旧接口或完整业务core作为本期门禁。
- [V13 后续业务适配](./database-v13-business-integration-followup.md)：跟踪旧接口、真实会话、执行器和业务core等后续事项，不代替数据库自身质量验收。
- [V13 原始增量计划](./database-v13-deployment-plan.md)：来源、历史阶段和裁决背景；后续范围及验收以当前收口计划为准。

当前没有 capability 治理计划；稳定边界见 `docs/common/capability.rules.md` 与 `docs/capabilities/current.md`。

## 已收口背景

- 已完成计划统一归档到 [docs/deprecated](../docs/deprecated/README.md)。
- [Capability Plugin Plan](../docs/deprecated/capability-plugin-plan.md) 已完成并归档；旧的单 manifest 模型仅保留为历史背景。
- 稳定规则见 [capability.rules.md](../docs/common/capability.rules.md)，当前语义决策见
  [capabilities/current.md](../docs/capabilities/current.md)。
- [AI Workflow 基线补强计划](../docs/deprecated/ai-workflow-baseline-plan.md) 已完成并归档。
