// src/types/services/register.types.ts

/**
 * 注册类型枚举
 *
 * `CUSTOMER`：客户，注册后直接开通并绑定所选组织为 CUSTOMER 成员；
 * `ENGINEER`：工程师，注册后账号保持待审（PENDING/PENDING），只落待审申请，
 * 由所选组织管理员审核通过后才开通并建立 ENGINEER 成员关系。
 */
export enum RegisterTypeEnum {
  /** 客户 */
  CUSTOMER = 'CUSTOMER',
  /** 工程师（待组织管理员审核） */
  ENGINEER = 'ENGINEER',
}
