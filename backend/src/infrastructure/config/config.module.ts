// src/infrastructure/config/config.module.ts
import { Module } from '@nestjs/common';
import { ConfigFactory, ConfigModule, registerAs } from '@nestjs/config';
import { parseBooleanInput } from '@core/common/normalize/normalize.helper';
import { IncomingMessage, ServerResponse } from 'http';
import databaseConfig from './database.config';

const isProductionEnv = (): boolean => process.env.NODE_ENV === 'production';

const getOptionalEnv = (key: string): string | undefined => {
  const value = process.env[key];
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
};

const getRequiredEnv = (key: string): string => {
  const value = getOptionalEnv(key);
  if (!value) {
    throw new Error(`${key} is required`);
  }
  return value;
};

const parseStrictInteger = (raw: string): number => {
  const normalized = raw.trim();
  if (!/^-?\d+$/.test(normalized)) {
    return Number.NaN;
  }
  return Number(normalized);
};

const getRequiredIntEnv = (key: string): number => {
  const value = getRequiredEnv(key);
  const parsed = parseStrictInteger(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${key} must be a valid integer`);
  }
  return parsed;
};

const getIntEnvWithDefault = (key: string, defaultValue: number): number => {
  const value = getOptionalEnv(key);
  if (!value) {
    return defaultValue;
  }
  const parsed = parseStrictInteger(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${key} must be a valid integer`);
  }
  return parsed;
};

const getBooleanEnvWithDefault = (key: string, defaultValue: boolean): boolean => {
  const raw = process.env[key];
  const parsed = parseBooleanInput(raw);
  if (parsed === undefined) {
    return defaultValue;
  }
  return parsed;
};

const PRODUCTION_REQUIRED_KEYS = [
  'APP_HOST',
  'APP_PORT',
  'APP_CORS_ENABLED',
  'APP_CORS_CREDENTIALS',
  'GRAPHQL_SANDBOX_ENABLED',
  'GRAPHQL_INTROSPECTION_ENABLED',
  'DB_HOST',
  'DB_PORT',
  'DB_USER',
  'DB_PASS',
  'DB_NAME',
  'DB_SYNCHRONIZE',
  'DB_LOGGING',
  'REDIS_HOST',
  'REDIS_PORT',
  'REDIS_DB',
  'REDIS_TLS',
  'BULLMQ_PREFIX',
  'JWT_SECRET',
  'JWT_ENABLE_REFRESH',
  'PAGINATION_HMAC_SECRET',
  'FIELD_ENCRYPTION_KEY',
  'FIELD_ENCRYPTION_IV',
  'AI_PROVIDER_MODE',
  'AI_QUEUE_DEBUG_ENABLED',
  'EMAIL_QUEUE_DEBUG_ENABLED',
] as const;

const PRODUCTION_BOOLEAN_KEYS = [
  'APP_CORS_ENABLED',
  'APP_CORS_CREDENTIALS',
  'GRAPHQL_SANDBOX_ENABLED',
  'GRAPHQL_INTROSPECTION_ENABLED',
  'DB_SYNCHRONIZE',
  'DB_LOGGING',
  'REDIS_TLS',
  'JWT_ENABLE_REFRESH',
  'AI_QUEUE_DEBUG_ENABLED',
  'EMAIL_QUEUE_DEBUG_ENABLED',
] as const;

const PRODUCTION_INTEGER_KEYS = [
  'APP_PORT',
  'DB_PORT',
  'DB_POOL_SIZE',
  'REDIS_PORT',
  'REDIS_DB',
] as const;

const collectRequiredEnvErrors = (): string[] => {
  const errors: string[] = [];
  for (const key of PRODUCTION_REQUIRED_KEYS) {
    if (!getOptionalEnv(key)) {
      errors.push(`${key} is required in production`);
    }
  }
  return errors;
};

const collectBooleanEnvErrors = (): string[] => {
  const errors: string[] = [];
  for (const key of PRODUCTION_BOOLEAN_KEYS) {
    const raw = process.env[key];
    if (raw === undefined) {
      continue;
    }
    if (parseBooleanInput(raw) === undefined) {
      errors.push(`${key} must be a boolean-like value`);
    }
  }
  return errors;
};

const collectIntegerEnvErrors = (): string[] => {
  const errors: string[] = [];
  for (const key of PRODUCTION_INTEGER_KEYS) {
    const value = getOptionalEnv(key);
    if (!value) {
      continue;
    }
    if (!Number.isInteger(parseStrictInteger(value))) {
      errors.push(`${key} must be an integer`);
    }
  }
  return errors;
};

const collectDbAndCorsRuleErrors = (): string[] => {
  const errors: string[] = [];
  const dbSynchronize = parseBooleanInput(process.env.DB_SYNCHRONIZE);
  if (dbSynchronize === true) {
    errors.push('DB_SYNCHRONIZE must be false in production');
  }

  const corsEnabled = parseBooleanInput(process.env.APP_CORS_ENABLED);
  if (corsEnabled === true && !getOptionalEnv('APP_CORS_ORIGINS')) {
    errors.push('APP_CORS_ORIGINS is required when APP_CORS_ENABLED=true in production');
  }
  return errors;
};

const collectAiProviderRuleErrors = (): string[] => {
  const errors: string[] = [];
  const providerMode = getOptionalEnv('AI_PROVIDER_MODE')?.toLowerCase();
  if (providerMode && providerMode !== 'mock' && providerMode !== 'remote') {
    errors.push('AI_PROVIDER_MODE must be either mock or remote');
  }
  if (providerMode === 'remote') {
    const qwenReady = Boolean(getOptionalEnv('QWEN_BASE_URL') && getOptionalEnv('QWEN_API_KEY'));
    const openAiReady = Boolean(
      getOptionalEnv('OPENAI_BASE_URL') && getOptionalEnv('OPENAI_API_KEY'),
    );
    if (!qwenReady && !openAiReady) {
      errors.push(
        'AI_PROVIDER_MODE=remote requires at least one provider config: QWEN_* or OPENAI_*',
      );
    }
  }
  return errors;
};

const collectFieldEncryptionRuleErrors = (): string[] => {
  const errors: string[] = [];
  const fieldEncryptionKey = getOptionalEnv('FIELD_ENCRYPTION_KEY');
  if (fieldEncryptionKey && fieldEncryptionKey.length < 16) {
    errors.push('FIELD_ENCRYPTION_KEY length must be at least 16');
  }
  const fieldEncryptionIv = getOptionalEnv('FIELD_ENCRYPTION_IV');
  if (fieldEncryptionIv && fieldEncryptionIv.length < 16) {
    errors.push('FIELD_ENCRYPTION_IV length must be at least 16');
  }
  return errors;
};

const collectRagDiagnosisRuleErrors = (): string[] => {
  const errors: string[] = [];
  const mode = getOptionalEnv('LITHO_RAG_MODE')?.toLowerCase();
  if (mode && mode !== 'disabled' && mode !== 'remote') {
    errors.push('LITHO_RAG_MODE must be either disabled or remote');
  }

  // 显式 disabled 时功能未启用：残留的 URL、密钥、超时与私网开关都不参与预检，
  // 避免无关的 API／Worker 进程因残留配置而无法启动。
  if (mode === 'disabled') {
    return errors;
  }

  const allowRaw = process.env.LITHO_RAG_ALLOW_TAILNET_HTTP;
  if (allowRaw !== undefined && parseBooleanInput(allowRaw) === undefined) {
    errors.push('LITHO_RAG_ALLOW_TAILNET_HTTP must be a boolean-like value');
  }

  const timeoutRaw = getOptionalEnv('LITHO_RAG_TIMEOUT_MS');
  if (timeoutRaw && !Number.isInteger(parseStrictInteger(timeoutRaw))) {
    errors.push('LITHO_RAG_TIMEOUT_MS must be an integer');
  }

  const baseUrl = getOptionalEnv('LITHO_RAG_BASE_URL');
  const apiKey = getOptionalEnv('LITHO_RAG_API_KEY');
  if (Boolean(baseUrl) !== Boolean(apiKey)) {
    errors.push('LITHO_RAG_BASE_URL and LITHO_RAG_API_KEY must be configured together');
  }
  if (mode === 'remote' && (!baseUrl || !apiKey)) {
    errors.push('LITHO_RAG_MODE=remote requires LITHO_RAG_BASE_URL and LITHO_RAG_API_KEY');
  }
  return errors;
};

const collectProductionRuleErrors = (): string[] => {
  return [
    ...collectDbAndCorsRuleErrors(),
    ...collectAiProviderRuleErrors(),
    ...collectFieldEncryptionRuleErrors(),
    ...collectRagDiagnosisRuleErrors(),
  ];
};

const collectProductionEnvFreezeErrors = (): string[] => {
  return [
    ...collectRequiredEnvErrors(),
    ...collectBooleanEnvErrors(),
    ...collectIntegerEnvErrors(),
    ...collectProductionRuleErrors(),
  ];
};

const assertProductionEnvFreeze = (): void => {
  if (!isProductionEnv()) {
    return;
  }

  const errors = collectProductionEnvFreezeErrors();

  if (errors.length > 0) {
    throw new Error(`Production env freeze validation failed:\n- ${errors.join('\n- ')}`);
  }
};

assertProductionEnvFreeze();

/**
 * 生成 GraphQL 配置
 */
const graphqlConfig = () => {
  const isProduction = isProductionEnv();
  const sandboxEnabled = parseBooleanInput(process.env.GRAPHQL_SANDBOX_ENABLED) ?? !isProduction;
  const introspectionEnabled =
    parseBooleanInput(process.env.GRAPHQL_INTROSPECTION_ENABLED) ?? !isProduction;

  return {
    graphql: {
      schemaDestination: 'src/schema.graphql',
      introspection: introspectionEnabled,
      playground: sandboxEnabled,
      sortSchema: true,
      subscriptions: {
        // graphql-ws 是 Apollo 要求的关键字，不能改名
        // eslint-disable-next-line @typescript-eslint/naming-convention
        'graphql-ws': true,
      },
    },
  };
};

/**
 * 生成 Server 配置
 */
const serverConfig: ConfigFactory = () => ({
  server: {
    host: process.env.APP_HOST || '127.0.0.1',
    port: getIntEnvWithDefault('APP_PORT', 3000),
    cors: {
      enabled: getBooleanEnvWithDefault('APP_CORS_ENABLED', true),
      origins: process.env.APP_CORS_ORIGINS || '',
      credentials: getBooleanEnvWithDefault('APP_CORS_CREDENTIALS', true),
    },
  },
});

/**
 * 生成日志配置
 */
const buildCustomPropsFor4xx = (
  req: IncomingMessage,
  res: ServerResponse,
): Record<string, unknown> => {
  const statusCode = res.statusCode ?? 0;
  if (statusCode >= 400 && statusCode < 500) {
    const forwardedRaw = req.headers?.['x-forwarded-for'];
    const xForwardedFor = Array.isArray(forwardedRaw) ? forwardedRaw.join(',') : forwardedRaw;
    const userAgentRaw = req.headers?.['user-agent'];
    const userAgent = Array.isArray(userAgentRaw) ? userAgentRaw.join(',') : userAgentRaw;

    const remoteAddress = req.socket?.remoteAddress ?? null;
    const method = req.method ?? null;
    const url = req.url ?? null;
    const originalUrl = (req as unknown as { originalUrl?: string }).originalUrl ?? url;

    return {
      remoteAddress,
      xForwardedFor: xForwardedFor ?? null,
      method,
      url,
      originalUrl,
      userAgent: userAgent ?? null,
    };
  }
  return {};
};

const buildCustomLogLevel = () => {
  return (req: IncomingMessage, res: ServerResponse, err?: Error) => {
    // 忽略 favicon 请求
    if (req.url === '/favicon.ico') return 'silent';

    // 正常的日志记录逻辑
    if (res.statusCode >= 500 || err) return 'error';
    if (res.statusCode >= 400) return 'warn';
    if (res.statusCode > 200) return 'warn';

    // 只记录你允许的 /graphql POST 相关 200 状态日志
    if (res.statusCode === 200 && req.method === 'POST' && req.url === '/graphql') {
      return 'info'; // 正常记录
    }

    // 默认阻止 /graphql GET 相关的 200 状态日志，但保留次分支用于将来开放特殊情况
    if (res.statusCode === 200 && req.method === 'GET' && req.url === '/graphql') {
      return 'silent'; // 屏蔽
    }
    return 'silent';
  };
};

const buildLoggerTransport = (input: { readonly isDev: boolean; readonly logPath: string }) => {
  if (input.isDev) {
    return {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:dd HH:MM:ss',
        messageFormat: '{time} - [{context}] {method} {url} {statusCode} - {msg}',
        ignore: 'hostname,pid,req,context',
        // 简洁输出, 完全屏蔽上下文的输出
        // hideObject: true,
      },
    };
  }
  return {
    targets: [
      {
        target: 'pino/file',
        options: {
          destination: `${input.logPath}/app.log`,
          mkdir: true,
        },
        level: 'info',
      },
      {
        target: 'pino/file',
        options: {
          destination: `${input.logPath}/error.log`,
          mkdir: true,
        },
        level: 'error',
      },
    ],
  };
};

const loggerConfig: ConfigFactory = () => {
  const isDev = process.env.NODE_ENV !== 'production';
  const logPath = isDev ? './logs' : '/var/log/backend';
  const level = process.env.LOG_LEVEL ?? (isDev ? 'debug' : 'info');
  const includeRequestMeta = isDev ? true : process.env.LOG_INCLUDE_REQUEST_META === 'true';

  return {
    logger: {
      level,
      redactFields: ['req.headers.authorization'],
      file: {
        enabled: !isDev,
        path: logPath,
      },
      // 不自动展开 req/res，但允许你手动 logger.debug({ req, res }, ...)
      customProps: includeRequestMeta ? buildCustomPropsFor4xx : undefined,
      // 自定义日志级别函数
      customLogLevel: buildCustomLogLevel(),
      // 动态生成 transport 配置
      transport: buildLoggerTransport({ isDev, logPath }),
    },
  };
};

const redisConfig: ConfigFactory = () => {
  const passwordRaw = process.env.REDIS_PASSWORD;
  const password = passwordRaw && passwordRaw.trim().length > 0 ? passwordRaw : undefined;
  return {
    redis: {
      host: getRequiredEnv('REDIS_HOST'),
      port: getRequiredIntEnv('REDIS_PORT'),
      db: getRequiredIntEnv('REDIS_DB'),
      password,
      tls: process.env.REDIS_TLS === 'true',
    },
  };
};

const bullmqConfig: ConfigFactory = () => ({
  bullmq: {
    prefix: process.env.BULLMQ_PREFIX || 'bullmq',
  },
});

const qmWorkerEntryConfig: ConfigFactory = () => ({
  qmWorkerEntry: {
    ai: {
      enabled: parseBooleanInput(process.env.AI_QUEUE_DEBUG_ENABLED) ?? false,
    },
    email: {
      enabled: parseBooleanInput(process.env.EMAIL_QUEUE_DEBUG_ENABLED) ?? false,
    },
  },
});

const parseCsvEnv = (key: string): readonly string[] => {
  return (process.env[key] ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
};

const capabilityRuntimeConfig: ConfigFactory = () => ({
  capabilityRuntime: {
    disabledIds: parseCsvEnv('CAPABILITY_DISABLED_IDS'),
  },
});

const aiWorkerConfig: ConfigFactory = () => ({
  aiWorker: {
    providerMode: process.env.AI_PROVIDER_MODE || 'mock',
    qwen: {
      baseUrl: process.env.QWEN_BASE_URL || '',
      apiKey: process.env.QWEN_API_KEY || '',
      generateTimeoutMs: getIntEnvWithDefault('QWEN_GENERATE_TIMEOUT_MS', 30000),
    },
    openai: {
      baseUrl: process.env.OPENAI_BASE_URL || '',
      apiKey: process.env.OPENAI_API_KEY || '',
      generateTimeoutMs: getIntEnvWithDefault('OPENAI_GENERATE_TIMEOUT_MS', 30000),
    },
  },
});

/**
 * 生成 RAG 公共诊断客户端配置。
 *
 * 三种模式：
 * - 显式 `disabled`：跳过 RAG 专属配置检查与参数解析；合法诊断请求由客户端按
 *   `CONFIG_ERROR` 失败关闭且零出站，残留的 URL／密钥／超时／开关均被忽略。
 * - 未设置：保留 `remote` 默认；生产允许 URL 与密钥都不设，但只配一项会在预检失败。
 * - 显式 `remote`：要求 `LITHO_RAG_BASE_URL` 与 `LITHO_RAG_API_KEY` 同时齐全。
 *
 * 其余运行期不可用的配置继续由客户端在 `diagnose` 时按 `CONFIG_ERROR` 失败关闭，
 * 不在启动期抛错，保证无 RAG 密钥的进程仍可启用原有功能。
 */
const ragDiagnosisConfig: ConfigFactory = () => {
  const mode = process.env.LITHO_RAG_MODE?.trim().toLowerCase() || 'remote';

  // 显式 disabled 时不解析 RAG 专属参数：残留的非法超时或布尔值不得阻断启动。
  if (mode === 'disabled') {
    return {
      ragDiagnosis: {
        mode,
        baseUrl: '',
        apiKey: '',
        allowInsecureHttp: false,
        timeoutMs: 30000,
      },
    };
  }

  return {
    ragDiagnosis: {
      mode,
      baseUrl: getOptionalEnv('LITHO_RAG_BASE_URL') ?? '',
      apiKey: getOptionalEnv('LITHO_RAG_API_KEY') ?? '',
      allowInsecureHttp: getBooleanEnvWithDefault('LITHO_RAG_ALLOW_TAILNET_HTTP', false),
      timeoutMs: getIntEnvWithDefault('LITHO_RAG_TIMEOUT_MS', 30000),
    },
  };
};

/**
 * 任务05 对话链路配置：
 * - `model` / `provider`：派发时写入工作流上下文的模型快照（未配置则由 provider 注册表决定）；
 * - `visualizationTtlSeconds`：图形临时通道有效期（默认 30 分钟，属建议值，待 03/负责人确认）。
 */
const aiConversationConfig: ConfigFactory = () => ({
  aiConversation: {
    model: getOptionalEnv('AI_CONVERSATION_MODEL') ?? 'qwen-plus',
    provider: getOptionalEnv('AI_CONVERSATION_PROVIDER') ?? null,
    visualizationTtlSeconds: getIntEnvWithDefault(
      'AI_CONVERSATION_VISUALIZATION_TTL_SECONDS',
      1800,
    ),
    export: {
      /** PDF 中文字体文件路径（CJK 字体为运行时资源，不入库；缺失时导出按设计失败关闭） */
      pdfFontPath:
        getOptionalEnv('AI_CONVERSATION_EXPORT_PDF_FONT_PATH') ??
        'var/fonts/NotoSansSC-Regular.otf',
      /** 受控原始 JSON 的技术授权凭据；未配置时受控 JSON 一律拒绝（安全默认） */
      rawJsonAuthorization: getOptionalEnv('AI_CONVERSATION_EXPORT_RAW_JSON_AUTHORIZATION') ?? '',
    },
  },
});

const emailDeliveryConfig: ConfigFactory = () => ({
  emailDelivery: {
    sendAsUser: getOptionalEnv('EMAIL_SEND_AS_USER'),
    sendmailPath: getOptionalEnv('EMAIL_SENDMAIL_PATH') ?? '/usr/sbin/sendmail',
  },
});

/** 参考资料文件存储默认 MIME 白名单（扩展名同源，见 file-storage 契约） */
const REFERENCE_DOCUMENT_DEFAULT_MIME_TYPES: readonly string[] = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'image/png',
  'image/jpeg',
  'text/plain',
  'text/markdown',
  'text/csv',
];

/** 生成参考资料文件存储配置（上传目录/大小上限/MIME 白名单，未配置时用安全缺省） */
const referenceDocumentStorageConfig: ConfigFactory = () => ({
  referenceDocumentStorage: {
    // 相对路径相对 backend 运行目录解析；不得指向 Git 仓库内未忽略目录（见 env/.env.example 注释）
    dir: getOptionalEnv('REFERENCE_DOCUMENT_STORAGE_DIR') ?? 'var/reference-documents',
    uploadMaxBytes: getIntEnvWithDefault('REFERENCE_DOCUMENT_UPLOAD_MAX_BYTES', 20 * 1024 * 1024),
    allowedMimeTypes: (() => {
      const parsed = parseCsvEnv('REFERENCE_DOCUMENT_ALLOWED_MIME_TYPES');

      return parsed.length > 0 ? parsed : REFERENCE_DOCUMENT_DEFAULT_MIME_TYPES;
    })(),
  },
});

/**
 * 生成 JWT 配置
 */
const jwtConfig = registerAs('jwt', () => ({
  // 用于签名 JWT 的密钥（建议走环境变量管理）
  secret: getRequiredEnv('JWT_SECRET'),

  // Access Token 有效期
  expiresIn: process.env.JWT_EXPIRES_IN || '2h',

  // Refresh Token 有效期（如果实现刷新机制）
  refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',

  // 是否启用 JWT 的加密算法和算法选项（可选）
  algorithm: process.env.JWT_ALGORITHM || 'HS256',

  // 是否允许自动刷新（自定义业务用）
  enableRefresh: process.env.JWT_ENABLE_REFRESH === 'true',

  // 允许的 issuer、audience 等（更严格控制）
  issuer: process.env.JWT_ISSUER || 'ssts-local',
  audience: process.env.JWT_AUDIENCE || 'DESKTOP,SSTSTEST,SSTSWEB,SSTSWEAPP,SJWEB,SJWEAPP',
}));

/**
 * 生成管理员默认密码重置配置（任务 08.4）
 *
 * 缺失时**不提供默认值**：重置用例在运行期以 `ADMIN_USER_DEFAULT_PASSWORD_NOT_CONFIGURED`
 * 拒绝，避免把硬编码弱口令变成可用凭据。本键同时不进入生产必填清单——它只影响单个
 * 管理动作，缺失时按失败关闭处理即可，不应阻断整个服务启动。
 */
const adminAccountResetConfig: ConfigFactory = () => ({
  adminAccountReset: {
    defaultPassword: getOptionalEnv('ADMIN_DEFAULT_RESET_PASSWORD'),
  },
});

/**
 * 生成分页配置
 */
const paginationConfig = () => ({
  pagination: {
    hmacSecret: getRequiredEnv('PAGINATION_HMAC_SECRET'),
  },
});

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true, // 使 ConfigService 全局可用（无需再次 import）
      envFilePath: isProductionEnv()
        ? ['env/.env.production']
        : [`env/.env.${process.env.NODE_ENV || 'development'}`, 'env/.env.development'],
      load: [
        graphqlConfig,
        serverConfig,
        loggerConfig,
        databaseConfig,
        redisConfig,
        bullmqConfig,
        qmWorkerEntryConfig,
        capabilityRuntimeConfig,
        aiWorkerConfig,
        ragDiagnosisConfig,
        aiConversationConfig,
        emailDeliveryConfig,
        referenceDocumentStorageConfig,
        adminAccountResetConfig,
        jwtConfig,
        paginationConfig,
      ],
    }),
  ],
})
export class AppConfigModule {}
