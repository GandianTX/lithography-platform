// src/features/auth-session/ui/auth-session-provider.spec.tsx

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { authSessionStore } from '../auth-session-entry';

import { useAuthSession } from './auth-session-context';
import { AuthSessionProvider } from './auth-session-provider';

function SessionProbe() {
  const sessionState = useAuthSession();

  return <output data-testid="session-probe">{JSON.stringify(sessionState)}</output>;
}

function readProbeState() {
  return JSON.parse(screen.getByTestId('session-probe').textContent ?? '');
}

describe('AuthSessionProvider', () => {
  afterEach(() => {
    authSessionStore.clearSession();
    window.sessionStorage.clear();
    cleanup();
  });

  it('starts anonymous and follows the session store without exposing the access token', async () => {
    render(
      <AuthSessionProvider>
        <SessionProbe />
      </AuthSessionProvider>,
    );

    expect(readProbeState()).toEqual({ session: null, status: 'anonymous' });

    authSessionStore.establishSession({
      accessToken: 'test-only-access-token',
      accountId: 900101,
      role: 'ENGINEER',
      userInfo: null,
    });

    await waitFor(() => {
      expect(readProbeState().status).toBe('authenticated');
    });

    const probeState = readProbeState();
    expect(probeState.session).toEqual({
      accountId: 900101,
      adminLevel: null,
      customerOrganizationId: null,
      restriction: 'NONE',
      role: 'ENGINEER',
      userInfo: null,
    });
    expect(screen.getByTestId('session-probe').textContent).not.toContain('test-only-access-token');

    authSessionStore.clearSession();

    await waitFor(() => {
      expect(readProbeState()).toEqual({ session: null, status: 'anonymous' });
    });
  });
});

describe('useAuthSession', () => {
  it('throws outside of AuthSessionProvider instead of reading an empty context', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      expect(() => render(<SessionProbe />)).toThrow(
        'useAuthSession must be used within AuthSessionProvider.',
      );
    } finally {
      errorSpy.mockRestore();
      cleanup();
    }
  });
});
