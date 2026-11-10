/// <reference types="jest" />
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { buildEnvironment } from '../../../test/run-v13-authoritative-spec';
import { V13_SPEC_GROUPS } from '../../../test/utils/v13-spec-set-guard';

const MANAGED_ENV_KEYS = [
  'V13_AUTHORITATIVE_SPECS',
  'V13_SPEC_CONFIG_FILE',
  'V13_SPEC_TARGET_DB',
  'V13_SPEC_SERVER_UUID',
  'E2E_ALLOW_PHYSICAL_CLEANUP',
  'E2E_ALLOWED_DB_NAMES',
  'E2E_EXPECTED_SERVER_UUID',
  'E2E_REAL_DB_NAME',
  'E2E_ALLOW_MIGRATION_43_UPGRADE',
  'D3_ALLOWED_DB_NAMES',
  'D3_CONSTRAINT_SPECS',
  'D3_ALLOW_PHYSICAL_CLEANUP',
  'D3_CONFIG_FILE',
  'D3_EXPECTED_SERVER_UUID',
  'E2E_REAL_DB_SPECS',
  'E2E_OWNED_FIXTURE_SPECS',
  'E2E_OWNED_FIXTURE_CONFIG_FILE',
  'E2E_OWNED_FIXTURE_TARGET_DB',
  'E2E_OWNED_FIXTURE_EXPECTED_SERVER_UUID',
  'NODE_ENV',
] as const;

describe('V13 权威规格启动配置', () => {
  let tempDir: string;
  let previousEnv: Record<string, string | undefined>;

  const targetDb = 'lithography_v13_spec';
  const serverUuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  const writeConfig = (content: string): string => {
    const filePath = path.resolve(tempDir, 'deploy.env');
    fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(filePath, 0o600);
    return filePath;
  };

  const validConfig = (): string =>
    [
      'DB_HOST=127.0.0.1',
      'DB_PORT=3306',
      'DB_USER=spec_runner',
      'DB_PASS=secret',
      `DB_NAME=${targetDb}`,
    ].join('\n');

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v13-authoritative-'));
    fs.chmodSync(tempDir, 0o700);
    previousEnv = {};
    for (const key of MANAGED_ENV_KEYS) {
      previousEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.V13_AUTHORITATIVE_SPECS = '1';
    process.env.V13_SPEC_TARGET_DB = targetDb;
    process.env.V13_SPEC_SERVER_UUID = serverUuid;
    process.env.E2E_ALLOW_PHYSICAL_CLEANUP = '1';
  });

  afterEach(() => {
    for (const key of MANAGED_ENV_KEYS) {
      if (previousEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previousEnv[key];
      }
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('合法配置只注入连接参数，外部残留的 UUID/目标/许可不能覆盖显式值', () => {
    process.env.V13_SPEC_CONFIG_FILE = writeConfig(validConfig());
    process.env.E2E_ALLOWED_DB_NAMES = 'other_db';
    process.env.E2E_EXPECTED_SERVER_UUID = 'attacker-uuid';
    process.env.E2E_REAL_DB_NAME = 'other_db';

    const env = buildEnvironment(V13_SPEC_GROUPS.delivery);

    expect(env.E2E_ALLOWED_DB_NAMES).toBe(targetDb);
    expect(env.E2E_REAL_DB_NAME).toBe(targetDb);
    expect(env.E2E_EXPECTED_SERVER_UUID).toBe(serverUuid);
    expect(env.E2E_ALLOW_PHYSICAL_CLEANUP).toBe('1');
    expect(env.D3_ALLOWED_DB_NAMES).toBe(targetDb);
    expect(env.E2E_OWNED_FIXTURE_TARGET_DB).toBe(targetDb);
    expect(env.NODE_ENV).toBe('test');
    expect(env.DB_NAME).toBe(targetDb);
  });

  it.each([
    ['E2E_EXPECTED_SERVER_UUID=attacker-uuid', 'E2E_EXPECTED_SERVER_UUID'],
    ['E2E_ALLOW_PHYSICAL_CLEANUP=0', 'E2E_ALLOW_PHYSICAL_CLEANUP'],
    ['E2E_ALLOWED_DB_NAMES=other_db', 'E2E_ALLOWED_DB_NAMES'],
    ['V13_SPEC_TARGET_DB=other_db', 'V13_SPEC_TARGET_DB'],
    ['D3_ALLOWED_DB_NAMES=other_db', 'D3_ALLOWED_DB_NAMES'],
    ['NODE_ENV=production', 'NODE_ENV'],
    ['DB_EXTRA=1', 'DB_EXTRA'],
    ['MYSQL_PWD=secret', 'MYSQL_PWD'],
  ])('配置文件夹带保留变量 %s 时失败关闭', (line, key) => {
    process.env.V13_SPEC_CONFIG_FILE = writeConfig(`${validConfig()}\n${line}`);

    expect(() => buildEnvironment(V13_SPEC_GROUPS.delivery)).toThrow(new RegExp(`保留变量 ${key}`));
  });

  it('配置夹带实际 UUID 也不能覆盖入口显式给出的错误 UUID', () => {
    process.env.V13_SPEC_SERVER_UUID = '00000000-0000-0000-0000-000000000000';
    process.env.V13_SPEC_CONFIG_FILE = writeConfig(
      `${validConfig()}\nV13_SPEC_SERVER_UUID=${serverUuid}`,
    );

    expect(() => buildEnvironment(V13_SPEC_GROUPS.delivery)).toThrow(
      /保留变量 V13_SPEC_SERVER_UUID/,
    );
  });

  it('父进程残留的 E2E/D3 控制变量不会继承进子进程环境', () => {
    process.env.V13_SPEC_CONFIG_FILE = writeConfig(validConfig());
    process.env.D3_CONSTRAINT_SPECS = '1';
    process.env.E2E_ALLOW_MIGRATION_43_UPGRADE = '1';
    process.env.E2E_ALLOWED_DB_NAMES = 'other_db';

    const env = buildEnvironment(V13_SPEC_GROUPS.upgrade);

    expect(env.D3_CONSTRAINT_SPECS).toBeUndefined();
    expect(env.E2E_ALLOWED_DB_NAMES).toBe(targetDb);
    expect(env.E2E_ALLOW_MIGRATION_43_UPGRADE).toBe('1');
  });

  it('父进程残留的 DB_* 不会覆盖配置文件连接字段', () => {
    process.env.V13_SPEC_CONFIG_FILE = writeConfig(validConfig());
    process.env.DB_NAME = 'other_db';

    const env = buildEnvironment(V13_SPEC_GROUPS.delivery);

    expect(env.DB_NAME).toBe(targetDb);
  });

  it('配置目标与显式目标不一致时失败关闭', () => {
    process.env.V13_SPEC_CONFIG_FILE = writeConfig(
      validConfig().replace(`DB_NAME=${targetDb}`, 'DB_NAME=other_db'),
    );

    expect(() => buildEnvironment(V13_SPEC_GROUPS.delivery)).toThrow(/目标库/);
  });

  it('缺少物理清理许可时在执行前失败关闭', () => {
    process.env.V13_SPEC_CONFIG_FILE = writeConfig(validConfig());
    delete process.env.E2E_ALLOW_PHYSICAL_CLEANUP;

    expect(() => buildEnvironment(V13_SPEC_GROUPS.delivery)).toThrow(/E2E_ALLOW_PHYSICAL_CLEANUP/);
  });
});
