// src/features/registration/infrastructure/my-engineer-registration-adapter.ts

/**
 * 本人最新工程师申请 GraphQL adapter（受限会话读取）。
 *
 * - 走默认认证模式（携带当前访问令牌），账号主键由服务端从会话解析，
 *   本 adapter 不传任何账号或申请 ID；
 * - `APPLICATION_NOT_FOUND` 在 filter 中映射为稳定大类 `NOT_FOUND`，据此返回 null
 *   （没有申请不属于错误页）；其余失败原样上抛，由 application 状态机收敛；
 * - 原始 DTO 与 operation 只停留在本目录，对外返回 feature 内部模型。
 */

import { executeGraphQL, readGraphQLErrorDetail } from '@/shared/graphql';

import {
  ENGINEER_REGISTRATION_STATUSES,
  type EngineerRegistrationStatus,
  type MyEngineerRegistrationView,
} from '../application/registration.types';

const MY_ENGINEER_REGISTRATION_QUERY = `
  query MyEngineerRegistration {
    myEngineerRegistration {
      applicationId
      organizationId
      organizationName
      status
      applicationNote
      submittedAt
      reviewedAt
      reviewComment
    }
  }
`;

type MyEngineerRegistrationData = {
  myEngineerRegistration: MyEngineerRegistrationView;
};

function isEngineerRegistrationStatus(value: unknown): value is EngineerRegistrationStatus {
  return (
    typeof value === 'string' &&
    (ENGINEER_REGISTRATION_STATUSES as readonly string[]).includes(value)
  );
}

/** 本人最新一份工程师申请；`NOT_FOUND` 表示该账号没有申请记录（返回 null） */
export async function fetchMyEngineerRegistration(): Promise<MyEngineerRegistrationView | null> {
  try {
    const data = await executeGraphQL<MyEngineerRegistrationData, Record<string, never>>(
      MY_ENGINEER_REGISTRATION_QUERY,
      {},
      { fetchPolicy: 'no-cache' },
    );

    const application = data.myEngineerRegistration;
    if (!isEngineerRegistrationStatus(application.status)) {
      throw new Error(`未知的工程师申请状态：${String(application.status)}`);
    }

    return application;
  } catch (error) {
    if (readGraphQLErrorDetail(error)?.code === 'NOT_FOUND') {
      return null;
    }

    throw error;
  }
}
