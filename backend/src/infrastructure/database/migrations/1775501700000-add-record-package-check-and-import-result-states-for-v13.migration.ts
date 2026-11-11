import { MigrationInterface, type QueryRunner } from 'typeorm';

const PACKAGE_TABLE = 'record_package_import';
const ITEM_TABLE = 'record_package_item';

const PACKAGE_IMPORT_STATUS = ['PENDING', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED'] as const;
const PACKAGE_CHECK_STATUS = ['PENDING', 'PASSED', 'REJECTED'] as const;
const ITEM_IMPORT_RESULT = ['SUCCEEDED', 'FAILED', 'SKIPPED', 'CONFLICT'] as const;
const ITEM_CHECK_RESULT = ['PASSED', 'REJECTED'] as const;

const PACKAGE_CHECK_STATUS_CHECK = 'chk_record_package_import_check_status';
const PACKAGE_CHECK_STAGE_CHECK = 'chk_record_package_import_check_stage';
const PACKAGE_MANIFEST_CHECK = 'chk_record_package_import_manifest';
const ITEM_RESULT_CHECK = 'chk_record_package_item_result';
const ITEM_CHECK_RESULT_CHECK = 'chk_record_package_item_check_result';
const ITEM_CHECK_STAGE_CHECK = 'chk_record_package_item_check_stage';

const quoteIn = (values: ReadonlyArray<string>): string =>
  values.map((value) => `'${value}'`).join(', ');

/**
 * 第 39 条迁移：记录包检查阶段与导入阶段可分别表达（R071—R073）。
 *
 * 状态组合（P0 冻结）：
 * - 包检查 `check_status`：NULL=历史无法判定／PENDING 未完成／PASSED 通过／REJECTED 拒绝；
 * - 包导入 `status`（沿用）：PENDING 未执行／RUNNING 进行中／SUCCEEDED 成功／
 *   PARTIAL 部分完成／FAILED 失败；
 * - 条目检查 `check_result`：NULL=未完成（或历史无法判定）／PASSED／REJECTED；
 * - 条目导入 `result`（改为可空）：NULL 未执行／SUCCEEDED／FAILED／SKIPPED／CONFLICT。
 *
 * 合法组合（数据库可证部分）：
 * - 包：RUNNING/SUCCEEDED/PARTIAL 必须有 check_status=PASSED；
 *   REJECTED 不允许任何导入阶段（status 必须为 PENDING）；PENDING 检查不允许开始导入。
 *   历史行 NULL 仅允许停留 PENDING/FAILED（不可证明检查已通过）。
 * - 条目：REJECTED 检查结果不允许任何导入结果；SUCCEEDED 必须有 check_result=PASSED。
 *   历史行 check_result=NULL 且 result=FAILED/SKIPPED 保留（无法证明，不猜测回填）。
 *
 * 历史兼容（不猜测、不统一回填成“检查待处理”）：
 * - 包 status=RUNNING/SUCCEEDED/PARTIAL 可证明导入前检查已通过 → 回填 PASSED；
 * - 条目 result=SUCCEEDED 可证明检查已通过 → 回填 PASSED；
 * - 其余历史行保持 NULL（语义为“历史未判定”，不是“检查未完成”）。
 *
 * DDL 约束：MySQL 的 DDL 隐式提交，跨表部分成功不能随迁移整体回滚。
 * 每个 ALTER 以“列/约束是否存在”判断是否已执行，失败后可直接重跑本迁移续跑。
 */
export class AddRecordPackageCheckAndImportResultStatesForV131775501700000 implements MigrationInterface {
  name = 'AddRecordPackageCheckAndImportResultStatesForV131775501700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const done: string[] = [];

    await this.runStep(done, '校验受影响表存在', async () => {
      const missing = await this.missingTables(queryRunner);
      if (missing.length > 0) {
        throw new Error(`缺少受影响表 ${missing.join('、')}；未执行任何 ALTER`);
      }
    });

    const packageCheckColumnExists = await this.columnExists(
      queryRunner,
      PACKAGE_TABLE,
      'check_status',
    );
    const itemCheckColumnExists = await this.columnExists(queryRunner, ITEM_TABLE, 'check_result');

    // 预检必须发生在任何 ALTER 之前：违规历史行直接失败关闭并给出定位 ID。
    await this.runStep(done, '检查历史数据', async () => {
      const issues = [
        ...(await this.collectPackageIssues(queryRunner, packageCheckColumnExists)),
        ...(await this.collectItemIssues(queryRunner, itemCheckColumnExists)),
      ];
      if (issues.length > 0) {
        const detail = issues
          .map(
            (issue) =>
              `${issue.table}: ${issue.rule} ${issue.rows} 行` +
              (issue.locators.length > 0 ? `（示例 ID：${issue.locators.join(', ')}）` : ''),
          )
          .join('；');
        throw new Error(
          `预检失败：${detail}；未执行任何 ALTER。` +
            '无法证明的历史状态不会被猜测回填，请按定位 ID 人工确认后重试。',
        );
      }
    });

    await this.runStep(done, `${PACKAGE_TABLE} 增加检查状态并收紧版本键`, async () => {
      if (packageCheckColumnExists) {
        return;
      }
      const manifestCheckExists = await this.checkExists(
        queryRunner,
        PACKAGE_TABLE,
        PACKAGE_MANIFEST_CHECK,
      );
      await queryRunner.query(`
        ALTER TABLE \`${PACKAGE_TABLE}\`
          ADD COLUMN \`check_status\` varchar(16) NULL DEFAULT NULL
            COMMENT '检查状态：NULL 历史未判定/PENDING/PASSED/REJECTED' AFTER \`status\`,
          ${manifestCheckExists ? `DROP CONSTRAINT \`${PACKAGE_MANIFEST_CHECK}\`,` : ''}
          ADD CONSTRAINT \`${PACKAGE_MANIFEST_CHECK}\` CHECK (
            JSON_VALID(\`manifest_json\`)
            AND JSON_EXTRACT(\`manifest_json\`, '$.schema_version') IS NOT NULL
            AND JSON_TYPE(JSON_EXTRACT(\`manifest_json\`, '$.schema_version')) <> 'NULL'
            AND CHAR_LENGTH(\`manifest_checksum\`) = 64
          )
      `);
    });

    await this.runStep(done, `${PACKAGE_TABLE} 按可证明事实回填检查状态`, async () => {
      await queryRunner.query(`
        UPDATE \`${PACKAGE_TABLE}\`
        SET \`check_status\` = 'PASSED'
        WHERE \`check_status\` IS NULL
          AND \`status\` IN ('RUNNING', 'SUCCEEDED', 'PARTIAL')
      `);
    });

    await this.runStep(done, `${PACKAGE_TABLE} 增加检查/导入组合约束`, async () => {
      const missing = await this.missingChecks(queryRunner, PACKAGE_TABLE, [
        PACKAGE_CHECK_STATUS_CHECK,
        PACKAGE_CHECK_STAGE_CHECK,
      ]);
      if (missing.length === 0) {
        return;
      }
      const clauses = [
        missing.includes(PACKAGE_CHECK_STATUS_CHECK)
          ? `ADD CONSTRAINT \`${PACKAGE_CHECK_STATUS_CHECK}\` CHECK (
              \`check_status\` IS NULL
              OR \`check_status\` IN (${quoteIn(PACKAGE_CHECK_STATUS)})
            )`
          : '',
        missing.includes(PACKAGE_CHECK_STAGE_CHECK)
          ? `ADD CONSTRAINT \`${PACKAGE_CHECK_STAGE_CHECK}\` CHECK (
              (\`status\` NOT IN ('RUNNING', 'SUCCEEDED', 'PARTIAL')
                OR COALESCE(\`check_status\`, '') = 'PASSED')
              AND (COALESCE(\`check_status\`, '') <> 'REJECTED' OR \`status\` = 'PENDING')
              AND (COALESCE(\`check_status\`, '') <> 'PENDING' OR \`status\` = 'PENDING')
            )`
          : '',
      ].filter(Boolean);
      await queryRunner.query(`ALTER TABLE \`${PACKAGE_TABLE}\` ${clauses.join(',\n')}`);
    });

    await this.runStep(done, `${ITEM_TABLE} 增加检查结果并放开未执行导入结果`, async () => {
      if (itemCheckColumnExists) {
        return;
      }
      // 新列不与引用它的 CHECK 放在同一条 ALTER，避免 DDL 解析歧义。
      const resultCheckExists = await this.checkExists(queryRunner, ITEM_TABLE, ITEM_RESULT_CHECK);
      await queryRunner.query(`
        ALTER TABLE \`${ITEM_TABLE}\`
          MODIFY COLUMN \`result\` varchar(16) NULL DEFAULT NULL
            COMMENT '导入结果：NULL 未执行/SUCCEEDED/FAILED/SKIPPED/CONFLICT',
          ADD COLUMN \`check_result\` varchar(16) NULL DEFAULT NULL
            COMMENT '检查结果：NULL 未完成或历史未判定/PASSED/REJECTED' AFTER \`version_no\`,
          ${resultCheckExists ? `DROP CONSTRAINT \`${ITEM_RESULT_CHECK}\`,` : ''}
          ADD CONSTRAINT \`${ITEM_RESULT_CHECK}\` CHECK (
            \`result\` IS NULL OR \`result\` IN (${quoteIn(ITEM_IMPORT_RESULT)})
          )
      `);
    });

    await this.runStep(done, `${ITEM_TABLE} 增加检查结果域约束`, async () => {
      if (await this.checkExists(queryRunner, ITEM_TABLE, ITEM_CHECK_RESULT_CHECK)) {
        return;
      }
      await queryRunner.query(`
        ALTER TABLE \`${ITEM_TABLE}\`
          ADD CONSTRAINT \`${ITEM_CHECK_RESULT_CHECK}\` CHECK (
            \`check_result\` IS NULL OR \`check_result\` IN (${quoteIn(ITEM_CHECK_RESULT)})
          )
      `);
    });

    await this.runStep(done, `${ITEM_TABLE} 按可证明事实回填检查结果`, async () => {
      await queryRunner.query(`
        UPDATE \`${ITEM_TABLE}\`
        SET \`check_result\` = 'PASSED'
        WHERE \`check_result\` IS NULL AND \`result\` = 'SUCCEEDED'
      `);
    });

    await this.runStep(done, `${ITEM_TABLE} 增加检查/导入组合约束`, async () => {
      if (await this.checkExists(queryRunner, ITEM_TABLE, ITEM_CHECK_STAGE_CHECK)) {
        return;
      }
      await queryRunner.query(`
        ALTER TABLE \`${ITEM_TABLE}\`
          ADD CONSTRAINT \`${ITEM_CHECK_STAGE_CHECK}\` CHECK (
            (COALESCE(\`check_result\`, '') <> 'REJECTED' OR \`result\` IS NULL)
            AND (\`result\` <> 'SUCCEEDED' OR COALESCE(\`check_result\`, '') = 'PASSED')
          )
      `);
    });
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const done: string[] = [];

    await this.runStep(done, '校验受影响表存在', async () => {
      const missing = await this.missingTables(queryRunner);
      if (missing.length > 0) {
        throw new Error(`缺少受影响表 ${missing.join('、')}；未执行任何 ALTER`);
      }
    });

    await this.runStep(done, '检查未执行或冲突的导入结果', async () => {
      const rows = (await queryRunner.query(`
        SELECT \`id\` AS locator FROM \`${ITEM_TABLE}\`
        WHERE \`result\` IS NULL OR \`result\` = 'CONFLICT'
        ORDER BY \`id\`
        LIMIT 10
      `)) as Array<{ locator: string | number }>;
      if (rows.length > 0) {
        throw new Error(
          '回退失败：存在导入结果为空（未执行）或为 CONFLICT 的条目；' +
            '恢复 NOT NULL 与旧三值域将丢失信息，' +
            `未执行任何 ALTER（示例 ID：${rows.map((row) => row.locator).join(', ')}）`,
        );
      }
    });

    await this.runStep(done, `${ITEM_TABLE} 移除检查结果约束`, async () => {
      if (!(await this.columnExists(queryRunner, ITEM_TABLE, 'check_result'))) {
        return;
      }
      const existing = await this.existingChecks(queryRunner, ITEM_TABLE, [
        ITEM_CHECK_STAGE_CHECK,
        ITEM_CHECK_RESULT_CHECK,
        ITEM_RESULT_CHECK,
      ]);
      if (existing.length === 0) {
        return;
      }
      await queryRunner.query(
        `ALTER TABLE \`${ITEM_TABLE}\` ${existing
          .map((constraint) => `DROP CONSTRAINT \`${constraint}\``)
          .join(', ')}`,
      );
    });

    await this.runStep(done, `${ITEM_TABLE} 移除检查结果列并恢复旧结果域`, async () => {
      if (!(await this.columnExists(queryRunner, ITEM_TABLE, 'check_result'))) {
        if (await this.checkExists(queryRunner, ITEM_TABLE, ITEM_RESULT_CHECK)) {
          return;
        }
        // 上一次回退已删除列与旧结果约束：仅补回旧域，不触碰数据。
        await queryRunner.query(`
          ALTER TABLE \`${ITEM_TABLE}\`
            ADD CONSTRAINT \`${ITEM_RESULT_CHECK}\` CHECK (
              \`result\` IN ('SUCCEEDED', 'FAILED', 'SKIPPED')
            )
        `);
        return;
      }
      await queryRunner.query(`
        ALTER TABLE \`${ITEM_TABLE}\`
          DROP COLUMN \`check_result\`,
          MODIFY COLUMN \`result\` varchar(16) NOT NULL COMMENT 'SUCCEEDED/FAILED/SKIPPED',
          ADD CONSTRAINT \`${ITEM_RESULT_CHECK}\` CHECK (
            \`result\` IN ('SUCCEEDED', 'FAILED', 'SKIPPED')
          )
      `);
    });

    await this.runStep(done, `${PACKAGE_TABLE} 移除检查状态约束`, async () => {
      const existing = await this.existingChecks(queryRunner, PACKAGE_TABLE, [
        PACKAGE_CHECK_STATUS_CHECK,
        PACKAGE_CHECK_STAGE_CHECK,
      ]);
      if (existing.length === 0) {
        return;
      }
      await queryRunner.query(
        `ALTER TABLE \`${PACKAGE_TABLE}\` ${existing
          .map((constraint) => `DROP CONSTRAINT \`${constraint}\``)
          .join(', ')}`,
      );
    });

    await this.runStep(done, `${PACKAGE_TABLE} 移除检查状态列并恢复版本键检查`, async () => {
      if (!(await this.columnExists(queryRunner, PACKAGE_TABLE, 'check_status'))) {
        return;
      }
      await queryRunner.query(`
        ALTER TABLE \`${PACKAGE_TABLE}\`
          DROP COLUMN \`check_status\`,
          DROP CONSTRAINT \`${PACKAGE_MANIFEST_CHECK}\`,
          ADD CONSTRAINT \`${PACKAGE_MANIFEST_CHECK}\` CHECK (
            JSON_VALID(\`manifest_json\`)
            AND JSON_EXTRACT(\`manifest_json\`, '$.schema_version') IS NOT NULL
            AND CHAR_LENGTH(\`manifest_checksum\`) = 64
          )
      `);
    });
  }

  /**
   * 任何 ALTER 前读取历史数据。定位 ID 只用于诊断，不参与回填判断。
   */
  private async collectPackageIssues(
    queryRunner: QueryRunner,
    checkColumnExists: boolean,
  ): Promise<PreflightIssue[]> {
    const metrics = [
      { rule: '非法 JSON', condition: 'JSON_VALID(`manifest_json`) = 0' },
      {
        rule: '缺 schema_version',
        condition:
          "JSON_VALID(`manifest_json`) = 1 AND JSON_EXTRACT(`manifest_json`, '$.schema_version') IS NULL",
      },
      {
        rule: 'schema_version 为 JSON null',
        condition:
          "JSON_VALID(`manifest_json`) = 1 AND JSON_TYPE(JSON_EXTRACT(`manifest_json`, '$.schema_version')) = 'NULL'",
      },
      {
        rule: '非法导入状态',
        condition: `\`status\` NOT IN (${quoteIn(PACKAGE_IMPORT_STATUS)})`,
      },
      {
        rule: 'manifest_checksum 非 64 位',
        condition: 'CHAR_LENGTH(`manifest_checksum`) <> 64',
      },
      {
        rule: '条目计数越界',
        condition: '`item_succeeded` + `item_failed` > `item_total`',
      },
    ];
    if (checkColumnExists) {
      metrics.push(
        {
          rule: '非法检查状态',
          condition: `\`check_status\` IS NOT NULL AND \`check_status\` NOT IN (${quoteIn(PACKAGE_CHECK_STATUS)})`,
        },
        {
          rule: '非法检查/导入组合',
          condition:
            "NOT ((`status` NOT IN ('RUNNING', 'SUCCEEDED', 'PARTIAL') OR COALESCE(`check_status`, '') = 'PASSED')" +
            " AND (COALESCE(`check_status`, '') <> 'REJECTED' OR `status` = 'PENDING')" +
            " AND (COALESCE(`check_status`, '') <> 'PENDING' OR `status` = 'PENDING'))",
        },
      );
    }
    return this.collectIssues(queryRunner, PACKAGE_TABLE, 'package_id', metrics);
  }

  private async collectItemIssues(
    queryRunner: QueryRunner,
    checkColumnExists: boolean,
  ): Promise<PreflightIssue[]> {
    const metrics = [
      {
        rule: '非法导入结果',
        condition: `\`result\` IS NOT NULL AND \`result\` NOT IN (${quoteIn(ITEM_IMPORT_RESULT)})`,
      },
      {
        rule: '失败无原因',
        condition:
          "`result` = 'FAILED' AND (`error_message` IS NULL OR CHAR_LENGTH(TRIM(`error_message`)) = 0)",
      },
    ];
    if (checkColumnExists) {
      metrics.push(
        {
          rule: '非法检查结果',
          condition: `\`check_result\` IS NOT NULL AND \`check_result\` NOT IN (${quoteIn(ITEM_CHECK_RESULT)})`,
        },
        {
          rule: '非法检查/导入组合',
          condition:
            "NOT ((COALESCE(`check_result`, '') <> 'REJECTED' OR `result` IS NULL)" +
            " AND (`result` <> 'SUCCEEDED' OR COALESCE(`check_result`, '') = 'PASSED'))",
        },
      );
    }
    return this.collectIssues(queryRunner, ITEM_TABLE, 'id', metrics);
  }

  private async collectIssues(
    queryRunner: QueryRunner,
    table: string,
    locatorColumn: string,
    metrics: ReadonlyArray<{ rule: string; condition: string }>,
  ): Promise<PreflightIssue[]> {
    const selectMetrics = metrics
      .map(
        (metric, index) =>
          `SUM(CASE WHEN ${metric.condition} THEN 1 ELSE 0 END) AS metric_${index}`,
      )
      .join(', ');
    const rows = (await queryRunner.query(
      `SELECT COUNT(*) AS total, ${selectMetrics} FROM \`${table}\``,
    )) as Array<Record<string, string | number>>;
    const counted = rows[0] ?? {};
    const issues = metrics
      .map((metric, index) => ({
        table,
        rule: metric.rule,
        rows: Number(counted[`metric_${index}`] ?? 0),
      }))
      .filter((issue) => issue.rows > 0);
    if (issues.length === 0) {
      return [];
    }
    const locators = (await queryRunner.query(
      `SELECT \`${locatorColumn}\` AS locator FROM \`${table}\`
       WHERE ${metrics.map((metric) => `(${metric.condition})`).join(' OR ')}
       ORDER BY \`${locatorColumn}\`
       LIMIT 10`,
    )) as Array<{ locator: string | number }>;
    const ids = locators.map((row) => String(row.locator));
    return issues.map((issue) => ({ ...issue, locators: ids }));
  }

  private async runStep(done: string[], step: string, action: () => Promise<void>): Promise<void> {
    try {
      await action();
      done.push(step);
    } catch (error) {
      throw new Error(
        `第 39 条迁移（记录包检查/导入状态）在步骤「${step}」失败；` +
          `已完成：${done.length > 0 ? done.join('、') : '无'}；` +
          '该步骤的表级 ALTER 原子，但跨表 DDL 已提交部分不能随本迁移整体回滚；' +
          '修复后可重新执行本迁移，已存在的列/约束会被跳过。' +
          `原始错误：${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  private async missingTables(queryRunner: QueryRunner): Promise<string[]> {
    const rows = (await queryRunner.query(
      `SELECT TABLE_NAME AS table_name FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME IN (?, ?)`,
      [PACKAGE_TABLE, ITEM_TABLE],
    )) as Array<{ table_name: string }>;
    const present = new Set(rows.map((row) => row.table_name));
    return [PACKAGE_TABLE, ITEM_TABLE].filter((table) => !present.has(table));
  }

  private async columnExists(
    queryRunner: QueryRunner,
    table: string,
    column: string,
  ): Promise<boolean> {
    const rows = (await queryRunner.query(
      `SELECT COLUMN_NAME AS column_name FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, column],
    )) as Array<{ column_name: string }>;
    return rows.length > 0;
  }

  private async checkExists(
    queryRunner: QueryRunner,
    table: string,
    constraint: string,
  ): Promise<boolean> {
    const rows = (await queryRunner.query(
      `SELECT CONSTRAINT_NAME AS constraint_name FROM information_schema.TABLE_CONSTRAINTS
       WHERE CONSTRAINT_SCHEMA = DATABASE()
         AND TABLE_NAME = ?
         AND CONSTRAINT_NAME = ?
         AND CONSTRAINT_TYPE = 'CHECK'`,
      [table, constraint],
    )) as Array<{ constraint_name: string }>;
    return rows.length > 0;
  }

  private async missingChecks(
    queryRunner: QueryRunner,
    table: string,
    constraints: ReadonlyArray<string>,
  ): Promise<string[]> {
    const missing: string[] = [];
    for (const constraint of constraints) {
      if (!(await this.checkExists(queryRunner, table, constraint))) {
        missing.push(constraint);
      }
    }
    return missing;
  }

  private async existingChecks(
    queryRunner: QueryRunner,
    table: string,
    constraints: ReadonlyArray<string>,
  ): Promise<string[]> {
    const existing: string[] = [];
    for (const constraint of constraints) {
      if (await this.checkExists(queryRunner, table, constraint)) {
        existing.push(constraint);
      }
    }
    return existing;
  }
}

interface PreflightIssue {
  readonly table: string;
  readonly rule: string;
  readonly rows: number;
  readonly locators: string[];
}
