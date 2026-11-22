// @ts-check
import eslint from '@eslint/js';
import eslintPluginBoundaries from 'eslint-plugin-boundaries';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import path from 'node:path';
import tseslint from 'typescript-eslint';

const PROJECT_ROOT = import.meta.dirname;
const ADAPTERS_ROOT = path.join(PROJECT_ROOT, 'src', 'adapters');
const BOOTSTRAPS_ROOT = path.join(PROJECT_ROOT, 'src', 'bootstraps');
const CORE_ROOT = path.join(PROJECT_ROOT, 'src', 'core');
const GRAPHQL_SCHEMA_ROOT = path.join(PROJECT_ROOT, 'src', 'adapters', 'api', 'graphql', 'schema');
const INFRASTRUCTURE_ROOT = path.join(PROJECT_ROOT, 'src', 'infrastructure');
const MODULES_ROOT = path.join(PROJECT_ROOT, 'src', 'modules');
const TYPES_ROOT = path.join(PROJECT_ROOT, 'src', 'types');
const USECASES_ROOT = path.join(PROJECT_ROOT, 'src', 'usecases');
const SRC_ROOT = path.join(PROJECT_ROOT, 'src');
const RESTRICTED_SRC_TYPES_IMPORT_PATTERNS = ['src/types/**', '@src/types/**', '**/src/types/**'];
const MODULES_CONTRACTS_ELEMENT_PATTERNS = [
  // Module-scope root contracts, e.g. src/modules/account/account.contract.ts.
  'src/modules/*/*.contract.ts',
  // Nested module-owned contracts, e.g. src/modules/common/email-dispatch/email-dispatch.contract.ts.
  'src/modules/*/**/*.contract.ts',
];
const USECASES_CONTRACTS_ELEMENT_PATTERNS = [
  'src/usecases/*/*.contract.ts',
  'src/usecases/*/**/*.contract.ts',
];
const BOUNDARY_CONTRACT_FILE_PATH_PATTERN = /(^|[/\\])[^/\\]+\.contract(?:\.ts)?$/;
const ENTITY_FILE_PATH_PATTERN = /(^|[/\\])[^/\\]+\.entity(?:\.ts)?$/;
const GRAPHQL_ADAPTER_ROOT = path.join(PROJECT_ROOT, 'src', 'adapters', 'api', 'graphql');
const ENTITY_FORBIDDEN_IMPORT_SOURCES = new Set([
  '@nestjs/common',
  '@nestjs/graphql',
  '@nestjs/swagger',
  'class-transformer',
  'class-validator',
]);
const ENTITY_FORBIDDEN_DECORATOR_NAMES = new Set([
  'ApiHideProperty',
  'ApiOperation',
  'ApiProperty',
  'ApiPropertyOptional',
  'ApiResponse',
  'ApiTags',
  'ArgsType',
  'Catch',
  'Controller',
  'Delete',
  'Exclude',
  'Expose',
  'Field',
  'Get',
  'HideField',
  'InputType',
  'InterfaceType',
  'IsArray',
  'IsBoolean',
  'IsDate',
  'IsEmail',
  'IsEnum',
  'IsInt',
  'IsNumber',
  'IsOptional',
  'IsString',
  'IsUrl',
  'IsUUID',
  'Length',
  'Matches',
  'MaxLength',
  'MinLength',
  'Mutation',
  'ObjectType',
  'Patch',
  'Post',
  'Put',
  'Query',
  'Resolver',
  'Subscription',
  'Transform',
  'Type',
  'UseGuards',
  'UseInterceptors',
  'UsePipes',
  'ValidateNested',
]);
const GRAPHQL_SCHEMA_REGISTRATION_FUNCTION_NAMES = new Set([
  'registerEnumType',
  'registerScalarType',
]);
const GRAPHQL_ADAPTER_DECORATOR_NAMES = new Set([
  'Args',
  'ArgsType',
  'Context',
  'Field',
  'HideField',
  'InputType',
  'InterfaceType',
  'Mutation',
  'ObjectType',
  'Parent',
  'Query',
  'ResolveField',
  'Resolver',
  'Root',
  'Subscription',
]);
const RUNTIME_CONFIG_IMPORT_NAMES = new Set(['ConfigModule', 'ConfigService']);
const TRANSACTION_MANAGER_ORM_METHODS = new Set([
  'createQueryBuilder',
  'delete',
  'getRepository',
  'insert',
  'query',
  'save',
  'update',
]);

/**
 * @param {string} targetPath
 * @param {string} rootPath
 * @returns {boolean}
 */
function isPathInside(targetPath, rootPath) {
  const relative = path.relative(rootPath, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
function isBoundaryPortFilePath(filePath) {
  return /\.ports?\.ts$/.test(filePath);
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
function isEntityFilePath(filePath) {
  return ENTITY_FILE_PATH_PATTERN.test(filePath);
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
function isQueryServiceFilePath(filePath) {
  return /(^|[/\\])[^/\\]+\.query\.service(?:\.ts)?$/.test(filePath);
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
function isUsecaseImplementationFilePath(filePath) {
  return /(^|[/\\])[^/\\]+\.usecase(?:\.ts)?$/.test(filePath);
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
function isUsecaseTypesFilePath(filePath) {
  return /(^|[/\\])[^/\\]+\.types(?:\.ts)?$/.test(filePath);
}

/**
 * @param {import('estree').ImportDeclaration & { importKind?: string }} node
 * @param {import('estree').ImportDeclaration['specifiers'][number] & { importKind?: string }} specifier
 * @returns {boolean}
 */
function isTypeOnlyImportSpecifier(node, specifier) {
  return (
    node.importKind === 'type' ||
    (specifier.type === 'ImportSpecifier' && specifier.importKind === 'type')
  );
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
function isMixedServiceFilePath(filePath) {
  const resolved = path.resolve(filePath);
  if (!isPathInside(resolved, MODULES_ROOT)) {
    return false;
  }
  const normalized = resolved.split(path.sep).join('/');
  if (normalized.includes('/services/') || normalized.includes('/service/')) {
    return true;
  }
  const fileName = path.basename(resolved);
  return (
    (fileName.endsWith('.service') || fileName.endsWith('.service.ts')) &&
    !isQueryServiceFilePath(resolved)
  );
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
function isTestFilePath(filePath) {
  const normalized = path.resolve(filePath).split(path.sep).join('/');
  return (
    normalized.includes('/test/') ||
    /\.spec\.ts$/.test(normalized) ||
    /\.test\.ts$/.test(normalized)
  );
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
function isModuleFilePath(filePath) {
  return /(^|[/\\])[^/\\]+\.module(?:\.ts)?$/.test(filePath);
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
function isRuntimeConfigImportAllowedFilePath(filePath) {
  const resolved = path.resolve(filePath);
  if (
    isPathInside(resolved, INFRASTRUCTURE_ROOT) ||
    isPathInside(resolved, BOOTSTRAPS_ROOT) ||
    isTestFilePath(resolved)
  ) {
    return true;
  }
  return (
    isModuleFilePath(resolved) &&
    (isPathInside(resolved, MODULES_ROOT) || isPathInside(resolved, ADAPTERS_ROOT))
  );
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
function isProcessEnvAllowedFilePath(filePath) {
  const resolved = path.resolve(filePath);
  return (
    isPathInside(resolved, INFRASTRUCTURE_ROOT) ||
    isPathInside(resolved, BOOTSTRAPS_ROOT) ||
    isTestFilePath(resolved)
  );
}

/**
 * @param {import('estree').Node} node
 * @returns {string | null}
 */
function getStaticPropertyName(node) {
  if (node.type !== 'MemberExpression') {
    return null;
  }
  if (!node.computed && node.property.type === 'Identifier') {
    return node.property.name;
  }
  if (
    node.computed &&
    node.property.type === 'Literal' &&
    typeof node.property.value === 'string'
  ) {
    return node.property.value;
  }
  return null;
}

/**
 * @param {import('@typescript-eslint/types').TSESTree.Decorator} node
 * @returns {string | null}
 */
function getDecoratorName(node) {
  const expression = node.expression;
  if (expression.type === 'Identifier') {
    return expression.name;
  }
  if (expression.type === 'CallExpression') {
    const callee = expression.callee;
    if (callee.type === 'Identifier') {
      return callee.name;
    }
    if (callee.type === 'MemberExpression') {
      return getStaticPropertyName(
        /** @type {import('estree').Node} */ (/** @type {unknown} */ (callee)),
      );
    }
  }
  if (expression.type === 'MemberExpression') {
    return getStaticPropertyName(
      /** @type {import('estree').Node} */ (/** @type {unknown} */ (expression)),
    );
  }
  return null;
}

/**
 * @param {string} fromFile
 * @param {string} specifier
 * @returns {string | null}
 */
function resolveInternalImport(fromFile, specifier) {
  if (specifier.startsWith('.')) {
    return path.resolve(path.dirname(fromFile), specifier);
  }
  if (specifier.startsWith('@src/')) {
    return path.resolve(PROJECT_ROOT, 'src', specifier.slice('@src/'.length));
  }
  if (specifier.startsWith('@core/')) {
    return path.resolve(PROJECT_ROOT, 'src', 'core', specifier.slice('@core/'.length));
  }
  if (specifier.startsWith('@app-types/')) {
    return path.resolve(PROJECT_ROOT, 'src', 'types', specifier.slice('@app-types/'.length));
  }
  if (specifier.startsWith('@adapters/')) {
    return path.resolve(PROJECT_ROOT, 'src', 'adapters', specifier.slice('@adapters/'.length));
  }
  if (specifier.startsWith('@modules/')) {
    return path.resolve(PROJECT_ROOT, 'src', 'modules', specifier.slice('@modules/'.length));
  }
  if (specifier.startsWith('@usecases/')) {
    return path.resolve(PROJECT_ROOT, 'src', 'usecases', specifier.slice('@usecases/'.length));
  }
  if (specifier.startsWith('src/')) {
    return path.resolve(PROJECT_ROOT, specifier);
  }
  return null;
}

/**
 * @param {string} filePath
 * @returns {string | null}
 */
function getUsecaseScope(filePath) {
  if (!isPathInside(filePath, USECASES_ROOT)) {
    return null;
  }
  const [scope] = path.relative(USECASES_ROOT, filePath).split(path.sep);
  return scope && scope !== '..' ? scope : null;
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
function isCommonUsecaseBoundaryContractFilePath(filePath) {
  if (!isPathInside(filePath, USECASES_ROOT)) {
    return false;
  }
  const relative = path.relative(USECASES_ROOT, filePath);
  return (
    relative.startsWith(`common${path.sep}`) &&
    (relative.endsWith('.contract') || relative.endsWith('.contract.ts'))
  );
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
function isAnyUsecaseBoundaryContractFilePath(filePath) {
  const resolved = path.resolve(filePath);
  return (
    isPathInside(resolved, USECASES_ROOT) && BOUNDARY_CONTRACT_FILE_PATH_PATTERN.test(resolved)
  );
}

/**
 * @param {string} filePath
 * @returns {string | null}
 */
function getModuleScope(filePath) {
  if (!isPathInside(filePath, MODULES_ROOT)) {
    return null;
  }
  const [scope] = path.relative(MODULES_ROOT, filePath).split(path.sep);
  return scope && scope !== '..' ? scope : null;
}

/**
 * Must stay aligned with the boundaries plugin modules-contracts element
 * patterns above so local architecture rules and boundaries/dependencies
 * agree on which module files are boundary contracts.
 * @param {string} filePath
 * @returns {boolean}
 */
function isModuleBoundaryContractFilePath(filePath) {
  const resolved = path.resolve(filePath);
  return isPathInside(resolved, MODULES_ROOT) && BOUNDARY_CONTRACT_FILE_PATH_PATTERN.test(resolved);
}

/**
 * @param {import('eslint').Rule.RuleContext} context
 * @param {import('estree').Node & { source?: { value?: unknown } }} node
 * @param {(specifier: string, targetPath: string) => void} onResolvedImport
 * @returns {void}
 */
function checkStaticImportLikeNode(context, node, onResolvedImport) {
  const specifier = typeof node.source?.value === 'string' ? node.source.value : null;
  if (!specifier) {
    return;
  }
  const fromFile = context.filename;
  const targetPath = resolveInternalImport(fromFile, specifier);
  if (!targetPath) {
    return;
  }
  onResolvedImport(specifier, targetPath);
}

/**
 * @param {import('eslint').Rule.RuleContext} context
 * @param {import('estree').CallExpression} node
 * @param {(specifier: string, targetPath: string) => void} onResolvedImport
 * @returns {void}
 */
function checkRequireCallNode(context, node, onResolvedImport) {
  if (node.callee.type !== 'Identifier' || node.callee.name !== 'require') {
    return;
  }
  const firstArg = node.arguments[0];
  if (!firstArg || firstArg.type !== 'Literal' || typeof firstArg.value !== 'string') {
    return;
  }
  const specifier = firstArg.value;
  const fromFile = context.filename;
  const targetPath = resolveInternalImport(fromFile, specifier);
  if (!targetPath) {
    return;
  }
  onResolvedImport(specifier, targetPath);
}

/**
 * @param {import('eslint').Rule.RuleContext} context
 * @param {import('estree').ImportExpression} node
 * @param {(specifier: string, targetPath: string) => void} onResolvedImport
 * @returns {void}
 */
function checkImportExpressionNode(context, node, onResolvedImport) {
  if (node.source.type !== 'Literal' || typeof node.source.value !== 'string') {
    return;
  }
  const specifier = node.source.value;
  const fromFile = context.filename;
  const targetPath = resolveInternalImport(fromFile, specifier);
  if (!targetPath) {
    return;
  }
  onResolvedImport(specifier, targetPath);
}

const localArchitecturePlugin = {
  rules: {
    'no-boundary-port-naming-drift': {
      meta: {
        type: /** @type {const} */ ('problem'),
        docs: {
          description:
            'disallow new *.port.ts/*.ports.ts boundary files and parallel transaction contract names',
        },
        schema: [],
      },
      /** @param {import('eslint').Rule.RuleContext} context */
      create(context) {
        /**
         * @param {import('estree').Node} node
         * @param {string} specifier
         * @param {string} targetPath
         * @returns {void}
         */
        function reportPortImportIfNeeded(node, specifier, targetPath) {
          if (specifier.includes('transaction-runner.port')) {
            context.report({
              node,
              message:
                'TransactionRunner 边界契约固定使用 transaction-runner.contract.ts；禁止导入 transaction-runner.port。',
            });
            return;
          }
          if (!/(^|\/)[^/]+\.ports?(?:\.ts)?$/.test(specifier)) {
            return;
          }
          context.report({
            node,
            message:
              '新增 boundary contract 文件使用 *.contract.ts；禁止新增或导入 *.port.ts / *.ports.ts。当前 import: "{{specifier}}"',
            data: { specifier },
          });
        }

        return {
          /** @param {import('estree').Program} node */
          Program(node) {
            if (!isPathInside(context.filename, SRC_ROOT)) {
              return;
            }
            if (!isBoundaryPortFilePath(context.filename)) {
              return;
            }
            context.report({
              node,
              message:
                '新增 boundary contract 文件使用 *.contract.ts；禁止新增 *.port.ts / *.ports.ts。',
            });
          },
          /** @param {import('estree').ImportDeclaration} node */
          ImportDeclaration(node) {
            checkStaticImportLikeNode(context, node, (specifier, targetPath) => {
              reportPortImportIfNeeded(node, specifier, targetPath);
            });
          },
          /** @param {import('estree').ExportAllDeclaration} node */
          ExportAllDeclaration(node) {
            checkStaticImportLikeNode(context, node, (specifier, targetPath) => {
              reportPortImportIfNeeded(node, specifier, targetPath);
            });
          },
          /** @param {import('estree').Node & { source?: { value?: unknown } }} node */
          ExportNamedDeclaration(node) {
            checkStaticImportLikeNode(context, node, (specifier, targetPath) => {
              reportPortImportIfNeeded(node, specifier, targetPath);
            });
          },
          /** @param {import('estree').CallExpression} node */
          CallExpression(node) {
            checkRequireCallNode(context, node, (specifier, targetPath) => {
              reportPortImportIfNeeded(node, specifier, targetPath);
            });
          },
          /** @param {import('estree').ImportExpression} node */
          ImportExpression(node) {
            checkImportExpressionNode(context, node, (specifier, targetPath) => {
              reportPortImportIfNeeded(node, specifier, targetPath);
            });
          },
          /** @param {import('estree').Identifier} node */
          Identifier(node) {
            if (node.name !== 'TransactionPort' && node.name !== 'UnitOfWork') {
              return;
            }
            context.report({
              node,
              message:
                '事务边界固定命名为 TransactionRunner；禁止新增 TransactionPort / UnitOfWork 并行抽象。',
            });
          },
        };
      },
    },
    'no-transaction-manager-alias': {
      meta: {
        type: /** @type {const} */ ('problem'),
        docs: {
          description: 'disallow local *TransactionManager aliases in usecases and modules',
        },
        schema: [],
      },
      /** @param {import('eslint').Rule.RuleContext} context */
      create(context) {
        if (
          !isPathInside(context.filename, MODULES_ROOT) &&
          !isPathInside(context.filename, USECASES_ROOT)
        ) {
          return {};
        }
        return {
          /** @param {import('@typescript-eslint/types').TSESTree.TSTypeAliasDeclaration} node */
          TSTypeAliasDeclaration(node) {
            const aliasName = node.id.name;
            if (typeof aliasName !== 'string' || !aliasName.endsWith('TransactionManager')) {
              return;
            }
            context.report({
              node,
              message:
                '禁止新增本地 *TransactionManager alias；usecase 使用 PersistenceTransactionContext，modules(service) / QueryService 对外接收 transactionContext。',
            });
          },
          /** @param {import('@typescript-eslint/types').TSESTree.TSInterfaceDeclaration} node */
          TSInterfaceDeclaration(node) {
            const interfaceName = node.id.name;
            if (
              typeof interfaceName !== 'string' ||
              !interfaceName.endsWith('TransactionManager')
            ) {
              return;
            }
            context.report({
              node,
              message:
                '禁止新增本地 *TransactionManager interface；usecase 使用 PersistenceTransactionContext，modules(service) / QueryService 对外接收 transactionContext。',
            });
          },
        };
      },
    },
    'no-usecase-transaction-manager-orm-api': {
      meta: {
        type: /** @type {const} */ ('problem'),
        docs: {
          description: 'disallow usecases directly calling ORM APIs on transaction contexts',
        },
        schema: [],
      },
      /** @param {import('eslint').Rule.RuleContext} context */
      create(context) {
        if (!isPathInside(context.filename, USECASES_ROOT)) {
          return {};
        }
        const transactionContextNames = new Set();
        const sourceCode = context.sourceCode;

        /**
         * @param {import('estree').Node} node
         * @returns {boolean}
         */
        function textMentionsTransactionContextType(node) {
          return /\b(?:PersistenceTransactionContext|TransactionManager|EntityManager)\b/.test(
            sourceCode.getText(node),
          );
        }

        /**
         * @param {import('estree').Pattern | import('estree').Node} node
         * @returns {void}
         */
        function rememberTypedIdentifier(node) {
          if (node.type === 'Identifier') {
            const id = /** @type {import('@typescript-eslint/types').TSESTree.Identifier} */ (node);
            if (
              id.typeAnnotation &&
              textMentionsTransactionContextType(
                /** @type {import('estree').Node} */ (/** @type {unknown} */ (id.typeAnnotation)),
              )
            ) {
              transactionContextNames.add(id.name);
              return;
            }
          }
          if (node.type === 'AssignmentPattern') {
            rememberTypedIdentifier(node.left);
          }
        }

        /**
         * @param {import('estree').Node} node
         * @returns {boolean}
         */
        function isTransactionContextLikeExpression(node) {
          if (node.type === 'ChainExpression') {
            return isTransactionContextLikeExpression(node.expression);
          }
          if (node.type === 'Identifier') {
            const lowerName = node.name.toLowerCase();
            return (
              transactionContextNames.has(node.name) ||
              lowerName === 'transactioncontext' ||
              lowerName === 'activetransactioncontext' ||
              lowerName === 'manager' ||
              lowerName === 'txmanager' ||
              lowerName === 'activemanager' ||
              lowerName === 'transactionmanager'
            );
          }
          if (node.type !== 'MemberExpression') {
            return false;
          }
          const propertyName = getStaticPropertyName(node);
          if (!propertyName) {
            return false;
          }
          const lowerPropertyName = propertyName.toLowerCase();
          return (
            lowerPropertyName === 'transactioncontext' ||
            lowerPropertyName === 'activetransactioncontext' ||
            lowerPropertyName === 'manager' ||
            lowerPropertyName === 'txmanager' ||
            lowerPropertyName === 'activemanager' ||
            lowerPropertyName === 'transactionmanager'
          );
        }

        /**
         * @param {import('estree').Function} node
         * @returns {void}
         */
        function rememberFunctionParams(node) {
          for (const param of node.params) {
            rememberTypedIdentifier(param);
          }
        }

        return {
          FunctionDeclaration: rememberFunctionParams,
          FunctionExpression: rememberFunctionParams,
          ArrowFunctionExpression: rememberFunctionParams,
          /** @param {import('estree').VariableDeclarator} node */
          VariableDeclarator(node) {
            if (node.id.type !== 'Identifier') {
              return;
            }
            const id = /** @type {import('@typescript-eslint/types').TSESTree.Identifier} */ (
              node.id
            );
            if (
              id.typeAnnotation &&
              textMentionsTransactionContextType(
                /** @type {import('estree').Node} */ (/** @type {unknown} */ (id.typeAnnotation)),
              )
            ) {
              transactionContextNames.add(id.name);
              return;
            }
            if (node.init && textMentionsTransactionContextType(node.init)) {
              transactionContextNames.add(id.name);
            }
          },
          /** @param {import('estree').CallExpression} node */
          CallExpression(node) {
            if (node.callee.type !== 'MemberExpression') {
              return;
            }
            const methodName = getStaticPropertyName(node.callee);
            if (!methodName || !TRANSACTION_MANAGER_ORM_METHODS.has(methodName)) {
              return;
            }
            if (!isTransactionContextLikeExpression(node.callee.object)) {
              return;
            }
            context.report({
              node: node.callee,
              message:
                'Usecase 只能传递 transaction context，不得直接调用事务上下文的 ORM API "{{methodName}}"；请下沉到 modules service / QueryService / repository 封装。',
              data: { methodName },
            });
          },
        };
      },
    },
    'no-runtime-config-outside-wiring': {
      meta: {
        type: /** @type {const} */ ('problem'),
        docs: {
          description:
            'disallow process.env and Nest ConfigService outside infrastructure, bootstraps, tests, or module wiring',
        },
        schema: [],
      },
      /** @param {import('eslint').Rule.RuleContext} context */
      create(context) {
        const isConfigImportAllowed = isRuntimeConfigImportAllowedFilePath(context.filename);
        const isProcessEnvAllowed = isProcessEnvAllowedFilePath(context.filename);

        return {
          /** @param {import('@typescript-eslint/types').TSESTree.ImportDeclaration} node */
          ImportDeclaration(node) {
            if (node.source.value !== '@nestjs/config' || isConfigImportAllowed) {
              return;
            }
            const importedNames = node.specifiers
              .map((specifier) => {
                if (specifier.type !== 'ImportSpecifier') {
                  return specifier.local.name;
                }
                return specifier.imported.type === 'Identifier'
                  ? specifier.imported.name
                  : String(specifier.imported.value);
              })
              .filter((importedName) => RUNTIME_CONFIG_IMPORT_NAMES.has(importedName));
            const displayImport =
              importedNames.length > 0 ? importedNames.join(', ') : '@nestjs/config';
            context.report({
              node: /** @type {import('estree').Node} */ (/** @type {unknown} */ (node)),
              message:
                '运行时配置读取只能放在 infrastructure、bootstraps、测试，或 adapters/modules 的 *.module.ts DI wiring 中。当前 import: "{{displayImport}}"',
              data: { displayImport },
            });
          },
          /** @param {import('estree').MemberExpression} node */
          MemberExpression(node) {
            if (isProcessEnvAllowed) {
              return;
            }
            if (node.object.type !== 'Identifier' || node.object.name !== 'process') {
              return;
            }
            const propertyName = getStaticPropertyName(node);
            if (propertyName !== 'env') {
              return;
            }
            context.report({
              node,
              message:
                'process.env 只能在 infrastructure、bootstraps 或测试代码中读取；业务/适配执行逻辑请通过配置模块的 DI wiring 注入。',
            });
          },
        };
      },
    },
    'no-infrastructure-to-modules-imports': {
      meta: {
        type: /** @type {const} */ ('problem'),
        docs: {
          description: 'disallow infrastructure importing modules',
        },
        schema: [],
      },
      /** @param {import('eslint').Rule.RuleContext} context */
      create(context) {
        if (!isPathInside(context.filename, INFRASTRUCTURE_ROOT)) {
          return {};
        }

        /**
         * @param {import('estree').Node & { source?: { value?: unknown } }} node
         * @returns {void}
         */
        function reportIfNeeded(node) {
          checkStaticImportLikeNode(context, node, (specifier, targetPath) => {
            if (
              !isPathInside(targetPath, MODULES_ROOT) ||
              isModuleBoundaryContractFilePath(targetPath)
            ) {
              return;
            }
            context.report({
              node,
              message:
                'Infrastructure 层禁止依赖 modules 实现；仅允许依赖 module-owned boundary contract。当前 import: "{{specifier}}"',
              data: { specifier },
            });
          });
        }

        return {
          ImportDeclaration: reportIfNeeded,
          ExportAllDeclaration: reportIfNeeded,
          ExportNamedDeclaration: reportIfNeeded,
          /** @param {import('estree').CallExpression} node */
          CallExpression(node) {
            checkRequireCallNode(context, node, (specifier, targetPath) => {
              if (
                !isPathInside(targetPath, MODULES_ROOT) ||
                isModuleBoundaryContractFilePath(targetPath)
              ) {
                return;
              }
              context.report({
                node,
                message:
                  'Infrastructure 层禁止依赖 modules 实现；仅允许依赖 module-owned boundary contract。当前 import: "{{specifier}}"',
                data: { specifier },
              });
            });
          },
          /** @param {import('estree').ImportExpression} node */
          ImportExpression(node) {
            checkImportExpressionNode(context, node, (specifier, targetPath) => {
              if (
                !isPathInside(targetPath, MODULES_ROOT) ||
                isModuleBoundaryContractFilePath(targetPath)
              ) {
                return;
              }
              context.report({
                node,
                message:
                  'Infrastructure 层禁止依赖 modules 实现；仅允许依赖 module-owned boundary contract。当前 import: "{{specifier}}"',
                data: { specifier },
              });
            });
          },
        };
      },
    },
    'no-infrastructure-to-usecases-imports': {
      meta: {
        type: /** @type {const} */ ('problem'),
        docs: {
          description:
            'disallow infrastructure importing usecase implementations while allowing usecase-owned boundary contracts',
        },
        schema: [],
      },
      /** @param {import('eslint').Rule.RuleContext} context */
      create(context) {
        if (!isPathInside(context.filename, INFRASTRUCTURE_ROOT)) {
          return {};
        }

        /**
         * @param {import('estree').Node} node
         * @param {string} specifier
         * @param {string} targetPath
         * @returns {void}
         */
        function checkImport(node, specifier, targetPath) {
          if (
            !isPathInside(targetPath, USECASES_ROOT) ||
            isAnyUsecaseBoundaryContractFilePath(targetPath)
          ) {
            return;
          }
          context.report({
            node,
            message:
              'Infrastructure 层禁止依赖 usecase 实现；仅允许依赖实际实现或装配的 usecase-owned *.contract.ts。当前 import: "{{specifier}}"',
            data: { specifier },
          });
        }

        /** @param {import('estree').Node & { source?: { value?: unknown } }} node */
        function reportIfNeeded(node) {
          checkStaticImportLikeNode(context, node, (specifier, targetPath) => {
            checkImport(node, specifier, targetPath);
          });
        }

        return {
          ImportDeclaration: reportIfNeeded,
          ExportAllDeclaration: reportIfNeeded,
          ExportNamedDeclaration: reportIfNeeded,
          /** @param {import('estree').CallExpression} node */
          CallExpression(node) {
            checkRequireCallNode(context, node, (specifier, targetPath) => {
              checkImport(node, specifier, targetPath);
            });
          },
          /** @param {import('estree').ImportExpression} node */
          ImportExpression(node) {
            checkImportExpressionNode(context, node, (specifier, targetPath) => {
              checkImport(node, specifier, targetPath);
            });
          },
        };
      },
    },
    'no-adapter-to-queryservice-imports': {
      meta: {
        type: /** @type {const} */ ('problem'),
        docs: {
          description: 'disallow adapters importing QueryService implementations',
        },
        schema: [],
      },
      /** @param {import('eslint').Rule.RuleContext} context */
      create(context) {
        if (!isPathInside(context.filename, ADAPTERS_ROOT)) {
          return {};
        }

        /**
         * @param {import('estree').Node} node
         * @param {string} specifier
         * @param {string} targetPath
         * @returns {void}
         */
        function checkImport(node, specifier, targetPath) {
          if (!isPathInside(targetPath, MODULES_ROOT) || !isQueryServiceFilePath(targetPath)) {
            return;
          }
          context.report({
            node,
            message:
              'Adapter 层禁止直接依赖 QueryService；必须通过 Usecase 获取读侧结果。当前 import: "{{specifier}}"',
            data: { specifier },
          });
        }

        /** @param {import('estree').Node & { source?: { value?: unknown } }} node */
        function reportIfNeeded(node) {
          checkStaticImportLikeNode(context, node, (specifier, targetPath) => {
            checkImport(node, specifier, targetPath);
          });
        }

        return {
          ImportDeclaration: reportIfNeeded,
          ExportAllDeclaration: reportIfNeeded,
          ExportNamedDeclaration: reportIfNeeded,
          /** @param {import('estree').CallExpression} node */
          CallExpression(node) {
            checkRequireCallNode(context, node, (specifier, targetPath) => {
              checkImport(node, specifier, targetPath);
            });
          },
          /** @param {import('estree').ImportExpression} node */
          ImportExpression(node) {
            checkImportExpressionNode(context, node, (specifier, targetPath) => {
              checkImport(node, specifier, targetPath);
            });
          },
        };
      },
    },
    'no-adapter-to-infrastructure-imports': {
      meta: {
        type: /** @type {const} */ ('problem'),
        docs: {
          description: 'disallow API and Worker adapters importing infrastructure implementation',
        },
        schema: [],
      },
      /** @param {import('eslint').Rule.RuleContext} context */
      create(context) {
        if (!isPathInside(context.filename, ADAPTERS_ROOT)) {
          return {};
        }

        /**
         * @param {import('estree').Node} node
         * @param {string} specifier
         * @param {string} targetPath
         * @returns {void}
         */
        function checkImport(node, specifier, targetPath) {
          if (!isPathInside(targetPath, INFRASTRUCTURE_ROOT)) {
            return;
          }
          context.report({
            node,
            message:
              'Adapter 层禁止依赖 infrastructure；协议视图留在 adapter，本地映射到 Usecase 输入。当前 import: "{{specifier}}"',
            data: { specifier },
          });
        }

        /** @param {import('estree').Node & { source?: { value?: unknown } }} node */
        function reportIfNeeded(node) {
          checkStaticImportLikeNode(context, node, (specifier, targetPath) => {
            checkImport(node, specifier, targetPath);
          });
        }

        return {
          ImportDeclaration: reportIfNeeded,
          ExportAllDeclaration: reportIfNeeded,
          ExportNamedDeclaration: reportIfNeeded,
          /** @param {import('estree').CallExpression} node */
          CallExpression(node) {
            checkRequireCallNode(context, node, (specifier, targetPath) => {
              checkImport(node, specifier, targetPath);
            });
          },
          /** @param {import('estree').ImportExpression} node */
          ImportExpression(node) {
            checkImportExpressionNode(context, node, (specifier, targetPath) => {
              checkImport(node, specifier, targetPath);
            });
          },
        };
      },
    },
    'no-adapter-types-from-usecase-implementations': {
      meta: {
        type: /** @type {const} */ ('problem'),
        docs: {
          description:
            'allow adapters to import usecase execution classes, but require flow types to use type-only imports from dedicated *.types.ts files',
        },
        schema: [],
      },
      /** @param {import('eslint').Rule.RuleContext} context */
      create(context) {
        if (!isPathInside(context.filename, ADAPTERS_ROOT)) {
          return {};
        }

        return {
          /** @param {import('estree').ImportDeclaration} node */
          ImportDeclaration(node) {
            if (typeof node.source.value !== 'string') {
              return;
            }
            const targetPath = resolveInternalImport(context.filename, node.source.value);
            if (!targetPath || !isPathInside(targetPath, USECASES_ROOT)) {
              return;
            }

            if (isUsecaseTypesFilePath(targetPath)) {
              for (const specifier of node.specifiers) {
                if (isTypeOnlyImportSpecifier(node, specifier)) {
                  continue;
                }
                context.report({
                  node: specifier,
                  message:
                    'Adapter 从 Usecase *.types.ts 只能使用 type-only import；运行时值必须来自 Usecase 执行类或其他允许的运行时边界。当前 import: "{{specifier}}"',
                  data: { specifier: node.source.value },
                });
              }
              return;
            }

            if (!isUsecaseImplementationFilePath(targetPath)) {
              for (const specifier of node.specifiers) {
                if (!isTypeOnlyImportSpecifier(node, specifier)) {
                  continue;
                }
                context.report({
                  node: specifier,
                  message:
                    'Adapter 只能从 Usecase 相邻 *.types.ts type-only 导入流程类型；禁止从 helper、normalize、registry、contract 或其他内部文件借类型。当前 import: "{{specifier}}"',
                  data: { specifier: node.source.value },
                });
              }
              return;
            }

            for (const specifier of node.specifiers) {
              const importedName =
                specifier.type === 'ImportSpecifier'
                  ? specifier.imported.type === 'Identifier'
                    ? specifier.imported.name
                    : String(specifier.imported.value)
                  : specifier.local.name;
              if (specifier.type === 'ImportSpecifier' && importedName.endsWith('Usecase')) {
                continue;
              }
              context.report({
                node: specifier,
                message:
                  'Adapter 从 *.usecase.ts 只能导入 Usecase 执行类；共享流程类型请移到独立 *.types.ts。当前 import: "{{importedName}}"',
                data: { importedName },
              });
            }
          },
        };
      },
    },
    'no-adapter-decorators-on-entities': {
      meta: {
        type: /** @type {const} */ ('problem'),
        docs: {
          description: 'disallow adapter/protocol decorators and imports in ORM entity files',
        },
        schema: [],
      },
      /** @param {import('eslint').Rule.RuleContext} context */
      create(context) {
        if (!isEntityFilePath(context.filename)) {
          return {};
        }

        /**
         * @param {import('estree').Node} node
         * @param {string} source
         * @returns {void}
         */
        function reportImportIfNeeded(node, source) {
          if (
            !ENTITY_FORBIDDEN_IMPORT_SOURCES.has(source) &&
            !source.startsWith('@adapters/') &&
            !source.startsWith('@src/adapters/') &&
            !source.startsWith('src/adapters/')
          ) {
            return;
          }
          context.report({
            node,
            message:
              'ORM Entity 禁止 import adapter / GraphQL / HTTP / Swagger / validation / transformer 依赖。当前 import: "{{source}}"',
            data: { source },
          });
        }

        return {
          /** @param {import('@typescript-eslint/types').TSESTree.ImportDeclaration} node */
          ImportDeclaration(node) {
            const source = typeof node.source.value === 'string' ? node.source.value : null;
            if (!source) {
              return;
            }
            reportImportIfNeeded(
              /** @type {import('estree').Node} */ (/** @type {unknown} */ (node)),
              source,
            );
            checkStaticImportLikeNode(
              context,
              /** @type {import('estree').Node & { source?: { value?: unknown } }} */ (
                /** @type {unknown} */ (node)
              ),
              (_specifier, targetPath) => {
                if (!isPathInside(targetPath, ADAPTERS_ROOT)) {
                  return;
                }
                context.report({
                  node: /** @type {import('estree').Node} */ (/** @type {unknown} */ (node)),
                  message: 'ORM Entity 禁止依赖 adapters 层文件；Entity 只表达持久化结构。',
                });
              },
            );
          },
          /** @param {import('@typescript-eslint/types').TSESTree.Decorator} node */
          Decorator(node) {
            const decoratorName = getDecoratorName(node);
            if (!decoratorName || !ENTITY_FORBIDDEN_DECORATOR_NAMES.has(decoratorName)) {
              return;
            }
            context.report({
              node: /** @type {import('estree').Node} */ (/** @type {unknown} */ (node)),
              message:
                'ORM Entity 禁止使用 adapter / GraphQL / HTTP / Swagger / validation / transformer 装饰器 "{{decoratorName}}"。',
              data: { decoratorName },
            });
          },
        };
      },
    },
    'no-graphql-schema-registration-outside-schema': {
      meta: {
        type: /** @type {const} */ ('problem'),
        docs: {
          description: 'disallow GraphQL enum/scalar registration outside schema registry files',
        },
        schema: [],
      },
      /** @param {import('eslint').Rule.RuleContext} context */
      create(context) {
        if (isPathInside(context.filename, GRAPHQL_SCHEMA_ROOT)) {
          return {};
        }

        return {
          /** @param {import('@typescript-eslint/types').TSESTree.ImportDeclaration} node */
          ImportDeclaration(node) {
            if (node.source.value !== '@nestjs/graphql') {
              return;
            }
            for (const specifier of node.specifiers) {
              if (specifier.type !== 'ImportSpecifier') {
                continue;
              }
              const importedName =
                specifier.imported.type === 'Identifier'
                  ? specifier.imported.name
                  : String(specifier.imported.value);
              if (!GRAPHQL_SCHEMA_REGISTRATION_FUNCTION_NAMES.has(importedName)) {
                continue;
              }
              context.report({
                node: /** @type {import('estree').Node} */ (/** @type {unknown} */ (specifier)),
                message:
                  'GraphQL enum/scalar 注册只能放在 src/adapters/api/graphql/schema/。当前导入: "{{importedName}}"',
                data: { importedName },
              });
            }
          },
          /** @param {import('estree').CallExpression} node */
          CallExpression(node) {
            if (
              node.callee.type !== 'Identifier' ||
              !GRAPHQL_SCHEMA_REGISTRATION_FUNCTION_NAMES.has(node.callee.name)
            ) {
              return;
            }
            context.report({
              node,
              message:
                'GraphQL enum/scalar 注册只能放在 src/adapters/api/graphql/schema/。当前调用: "{{functionName}}"',
              data: { functionName: node.callee.name },
            });
          },
        };
      },
    },
    'no-graphql-decorators-outside-adapters': {
      meta: {
        type: /** @type {const} */ ('problem'),
        docs: {
          description: 'disallow GraphQL decorators outside the GraphQL adapter layer',
        },
        schema: [],
      },
      /** @param {import('eslint').Rule.RuleContext} context */
      create(context) {
        if (isPathInside(context.filename, GRAPHQL_ADAPTER_ROOT)) {
          return {};
        }

        return {
          /** @param {import('@typescript-eslint/types').TSESTree.ImportDeclaration} node */
          ImportDeclaration(node) {
            if (node.source.value !== '@nestjs/graphql') {
              return;
            }
            for (const specifier of node.specifiers) {
              if (specifier.type !== 'ImportSpecifier') {
                continue;
              }
              const importedName =
                specifier.imported.type === 'Identifier'
                  ? specifier.imported.name
                  : String(specifier.imported.value);
              if (!GRAPHQL_ADAPTER_DECORATOR_NAMES.has(importedName)) {
                continue;
              }
              context.report({
                node: /** @type {import('estree').Node} */ (/** @type {unknown} */ (specifier)),
                message:
                  'GraphQL decorator 只能出现在 src/adapters/api/graphql/**。当前导入: "{{importedName}}"',
                data: { importedName },
              });
            }
          },
          /** @param {import('@typescript-eslint/types').TSESTree.Decorator} node */
          Decorator(node) {
            const decoratorName = getDecoratorName(node);
            if (!decoratorName || !GRAPHQL_ADAPTER_DECORATOR_NAMES.has(decoratorName)) {
              return;
            }
            context.report({
              node: /** @type {import('estree').Node} */ (/** @type {unknown} */ (node)),
              message:
                'GraphQL decorator 只能出现在 src/adapters/api/graphql/**。当前装饰器: "{{decoratorName}}"',
              data: { decoratorName },
            });
          },
        };
      },
    },
    'no-upstream-entity-imports': {
      meta: {
        type: /** @type {const} */ ('problem'),
        docs: {
          description: 'disallow adapters and usecases importing ORM entities',
        },
        schema: [],
      },
      /** @param {import('eslint').Rule.RuleContext} context */
      create(context) {
        if (
          !isPathInside(context.filename, ADAPTERS_ROOT) &&
          !isPathInside(context.filename, USECASES_ROOT)
        ) {
          return {};
        }

        /**
         * @param {import('estree').Node} node
         * @param {string} specifier
         * @param {string} targetPath
         * @returns {void}
         */
        function reportIfEntityImport(node, specifier, targetPath) {
          if (!isEntityFilePath(targetPath)) {
            return;
          }
          context.report({
            node,
            message:
              'Adapters / Usecases 禁止 import ORM Entity；请使用 View、DTO、record snapshot 或稳定 contract type。当前 import: "{{specifier}}"',
            data: { specifier },
          });
        }

        /**
         * @param {import('estree').Node & { source?: { value?: unknown } }} node
         * @returns {void}
         */
        function reportStaticImportIfNeeded(node) {
          checkStaticImportLikeNode(context, node, (specifier, targetPath) => {
            reportIfEntityImport(node, specifier, targetPath);
          });
        }

        return {
          ImportDeclaration: reportStaticImportIfNeeded,
          ExportAllDeclaration: reportStaticImportIfNeeded,
          ExportNamedDeclaration: reportStaticImportIfNeeded,
          /** @param {import('estree').CallExpression} node */
          CallExpression(node) {
            checkRequireCallNode(context, node, (specifier, targetPath) => {
              reportIfEntityImport(node, specifier, targetPath);
            });
          },
          /** @param {import('estree').ImportExpression} node */
          ImportExpression(node) {
            checkImportExpressionNode(context, node, (specifier, targetPath) => {
              reportIfEntityImport(node, specifier, targetPath);
            });
          },
        };
      },
    },
    'no-queryservice-to-mixed-service-imports': {
      meta: {
        type: /** @type {const} */ ('problem'),
        docs: {
          description: 'disallow QueryService importing ordinary mixed read/write services',
        },
        schema: [],
      },
      /** @param {import('eslint').Rule.RuleContext} context */
      create(context) {
        if (
          !isPathInside(context.filename, MODULES_ROOT) ||
          !isQueryServiceFilePath(context.filename)
        ) {
          return {};
        }

        /**
         * @param {import('estree').Node} node
         * @param {string} specifier
         * @param {string} targetPath
         * @returns {void}
         */
        function reportIfMixedService(node, specifier, targetPath) {
          if (!isMixedServiceFilePath(targetPath)) {
            return;
          }
          context.report({
            node,
            message:
              'QueryService 禁止依赖普通 Service；请依赖同域 QueryService、只读 repository 或查询实现。当前 import: "{{specifier}}"',
            data: { specifier },
          });
        }

        /**
         * @param {import('estree').Node & { source?: { value?: unknown } }} node
         * @returns {void}
         */
        function reportStaticImportIfNeeded(node) {
          checkStaticImportLikeNode(context, node, (specifier, targetPath) => {
            reportIfMixedService(node, specifier, targetPath);
          });
        }

        return {
          ImportDeclaration: reportStaticImportIfNeeded,
          ExportAllDeclaration: reportStaticImportIfNeeded,
          ExportNamedDeclaration: reportStaticImportIfNeeded,
          /** @param {import('estree').CallExpression} node */
          CallExpression(node) {
            checkRequireCallNode(context, node, (specifier, targetPath) => {
              reportIfMixedService(node, specifier, targetPath);
            });
          },
          /** @param {import('estree').ImportExpression} node */
          ImportExpression(node) {
            checkImportExpressionNode(context, node, (specifier, targetPath) => {
              reportIfMixedService(node, specifier, targetPath);
            });
          },
        };
      },
    },
    'no-cross-domain-usecases-imports': {
      meta: {
        type: /** @type {const} */ ('problem'),
        docs: {
          description: 'disallow cross-domain imports inside usecases',
        },
        schema: [],
      },
      /** @param {import('eslint').Rule.RuleContext} context */
      create(context) {
        const fromScope = getUsecaseScope(context.filename);
        if (!fromScope) {
          return {};
        }

        /**
         * @param {import('estree').Node & { source?: { value?: unknown } }} node
         * @returns {void}
         */
        function reportIfNeeded(node) {
          checkStaticImportLikeNode(context, node, (specifier, targetPath) => {
            if (!isPathInside(targetPath, USECASES_ROOT)) {
              return;
            }
            if (isCommonUsecaseBoundaryContractFilePath(targetPath)) {
              return;
            }
            const toScope = getUsecaseScope(targetPath);
            if (!toScope || toScope === fromScope) {
              return;
            }
            context.report({
              node,
              message:
                'Usecase 层仅允许同域依赖；当前从 "{{fromScope}}" 依赖了 "{{toScope}}"。当前 import: "{{specifier}}"',
              data: {
                fromScope,
                specifier,
                toScope,
              },
            });
          });
        }

        return {
          ImportDeclaration: reportIfNeeded,
          ExportAllDeclaration: reportIfNeeded,
          ExportNamedDeclaration: reportIfNeeded,
          /** @param {import('estree').CallExpression} node */
          CallExpression(node) {
            checkRequireCallNode(context, node, (specifier, targetPath) => {
              if (!isPathInside(targetPath, USECASES_ROOT)) {
                return;
              }
              if (isCommonUsecaseBoundaryContractFilePath(targetPath)) {
                return;
              }
              const toScope = getUsecaseScope(targetPath);
              if (!toScope || toScope === fromScope) {
                return;
              }
              context.report({
                node,
                message:
                  'Usecase 层仅允许同域依赖；当前从 "{{fromScope}}" 依赖了 "{{toScope}}"。当前 import: "{{specifier}}"',
                data: {
                  fromScope,
                  specifier,
                  toScope,
                },
              });
            });
          },
          /** @param {import('estree').ImportExpression} node */
          ImportExpression(node) {
            checkImportExpressionNode(context, node, (specifier, targetPath) => {
              if (!isPathInside(targetPath, USECASES_ROOT)) {
                return;
              }
              if (isCommonUsecaseBoundaryContractFilePath(targetPath)) {
                return;
              }
              const toScope = getUsecaseScope(targetPath);
              if (!toScope || toScope === fromScope) {
                return;
              }
              context.report({
                node,
                message:
                  'Usecase 层仅允许同域依赖；当前从 "{{fromScope}}" 依赖了 "{{toScope}}"。当前 import: "{{specifier}}"',
                data: {
                  fromScope,
                  specifier,
                  toScope,
                },
              });
            });
          },
        };
      },
    },
    'no-modules-to-usecases-imports': {
      meta: {
        type: /** @type {const} */ ('problem'),
        docs: {
          description:
            'disallow modules importing usecase-owned files; only shared runtime capability contracts under usecases/common are allowed',
        },
        schema: [],
      },
      /** @param {import('eslint').Rule.RuleContext} context */
      create(context) {
        const fromScope = getModuleScope(context.filename);
        if (!fromScope) {
          return {};
        }

        /**
         * @param {import('estree').Node & { source?: { value?: unknown } }} node
         * @returns {void}
         */
        function reportIfNeeded(node) {
          checkStaticImportLikeNode(context, node, (specifier, targetPath) => {
            if (!isPathInside(targetPath, USECASES_ROOT)) {
              return;
            }
            // 共享运行时能力契约（usecases/common/**.contract.ts）允许被 modules 消费
            if (isCommonUsecaseBoundaryContractFilePath(targetPath)) {
              return;
            }
            context.report({
              node,
              message:
                'Modules 层不得依赖 usecase 层文件；只允许依赖共享运行时能力契约（usecases/common/**.contract.ts）。当前从 "{{fromScope}}" 导入 "{{specifier}}"',
              data: { fromScope, specifier },
            });
          });
        }

        return {
          ImportDeclaration: reportIfNeeded,
          ExportAllDeclaration: reportIfNeeded,
          ExportNamedDeclaration: reportIfNeeded,
          /** @param {import('estree').CallExpression} node */
          CallExpression(node) {
            checkRequireCallNode(context, node, (specifier, targetPath) => {
              if (!isPathInside(targetPath, USECASES_ROOT)) {
                return;
              }
              if (isCommonUsecaseBoundaryContractFilePath(targetPath)) {
                return;
              }
              context.report({
                node,
                message:
                  'Modules 层不得依赖 usecase 层文件；只允许依赖共享运行时能力契约（usecases/common/**.contract.ts）。当前从 "{{fromScope}}" 导入 "{{specifier}}"',
                data: { fromScope, specifier },
              });
            });
          },
          /** @param {import('estree').ImportExpression} node */
          ImportExpression(node) {
            checkImportExpressionNode(context, node, (specifier, targetPath) => {
              if (!isPathInside(targetPath, USECASES_ROOT)) {
                return;
              }
              if (isCommonUsecaseBoundaryContractFilePath(targetPath)) {
                return;
              }
              context.report({
                node,
                message:
                  'Modules 层不得依赖 usecase 层文件；只允许依赖共享运行时能力契约（usecases/common/**.contract.ts）。当前从 "{{fromScope}}" 导入 "{{specifier}}"',
                data: { fromScope, specifier },
              });
            });
          },
        };
      },
    },
    'no-types-to-core-imports': {
      meta: {
        type: /** @type {const} */ ('problem'),
        docs: {
          description: 'disallow types layer importing core layer',
        },
        schema: [],
      },
      /** @param {import('eslint').Rule.RuleContext} context */
      create(context) {
        if (!isPathInside(context.filename, TYPES_ROOT)) {
          return {};
        }

        /**
         * @param {import('estree').Node & { source?: { value?: unknown } }} node
         * @returns {void}
         */
        function reportIfNeeded(node) {
          checkStaticImportLikeNode(context, node, (specifier, targetPath) => {
            if (!isPathInside(targetPath, CORE_ROOT)) {
              return;
            }
            context.report({
              node,
              message:
                'Types 层禁止依赖 core；types 是最底层共享契约，不应包含领域实现语义。当前 import: "{{specifier}}"',
              data: { specifier },
            });
          });
        }

        return {
          ImportDeclaration: reportIfNeeded,
          ExportAllDeclaration: reportIfNeeded,
          ExportNamedDeclaration: reportIfNeeded,
          /** @param {import('estree').CallExpression} node */
          CallExpression(node) {
            checkRequireCallNode(context, node, (specifier, targetPath) => {
              if (!isPathInside(targetPath, CORE_ROOT)) {
                return;
              }
              context.report({
                node,
                message:
                  'Types 层禁止依赖 core；types 是最底层共享契约，不应包含领域实现语义。当前 import: "{{specifier}}"',
                data: { specifier },
              });
            });
          },
          /** @param {import('estree').ImportExpression} node */
          ImportExpression(node) {
            checkImportExpressionNode(context, node, (specifier, targetPath) => {
              if (!isPathInside(targetPath, CORE_ROOT)) {
                return;
              }
              context.report({
                node,
                message:
                  'Types 层禁止依赖 core；types 是最底层共享契约，不应包含领域实现语义。当前 import: "{{specifier}}"',
                data: { specifier },
              });
            });
          },
        };
      },
    },
    'no-cross-domain-modules-imports': {
      meta: {
        type: /** @type {const} */ ('problem'),
        docs: {
          description:
            'enforce three-tier module dependency matrix: business→common allowed, common→business forbidden, business→business forbidden',
        },
        schema: [],
      },
      /** @param {import('eslint').Rule.RuleContext} context */
      create(context) {
        const fromScope = getModuleScope(context.filename);
        if (!fromScope) {
          return {};
        }

        /**
         * @param {import('estree').Node} node
         * @param {string} specifier
         * @param {string} targetPath
         */
        function checkCrossDomain(node, specifier, targetPath) {
          if (!isPathInside(targetPath, MODULES_ROOT)) return;
          const toScope = getModuleScope(targetPath);
          if (!toScope || toScope === fromScope) return;
          if (fromScope !== 'common' && toScope === 'common') return;
          if (fromScope === 'common') {
            context.report({
              node,
              message:
                'modules/common 是受限共享层，禁止反向依赖业务域模块 "{{toScope}}"。契约应下沉到 core，绑定留在业务模块。当前 import: "{{specifier}}"',
              data: { fromScope, specifier, toScope },
            });
            return;
          }
          context.report({
            node,
            message:
              '业务域 modules 禁止跨域依赖；当前从 "{{fromScope}}" 依赖了 "{{toScope}}"。如需跨域读取请走 QueryService 契约上提或经 usecase 编排。当前 import: "{{specifier}}"',
            data: { fromScope, specifier, toScope },
          });
        }

        /** @param {import('estree').Node & { source?: { value?: unknown } }} node */
        function reportIfNeeded(node) {
          checkStaticImportLikeNode(context, node, (specifier, targetPath) => {
            checkCrossDomain(node, specifier, targetPath);
          });
        }

        return {
          ImportDeclaration: reportIfNeeded,
          ExportAllDeclaration: reportIfNeeded,
          ExportNamedDeclaration: reportIfNeeded,
          /** @param {import('estree').CallExpression} node */
          CallExpression(node) {
            checkRequireCallNode(context, node, (specifier, targetPath) => {
              checkCrossDomain(node, specifier, targetPath);
            });
          },
          /** @param {import('estree').ImportExpression} node */
          ImportExpression(node) {
            checkImportExpressionNode(context, node, (specifier, targetPath) => {
              checkCrossDomain(node, specifier, targetPath);
            });
          },
        };
      },
    },
  },
};

export default defineConfig(
  {
    ignores: ['eslint.config.mjs', 'dist/**', 'node_modules/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'module',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    plugins: {
      boundaries: /** @type {import('eslint').ESLint.Plugin} */ (
        /** @type {unknown} */ (eslintPluginBoundaries)
      ),
      'local-architecture': localArchitecturePlugin,
    },
    settings: {
      'boundaries/dependency-nodes': ['import'],
      'boundaries/elements': [
        { type: 'adapters-common', pattern: 'src/adapters/api/graphql/decorators', mode: 'folder' },
        { type: 'adapters-common', pattern: 'src/adapters/api/graphql/guards', mode: 'folder' },
        { type: 'adapters-common', pattern: 'src/adapters/api/graphql/common', mode: 'folder' },
        { type: 'adapters-common', pattern: 'src/adapters/api/graphql/schema', mode: 'folder' },
        { type: 'adapters-common', pattern: 'src/adapters/api/graphql/*.ts', mode: 'file' },
        {
          type: 'api-adapters-scope',
          pattern: 'src/adapters/api/graphql/*',
          mode: 'folder',
          capture: ['adapterScope'],
        },
        {
          type: 'worker-adapters-scope',
          pattern: 'src/adapters/worker/*',
          mode: 'folder',
          capture: ['adapterScope'],
        },
        {
          type: 'adapters-integration',
          pattern: 'src/adapters/api/integration-events',
          mode: 'folder',
        },
        {
          type: 'usecases-contracts',
          pattern: USECASES_CONTRACTS_ELEMENT_PATTERNS[0],
          mode: 'file',
          capture: ['usecaseScope'],
        },
        {
          type: 'usecases-contracts',
          pattern: USECASES_CONTRACTS_ELEMENT_PATTERNS[1],
          mode: 'file',
          capture: ['usecaseScope'],
        },
        {
          type: 'usecases',
          pattern: 'src/usecases/*/*.ts',
          mode: 'file',
          capture: ['usecaseScope'],
        },
        {
          type: 'usecases',
          pattern: 'src/usecases/*/**/*.ts',
          mode: 'file',
          capture: ['usecaseScope'],
        },
        {
          type: 'modules-contracts',
          pattern: MODULES_CONTRACTS_ELEMENT_PATTERNS[0],
          mode: 'file',
          capture: ['moduleScope'],
        },
        {
          type: 'modules-contracts',
          pattern: MODULES_CONTRACTS_ELEMENT_PATTERNS[1],
          mode: 'file',
          capture: ['moduleScope'],
        },
        {
          type: 'modules-types',
          pattern: 'src/modules/*/*.types.ts',
          mode: 'file',
          capture: ['moduleScope'],
        },
        {
          type: 'modules-types',
          pattern: 'src/modules/*/**/*.types.ts',
          mode: 'file',
          capture: ['moduleScope'],
        },
        {
          type: 'modules-queries',
          pattern: 'src/modules/*/**/queries',
          mode: 'folder',
          capture: ['moduleScope'],
        },
        {
          type: 'modules-queries',
          pattern: 'src/modules/*/**/*.query.service.ts',
          mode: 'file',
          capture: ['moduleScope'],
        },
        {
          type: 'modules-services',
          pattern: 'src/modules/*/**/services',
          mode: 'folder',
          capture: ['moduleScope'],
        },
        {
          type: 'modules-services',
          pattern: 'src/modules/*/**/service',
          mode: 'folder',
          capture: ['moduleScope'],
        },
        {
          type: 'modules-internal',
          pattern: 'src/modules/*',
          mode: 'folder',
          capture: ['moduleScope'],
        },
        {
          type: 'modules-internal',
          pattern: 'src/modules/*/*.ts',
          mode: 'file',
          capture: ['moduleScope'],
        },
        {
          type: 'modules-internal',
          pattern: 'src/modules/*/**/*.ts',
          mode: 'file',
          capture: ['moduleScope'],
        },
        { type: 'infrastructure', pattern: 'src/infrastructure/**' },
        { type: 'core', pattern: 'src/core/**' },
        { type: 'types', pattern: 'src/types/**' },
      ],
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          rules: [
            {
              from: { type: 'api-adapters-scope' },
              allow: [
                { to: { type: 'adapters-common' } },
                {
                  to: {
                    type: 'api-adapters-scope',
                    captured: { adapterScope: '{{from.adapterScope}}' },
                  },
                },
                { to: { type: 'usecases' } },
                { to: { type: 'core' } },
                { to: { type: 'types' } },
                {
                  to: {
                    type: 'modules-types',
                    captured: { moduleScope: '{{from.adapterScope}}' },
                  },
                  dependency: { kind: 'type' },
                },
              ],
            },
            {
              from: { type: 'worker-adapters-scope' },
              allow: [
                {
                  to: {
                    type: 'worker-adapters-scope',
                    captured: { adapterScope: '{{from.adapterScope}}' },
                  },
                },
                { to: { type: 'usecases' } },
                { to: { type: 'core' } },
                { to: { type: 'types' } },
              ],
            },
            {
              from: { type: 'adapters-common' },
              allow: [
                { to: { type: 'adapters-common' } },
                { to: { type: 'core' } },
                { to: { type: 'types' } },
              ],
            },
            {
              from: { type: 'adapters-integration' },
              allow: [
                { to: { type: 'usecases' } },
                { to: { type: 'core' } },
                { to: { type: 'types' } },
              ],
            },
            {
              from: { type: 'usecases' },
              allow: [
                {
                  to: {
                    type: 'usecases',
                    captured: { usecaseScope: '{{from.usecaseScope}}' },
                  },
                },
                { to: { type: 'usecases-contracts' } },
                { to: { type: 'modules-contracts' } },
                { to: { type: 'modules-types' } },
                { to: { type: 'modules-queries' } },
                { to: { type: 'modules-services' } },
                { to: { type: 'core' } },
                { to: { type: 'types' } },
              ],
            },
            {
              from: { type: 'usecases-contracts' },
              allow: [
                { to: { type: 'usecases-contracts' } },
                { to: { type: 'core' } },
                { to: { type: 'types' } },
              ],
            },
            {
              from: { type: 'modules-contracts' },
              allow: [
                {
                  to: {
                    type: 'modules-contracts',
                    captured: { moduleScope: '{{from.moduleScope}}' },
                  },
                },
                {
                  to: {
                    type: 'modules-types',
                    captured: { moduleScope: '{{from.moduleScope}}' },
                  },
                },
                { to: { type: 'modules-types', captured: { moduleScope: 'common' } } },
                { to: { type: 'core' } },
                { to: { type: 'types' } },
              ],
            },
            {
              from: { type: 'modules-types' },
              allow: [
                {
                  to: {
                    type: 'modules-types',
                    captured: { moduleScope: '{{from.moduleScope}}' },
                  },
                },
                { to: { type: 'modules-types', captured: { moduleScope: 'common' } } },
                { to: { type: 'core' } },
                { to: { type: 'types' } },
              ],
            },
            {
              from: { type: 'modules-queries' },
              allow: [
                {
                  to: {
                    type: 'modules-queries',
                    captured: { moduleScope: '{{from.moduleScope}}' },
                  },
                },
                {
                  to: {
                    type: 'modules-types',
                    captured: { moduleScope: '{{from.moduleScope}}' },
                  },
                },
                {
                  to: {
                    type: 'modules-contracts',
                    captured: { moduleScope: '{{from.moduleScope}}' },
                  },
                },
                {
                  to: {
                    type: 'modules-internal',
                    captured: { moduleScope: '{{from.moduleScope}}' },
                  },
                },
                { to: { type: 'modules-services', captured: { moduleScope: 'common' } } },
                { to: { type: 'modules-queries', captured: { moduleScope: 'common' } } },
                { to: { type: 'modules-contracts', captured: { moduleScope: 'common' } } },
                { to: { type: 'modules-types', captured: { moduleScope: 'common' } } },
                { to: { type: 'modules-internal', captured: { moduleScope: 'common' } } },
                { to: { type: 'infrastructure' } },
                { to: { type: 'core' } },
                { to: { type: 'types' } },
              ],
            },
            {
              from: { type: 'modules-services' },
              allow: [
                {
                  to: {
                    type: 'modules-services',
                    captured: { moduleScope: '{{from.moduleScope}}' },
                  },
                },
                {
                  to: {
                    type: 'modules-types',
                    captured: { moduleScope: '{{from.moduleScope}}' },
                  },
                },
                {
                  to: {
                    type: 'modules-contracts',
                    captured: { moduleScope: '{{from.moduleScope}}' },
                  },
                },
                {
                  to: {
                    type: 'modules-internal',
                    captured: { moduleScope: '{{from.moduleScope}}' },
                  },
                },
                { to: { type: 'modules-services', captured: { moduleScope: 'common' } } },
                { to: { type: 'modules-queries', captured: { moduleScope: 'common' } } },
                { to: { type: 'modules-contracts', captured: { moduleScope: 'common' } } },
                { to: { type: 'modules-types', captured: { moduleScope: 'common' } } },
                { to: { type: 'modules-internal', captured: { moduleScope: 'common' } } },
                { to: { type: 'infrastructure' } },
                { to: { type: 'core' } },
                { to: { type: 'types' } },
              ],
            },
            {
              from: { type: 'modules-internal' },
              allow: [
                {
                  to: {
                    type: 'modules-internal',
                    captured: { moduleScope: '{{from.moduleScope}}' },
                  },
                },
                {
                  to: {
                    type: 'modules-services',
                    captured: { moduleScope: '{{from.moduleScope}}' },
                  },
                },
                {
                  to: {
                    type: 'modules-queries',
                    captured: { moduleScope: '{{from.moduleScope}}' },
                  },
                },
                {
                  to: {
                    type: 'modules-types',
                    captured: { moduleScope: '{{from.moduleScope}}' },
                  },
                },
                {
                  to: {
                    type: 'modules-contracts',
                    captured: { moduleScope: '{{from.moduleScope}}' },
                  },
                },
                { to: { type: 'modules-services', captured: { moduleScope: 'common' } } },
                { to: { type: 'modules-queries', captured: { moduleScope: 'common' } } },
                { to: { type: 'modules-contracts', captured: { moduleScope: 'common' } } },
                { to: { type: 'modules-types', captured: { moduleScope: 'common' } } },
                { to: { type: 'modules-internal', captured: { moduleScope: 'common' } } },
                { to: { type: 'infrastructure' } },
                { to: { type: 'core' } },
                { to: { type: 'types' } },
              ],
            },
            {
              from: { type: 'infrastructure' },
              allow: [
                { to: { type: 'infrastructure' } },
                { to: { type: 'usecases-contracts' } },
                { to: { type: 'modules-contracts' } },
                { to: { type: 'core' } },
                { to: { type: 'types' } },
              ],
            },
            {
              from: { type: 'core' },
              allow: [{ to: { type: 'core' } }, { to: { type: 'types' } }],
            },
            {
              from: { type: 'types' },
              allow: [{ to: { type: 'types' } }],
            },
          ],
        },
      ],
      'local-architecture/no-infrastructure-to-modules-imports': 'error',
      'local-architecture/no-infrastructure-to-usecases-imports': 'error',
      'local-architecture/no-adapter-to-infrastructure-imports': 'error',
      'local-architecture/no-adapter-to-queryservice-imports': 'error',
      'local-architecture/no-adapter-types-from-usecase-implementations': 'error',
      'local-architecture/no-cross-domain-usecases-imports': 'error',
      'local-architecture/no-modules-to-usecases-imports': 'error',
      'local-architecture/no-types-to-core-imports': 'error',
      'local-architecture/no-cross-domain-modules-imports': 'error',
      'local-architecture/no-adapter-decorators-on-entities': 'error',
      'local-architecture/no-boundary-port-naming-drift': 'error',
      'local-architecture/no-graphql-decorators-outside-adapters': 'error',
      'local-architecture/no-graphql-schema-registration-outside-schema': 'error',
      'local-architecture/no-queryservice-to-mixed-service-imports': 'error',
      'local-architecture/no-runtime-config-outside-wiring': 'error',
      'local-architecture/no-transaction-manager-alias': 'error',
      'local-architecture/no-upstream-entity-imports': 'error',
      'local-architecture/no-usecase-transaction-manager-orm-api': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-var-requires': 'error',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      'no-console': 'warn',
      'no-debugger': 'error',
      'no-duplicate-imports': 'error',
      'no-unused-expressions': 'error',
      'no-restricted-imports': [
        'error',
        {
          patterns: RESTRICTED_SRC_TYPES_IMPORT_PATTERNS,
        },
      ],
      'prefer-const': 'error',
      'no-var': 'error',
      complexity: ['warn', 15],
      'max-depth': ['warn', 4],
      'max-lines-per-function': ['warn', 100],
      '@typescript-eslint/naming-convention': [
        'error',
        {
          selector: 'variableLike',
          format: ['camelCase', 'UPPER_CASE'],
        },
        {
          selector: 'typeLike',
          format: ['PascalCase'],
        },
        {
          selector: 'property',
          format: ['camelCase', 'snake_case', 'UPPER_CASE'],
        },
        {
          selector: 'parameter',
          format: ['camelCase', 'UPPER_CASE'],
          leadingUnderscore: 'allow',
        },
      ],
    },
  },
  {
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            '@nestjs/*',
            'class-transformer',
            'class-validator',
            'express',
            'graphql',
            'typeorm',
            ...RESTRICTED_SRC_TYPES_IMPORT_PATTERNS,
          ],
        },
      ],
    },
  },
  {
    files: ['src/types/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            '@nestjs/*',
            'class-transformer',
            'class-validator',
            'graphql',
            'typeorm',
            ...RESTRICTED_SRC_TYPES_IMPORT_PATTERNS,
          ],
        },
      ],
    },
  },
  {
    files: ['src/usecases/**/*.ts'],
    rules: {
      'max-lines-per-function': ['warn', 200],
    },
  },
  {
    ...tseslint.configs.disableTypeChecked,
    files: ['scripts/*.js', 'test/*.js'],
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-var-requires': 'off',
      complexity: 'off',
      'no-console': 'off',
    },
  },
  {
    files: ['test/**/*.ts', '**/*.spec.ts', '**/*.test.ts', 'e2e/**/*.ts'],
    rules: {
      complexity: 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      'max-lines-per-function': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/unbound-method': 'off',
      'local-architecture/no-cross-domain-modules-imports': 'off',
      'local-architecture/no-graphql-decorators-outside-adapters': 'off',
      'no-console': 'off',
    },
  },
);
