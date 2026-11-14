// src/usecases/registration/search-registration-organizations.types.ts

import type { PaginationParams } from '@core/pagination/pagination.types';

/** Web 注册公司候选检索入参（adapter 原样透传，归一化与资格裁决在本用例） */
export type SearchRegistrationOrganizationsInput = {
  /** 名称关键字；空/空白表示不过滤 */
  keyword?: string | null;
  pagination: PaginationParams;
};
