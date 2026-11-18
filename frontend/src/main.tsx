// src/main.tsx

// 本地字体（SIL OFL，随包 LICENSE 保留）：运行时零字体 CDN。
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';

import React from 'react';
import ReactDOM from 'react-dom/client';

import { bootstrapGraphQLRuntime } from '@/app/bootstrap';
import { GraphQLProvider, I18nProvider, ThemeProvider } from '@/app/providers';
import { App } from '@/app/router';

import { AuthSessionProvider } from '@/features/auth-session';

import './index.css';

bootstrapGraphQLRuntime();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AuthSessionProvider>
      <GraphQLProvider>
        <I18nProvider>
          <ThemeProvider>
            <App />
          </ThemeProvider>
        </I18nProvider>
      </GraphQLProvider>
    </AuthSessionProvider>
  </React.StrictMode>,
);
