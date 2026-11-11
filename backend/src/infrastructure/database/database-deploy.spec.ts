import { parseAdminBootstrapConfig } from './admin-bootstrap';
import { assertInitializationEmailConflicts, parseDeployCliArgs } from './database-deploy';
import { parseDevAccountBootstrapConfig } from './dev-account-bootstrap';

const validAdminFile = JSON.stringify({
  schema_version: 1,
  accounts: [
    {
      login_name: 'admin01',
      login_email: 'admin01@example.com',
      password: 'valid-password-01',
      admin_level: 1,
      organization_code: 'ORG-001',
      nickname: '管理员一',
      real_name: '张三',
    },
  ],
});

describe('database:deploy 参数（不连接实库）', () => {
  it('init 必须显式给出模式、配置文件、库名与一致确认', () => {
    expect(() =>
      parseDeployCliArgs([
        '--mode=init',
        '--config-file=.env.deploy',
        '--database=lithography',
        '--confirm-database=lithography',
      ]),
    ).not.toThrow();
  });

  it('库名确认不一致时失败关闭', () => {
    expect(() =>
      parseDeployCliArgs([
        '--mode=upgrade',
        '--config-file=.env.deploy',
        '--database=lithography',
        '--confirm-database=other',
      ]),
    ).toThrow(/confirm-database/);
  });

  it('upgrade 拒绝管理员初始化参数，避免每次部署重建账号', () => {
    expect(() =>
      parseDeployCliArgs([
        '--mode=upgrade',
        '--config-file=.env.deploy',
        '--database=lithography',
        '--confirm-database=lithography',
        '--admin-bootstrap-file=admins.json',
        '--confirm-admin-bootstrap=APPLY-ADMIN-BOOTSTRAP',
      ]),
    ).toThrow(/只允许在 init/);
  });

  it('init 启用管理员初始化时必须给出显式确认口令', () => {
    expect(() =>
      parseDeployCliArgs([
        '--mode=init',
        '--config-file=.env.deploy',
        '--database=lithography',
        '--confirm-database=lithography',
        '--admin-bootstrap-file=admins.json',
      ]),
    ).toThrow(/confirm-admin-bootstrap/);
  });

  it('缺少模式、配置文件或库名时失败关闭', () => {
    expect(() => parseDeployCliArgs([])).toThrow(/mode/);
    expect(() =>
      parseDeployCliArgs([
        '--mode=init',
        '--database=lithography',
        '--confirm-database=lithography',
      ]),
    ).toThrow(/config-file/);
    expect(() =>
      parseDeployCliArgs([
        '--mode=init',
        '--config-file=.env.deploy',
        '--confirm-database=lithography',
      ]),
    ).toThrow(/database/);
  });

  it('init 允许组织、管理员与开发账号在同一条命令中显式启用', () => {
    const options = parseDeployCliArgs([
      '--mode=init',
      '--config-file=.env.deploy',
      '--database=lithography_dev',
      '--confirm-database=lithography_dev',
      '--organization-bootstrap-file=organizations.json',
      '--confirm-organization-bootstrap=APPLY-ORGANIZATION-BOOTSTRAP',
      '--admin-bootstrap-file=admins.json',
      '--confirm-admin-bootstrap=APPLY-ADMIN-BOOTSTRAP',
      '--dev-accounts-file=dev-accounts.json',
      '--confirm-dev-accounts=APPLY-DEV-ACCOUNTS',
    ]);
    expect(options.organizationBootstrapFile).toBe('organizations.json');
    expect(options.adminBootstrapFile).toBe('admins.json');
    expect(options.devAccountsFile).toBe('dev-accounts.json');
  });

  it('组织初始化缺少确认口令或单独使用确认口令时失败关闭', () => {
    expect(() =>
      parseDeployCliArgs([
        '--mode=init',
        '--config-file=.env.deploy',
        '--database=lithography',
        '--confirm-database=lithography',
        '--organization-bootstrap-file=organizations.json',
      ]),
    ).toThrow(/confirm-organization-bootstrap/);
    expect(() =>
      parseDeployCliArgs([
        '--mode=init',
        '--config-file=.env.deploy',
        '--database=lithography',
        '--confirm-database=lithography',
        '--confirm-organization-bootstrap=APPLY-ORGANIZATION-BOOTSTRAP',
      ]),
    ).toThrow(/organization-bootstrap-file/);
  });

  it('开发账号初始化缺少确认口令时失败关闭', () => {
    expect(() =>
      parseDeployCliArgs([
        '--mode=init',
        '--config-file=.env.deploy',
        '--database=lithography_dev',
        '--confirm-database=lithography_dev',
        '--dev-accounts-file=dev-accounts.json',
      ]),
    ).toThrow(/confirm-dev-accounts/);
    expect(() =>
      parseDeployCliArgs([
        '--mode=init',
        '--config-file=.env.deploy',
        '--database=lithography_dev',
        '--confirm-database=lithography_dev',
        '--confirm-dev-accounts=APPLY-DEV-ACCOUNTS',
      ]),
    ).toThrow(/dev-accounts-file/);
  });

  it('开发账号初始化拒绝看起来像正式库的目标库名', () => {
    expect(() =>
      parseDeployCliArgs([
        '--mode=init',
        '--config-file=.env.deploy',
        '--database=lithography_prod',
        '--confirm-database=lithography_prod',
        '--dev-accounts-file=dev-accounts.json',
        '--confirm-dev-accounts=APPLY-DEV-ACCOUNTS',
      ]),
    ).toThrow(/开发或测试库/);
  });

  it('upgrade 拒绝组织与开发账号初始化参数', () => {
    expect(() =>
      parseDeployCliArgs([
        '--mode=upgrade',
        '--config-file=.env.deploy',
        '--database=lithography_dev',
        '--confirm-database=lithography_dev',
        '--organization-bootstrap-file=organizations.json',
        '--confirm-organization-bootstrap=APPLY-ORGANIZATION-BOOTSTRAP',
      ]),
    ).toThrow(/只允许在 init/);
    expect(() =>
      parseDeployCliArgs([
        '--mode=upgrade',
        '--config-file=.env.deploy',
        '--database=lithography_dev',
        '--confirm-database=lithography_dev',
        '--dev-accounts-file=dev-accounts.json',
        '--confirm-dev-accounts=APPLY-DEV-ACCOUNTS',
      ]),
    ).toThrow(/只允许在 init/);
  });
});

describe('管理员映射文件（不连接实库）', () => {
  it('合法映射可解析且保留等级与公司', () => {
    const config = parseAdminBootstrapConfig(validAdminFile);
    expect(config.schemaVersion).toBe(1);
    expect(config.accounts).toHaveLength(1);
    expect(config.accounts[0]).toMatchObject({
      loginName: 'admin01',
      adminLevel: 1,
      organizationCode: 'ORG-001',
    });
  });

  it('schema_version 不匹配、等级越界、重复账号与未知字段均失败关闭', () => {
    expect(() =>
      parseAdminBootstrapConfig(JSON.stringify({ schema_version: 2, accounts: [] })),
    ).toThrow(/schema_version/);
    expect(() =>
      parseAdminBootstrapConfig(
        JSON.stringify({
          schema_version: 1,
          accounts: [
            {
              login_name: 'admin01',
              password: 'valid-password-01',
              admin_level: 3,
              organization_code: 'ORG-001',
              nickname: '管理员一',
            },
          ],
        }),
      ),
    ).toThrow(/admin_level/);
    expect(() =>
      parseAdminBootstrapConfig(
        JSON.stringify({
          schema_version: 1,
          accounts: [
            {
              login_name: 'admin01',
              password: 'valid-password-01',
              admin_level: 1,
              organization_code: 'ORG-001',
              nickname: '管理员一',
            },
            {
              login_name: 'admin01',
              password: 'valid-password-02',
              admin_level: 1,
              organization_code: 'ORG-002',
              nickname: '管理员二',
            },
          ],
        }),
      ),
    ).toThrow(/重复账号/);
    expect(() =>
      parseAdminBootstrapConfig(
        JSON.stringify({
          schema_version: 1,
          accounts: [
            {
              login_name: 'admin01',
              password: 'valid-password-01',
              admin_level: 1,
              organization_code: 'ORG-001',
              nickname: '管理员一',
              secret_token: 'x',
            },
          ],
        }),
      ),
    ).toThrow(/不支持的字段/);
  });

  it('管理员映射内重复邮箱时失败关闭', () => {
    expect(() =>
      parseAdminBootstrapConfig(
        JSON.stringify({
          schema_version: 1,
          accounts: [
            {
              login_name: 'admin01',
              login_email: 'shared@example.com',
              password: 'valid-password-01',
              admin_level: 1,
              organization_code: 'ORG-001',
              nickname: '管理员一',
            },
            {
              login_name: 'admin02',
              login_email: 'SHARED@example.com',
              password: 'valid-password-02',
              admin_level: 1,
              organization_code: 'ORG-002',
              nickname: '管理员二',
            },
          ],
        }),
      ),
    ).toThrow(/重复邮箱/);
  });

  it('密码过短或缺失公司编码时失败关闭', () => {
    expect(() =>
      parseAdminBootstrapConfig(
        JSON.stringify({
          schema_version: 1,
          accounts: [
            {
              login_name: 'admin01',
              password: 'short',
              admin_level: 1,
              organization_code: 'ORG-001',
              nickname: '管理员一',
            },
          ],
        }),
      ),
    ).toThrow(/password/);
    expect(() =>
      parseAdminBootstrapConfig(
        JSON.stringify({
          schema_version: 1,
          accounts: [
            {
              login_name: 'admin01',
              password: 'valid-password-01',
              admin_level: 1,
              nickname: '管理员一',
            },
          ],
        }),
      ),
    ).toThrow(/organization_code/);
  });
});

describe('初始化映射邮箱冲突（不连接实库）', () => {
  const adminConfig = (email: string) =>
    parseAdminBootstrapConfig(
      JSON.stringify({
        schema_version: 1,
        accounts: [
          {
            login_name: 'admin01',
            login_email: email,
            password: 'valid-password-01',
            admin_level: 1,
            organization_code: 'ORG-001',
            nickname: '管理员一',
          },
        ],
      }),
    );

  const devConfig = (email: string) =>
    parseDevAccountBootstrapConfig(
      JSON.stringify({
        schema_version: 1,
        customers: [
          {
            login_name: 'dev-customer-01',
            login_email: email,
            password: 'Xk7#mQ2!vR9',
            nickname: '开发客户一',
            organization_code: 'ORG-CLIENT-A',
          },
        ],
        engineers: [],
      }),
    );

  it('管理员与开发客户邮箱冲突时拒绝', () => {
    expect(() =>
      assertInitializationEmailConflicts(
        adminConfig('same@example.com'),
        devConfig('SAME@example.com'),
      ),
    ).toThrow(/初始化映射邮箱冲突/);
  });

  it('管理员与开发工程师邮箱冲突时拒绝', () => {
    const dev = parseDevAccountBootstrapConfig(
      JSON.stringify({
        schema_version: 1,
        customers: [],
        engineers: [
          {
            login_name: 'dev-engineer-01',
            login_email: 'same@example.com',
            password: 'Hj4%kL6^bN2',
            nickname: '开发工程师一',
            organization_code: 'ORG-PEER-A',
          },
        ],
      }),
    );
    expect(() => assertInitializationEmailConflicts(adminConfig('same@example.com'), dev)).toThrow(
      /初始化映射邮箱冲突/,
    );
  });

  it('合法配置复跑保持幂等校验通过', () => {
    const admin = adminConfig('admin01@example.com');
    const dev = devConfig('dev-customer-01@example.com');
    expect(() => assertInitializationEmailConflicts(admin, dev)).not.toThrow();
    expect(() => assertInitializationEmailConflicts(admin, dev)).not.toThrow();
  });
});
