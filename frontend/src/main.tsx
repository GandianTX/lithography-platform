// src/main.tsx

// 本地字体（SIL OFL，随包 LICENSE 保留）：运行时零字体 CDN。
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';

import React from 'react';
import ReactDOM from 'react-dom/client';

import { bootstrapGraphQLRuntime } from '@/app/bootstrap';
import { GraphQLProvider, I18nProvider, ThemeProvider } from '@/app/providers';
import { App } from '@/app/router';

import {
  AuthSessionProvider,
  ensureWebSessionRestored,
  startAuthSessionCrossTabSync,
} from '@/features/auth-session';

import './index.css';

bootstrapGraphQLRuntime();

// 浏览器会话开启时，提前发起一次共享恢复（路由 loader 会 await 同一个 Promise，
// 把网络往返藏在首屏装配之后）；功能关闭时立即返回，行为与改造前一致。
void ensureWebSessionRestored();

// 跨标签会话同步：只接收「退出 / 换账号」事件，不含任何凭据
startAuthSessionCrossTabSync();

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
