// src/shared/ui/format-date-time.ts

/**
 * 全局展示时间的唯一实现（维修申请与历史维修记录切片共用）。
 * 后端 Date 标量为 ISO 字符串；解析失败时占位，不展示原始值误导用户。
 * 原 repair-request / reference-document 切片内的同名副本已收敛至此，
 * 后续切片需要展示时间时直接复用，不再各自实现。
 */
export function formatDateTimeText(value: string): string {
  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false });
}

// 分钟精度变体（客户维修工作台消费）：与 formatDateTimeText 同一解析口径，
// 输出不含秒；解析失败时回显原值（与原 pages/customer/format-date.ts 行为一致），
// 该副本已收敛至此，供 feature 面板跨层复用。
const minuteFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function formatDateTimeMinuteText(value: string): string {
  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? value : minuteFormatter.format(date);
}
