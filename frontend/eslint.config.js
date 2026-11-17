import js from '@eslint/js';
import boundaries from 'eslint-plugin-boundaries';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import tseslint from 'typescript-eslint';
import { defineConfig, globalIgnores } from 'eslint/config';

const localRules = {
  'no-design-system-classname': {
    meta: {
      type: 'problem',
      docs: {
        description:
          'Disallow className on Ant Design and Ant Design X component bodies; use wrappers instead.',
      },
      schema: [],
      messages: {
        noClassName:
          'Do not attach `className` to {{component}} from {{source}}. Tailwind must stay on wrapper elements.',
      },
    },
    create(context) {
      const imports = new Map();

      function getTagInfo(nameNode) {
        if (nameNode.type === 'JSXIdentifier') {
          const source = imports.get(nameNode.name);
          if (source) {
            return { source, root: nameNode.name, component: nameNode.name };
          }
        }

        if (
          nameNode.type === 'JSXMemberExpression' &&
          nameNode.object.type === 'JSXIdentifier' &&
          nameNode.property.type === 'JSXIdentifier'
        ) {
          const source = imports.get(nameNode.object.name);
          if (source) {
            return {
              source,
              root: nameNode.object.name,
              component: `${nameNode.object.name}.${nameNode.property.name}`,
            };
          }
        }

        return null;
      }

      return {
        ImportDeclaration(node) {
          if (node.source.value !== 'antd' && node.source.value !== '@ant-design/x') {
            return;
          }

          for (const specifier of node.specifiers) {
            if (specifier.type === 'ImportSpecifier') {
              imports.set(specifier.local.name, node.source.value);
            }
          }
        },
        JSXOpeningElement(node) {
          const tagInfo = getTagInfo(node.name);

          if (!tagInfo) {
            return;
          }

          if (tagInfo.source === 'antd' && tagInfo.root === 'Flex') {
            return;
          }

          const classNameAttribute = node.attributes.find(
            (attribute) =>
              attribute.type === 'JSXAttribute' &&
              attribute.name.type === 'JSXIdentifier' &&
              attribute.name.name === 'className',
          );

          if (!classNameAttribute) {
            return;
          }

          context.report({
            node: classNameAttribute,
            messageId: 'noClassName',
            data: {
              component: tagInfo.component,
              source: tagInfo.source,
            },
          });
        },
      };
    },
  },
  'no-tailwind-magic-colors': {
    meta: {
      type: 'problem',
      docs: {
        description: 'Disallow magic color values inside JSX className strings.',
      },
      schema: [],
      messages: {
        noMagicColor:
          'Do not use magic color values in `className`. Use shared tokens or CSS variables instead.',
      },
    },
    create(context) {
      const magicColorPattern = /#[0-9a-fA-F]{3,8}|\b(?:rgb|hsl)a?\s*\(/;

      function getStaticClassNameValue(attributeValue) {
        if (!attributeValue) {
          return null;
        }

        if (attributeValue.type === 'Literal' && typeof attributeValue.value === 'string') {
          return attributeValue.value;
        }

        if (
          attributeValue.type === 'JSXExpressionContainer' &&
          attributeValue.expression.type === 'Literal' &&
          typeof attributeValue.expression.value === 'string'
        ) {
          return attributeValue.expression.value;
        }

        if (
          attributeValue.type === 'JSXExpressionContainer' &&
          attributeValue.expression.type === 'TemplateLiteral' &&
          attributeValue.expression.expressions.length === 0
        ) {
          return attributeValue.expression.quasis.map((quasi) => quasi.value.cooked ?? '').join('');
        }

        return null;
      }

      return {
        JSXAttribute(node) {
          if (node.name.type !== 'JSXIdentifier' || node.name.name !== 'className') {
            return;
          }

          const classNameValue = getStaticClassNameValue(node.value);
          if (!classNameValue) {
            return;
          }

          if (!magicColorPattern.test(classNameValue)) {
            return;
          }

          context.report({
            node,
            messageId: 'noMagicColor',
          });
        },
      };
    },
  },
  'no-inline-zindex': {
    meta: {
      type: 'problem',
      docs: {
        description: 'Disallow raw inline zIndex values; use semantic layer tokens instead.',
      },
      schema: [],
      messages: {
        noInlineZIndex:
          'Do not set raw `zIndex` inline. Use semantic layer tokens or shared style variables.',
      },
    },
    create(context) {
      return {
        JSXAttribute(node) {
          if (node.name.type !== 'JSXIdentifier' || node.name.name !== 'style') {
            return;
          }

          if (!node.value || node.value.type !== 'JSXExpressionContainer') {
            return;
          }

          const expression = node.value.expression;
          if (expression.type !== 'ObjectExpression') {
            return;
          }

          for (const property of expression.properties) {
            if (property.type !== 'Property') {
              continue;
            }

            const keyName =
              property.key.type === 'Identifier'
                ? property.key.name
                : property.key.type === 'Literal'
                  ? property.key.value
                  : null;

            if (keyName !== 'zIndex') {
              continue;
            }

            context.report({
              node: property,
              messageId: 'noInlineZIndex',
            });
          }
        },
      };
    },
  },
};

// 跨模块深引禁用的 glob 组：主配置与 application 层的附加约束共用同一份清单，
// 避免两处各写一遍后漂移。
const CROSS_MODULE_DEEP_IMPORT_GROUPS = [
  '@/app/*/*',
  '@/pages/*/*',
  '@/widgets/*/*',
  '@/features/*/*',
  '@/entities/*/*',
  '@/labs/*/*',
  '@/sandbox/*/*',
  '**/app/*/*',
  '**/pages/*/*',
  '**/widgets/*/*',
  '**/features/*/*',
  '**/entities/*/*',
  '**/labs/*/*',
  '**/sandbox/*/*',
];

export default defineConfig([
  globalIgnores(['dist', 'docs/backend/**']),
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      boundaries,
      local: { rules: localRules },
      'simple-import-sort': simpleImportSort,
    },
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    settings: {
      'import/resolver': {
        typescript: {
          project: './tsconfig.app.json',
        },
      },
      'boundaries/elements': [
        { type: 'app', pattern: 'src/app/*', mode: 'folder', capture: ['moduleName'] },
        { type: 'pages', pattern: 'src/pages/*', mode: 'folder', capture: ['moduleName'] },
        { type: 'widgets', pattern: 'src/widgets/*', mode: 'folder', capture: ['moduleName'] },
        { type: 'features', pattern: 'src/features/*', mode: 'folder', capture: ['moduleName'] },
        { type: 'entities', pattern: 'src/entities/*', mode: 'folder', capture: ['moduleName'] },
        { type: 'shared', pattern: 'src/shared/*', mode: 'folder', capture: ['moduleName'] },
        { type: 'labs', pattern: 'src/labs/*', mode: 'folder', capture: ['moduleName'] },
        {
          type: 'sandbox',
          pattern: 'src/sandbox/*',
          mode: 'folder',
          capture: ['moduleName'],
        },
      ],
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          message:
            'Import violates boundary rules. 请查阅 docs/dependency-rules.md。 如需例外，必须先人工评审并记录到对应 labs 模块的 meta.ts exception。禁止用深层 import 或相对路径绕过规则。',
          rules: [
            {
              from: { type: 'app' },
              allow: [
                { to: { type: 'app' } },
                { to: { type: ['pages', 'widgets', 'features', 'entities', 'shared'] } },
                {
                  from: { captured: { moduleName: 'router' } },
                  to: { type: ['labs', 'sandbox'] },
                },
              ],
            },
            {
              from: { type: 'pages' },
              allow: [
                { to: { type: 'pages', captured: { moduleName: '{{from.moduleName}}' } } },
                { to: { type: ['widgets', 'features', 'entities', 'shared'] } },
              ],
            },
            {
              from: { type: 'widgets' },
              allow: [
                { to: { type: 'widgets', captured: { moduleName: '{{from.moduleName}}' } } },
                { to: { type: ['features', 'entities', 'shared'] } },
              ],
            },
            {
              from: { type: 'features' },
              allow: [
                {
                  to: { type: 'features', captured: { moduleName: '{{from.moduleName}}' } },
                },
                { to: { type: ['entities', 'shared'] } },
              ],
            },
            {
              from: { type: 'entities' },
              allow: [
                {
                  to: { type: 'entities', captured: { moduleName: '{{from.moduleName}}' } },
                },
                { to: { type: 'shared' } },
              ],
            },
            {
              from: { type: 'shared' },
              allow: [{ to: { type: 'shared' } }],
            },
            {
              from: { type: 'labs' },
              allow: [
                // labs 依赖 entities 时仍受 no-restricted-imports 约束，只能使用 @/entities/<name> 公开入口
                { to: { type: 'labs', captured: { moduleName: '{{from.moduleName}}' } } },
                { to: { type: ['shared', 'entities'] } },
              ],
            },
            {
              from: { type: 'sandbox' },
              allow: [
                // sandbox 依赖 entities 时仍受 no-restricted-imports 约束，只能使用 @/entities/<name> 公开入口
                {
                  to: { type: 'sandbox', captured: { moduleName: '{{from.moduleName}}' } },
                },
                { to: { type: ['shared', 'entities'] } },
              ],
            },
          ],
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: CROSS_MODULE_DEEP_IMPORT_GROUPS,
              message:
                'Cross-module imports must use a module public API such as "@/entities/user". 如认为确需例外，请先人工评审；不要用深层 import 绕过规则。',
            },
          ],
        },
      ],
      'simple-import-sort/imports': [
        'error',
        {
          groups: [
            ['^\\u0000'],
            ['^react$', '^react-dom$', '^@?\\w'],
            ['^@/app(?:/.*|$)'],
            ['^@/pages(?:/.*|$)', '^@/widgets(?:/.*|$)', '^@/features(?:/.*|$)'],
            ['^@/entities(?:/.*|$)'],
            ['^@/shared(?:/.*|$)'],
            ['^@/labs(?:/.*|$)', '^@/sandbox(?:/.*|$)'],
            ['^\\.\\.(?!/?$)', '^\\.\\./?$'],
            ['^\\./(?=.*/)(?!/?$)', '^\\.(?!/?$)', '^\\./?$'],
            ['^.+\\.css$'],
          ],
        },
      ],
      'simple-import-sort/exports': 'error',
      'local/no-design-system-classname': 'error',
      'local/no-tailwind-magic-colors': 'error',
      'local/no-inline-zindex': 'error',
    },
  },
  {
    // application 层不得依赖具体 UI 组件实现
    // （frontend/docs/stable-clean/architecture.md「最小落地规则」第 6 条）。
    // ui 反馈由 ui 层消费，或经窄 port（src/shared/feedback）注入；
    // 本块同时保留跨模块深引约束，避免覆盖主配置后失去该检查。
    files: ['src/features/*/application/**/*.{ts,tsx}', 'src/entities/*/application/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'antd',
              message:
                'application 不得依赖具体 UI 组件实现（frontend/docs/stable-clean/architecture.md 最小落地规则第 6 条）。请在 ui 层消费反馈，或经 src/shared/feedback 的窄 port 注入。',
            },
          ],
          patterns: [
            {
              group: ['antd/*', '@ant-design/*'],
              message:
                'application 不得依赖具体 UI 组件实现（frontend/docs/stable-clean/architecture.md 最小落地规则第 6 条）。请在 ui 层消费反馈，或经 src/shared/feedback 的窄 port 注入。',
            },
            {
              group: CROSS_MODULE_DEEP_IMPORT_GROUPS,
              message:
                'Cross-module imports must use a module public API such as "@/entities/user". 如认为确需例外，请先人工评审；不要用深层 import 绕过规则。',
            },
          ],
        },
      ],
    },
  },
  {
    // 视觉截图机械约束（PR5 P2-2）：e2e spec 一律经 e2e/helpers/visual-evidence.ts 的
    // captureStableViewport 采集全视口证据（工作区干净断言 / 滚动复位 / 布局稳定 / 元数据），
    // 禁止直接调用 page.screenshot()。helper 位于 e2e/helpers/（非 spec），不在本块范围内；
    // 已登记的局部 clip 例外见下一块与 frontend/docs/testing.md 例外登记表。
    files: ['e2e/**/*.spec.ts', 'e2e-real/**/*.spec.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          message:
            '禁止在 spec 中直接调用 page.screenshot()：全视口视觉证据必须经 e2e/helpers/visual-evidence.ts 的 captureStableViewport 采集。如属已登记的局部 clip 例外，请先在 frontend/docs/testing.md 登记表登记，并在 eslint.config.js 对应 override 中放行。',
          selector: 'CallExpression[callee.object.name="page"][callee.property.name="screenshot"]',
        },
      ],
    },
  },
  {
    // P2-2 已登记局部 clip 例外（frontend/docs/testing.md 例外登记表）：仅知识库视觉 spec 的
    // 「表头 + 一行正文」clip 合成图允许带 clip 直调 page.screenshot；同文件内无 clip 的
    // 全视口直调仍被禁止（同名规则整块覆盖上一块：本块即该文件的完整配置）。
    files: ['e2e/admin-document-database-visual.spec.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          message:
            'admin 视觉 spec 仅允许已登记的表头+首行 clip 例外带 clip 直调 page.screenshot；全视口截图必须经 captureStableViewport（见 frontend/docs/testing.md 例外登记表）。',
          selector:
            'CallExpression[callee.object.name="page"][callee.property.name="screenshot"]:not(:has(Property[key.name="clip"]))',
        },
      ],
    },
  },
  {
    // 已登记预提交实现截图例外（frontend/docs/testing.md 例外登记表）：任务 08 · S2/S3/S4/S5 检查轮
    // 与任务 02 · B 审查 R2 补证的证据在未提交工作区采集，captureStableViewport 的干净工作区门禁
    // 不成立；这些 spec 已在登记表登记，截图前统一调用 prepareStableViewport()，提交后须以
    // captureStableViewport 重采。
    files: [
      'e2e-real/admin-companies-real.spec.ts',
      'e2e-real/admin-engineer-approval-real.spec.ts',
      'e2e-real/admin-s4-credential-visual-real.spec.ts',
      'e2e-real/admin-s5-visual-real.spec.ts',
      'e2e-real/admin-user-management-real.spec.ts',
      'e2e-real/task02-b-review-visual-real.spec.ts',
    ],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
]);
