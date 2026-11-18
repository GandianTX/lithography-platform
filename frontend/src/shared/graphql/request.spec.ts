// src/shared/graphql/request.spec.ts

import { CombinedGraphQLErrors, ServerError } from '@apollo/client/errors';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { configureGraphQLRuntime, getGraphQLClient } from './client';
import { GraphQLIngressError } from './errors';
import { executeGraphQL } from './request';

vi.mock('./client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./client')>();

  return {
    ...actual,
    getGraphQLClient: vi.fn(),
  };
});

const mockedGetGraphQLClient = vi.mocked(getGraphQLClient);

function useFakeClient(queryError: unknown) {
  mockedGetGraphQLClient.mockReturnValue({
    query: vi.fn().mockRejectedValue(queryError),
  } as never);
}

function createUnauthenticatedError() {
  return new CombinedGraphQLErrors({
    errors: [{ extensions: { code: 'UNAUTHENTICATED' }, message: 'Unauthorized' }],
  });
}

describe('executeGraphQL auth failure signaling', () => {
  afterEach(() => {
    configureGraphQLRuntime({
      getAccessToken: () => null,
      onAuthFailure: undefined,
      refreshSession: undefined,
    });
    vi.clearAllMocks();
  });

  it('announces auth failure once when no refreshSession is configured', async () => {
    const onAuthFailure = vi.fn();
    configureGraphQLRuntime({ getAccessToken: () => 'token', onAuthFailure });
    useFakeClient(createUnauthenticatedError());

    await expect(executeGraphQL('query Probe { viewer { id } }', {})).rejects.toMatchObject({
      type: 'auth',
    });

    expect(onAuthFailure).toHaveBeenCalledTimes(1);
  });

  it('announces auth failure when the injected refreshSession rejects', async () => {
    const onAuthFailure = vi.fn();
    const refreshSession = vi.fn().mockRejectedValue(new Error('refresh failed'));
    configureGraphQLRuntime({ getAccessToken: () => 'token', onAuthFailure, refreshSession });
    useFakeClient(createUnauthenticatedError());

    await expect(executeGraphQL('query Probe { viewer { id } }', {})).rejects.toMatchObject({
      type: 'auth',
    });

    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(onAuthFailure).toHaveBeenCalledTimes(1);
  });

  it('does not announce auth failure for public requests or non-auth errors', async () => {
    const onAuthFailure = vi.fn();
    configureGraphQLRuntime({ getAccessToken: () => 'token', onAuthFailure });

    useFakeClient(createUnauthenticatedError());
    await expect(
      executeGraphQL('query Login { login { accessToken } }', {}, { authMode: 'none' }),
    ).rejects.toMatchObject({ type: 'auth' });

    useFakeClient(
      new ServerError('Server error', {
        bodyText: 'boom',
        response: new Response('boom', { status: 500, statusText: 'Internal Server Error' }),
      }),
    );
    await expect(executeGraphQL('query Probe { viewer { id } }', {})).rejects.toBeInstanceOf(
      GraphQLIngressError,
    );

    expect(onAuthFailure).not.toHaveBeenCalled();
  });
});

/**
 * 含凭据的 mutation 必须走可验证的无缓存路径：
 * 强制点在 transport 层，而不是各个 feature 自己记得传 `fetchPolicy`。
 */
describe('executeGraphQL cache policy', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  function useRecordingClient(data: unknown) {
    const mutate = vi.fn().mockResolvedValue({ data });
    const query = vi.fn().mockResolvedValue({ data });

    mockedGetGraphQLClient.mockReturnValue({ mutate, query } as never);

    return { mutate, query };
  }

  it('mutation 强制 no-cache，调用方传入其它策略也不生效', async () => {
    const { mutate } = useRecordingClient({ adminReissueCompanyAdminCredential: { ok: true } });

    await executeGraphQL(
      'mutation Probe($input: Int!) { probe(input: $input) { ok } }',
      { input: 1 },
      { fetchPolicy: 'cache-first' },
    );

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ fetchPolicy: 'no-cache' }));
  });

  it('query 缺省同样走 no-cache', async () => {
    const { query } = useRecordingClient({ viewer: { id: 1 } });

    await executeGraphQL('query Probe { viewer { id } }', {});

    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(expect.objectContaining({ fetchPolicy: 'no-cache' }));
  });
});
