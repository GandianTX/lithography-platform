import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig, loadEnv } from 'vite';

const DEFAULT_BUILD_CHUNK_WARNING_LIMIT = 1000;

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  return value === 'true';
}

function parseInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsedValue = Number.parseInt(value, 10);
  return Number.isNaN(parsedValue) ? fallback : parsedValue;
}

function normalizeModuleId(moduleId: string): string {
  return moduleId.replaceAll('\\', '/');
}

function isNodeModulePackage(moduleId: string, packageName: string): boolean {
  const normalizedModuleId = normalizeModuleId(moduleId);

  return (
    normalizedModuleId.includes(`/node_modules/${packageName}/`) ||
    normalizedModuleId.endsWith(`/node_modules/${packageName}`)
  );
}

function isAnyNodeModulePackage(moduleId: string, packageNames: string[]): boolean {
  return packageNames.some((packageName) => isNodeModulePackage(moduleId, packageName));
}

function isNodeModulePackageScope(moduleId: string, packageScope: string): boolean {
  return normalizeModuleId(moduleId).includes(`/node_modules/${packageScope}/`);
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const envDir = path.resolve(__dirname, 'env');
  const env = loadEnv(mode, envDir, '');

  const devServerHost = env.DEV_SERVER_HOST || 'localhost';
  const devServerPort = parseInteger(env.DEV_SERVER_PORT, 5173);
  const devServerStrictPort = parseBoolean(env.DEV_SERVER_STRICT_PORT, false);
  const devApiProxyTarget = env.DEV_API_PROXY_TARGET || 'http://127.0.0.1:3000';
  const buildOutDir = env.BUILD_OUT_DIR || 'dist';
  const buildSourcemap = parseBoolean(env.BUILD_SOURCEMAP, false);
  const buildChunkWarningLimit = parseInteger(
    env.BUILD_CHUNK_WARNING_LIMIT,
    DEFAULT_BUILD_CHUNK_WARNING_LIMIT,
  );

  return {
    envDir,
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      host: devServerHost,
      port: devServerPort,
      strictPort: devServerStrictPort,
      // /graphql 与 /api 同源转发到本地后端：localhost 与端口映射域名均无跨域可用，
      // 不依赖 VITE_GRAPHQL_ENDPOINT 直连；DEV_API_PROXY_TARGET 可覆盖目标后端
      // （/api 为参考资料文件上传/下载 REST 边界，与后端无全局前缀的显式路径一致）
      proxy: {
        '/graphql': {
          target: devApiProxyTarget,
          changeOrigin: true,
        },
        '/api': {
          target: devApiProxyTarget,
          changeOrigin: true,
        },
        // 隔离验收：浏览器同源代理读取后端健康摘要，用于核对代理命中的实例
        '/health': {
          target: devApiProxyTarget,
          changeOrigin: true,
        },
      },
    },
    // vite preview（生产构建本地预览）与 dev server 同源转发，供生产配置下的
    // 验收截图/真机验证使用：preview 跑的是 prod 构建，无 dev 调试菜单
    preview: {
      proxy: {
        '/graphql': {
          target: devApiProxyTarget,
          changeOrigin: true,
        },
        '/api': {
          target: devApiProxyTarget,
          changeOrigin: true,
        },
        // 隔离验收：浏览器同源代理读取后端健康摘要，用于核对代理命中的实例
        '/health': {
          target: devApiProxyTarget,
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir: buildOutDir,
      sourcemap: buildSourcemap,
      chunkSizeWarningLimit: buildChunkWarningLimit,
      rolldownOptions: {
        output: {
          codeSplitting: {
            groups: [
              {
                name: 'vendor-react',
                test: (moduleId) =>
                  isAnyNodeModulePackage(moduleId, ['react', 'react-dom', 'scheduler']),
                priority: 50,
              },
              {
                name: 'vendor-antd-color',
                test: (moduleId) =>
                  isAnyNodeModulePackage(moduleId, [
                    '@ant-design/fast-color',
                    '@rc-component/color-picker',
                  ]),
                priority: 48,
              },
              {
                name: 'vendor-antd-icons',
                test: (moduleId) =>
                  isAnyNodeModulePackage(moduleId, ['@ant-design/icons', '@ant-design/icons-svg']),
                priority: 47,
              },
              {
                name: 'vendor-antd-style',
                test: (moduleId) =>
                  isAnyNodeModulePackage(moduleId, [
                    '@ant-design/colors',
                    '@ant-design/cssinjs',
                    '@ant-design/cssinjs-utils',
                  ]),
                priority: 46,
              },
              {
                name: 'vendor-rc',
                test: (moduleId) =>
                  isNodeModulePackageScope(moduleId, '@rc-component') ||
                  isAnyNodeModulePackage(moduleId, [
                    'rc-cascader',
                    'rc-checkbox',
                    'rc-collapse',
                    'rc-dialog',
                    'rc-dropdown',
                    'rc-field-form',
                    'rc-image',
                    'rc-input',
                    'rc-input-number',
                    'rc-mentions',
                    'rc-menu',
                    'rc-motion',
                    'rc-notification',
                    'rc-pagination',
                    'rc-picker',
                    'rc-progress',
                    'rc-rate',
                    'rc-resize-observer',
                    'rc-segmented',
                    'rc-select',
                    'rc-slider',
                    'rc-steps',
                    'rc-switch',
                    'rc-table',
                    'rc-tabs',
                    'rc-textarea',
                    'rc-tooltip',
                    'rc-tree',
                    'rc-tree-select',
                    'rc-upload',
                    'rc-util',
                    'rc-virtual-list',
                  ]),
                priority: 45,
              },
              {
                name: 'vendor-antd',
                test: (moduleId) => isNodeModulePackage(moduleId, 'antd'),
                priority: 40,
              },
              {
                name: 'vendor-graphql',
                test: (moduleId) =>
                  isAnyNodeModulePackage(moduleId, ['@apollo/client', 'graphql', 'graphql-ws']),
                priority: 35,
              },
            ],
          },
        },
      },
    },
  };
});
