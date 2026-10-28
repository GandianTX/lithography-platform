#!/usr/bin/env node
// test/run-pr0-acceptance.js
//
// PR0 清理安全收敛：受控真实验收入口。
//
// 目标：把“真实运行绑定到明确配置的独占可丢弃实例”变成可复核、拒绝危险默认值的入口，
// 而不是依赖执行者手写 export 或 CLI。该启动器：
//   1) 只从显式存在的配置文件取值（不 source shell，不读取 backend/env/.env.e2e，不回落默认端口）；
//   2) 在连接前拒绝：缺失字段、DB_SYNCHRONIZE=true、允许全库清理、默认/生产端口、
//      父 shell 残留 DB/REDIS 值、真实外部服务开关、非可丢弃实例的归属证据；
//   3) 只读预检：MySQL 端口/库/数据目录/server_uuid、Redis 端口/DB/run_id、服务进程事实；
//   4) 预检后再次确认配置未变化，再用“显式构造”的子进程环境执行正式 runner；
//   5) 配置/服务变化或任何拒绝都发生在 spawn 之前，并打印拒绝阶段。
//
// 该文件不产生业务副作用；预检连接是只读查询。出现拒绝时退出码非零。

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const BACKEND_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(BACKEND_ROOT, '..');
const DEFAULT_USAGE =
  '用法：node test/run-pr0-acceptance.js --config <验收env> [--phase preflight-only] [core|--group core] ' +
  '[--file <spec>] [-t <pattern>] [--samples-out <path>]';

const REQUIRED_KEYS = [
  'DB_HOST',
  'DB_PORT',
  'DB_USER',
  'DB_PASS',
  'DB_NAME',
  'DB_SYNCHRONIZE',
  'DB_TIMEZONE',
  'DB_POOL_SIZE',
  'DB_LOGGING',
  'REDIS_HOST',
  'REDIS_PORT',
  'REDIS_DB',
  'REDIS_PASSWORD',
  'REDIS_TLS',
  'E2E_SKIP_DB_CLEANUP',
  'E2E_ALLOW_DB_CLEANUP',
  'E2E_ALLOW_PHYSICAL_CLEANUP',
  'E2E_ALLOWED_DB_NAMES',
  'ACCEPTANCE_INSTANCE_ROOT',
  'ACCEPTANCE_MYSQL_DATA_DIR',
  'ACCEPTANCE_MYSQL_PID',
  'ACCEPTANCE_MYSQL_SERVER_UUID',
  'ACCEPTANCE_REDIS_PID',
  'ACCEPTANCE_REDIS_RUN_ID',
  'JWT_SECRET',
  'PAGINATION_HMAC_SECRET',
  'FIELD_ENCRYPTION_KEY',
  'FIELD_ENCRYPTION_IV',
  'AI_PROVIDER_MODE',
];

/** 启动器必须拒绝的父 shell 残留数据库值（与配置不一致时）。 */
const SHELL_BINDING_KEYS = [
  'DB_HOST',
  'DB_PORT',
  'DB_USER',
  'DB_NAME',
  'REDIS_HOST',
  'REDIS_PORT',
  'REDIS_DB',
];

const EXTERNAL_SERVICE_KEYS = [
  'RUN_REAL_AI_E2E',
  'RUN_REAL_AI_AUTH_FAIL_E2E',
  'RUN_REAL_EMAIL_E2E',
  'RUN_REAL_EMAIL_DELIVERY_E2E',
  'RUN_REAL_WEAPP_E2E',
  'RUN_REAL_EXTERNAL_SMOKE',
];

const SYSTEM_SCHEMAS = new Set(['mysql', 'information_schema', 'performance_schema', 'sys']);

class AcceptanceRefusal extends Error {
  constructor(stage, message) {
    super(message);
    this.name = 'AcceptanceRefusal';
    this.stage = stage;
  }
}

const refuse = (stage, message) => {
  throw new AcceptanceRefusal(stage, message);
};

const isTruthy = (value) =>
  ['1', 'true', 'yes', 'on'].includes(
    String(value ?? '')
      .trim()
      .toLowerCase(),
  );

const isFalsy = (value) =>
  ['0', 'false', 'no', 'off'].includes(
    String(value ?? '')
      .trim()
      .toLowerCase(),
  );

const requireValue = (map, key) => {
  const value = (map[key] ?? '').trim();
  if (value === '') {
    refuse('config', `缺少必填配置 ${key}（不允许以默认值代替）`);
  }
  return value;
};

const requireInt = (map, key, min, max) => {
  const raw = requireValue(map, key);
  if (!/^\d+$/.test(raw)) {
    refuse('config', `配置 ${key} 必须是整数，实际为 "${raw}"`);
  }
  const value = Number(raw);
  if (value < min || value > max) {
    refuse('config', `配置 ${key} 超出允许范围 ${min}..${max}，实际为 ${value}`);
  }
  return value;
};

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

const parseConfigText = (text) => {
  const map = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }
    const match = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(trimmed);
    if (!match) {
      refuse('config', `无法解析的配置行：${trimmed.slice(0, 40)}`);
    }
    const key = match[1];
    let value = match[2];
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) {
      value = value.slice(1, -1);
    }
    if (Object.prototype.hasOwnProperty.call(map, key)) {
      refuse('config', `配置项重复：${key}`);
    }
    map[key] = value;
  }
  return map;
};

/** 读取并解析配置文件；文件不存在/不可读时在连接前拒绝。 */
const loadConfig = (configPath) => {
  const absolute = path.resolve(configPath);
  if (!fs.existsSync(absolute)) {
    refuse('config', `配置文件不存在：${absolute}`);
  }
  const text = fs.readFileSync(absolute, 'utf8');
  const hash = crypto.createHash('sha256').update(text).digest('hex');
  return { path: absolute, map: parseConfigText(text), hash };
};

const validateRequiredKeys = (map) => {
  for (const key of REQUIRED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(map, key)) {
      refuse('config', `缺少必填配置项 ${key}`);
    }
  }
};

const validateDatabaseBinding = (map) => {
  const dbHost = requireValue(map, 'DB_HOST');
  if (!LOOPBACK_HOSTS.has(dbHost)) {
    refuse('config', `DB_HOST 必须是本机回环地址，实际为 "${dbHost}"`);
  }
  const dbPort = requireInt(map, 'DB_PORT', 1, 65535);
  if (dbPort === 3306) {
    refuse('config', 'DB_PORT 不得使用仓库默认端口 3306（禁止误伤默认实例）');
  }
  const dbName = requireValue(map, 'DB_NAME');
  if (SYSTEM_SCHEMAS.has(dbName.toLowerCase()) || !/^[A-Za-z0-9_]+$/.test(dbName)) {
    refuse('config', `DB_NAME 不是可丢弃业务库名："${dbName}"`);
  }
  if ((map.DB_SYNCHRONIZE ?? '').trim().toLowerCase() !== 'false') {
    refuse('config', 'DB_SYNCHRONIZE 必须显式 false（禁止同步改 schema）');
  }
  requireValue(map, 'DB_TIMEZONE');
  requireInt(map, 'DB_POOL_SIZE', 1, 100);

  const allowedNames = requireValue(map, 'E2E_ALLOWED_DB_NAMES')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  if (!allowedNames.every((name) => /^[A-Za-z0-9_]+$/.test(name))) {
    refuse('config', 'E2E_ALLOWED_DB_NAMES 含非法库名');
  }
  if (!allowedNames.includes(dbName)) {
    refuse('config', `DB_NAME "${dbName}" 不在 E2E_ALLOWED_DB_NAMES 内`);
  }
  if (allowedNames.some((name) => SYSTEM_SCHEMAS.has(name.toLowerCase()))) {
    refuse('config', 'E2E_ALLOWED_DB_NAMES 不得包含系统库');
  }
  return {
    dbHost,
    dbPort,
    dbUser: requireValue(map, 'DB_USER'),
    dbPass: map.DB_PASS,
    dbName,
    allowedNames,
  };
};

const validateCleanupPolicy = (map) => {
  if (!isTruthy(map.E2E_SKIP_DB_CLEANUP)) {
    refuse('config', 'E2E_SKIP_DB_CLEANUP 必须为真（全局 TRUNCATE 必须跳过）');
  }
  if (!isFalsy(map.E2E_ALLOW_DB_CLEANUP)) {
    refuse('config', 'E2E_ALLOW_DB_CLEANUP 必须为假（全局清理许可必须关闭）');
  }
  if (!isTruthy(map.E2E_ALLOW_PHYSICAL_CLEANUP)) {
    refuse('config', 'E2E_ALLOW_PHYSICAL_CLEANUP 必须显式有效（启动器不代为赋予物理清理许可）');
  }
};

const validateRedisBinding = (map) => {
  const redisHost = requireValue(map, 'REDIS_HOST');
  if (!LOOPBACK_HOSTS.has(redisHost)) {
    refuse('config', `REDIS_HOST 必须是本机回环地址，实际为 "${redisHost}"`);
  }
  const redisPort = requireInt(map, 'REDIS_PORT', 1, 65535);
  if (redisPort === 6379) {
    refuse('config', 'REDIS_PORT 不得使用默认端口 6379（禁止误伤默认实例）');
  }
  const redisDb = requireInt(map, 'REDIS_DB', 0, 15);
  if ((map.REDIS_TLS ?? '').trim().toLowerCase() !== 'false') {
    refuse('config', 'REDIS_TLS 必须显式 false（该阶段不覆盖 TLS 实例）');
  }
  requireValue(map, 'JWT_SECRET');
  return { redisHost, redisPort, redisDb, redisPass: map.REDIS_PASSWORD };
};

/**
 * 本期真实消费者需要的最小运行值（分页 HMAC、字段加密、AI 模式）。
 * 缺失/空白或不符合消费格式时在连接与 spawn 之前拒绝；不打印任何密钥值。
 */
const validateRuntimeSecrets = (map) => {
  const paginationSecret = requireValue(map, 'PAGINATION_HMAC_SECRET');
  const fieldEncryptionKey = requireValue(map, 'FIELD_ENCRYPTION_KEY');
  if (fieldEncryptionKey.length < 16) {
    refuse('config', 'FIELD_ENCRYPTION_KEY 长度必须至少 16');
  }
  const fieldEncryptionIv = requireValue(map, 'FIELD_ENCRYPTION_IV');
  if (fieldEncryptionIv.length < 16) {
    refuse('config', 'FIELD_ENCRYPTION_IV 长度必须至少 16');
  }
  const aiProviderMode = requireValue(map, 'AI_PROVIDER_MODE').toLowerCase();
  if (aiProviderMode !== 'mock') {
    refuse('config', 'AI_PROVIDER_MODE 必须为 mock（受控验收不启用 remote）');
  }
  return { paginationSecret, fieldEncryptionKey, fieldEncryptionIv, aiProviderMode };
};

const validateExternalToggles = (map) => {
  for (const key of EXTERNAL_SERVICE_KEYS) {
    if (isTruthy(map[key])) {
      refuse('config', `真实外部服务开关必须关闭：${key}=${map[key]}`);
    }
  }
  for (const [key, value] of Object.entries(map)) {
    if (/^RUN_REAL_/.test(key) && isTruthy(value)) {
      refuse('config', `未知真实外部服务开关必须关闭：${key}`);
    }
  }
};

const validateShellBindings = (map) => {
  for (const key of SHELL_BINDING_KEYS) {
    const shellValue = (process.env[key] ?? '').trim();
    if (shellValue !== '' && shellValue !== (map[key] ?? '').trim()) {
      refuse(
        'config',
        `父 shell 残留 ${key}="${shellValue}" 与配置 "${map[key]}" 冲突；不接受隐式绑定`,
      );
    }
  }
};

const validateInstanceEvidence = (map) => {
  const instanceRoot = path.resolve(requireValue(map, 'ACCEPTANCE_INSTANCE_ROOT'));
  if (instanceRoot.startsWith(REPO_ROOT + path.sep) || instanceRoot === REPO_ROOT) {
    refuse('config', 'ACCEPTANCE_INSTANCE_ROOT 不得位于仓库内');
  }
  if (!fs.existsSync(instanceRoot) || !fs.statSync(instanceRoot).isDirectory()) {
    refuse('config', `ACCEPTANCE_INSTANCE_ROOT 不存在或不是目录：${instanceRoot}`);
  }
  const dataDir = path.resolve(requireValue(map, 'ACCEPTANCE_MYSQL_DATA_DIR'));
  const rootPrefix = instanceRoot.endsWith(path.sep) ? instanceRoot : instanceRoot + path.sep;
  if (!dataDir.startsWith(rootPrefix) && dataDir !== instanceRoot) {
    refuse('config', 'ACCEPTANCE_MYSQL_DATA_DIR 必须位于 ACCEPTANCE_INSTANCE_ROOT 内');
  }
  if (!fs.existsSync(dataDir) || !fs.statSync(dataDir).isDirectory()) {
    refuse('config', `MySQL 数据目录不存在：${dataDir}`);
  }
  if (dataDir === '/var/lib/mysql' || dataDir === '/var/lib/mysql/') {
    refuse('config', '拒绝使用系统默认 MySQL 数据目录');
  }

  requireInt(map, 'ACCEPTANCE_MYSQL_PID', 1, 2 ** 31 - 1);
  requireInt(map, 'ACCEPTANCE_REDIS_PID', 1, 2 ** 31 - 1);
  const uuid = requireValue(map, 'ACCEPTANCE_MYSQL_SERVER_UUID');
  if (!/^[0-9a-fA-F-]{8,64}$/.test(uuid)) {
    refuse('config', 'ACCEPTANCE_MYSQL_SERVER_UUID 格式异常');
  }
  const runId = requireValue(map, 'ACCEPTANCE_REDIS_RUN_ID');
  if (!/^[0-9a-f]{40}$/.test(runId)) {
    refuse('config', 'ACCEPTANCE_REDIS_RUN_ID 必须是 40 位十六进制');
  }
  return {
    instanceRoot,
    dataDir,
    mysqlPid: Number(map.ACCEPTANCE_MYSQL_PID),
    serverUuid: uuid.toLowerCase(),
    redisPid: Number(map.ACCEPTANCE_REDIS_PID),
    redisRunId: runId.toLowerCase(),
  };
};

const validateConfig = (config) => {
  const { map } = config;
  validateRequiredKeys(map);
  const db = validateDatabaseBinding(map);
  validateCleanupPolicy(map);
  const redis = validateRedisBinding(map);
  const runtime = validateRuntimeSecrets(map);
  validateExternalToggles(map);
  validateShellBindings(map);
  const instance = validateInstanceEvidence(map);
  return { ...db, ...redis, ...runtime, ...instance };
};

const readProcessCmdline = (pid) => {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return raw.split('\0').join(' ').trim();
  } catch {
    return '';
  }
};

const assertProcessFact = (pid, kind, requiredFragment) => {
  try {
    process.kill(pid, 0);
  } catch {
    refuse('instance', `${kind} 进程 ${pid} 不可用（拒绝使用无进程事实的实例）`);
  }
  const cmdline = readProcessCmdline(pid);
  if (cmdline === '') {
    refuse('instance', `${kind} 进程 ${pid} 的启动事实不可读`);
  }
  const isMysql = kind === 'MySQL';
  if (isMysql && !cmdline.includes('mysqld')) {
    refuse('instance', `进程 ${pid} 不是 mysqld：${cmdline.slice(0, 80)}`);
  }
  if (!isMysql && !cmdline.includes('redis-server')) {
    refuse('instance', `进程 ${pid} 不是 redis-server：${cmdline.slice(0, 80)}`);
  }
  if (!cmdline.includes(requiredFragment)) {
    refuse('instance', `${kind} 进程 ${pid} 的启动事实未包含 ${requiredFragment}`);
  }
};

const normalizeDir = (value) => path.resolve(String(value ?? '').trim());

/** 只读预检：绑定端口/库/实例身份，并校验服务进程与数据目录事实。 */
const runPreflight = async (bound) => {
  let connection = null;
  let redis = null;
  try {
    const mysql = require('mysql2/promise');
    connection = await mysql.createConnection({
      host: bound.dbHost,
      port: bound.dbPort,
      user: bound.dbUser,
      password: bound.dbPass,
      database: bound.dbName,
      connectTimeout: 5000,
      multipleStatements: false,
    });
    const [rows] = await connection.query(
      'SELECT @@port AS port, @@datadir AS datadir, @@server_uuid AS uuid, DATABASE() AS db',
    );
    const row = rows && rows[0] ? rows[0] : {};
    if (Number(row.port) !== bound.dbPort) {
      refuse('preflight', `MySQL 实际端口 ${row.port} 与配置 ${bound.dbPort} 不一致`);
    }
    if (String(row.db) !== bound.dbName) {
      refuse('preflight', `MySQL 实际库 ${row.db} 与配置 ${bound.dbName} 不一致`);
    }
    if (normalizeDir(row.datadir) !== bound.dataDir) {
      refuse('preflight', `MySQL 实际 datadir ${row.datadir} 与配置 ${bound.dataDir} 不一致`);
    }
    if (String(row.uuid).toLowerCase() !== bound.serverUuid) {
      refuse('preflight', `MySQL server_uuid ${row.uuid} 与记录的实例标识不一致`);
    }
    assertProcessFact(bound.mysqlPid, 'MySQL', bound.dataDir);

    const Redis = require('ioredis');
    redis = new Redis({
      host: bound.redisHost,
      port: bound.redisPort,
      db: bound.redisDb,
      password: bound.redisPass === '' ? undefined : bound.redisPass,
      lazyConnect: true,
      connectTimeout: 5000,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    });
    await redis.connect();
    const pong = await redis.ping();
    if (pong !== 'PONG') {
      refuse('preflight', `Redis PING 返回 ${pong}`);
    }
    const info = await redis.info('server');
    const fields = {};
    for (const line of String(info).split(/\r?\n/)) {
      const index = line.indexOf(':');
      if (index > 0) {
        fields[line.slice(0, index)] = line.slice(index + 1).trim();
      }
    }
    if (Number(fields.tcp_port) !== bound.redisPort) {
      refuse('preflight', `Redis 实际端口 ${fields.tcp_port} 与配置 ${bound.redisPort} 不一致`);
    }
    if (String(fields.run_id).toLowerCase() !== bound.redisRunId) {
      refuse('preflight', 'Redis run_id 与记录的实例标识不一致');
    }
    assertProcessFact(bound.redisPid, 'Redis', 'redis-server');

    console.log('PR0_ACCEPT_PRECHECK=ok');
    console.log(
      `PR0_ACCEPT_MYSQL=${bound.dbHost}:${bound.dbPort}/${bound.dbName} ` +
        `datadir=${bound.dataDir} uuid=${bound.serverUuid.slice(0, 8)}…`,
    );
    console.log(
      `PR0_ACCEPT_REDIS=${bound.redisHost}:${bound.redisPort} db=${bound.redisDb} ` +
        `run_id=${bound.redisRunId.slice(0, 8)}…`,
    );
    console.log(`PR0_ACCEPT_MYSQL_PID=${bound.mysqlPid}`);
    console.log(`PR0_ACCEPT_REDIS_PID=${bound.redisPid}`);
  } finally {
    if (redis) {
      await redis.quit().catch(() => {});
    }
    if (connection) {
      await connection.end().catch(() => {});
    }
  }
};

/**
 * 生成供 global setup/teardown 加载的“净化副本”：只含连接/运行必需值，
 * 不含 E2E 许可与清理开关。这样“故意移除许可”的子用例不会被配置文件重新注入许可。
 */
const writeSanitizedDotenv = (config, bound) => {
  const file = path.join(path.dirname(config.path), '.pr0-acceptance-load.env');
  const lines = [
    `DB_HOST=${bound.dbHost}`,
    `DB_PORT=${bound.dbPort}`,
    `DB_USER=${bound.dbUser}`,
    `DB_PASS=${bound.dbPass}`,
    `DB_NAME=${bound.dbName}`,
    'DB_SYNCHRONIZE=false',
    `DB_TIMEZONE=${(config.map.DB_TIMEZONE ?? '').trim()}`,
    `DB_POOL_SIZE=${(config.map.DB_POOL_SIZE ?? '').trim()}`,
    `DB_LOGGING=${(config.map.DB_LOGGING ?? '').trim()}`,
    `REDIS_HOST=${bound.redisHost}`,
    `REDIS_PORT=${bound.redisPort}`,
    `REDIS_DB=${bound.redisDb}`,
    `REDIS_PASSWORD=${bound.redisPass}`,
    'REDIS_TLS=false',
    'NODE_ENV=e2e',
    'TZ=Asia/Shanghai',
    `JWT_SECRET=${(config.map.JWT_SECRET ?? '').trim()}`,
    `PAGINATION_HMAC_SECRET=${bound.paginationSecret}`,
    `FIELD_ENCRYPTION_KEY=${bound.fieldEncryptionKey}`,
    `FIELD_ENCRYPTION_IV=${bound.fieldEncryptionIv}`,
    `AI_PROVIDER_MODE=${bound.aiProviderMode}`,
  ];
  fs.writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
  return file;
};

const buildChildEnv = (config, bound, options, dotenvFile) => {
  const base = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TERM']) {
    if (process.env[key] !== undefined) {
      base[key] = process.env[key];
    }
  }
  const env = {
    ...base,
    LANG: 'C.UTF-8',
    NODE_ENV: 'e2e',
    TZ: 'Asia/Shanghai',
    DB_HOST: bound.dbHost,
    DB_PORT: String(bound.dbPort),
    DB_USER: bound.dbUser,
    DB_PASS: bound.dbPass,
    DB_NAME: bound.dbName,
    DB_SYNCHRONIZE: 'false',
    DB_TIMEZONE: (config.map.DB_TIMEZONE ?? '').trim(),
    DB_POOL_SIZE: (config.map.DB_POOL_SIZE ?? '').trim(),
    DB_LOGGING: (config.map.DB_LOGGING ?? '').trim(),
    REDIS_HOST: bound.redisHost,
    REDIS_PORT: String(bound.redisPort),
    REDIS_DB: String(bound.redisDb),
    REDIS_PASSWORD: bound.redisPass,
    REDIS_TLS: 'false',
    JWT_SECRET: (config.map.JWT_SECRET ?? '').trim(),
    PAGINATION_HMAC_SECRET: bound.paginationSecret,
    FIELD_ENCRYPTION_KEY: bound.fieldEncryptionKey,
    FIELD_ENCRYPTION_IV: bound.fieldEncryptionIv,
    AI_PROVIDER_MODE: bound.aiProviderMode,
    E2E_SKIP_DB_CLEANUP: 'true',
    E2E_ALLOW_DB_CLEANUP: '0',
    E2E_ALLOW_PHYSICAL_CLEANUP: '1',
    E2E_ALLOWED_DB_NAMES: bound.allowedNames.join(','),
    // 防止 global setup/teardown 回落 backend/env/.env.e2e；
    // 加载的净化副本不含 E2E 许可开关，且文件名不是 .env.e2e，teardown 不会 FLUSHDB。
    E2E_DOTENV: dotenvFile,
    PR0_ACCEPTANCE_CONFIG: config.path,
    PR0_ACCEPTANCE_PHASE: 'runner',
    E2E_GROUP: options.group,
  };
  if (options.samplesOut) {
    env.S7_SAMPLES_OUT = options.samplesOut;
  }
  return env;
};

const buildRunnerArgs = (options) => {
  const args = [path.join(BACKEND_ROOT, 'test/run-e2e-group.js')];
  if (options.file) {
    args.push('--file', options.file);
    if (options.testNamePattern) {
      args.push('-t', options.testNamePattern);
    }
    return args;
  }
  args.push(options.group);
  return args;
};

const parseArgs = (argv) => {
  const options = { phase: 'runner', group: 'core', file: '', testNamePattern: '', samplesOut: '' };
  let configPath = '';
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--config':
        configPath = argv[index + 1] ?? '';
        index += 1;
        break;
      case '--phase':
        options.phase = argv[index + 1] ?? '';
        index += 1;
        break;
      case '--group':
        options.group = argv[index + 1] ?? '';
        index += 1;
        break;
      case 'core':
        options.group = 'core';
        break;
      case '--file':
        options.file = argv[index + 1] ?? '';
        index += 1;
        break;
      case '-t':
      case '--testNamePattern':
        options.testNamePattern = argv[index + 1] ?? '';
        index += 1;
        break;
      case '--samples-out':
        options.samplesOut = argv[index + 1] ?? '';
        index += 1;
        break;
      default:
        refuse('usage', `未知参数：${arg}。${DEFAULT_USAGE}`);
    }
  }
  if (!configPath) {
    refuse('usage', `缺少 --config。${DEFAULT_USAGE}`);
  }
  if (!['runner', 'preflight-only'].includes(options.phase)) {
    refuse('usage', `--phase 只支持 runner/preflight-only，实际 "${options.phase}"`);
  }
  if (!/^[a-zA-Z0-9:_-]+$/.test(options.group)) {
    refuse('usage', `--group 名称非法："${options.group}"`);
  }
  if (options.file && options.samplesOut) {
    refuse('usage', '--samples-out 只用于整组运行（core），不能与 --file 同用');
  }
  if (options.file && !/^test\/[A-Za-z0-9_./-]+\.e2e-spec\.ts$/.test(options.file)) {
    refuse('usage', `--file 必须是 test/ 下的 e2e 规格："${options.file}"`);
  }
  return { configPath, options };
};

const assertConfigUnchanged = (config) => {
  const current = fs.readFileSync(config.path, 'utf8');
  const hash = crypto.createHash('sha256').update(current).digest('hex');
  if (hash !== config.hash) {
    refuse('config-changed', '预检与执行之间配置文件发生变化：拒绝启动，请重新冻结后再运行');
  }
};

const run = async (argv) => {
  const { configPath, options } = parseArgs(argv);
  const config = loadConfig(configPath);
  const bound = validateConfig(config);
  const samplesOut = options.samplesOut ? path.resolve(options.samplesOut) : '';
  const runnerOptions = { ...options, samplesOut };

  await runPreflight(bound);
  assertConfigUnchanged(config);
  // 预检后再次确认实例进程事实仍成立，避免“检查后服务被替换”。
  assertProcessFact(bound.mysqlPid, 'MySQL', bound.dataDir);
  assertProcessFact(bound.redisPid, 'Redis', 'redis-server');

  if (options.phase === 'preflight-only') {
    console.log('PR0_ACCEPT_PHASE=preflight-only');
    return 0;
  }

  const args = buildRunnerArgs(runnerOptions);
  const dotenvFile = writeSanitizedDotenv(config, bound);
  const childEnv = buildChildEnv(config, bound, runnerOptions, dotenvFile);
  console.log(`PR0_ACCEPT_RUNNER=spawned args=${args.slice(1).join(' ')}`);

  const exitCode = await new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: BACKEND_ROOT,
      env: childEnv,
      stdio: 'inherit',
    });
    const forward = (signal) => {
      try {
        child.kill(signal);
      } catch {
        // 子进程已退出：忽略。
      }
    };
    process.once('SIGINT', () => forward('SIGINT'));
    process.once('SIGTERM', () => forward('SIGTERM'));
    child.once('error', (error) => {
      console.error(`PR0_ACCEPT_SPAWN_ERROR=${error.message}`);
      resolve(1);
    });
    child.once('exit', (code, signal) => {
      if (signal) {
        console.log(`PR0_ACCEPT_RUNNER_SIGNAL=${signal}`);
        resolve(1);
        return;
      }
      resolve(code ?? 1);
    });
  });
  console.log(`PR0_ACCEPT_RUNNER_EXIT=${exitCode}`);
  return exitCode;
};

const main = async (argv) => {
  try {
    return await run(argv);
  } catch (error) {
    if (error instanceof AcceptanceRefusal) {
      console.error(`PR0_ACCEPT_REFUSED=${error.stage}`);
      console.error(`PR0_ACCEPT_REFUSED_REASON=${error.message}`);
      return 2;
    }
    console.error('PR0_ACCEPT_REFUSED=internal');
    console.error(`PR0_ACCEPT_REFUSED_REASON=${error && error.message ? error.message : error}`);
    return 3;
  }
};

module.exports = {
  AcceptanceRefusal,
  parseConfigText,
  loadConfig,
  validateConfig,
  runPreflight,
  writeSanitizedDotenv,
  buildChildEnv,
  buildRunnerArgs,
  parseArgs,
  run,
  main,
  DEFAULT_USAGE,
};

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
