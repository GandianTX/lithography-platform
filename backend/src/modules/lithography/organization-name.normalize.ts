// src/modules/lithography/organization-name.normalize.ts

/**
 * 公司名称的同名比较归一化：去首尾空白、连续空白合并为单个空格、统一小写。
 *
 * 公开注册手填公司名的同名提示与一级管理员新增/编辑的同名提示共用本口径；
 * 只用于「可能同名」的提示查询，不改变落库原值，也不承担资格或唯一性裁决。
 */
export function normalizeOrganizationNameForComparison(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}
