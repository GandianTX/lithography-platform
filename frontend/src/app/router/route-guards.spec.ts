// src/app/router/route-guards.spec.ts

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthSessionRestriction, AuthSessionRole } from '@/features/auth-session';
import * as authSessionFeature from '@/features/auth-session';

import { indexRouteLoader, loginLoader, protectedRouteLoader } from './route-guards';

vi.mock('@/features/auth-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/auth-session')>();

  return {
    ...actual,
    getCurrentAuthSession: vi.fn(),
  };
});

const mockedGetCurrentAuthSession = vi.mocked(authSessionFeature.getCurrentAuthSession);

function createSnapshot(
  role: AuthSessionRole,
  restriction: AuthSessionRestriction = 'NONE',
  identity: { adminLevel?: number | null; adminOrganizationId?: number | null } = {},
) {
  return {
    accessToken: 'access-token',
    accountId: 900101,
    adminLevel: identity.adminLevel ?? null,
    customerOrganizationId: null,
    engineerOrganizationId: null,
    adminOrganizationId: identity.adminOrganizationId ?? null,
    registrationOrganizationId: null,
    restriction,
    role,
    userInfo: null,
  };
}

function createLoaderRequest(url: string) {
  return {
    request: new Request(url),
  };
}

function redirectLocation(result: unknown): string | null {
  return result instanceof Response ? result.headers.get('Location') : null;
}

describe('entry route guard wiring', () => {
  beforeEach(() => {
    mockedGetCurrentAuthSession.mockReset();
  });

  it('sends anonymous visitors from the entry route to /login', () => {
    mockedGetCurrentAuthSession.mockReturnValue(null);

    expect(redirectLocation(indexRouteLoader())).toBe('/login');
  });

  it('dispatches authenticated visitors to the role default entry', () => {
    mockedGetCurrentAuthSession.mockReturnValue(createSnapshot('SUPER_ADMIN'));
    expect(redirectLocation(indexRouteLoader())).toBe('/admin');

    mockedGetCurrentAuthSession.mockReturnValue(createSnapshot('ENGINEER'));
    expect(redirectLocation(indexRouteLoader())).toBe('/engineer');

    mockedGetCurrentAuthSession.mockReturnValue(createSnapshot('CUSTOMER'));
    expect(redirectLocation(indexRouteLoader())).toBe('/customer');
  });
});

describe('login route guard wiring', () => {
  beforeEach(() => {
    mockedGetCurrentAuthSession.mockReset();
  });

  it('renders the login page for anonymous visitors', () => {
    mockedGetCurrentAuthSession.mockReturnValue(null);

    expect(loginLoader(createLoaderRequest('http://localhost/login'))).toBeNull();
  });

  it('sends an authenticated visitor away from /login to the role default entry', () => {
    mockedGetCurrentAuthSession.mockReturnValue(createSnapshot('ENGINEER'));

    const result = loginLoader(createLoaderRequest('http://localhost/login'));

    expect(redirectLocation(result)).toBe('/engineer');
  });

  it('adopts a safe in-role returnTo and rejects cross-role or unsafe targets', () => {
    mockedGetCurrentAuthSession.mockReturnValue(createSnapshot('ENGINEER'));

    expect(
      redirectLocation(
        loginLoader(
          createLoaderRequest('http://localhost/login?returnTo=%2Fengineer%3Ftab%3Dopen'),
        ),
      ),
    ).toBe('/engineer?tab=open');
    expect(
      redirectLocation(
        loginLoader(createLoaderRequest('http://localhost/login?returnTo=%2Fadmin')),
      ),
    ).toBe('/engineer');
    expect(
      redirectLocation(
        loginLoader(
          createLoaderRequest('http://localhost/login?returnTo=https%3A%2F%2Fexample.com'),
        ),
      ),
    ).toBe('/engineer');
  });

  it('adopts a same-role sub-page returnTo for the owning role', () => {
    mockedGetCurrentAuthSession.mockReturnValue(createSnapshot('CUSTOMER'));

    expect(
      redirectLocation(
        loginLoader(
          createLoaderRequest(
            'http://localhost/login?returnTo=%2Fcustomer%2Frepair-requests%2Fnew',
          ),
        ),
      ),
    ).toBe('/customer/repair-requests/new');
  });
});

describe('protected route guard wiring', () => {
  beforeEach(() => {
    mockedGetCurrentAuthSession.mockReset();
  });

  it('sends anonymous visitors to /login while keeping the safe original target', () => {
    mockedGetCurrentAuthSession.mockReturnValue(null);

    const result = protectedRouteLoader(createLoaderRequest('http://localhost/admin'));

    expect(redirectLocation(result)).toBe('/login?returnTo=%2Fadmin');
  });

  it('keeps a role sub-page target in the anonymous returnTo', () => {
    mockedGetCurrentAuthSession.mockReturnValue(null);

    const result = protectedRouteLoader(
      createLoaderRequest('http://localhost/customer/repair-requests/new'),
    );

    expect(redirectLocation(result)).toBe('/login?returnTo=%2Fcustomer%2Frepair-requests%2Fnew');
  });

  it('lets the owning role and inherited SUPER_ADMIN visits through', () => {
    mockedGetCurrentAuthSession.mockReturnValue(createSnapshot('ENGINEER'));
    expect(protectedRouteLoader(createLoaderRequest('http://localhost/engineer'))).toBeNull();
    expect(
      protectedRouteLoader(createLoaderRequest('http://localhost/engineer/repair-requests/1')),
    ).toBeNull();

    mockedGetCurrentAuthSession.mockReturnValue(createSnapshot('SUPER_ADMIN'));
    expect(protectedRouteLoader(createLoaderRequest('http://localhost/engineer'))).toBeNull();
    expect(protectedRouteLoader(createLoaderRequest('http://localhost/customer'))).toBeNull();
  });

  it('sends SUPER_ADMIN away from the customer create page despite inheritance', () => {
    // 2026-08-29 负责人裁定：超管第一版不代客户创建，与 ENGINEER 一致跳回各自主页。
    mockedGetCurrentAuthSession.mockReturnValue(createSnapshot('SUPER_ADMIN'));

    expect(
      redirectLocation(
        protectedRouteLoader(createLoaderRequest('http://localhost/customer/repair-requests/new')),
      ),
    ).toBe('/admin');
  });

  it('applies the respective task 08 and document database scopes at the router', () => {
    const load = (path: string) =>
      protectedRouteLoader(createLoaderRequest(`http://localhost${path}`));

    mockedGetCurrentAuthSession.mockReturnValue(
      createSnapshot('SUPER_ADMIN', 'NONE', { adminLevel: 1, adminOrganizationId: 910003 }),
    );
    expect(load('/admin/users')).toBeNull();
    expect(load('/admin/document-database')).toBeNull();

    mockedGetCurrentAuthSession.mockReturnValue(
      createSnapshot('SUPER_ADMIN', 'NONE', { adminLevel: 1 }),
    );
    expect(load('/admin/users')).toBeNull();
    expect(redirectLocation(load('/admin/document-database'))).toBe('/admin');

    mockedGetCurrentAuthSession.mockReturnValue(
      createSnapshot('SUPER_ADMIN', 'NONE', { adminLevel: 2, adminOrganizationId: 910004 }),
    );
    expect(load('/admin/users')).toBeNull();
    expect(load('/admin/companies')).toBeNull();
    expect(load('/admin/engineer-registrations')).toBeNull();
    expect(redirectLocation(load('/admin/document-database'))).toBe('/admin');

    mockedGetCurrentAuthSession.mockReturnValue(createSnapshot('SUPER_ADMIN'));
    expect(redirectLocation(load('/admin/users'))).toBe('/admin');
    expect(redirectLocation(load('/admin/document-database'))).toBe('/admin');
  });

  it('never renders another role content and sends cross-role visitors back home', () => {
    mockedGetCurrentAuthSession.mockReturnValue(createSnapshot('ENGINEER'));

    expect(
      redirectLocation(protectedRouteLoader(createLoaderRequest('http://localhost/admin'))),
    ).toBe('/engineer');
    expect(
      redirectLocation(protectedRouteLoader(createLoaderRequest('http://localhost/customer'))),
    ).toBe('/engineer');
    expect(
      redirectLocation(
        protectedRouteLoader(createLoaderRequest('http://localhost/customer/repair-requests/1')),
      ),
    ).toBe('/engineer');
  });

  it('funnels restricted sessions into /restricted and keeps normal sessions out', () => {
    mockedGetCurrentAuthSession.mockReturnValue(createSnapshot('ENGINEER', 'ENGINEER_PENDING'));

    expect(redirectLocation(indexRouteLoader())).toBe('/restricted');
    expect(
      redirectLocation(protectedRouteLoader(createLoaderRequest('http://localhost/engineer'))),
    ).toBe('/restricted');
    expect(
      redirectLocation(protectedRouteLoader(createLoaderRequest('http://localhost/restricted'))),
    ).toBeNull();

    mockedGetCurrentAuthSession.mockReturnValue(createSnapshot('ENGINEER'));
    expect(
      redirectLocation(protectedRouteLoader(createLoaderRequest('http://localhost/restricted'))),
    ).toBe('/engineer');
  });
});
