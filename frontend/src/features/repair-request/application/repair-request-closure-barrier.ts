// src/features/repair-request/application/repair-request-closure-barrier.ts

/**
 * 结单成功事实的会话级本地登记（只存活于当前前端运行时，不写持久化/数据库）。
 *
 * 为什么需要模块级存储：真实详情页按 key=`accountId:requestId` 重挂载面板，
 * 组件与 hook 内的 useState/useRef 会随重挂载清空，导致「结单 mutation 已明确成功、
 * 但服务端回读尚未采用已结束详情」的只读事实在 A→B→A 后丢失，写入口重新出现。
 *
 * 隔离边界：以「身份/会话 scopeKey + 工单 ID」为键。
 * - 不同工单互不影响：B 不继承 A 的只读状态；
 * - 不同身份/会话（scopeKey 变化，如换账号或同账号新会话）互不影响，
 *   旧身份的事实与迟到结果不得作用于新身份；
 * - 只保存「本会话中该工单结单 mutation 已明确成功」这一必要事实（工单 ID），
 *   不保存凭据、回复正文或其他工单内容，也不新增数据库字段或接口。
 *
 * 撤销只由「当前身份、当前工单的已结束详情被共享详情状态实际采用」触发
 * （见 useEngineerRepairRequestDetailFlow 的 detailEnded 接管逻辑）；
 * 未结束、失败、失效或被其他请求取代的回读不得清除本登记。
 */

const closureSucceededByScope = new Map<string, Set<number>>();

/** 结单 mutation 明确成功：登记当前身份下当前工单的本地只读事实。 */
export function markRepairRequestClosureSucceeded(scopeKey: string, requestId: number): void {
  const requestIds = closureSucceededByScope.get(scopeKey);

  if (requestIds) {
    requestIds.add(requestId);
    return;
  }

  closureSucceededByScope.set(scopeKey, new Set([requestId]));
}

/** 服务端已结束详情被共享状态采用后，撤销当前身份下当前工单的本地只读事实。 */
export function clearRepairRequestClosureSucceeded(scopeKey: string, requestId: number): void {
  const requestIds = closureSucceededByScope.get(scopeKey);

  if (!requestIds) {
    return;
  }

  requestIds.delete(requestId);

  if (requestIds.size === 0) {
    closureSucceededByScope.delete(scopeKey);
  }
}

/** 当前身份下当前工单是否仍持有「结单已明确成功」的只读屏障。 */
export function hasRepairRequestClosureSucceeded(scopeKey: string, requestId: number): boolean {
  return closureSucceededByScope.get(scopeKey)?.has(requestId) === true;
}

/** 仅测试用：清空模块级登记，避免用例之间互相影响（不进入公开 barrel）。 */
export function resetRepairRequestClosureBarriersForTests(): void {
  closureSucceededByScope.clear();
}
