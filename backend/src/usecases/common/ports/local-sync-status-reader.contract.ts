// src/usecases/common/ports/local-sync-status-reader.contract.ts

/**
 * 真实同步状态读取实现的共享令牌（任务 09 → 任务 07 接入用）。
 *
 * 定位：这是中立装配令牌，不含任何实现。
 * - 任务 09 侧注册真实实现（读本机同步事实，不产生副作用）；
 * - 任务 07 侧在调用期惰性查找该令牌：找到即用真实实现，
 *   未注册则回落「明确不可用」实现（展示 NOT_CONNECTED，不得推断已同步）。
 *
 * 为什么不静态注入：任务 07 的端口装配在任务 07 模块内完成，
 * 静态绑定会让任务 07 在编译期依赖任务 09 的实现；惰性查找保持两边只依赖
 * 本令牌，且查找发生在请求期（此时全部模块已实例化，无初始化顺序问题）。
 *
 * 查找失败一律回落不可用实现（失败关闭）。
 */

export const LOCAL_SYNC_STATUS_READER = Symbol('LOCAL_SYNC_STATUS_READER');

/*
 * 为什么本文件**不**声明接口形状（review 遗留 L3，已核定为不可收敛）：
 * - 形状由任务 07 的端口 `MaintenanceReportSyncStatusReader` 定义；
 * - 若在本文件（common 域）引用它，会触发仓库架构守卫
 *   `local-architecture/no-cross-domain-usecases-imports`（common 不得依赖具体业务域）；
 * - 若在此**另写一份**形状，则是本分支要消除的"二次实现"（两处形状必然漂移）。
 *
 * 现有的编译期闭环（不依赖本文件声明形状）：
 * - 提供侧：`MaintenanceReportSyncStatusReaderAdapter` **实现**任务 07 的端口
 *   ⇒ 形状不符无法编译通过；
 * - 装配侧：令牌以 `useExisting` 绑定到该适配器 ⇒ 绑定错实现会被类型发现；
 * - 消费侧：按任务 07 的端口类型断言取用 ⇒ 用错形状无法编译通过。
 */
