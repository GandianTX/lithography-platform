// src/features/registration/infrastructure/registration-organization-adapter.ts

/**
 * 注册公司候选 GraphQL adapter（公开只读）。
 *
 * - 复用 shared/graphql 的 executeGraphQL（唯一 Apollo Client、ingress 错误模型），
 *   以 `authMode: 'none'` 发送公开请求，不携带任何登录态；
 * - 原始 DTO 与 operation 只停留在本目录，对外返回 feature 内部模型；
 * - 资格口径由服务端决定（ACTIVE 且属于一级维护名单），前端不做二次过滤；
 * - 使用 Web 独立入口 `registrationOrganizationSearch`（分页 + 关键字），
 *   无参的 `registrationOrganizations` 数组入口保留给小程序注册与凭据重提。
 */

import { executeGraphQL } from '@/shared/graphql';

import type {
  RegistrationOrganizationPage,
  RegistrationOrganizationSearch,
} from '../application/registration.types';

const REGISTRATION_ORGANIZATIONS_QUERY = `
  query RegistrationOrganizationSearch($pagination: PaginationArgs!, $keyword: String) {
    registrationOrganizationSearch(pagination: $pagination, keyword: $keyword) {
      items {
        id
        name
      }
      total
      page
      pageSize
    }
  }
`;

const REGISTRATION_ORGANIZATION_NAME_EXISTS_QUERY = `
  query RegistrationOrganizationNameExists($name: String!) {
    registrationOrganizationNameExists(name: $name)
  }
`;

type RegistrationOrganizationsData = {
  registrationOrganizationSearch: {
    items: RegistrationOrganizationPage['items'];
    total?: number | null;
    page?: number | null;
    pageSize?: number | null;
  };
};

type RegistrationOrganizationsVariables = {
  pagination: {
    mode: 'OFFSET';
    page: number;
    pageSize: number;
    withTotal: true;
  };
  keyword?: string;
};

type RegistrationOrganizationNameExistsData = {
  registrationOrganizationNameExists: boolean;
};

type RegistrationOrganizationNameExistsVariables = {
  name: string;
};

/** 公开检索注册公司候选（名称关键字可选；空白关键字整体省略） */
export async function fetchRegistrationOrganizations(
  search: RegistrationOrganizationSearch,
): Promise<RegistrationOrganizationPage> {
  const keyword = search.keyword?.trim();

  const data = await executeGraphQL<
    RegistrationOrganizationsData,
    RegistrationOrganizationsVariables
  >(
    REGISTRATION_ORGANIZATIONS_QUERY,
    {
      pagination: {
        mode: 'OFFSET',
        page: search.page,
        pageSize: search.pageSize,
        withTotal: true,
      },
      ...(keyword ? { keyword } : {}),
    },
    { authMode: 'none', fetchPolicy: 'no-cache' },
  );

  const page = data.registrationOrganizationSearch;
  return {
    items: page.items,
    total: page.total ?? 0,
    page: page.page ?? search.page,
    pageSize: page.pageSize ?? search.pageSize,
  };
}

/**
 * 手填公司名精确同名提示（公开只读，最小布尔结果）。
 *
 * 与候选分页完全独立：服务端按归一化后的完整名称精确比较启用且受管的公司，
 * 不受当前已加载候选或首屏影响。调用方传入的 `name` 可保留用户原始输入，
 * 服务端与前端使用同一归一化口径。
 */
export async function checkRegistrationOrganizationNameExists(name: string): Promise<boolean> {
  const data = await executeGraphQL<
    RegistrationOrganizationNameExistsData,
    RegistrationOrganizationNameExistsVariables
  >(
    REGISTRATION_ORGANIZATION_NAME_EXISTS_QUERY,
    { name },
    { authMode: 'none', fetchPolicy: 'no-cache' },
  );
  return data.registrationOrganizationNameExists === true;
}
