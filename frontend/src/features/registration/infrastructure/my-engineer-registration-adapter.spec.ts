// src/features/registration/infrastructure/my-engineer-registration-adapter.spec.ts

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { executeGraphQLMock, readGraphQLErrorDetailMock } = vi.hoisted(() => ({
  executeGraphQLMock: vi.fn(),
  readGraphQLErrorDetailMock: vi.fn(),
}));

vi.mock('@/shared/graphql', () => ({
  executeGraphQL: executeGraphQLMock,
  readGraphQLErrorDetail: readGraphQLErrorDetailMock,
}));

import { fetchMyEngineerRegistration } from './my-engineer-registration-adapter';

const APPLICATION = {
  applicationId: 77,
  organizationId: 21,
  organizationName: '示例光刻科技',
  status: 'REJECTED' as const,
  applicationNote: '从事光刻设备维护 5 年',
  submittedAt: '2026-02-01T00:00:00.000Z',
  reviewedAt: '2026-02-02T00:00:00.000Z',
  reviewComment: '请补充公司授权证明',
};

describe('fetchMyEngineerRegistration（受限会话读取本人申请）', () => {
  beforeEach(() => {
    executeGraphQLMock.mockReset();
    readGraphQLErrorDetailMock.mockReset();
  });

  it('以认证请求读取本人申请，不使用缓存', async () => {
    executeGraphQLMock.mockResolvedValue({ myEngineerRegistration: APPLICATION });

    const result = await fetchMyEngineerRegistration();

    expect(result).toEqual(APPLICATION);
    expect(executeGraphQLMock).toHaveBeenCalledWith(
      expect.stringContaining('myEngineerRegistration'),
      {},
      { fetchPolicy: 'no-cache' },
    );
  });

  it('NOT_FOUND 表示没有申请记录，返回 null 而不是抛错', async () => {
    executeGraphQLMock.mockRejectedValue(new Error('application not found'));
    readGraphQLErrorDetailMock.mockReturnValue({ code: 'NOT_FOUND' });

    await expect(fetchMyEngineerRegistration()).resolves.toBeNull();
  });

  it('其他业务失败原样上抛', async () => {
    const failure = new Error('unauthorized');
    executeGraphQLMock.mockRejectedValue(failure);
    readGraphQLErrorDetailMock.mockReturnValue({ code: 'UNAUTHENTICATED' });

    await expect(fetchMyEngineerRegistration()).rejects.toBe(failure);
  });

  it('未知申请状态失败关闭（不把未知枚举值透传给页面）', async () => {
    executeGraphQLMock.mockResolvedValue({
      myEngineerRegistration: { ...APPLICATION, status: 'UNKNOWN' },
    });

    await expect(fetchMyEngineerRegistration()).rejects.toThrow('未知的工程师申请状态');
  });
});
