// src/modules/lithography/organization.types.ts

import type { IdentityTypeEnum } from '@app-types/models/account.types';

/**
 * 组织领域稳定视图与事实类型（不暴露 ORM Entity）。
 */

/**
 * 组织成员事实：可信组织上下文解析与成员校验的唯一输入事实。
 *
 * 仅表达「有效」关系：成员状态 ACTIVE 且所属组织状态 ACTIVE
 * （过滤口径由 OrganizationMembershipQueryService 统一保证）。
 * 组织名称/编码来自组织表事实，不取账号 `company_name` 等自报字段。
 */
export type OrganizationMembershipFact = {
  /** 成员关系主键 */
  membershipId: number;
  /** 组织主键 */
  organizationId: number;
  /** 组织业务编码（如 `CLIENT_DEFAULT`） */
  organizationCode: string;
  /** 组织名称（展示用） */
  organizationName: string;
  /** 组织类别：`CLIENT`=甲方；`PEER`=同行 */
  organizationKind: string;
  /** 组织内角色：`SUPER_ADMIN`=组织管理员；`ENGINEER`=工程师；`CUSTOMER`=客户 */
  memberRole: string;
};

/**
 * 补录写入前的成员关系核对事实：**不按有效口径过滤**，保留成员状态与所属组织状态。
 *
 * 与 `OrganizationMembershipFact` 的差异（刻意分开，避免污染可信组织解析的有效口径）：
 * - 停用组织上的 ACTIVE 成员关系仍返回，因为它会占用 `active_account_id` 唯一键；
 * - `LEFT` 历史成员关系仍返回，因为它会占用 `(organization_id, account_id)` 唯一键；
 * 调用方据此在写 FK / 成员关系之前失败关闭，而不是让唯一索引在提交时抛错。
 */
export type OrganizationMembershipBindingFact = {
  /** 成员关系主键 */
  membershipId: number;
  /** 组织主键 */
  organizationId: number;
  /** 组织内角色：`SUPER_ADMIN`=组织管理员；`ENGINEER`=工程师；`CUSTOMER`=客户 */
  memberRole: string;
  /** 成员状态：`ACTIVE`=在籍；`LEFT`=已退出 */
  membershipStatus: string;
  /** 所属组织状态：`ACTIVE`=启用；`DISABLED`=停用 */
  organizationStatus: string;
};

/**
 * 组织成员关系写入数据（管理员代建与自助注册共用同一写入入口形态）。
 *
 * `memberRole` 与实体 `chk_organization_membership_role` 值域一致；
 * 本期写路径：管理员创建账号时绑定；客户自助注册时按所选有效组织同事务绑定 CUSTOMER；
 * 工程师自助注册先落待审申请，不建成员关系，审核通过时与账号启用同事务绑定 ENGINEER。
 */
export type OrganizationMembershipInsertData = {
  /** 组织主键（管理员代建取自可信组织解析；自助注册取客户端所选、已在同事务内复核 ACTIVE） */
  organizationId: number;
  /** 账号主键（同一事务内刚创建的账号） */
  accountId: number;
  /** 组织内角色：`SUPER_ADMIN`=组织管理员；`ENGINEER`=工程师；`CUSTOMER`=客户 */
  memberRole: IdentityTypeEnum.SUPER_ADMIN | IdentityTypeEnum.ENGINEER | IdentityTypeEnum.CUSTOMER;
};

/**
 * 注册组织选项读模型：只含允许自助注册的有效组织主键与展示名称。
 *
 * 刻意不含组织编码、类别、状态、成员、管理员、内部统计或其他属性；
 * 浏览器所选 organizationId 只是申请参数，组织有效性仍由创建事务内复核。
 */
export type OrganizationRegistrationOption = {
  readonly id: number;
  readonly name: string;
};

/** 注册组织候选分页参数（页码从 1 开始，页大小由写入/查询侧统一限流） */
export type OrganizationRegistrationOptionPagination = {
  page: number;
  pageSize: number;
};

/**
 * 注册组织候选检索条件。
 *
 * `keyword` 为名称关键字（空表示不过滤），由用例归一化后传入；
 * 资格口径固定为「ACTIVE 且属于一级维护名单」，不接受调用方覆盖。
 */
export type OrganizationRegistrationOptionQuery = {
  keyword?: string;
  pagination: OrganizationRegistrationOptionPagination;
};

/** 注册组织候选分页结果（按名称、主键稳定排序） */
export type OrganizationRegistrationOptionPage = {
  items: OrganizationRegistrationOption[];
  total: number;
  page: number;
  pageSize: number;
};

/**
 * 报修服务候选读模型：客户提交报修时可选的维修服务公司最小信息。
 *
 * 只含选择所需的 `id` / `name` / `shortName`（R018-02），不返回组织编码、
 * 联系信息、受管归类或成员资料；资格口径固定为「启用且具备维修服务资格」，
 * 提交报修时由任务 03 在写入事务内再次复核。
 */
export type OrganizationServiceProviderOption = {
  readonly id: number;
  readonly name: string;
  readonly shortName: string | null;
};

/** 报修服务候选检索条件（关键字为名称子串，空表示不过滤） */
export type OrganizationServiceProviderOptionQuery = {
  keyword?: string;
  pagination: OrganizationRegistrationOptionPagination;
};

/** 报修服务候选分页结果（按名称、主键稳定排序） */
export type OrganizationServiceProviderOptionPage = {
  items: OrganizationServiceProviderOption[];
  total: number;
  page: number;
  pageSize: number;
};

/**
 * 管理员公司名称名单读模型（R015 最小字段视图）。
 *
 * 只含主键与全称；联系方式、成员、业务详情、受管/维修资格等一律不输出。
 * 该名单是管理端读视图，**不是**公开注册候选，资格口径与 `ACTIVE + 受管` 无关。
 */
export type OrganizationNameOption = {
  readonly id: number;
  readonly name: string;
};

/** 管理员公司名称名单检索条件（关键字为名称子串，空表示不过滤） */
export type OrganizationNameOptionQuery = {
  keyword?: string;
  pagination: OrganizationRegistrationOptionPagination;
};

/** 管理员公司名称名单分页结果（按名称、主键稳定排序） */
export type OrganizationNameOptionPage = {
  items: OrganizationNameOption[];
  total: number;
  page: number;
  pageSize: number;
};

/**
 * 组织状态值域：与实体 `chk_organization_status` 一致。
 *
 * 以「运行时常量 + 同名类型」声明，既保持字面量联合类型（库值与入参都用字符串），
 * 也为 GraphQL `registerEnumType` 提供运行时对象，不引入第二套值域判断。
 * 常量名按仓库命名规范使用 camelCase，GraphQL 枚举名在注册处显式指定。
 */
export const organizationStatusValues = {
  ACTIVE: 'ACTIVE',
  DISABLED: 'DISABLED',
} as const;
export type OrganizationStatus =
  (typeof organizationStatusValues)[keyof typeof organizationStatusValues];

/** 组织类别值域：与实体 `chk_organization_kind` 一致（同样提供运行时对象） */
export const organizationKindValues = {
  CLIENT: 'CLIENT',
  PEER: 'PEER',
} as const;
export type OrganizationKind = (typeof organizationKindValues)[keyof typeof organizationKindValues];

/**
 * 管理员公司档案完整视图（任务 08.2 一级管理读写共用）。
 *
 * 含编号、联系信息、状态与维修资格等全部管理字段；只允许一级管理员读取，
 * 二级管理员的读入口是 `OrganizationNameOption` 最小名单。
 */
export type AdminOrganizationView = {
  readonly id: number;
  readonly organizationCode: string;
  readonly name: string;
  readonly shortName: string | null;
  readonly contactName: string | null;
  readonly contactPhone: string | null;
  readonly contactEmail: string | null;
  readonly address: string | null;
  readonly remark: string | null;
  readonly isServiceProvider: boolean;
  readonly isManagedCompany: boolean;
  readonly kind: OrganizationKind;
  readonly status: OrganizationStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

/** 管理员公司档案列表检索条件（关键字与筛选为空表示不过滤） */
export type AdminOrganizationListQuery = {
  keyword?: string;
  status?: OrganizationStatus;
  isManagedCompany?: boolean;
  isServiceProvider?: boolean;
  pagination: OrganizationRegistrationOptionPagination;
};

/** 管理员公司档案分页结果（按名称、主键稳定排序） */
export type AdminOrganizationPage = {
  items: AdminOrganizationView[];
  total: number;
  page: number;
  pageSize: number;
};

/** 一级管理员新增公司：编号由服务端生成，受管归类固定为 true、状态按入参（缺省 ACTIVE） */
export type CreateManagedCompanyData = {
  name: string;
  shortName: string | null;
  contactName: string | null;
  contactPhone: string;
  contactEmail: string | null;
  address: string | null;
  remark: string | null;
  status: OrganizationStatus;
  isServiceProvider: boolean;
};

/**
 * 一级管理员编辑公司的白名单补丁。
 *
 * 键缺省 = 不修改；可选文本显式为 null = 清空。编号、受管归类与类别不在补丁内，
 * 由写服务拒绝任何越界字段。
 */
export type UpdateManagedCompanyPatch = {
  name?: string;
  shortName?: string | null;
  contactName?: string | null;
  contactPhone?: string;
  contactEmail?: string | null;
  address?: string | null;
  remark?: string | null;
  status?: OrganizationStatus;
  isServiceProvider?: boolean;
};
