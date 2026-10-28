// 文件位置：src/core/organization/policy/organization-context.policy.ts

/**
 * 可信组织上下文决议（A-PR0 计划 §2.1）。
 *
 * 组织归属的唯一可信来源是经验证的组织成员关系——不取 `company_name`、
 * 不取客户端自报的所有者或角色名称；调用方必须先经「有效」过滤
 * （成员状态 ACTIVE 且组织状态 ACTIVE），本模块只做数量决议：
 *
 * - 无有效成员关系：决议 `NO_ACTIVE_MEMBERSHIP`，拒绝操作，不回退全库；
 * - 多个有效成员关系且无可信组织上下文：决议 `AMBIGUOUS_MEMBERSHIP`，拒绝歧义请求；
 * - 恰有一条有效关系：决议 `RESOLVED`，作为当前可信组织上下文。
 *
 * 纯函数、无 IO，便于跨用例复用同一口径；错误映射与文案归调用方（usecase）。
 */

/** 单例组织上下文决议结果 */
export type SingletonOrganizationContextResolution<TFact> =
  | { readonly kind: 'RESOLVED'; readonly fact: TFact }
  | { readonly kind: 'NO_ACTIVE_MEMBERSHIP' }
  | { readonly kind: 'AMBIGUOUS_MEMBERSHIP' };

/**
 * 从有效成员关系事实集合决议当前可信组织上下文。
 *
 * @param facts 已按「成员 ACTIVE 且组织 ACTIVE」过滤的成员关系事实（顺序稳定由调用方保证）
 * @returns 决议结果；泛型透传事实对象，core 不依赖具体业务类型
 */
export function resolveSingletonOrganizationContext<TFact>(
  facts: readonly TFact[],
): SingletonOrganizationContextResolution<TFact> {
  if (facts.length === 0) {
    return { kind: 'NO_ACTIVE_MEMBERSHIP' };
  }
  if (facts.length > 1) {
    return { kind: 'AMBIGUOUS_MEMBERSHIP' };
  }
  const [first] = facts;
  if (first === undefined) {
    // 防御式：类型层面不可达（length === 1），与空集合同口径处理
    return { kind: 'NO_ACTIVE_MEMBERSHIP' };
  }
  return { kind: 'RESOLVED', fact: first };
}
