// scripts/lint-colors.mjs

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const SOURCE_ROOT = path.resolve('src');
const CHECKED_EXTENSIONS = new Set(['.css', '.ts', '.tsx']);
const MAGIC_COLOR_PATTERN = /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|hsl)a?\s*\(/gi;
const INDEX_CSS_PATH = path.normalize('src/index.css');
const THEME_PATH = path.normalize('src/app/theme/index.ts');
// 白名单即「documented global token」：每一项都对应 gkj 视觉基准的映射记录，
// 见 frontend/docs/gkj-visual-baseline.md（第 2 节通用基准 / 第 6 节知识库页变体，PR3 R7）。
const ALLOWED_INDEX_CSS_COLOR_TOKENS = new Set([
  '--ai-workspace-bg',
  '--ai-workspace-ink',
  '--ai-workspace-muted',
  '--ai-scene-bg-start',
  '--ai-scene-bg-mid',
  '--ai-scene-bg-end',
  '--ai-input-line',
  '--ai-input-bg',
  '--ai-panel-bg',
  '--ai-panel-line',
  '--ai-thread-bg-start',
  '--ai-thread-bg-end',
  '--ai-thread-line',
  '--ai-message-bg',
  '--ai-message-line',
  '--ai-message-mine-bg',
  '--ai-message-mine-line',
  '--ai-panel-header-bg',
  '--ai-compose-bg',
  '--ai-failure-bg',
  '--ai-failure-line',
  '--ai-fault-card-bg',
  '--ai-fault-card-text',
  '--ai-chip-bg',
  '--ai-chip-text',
  '--ai-geo-part-normal',
  '--ai-geo-part-highlight',
  '--ai-geo-part-warning',
  '--ai-geo-part-hidden',
  '--ai-geo-part-fault',
  '--ai-geo-outline',
  '--ai-geo-outline-highlight',
  '--ai-geo-outline-warning',
  '--ai-geo-outline-fault',
  '--ai-geo-base',
  '--ai-geo-base-dark',
  '--ai-geo-grid',
  '--ai-geo-scan',
  '--ai-geo-hatch',
  '--ai-ink',
  '--ai-muted',
  '--ai-blue',
  '--ai-accent',
  '--ai-hover',
  '--ai-white',
  '--ai-nav-hover-bg',
  '--ai-select-line',
  '--ai-select-arrow',
  '--ai-btn-line',
  '--ai-btn-ink',
  '--ai-btn-hover-bg',
  '--ai-btn-hover-line',
  '--ai-btn-active-bg',
  '--ai-accent-hover',
  '--ai-accent-active',
  '--ai-btn-disabled-bg',
  '--ai-btn-disabled-ink',
  '--ai-geo-hover-fill',
  '--ai-geo-outline-hover',
  '--ai-geo-legend-highlight-bg',
  '--ai-geo-legend-highlight-text',
  '--ai-geo-legend-warning-bg',
  '--ai-geo-legend-warning-text',
  '--color-ai-accent',
  '--color-ai-accent-hover',
  // gkj 原型受控语义常量（基准表：frontend/docs/gkj-visual-baseline.md）
  // 工程师工作台条目交互三态（PR4；基准表 2.4 节）+ 跨页共享中性控件文字色
  '--activity-item-bg',
  '--activity-item-hover-bg',
  '--activity-item-hover-border',
  '--activity-item-active-bg',
  '--activity-item-active-border',
  '--activity-item-active-ring',
  '--avatar-border',
  '--avatar-gradient',
  '--brand-mark-bg',
  '--brand-mark-fg',
  '--control-text-body',
  '--control-text-tool',
  '--empty-bg',
  '--empty-border',
  '--empty-text',
  '--eyebrow-text',
  '--filter-bar-bg',
  '--filter-bar-border',
  '--nav-bg',
  '--nav-border',
  '--nav-hover-bg',
  '--nav-hover-text',
  '--nav-shadow',
  '--nav-text',
  '--panel-bg',
  '--panel-border',
  '--panel-shadow',
  '--status-critical-bg',
  '--status-critical-text',
  '--status-ok-bg',
  '--status-ok-text',
  '--status-warn-bg',
  '--status-warn-text',
  '--stat-card-border',
  '--stat-card-gradient',
  '--sidebar-footer-bg',
  '--text-muted',
  '--text-strong',
  '--workspace-bg',
  // 知识库页（#knowledge-base-page）opt-in 变体常量（基准表第 6 节；仅 /admin/document-database 消费）
  '--kb-workspace-bg',
  '--kb-card-bg',
  '--kb-card-border',
  '--kb-card-shadow',
  '--kb-divider',
  '--kb-primary',
  '--kb-primary-hover',
  '--kb-primary-shadow',
  '--kb-on-primary',
  '--kb-text-body',
  '--kb-text-muted',
  '--kb-text-faint',
  '--kb-text-tool',
  '--kb-table-head-bg',
  '--kb-table-head-border',
  '--kb-table-row-hover',
  '--kb-search-bg',
  '--kb-search-border',
]);
const ALLOWED_THEME_TOKEN_NAMES = new Set([
  'colorBorderSecondary',
  'colorError',
  'colorErrorBg',
  'colorLink',
  'colorBgContainer',
  'colorBgLayout',
  'colorPrimary',
  'colorPrimaryActive',
  'colorPrimaryBg',
  'colorSuccess',
  'colorSuccessBg',
  'colorWarning',
  'colorWarningBg',
]);

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectFiles(absolutePath)));
      continue;
    }

    if (entry.isFile() && CHECKED_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(absolutePath);
    }
  }

  return files;
}

function isAllowedMagicColor(relativeFile, line) {
  const normalizedFile = path.normalize(relativeFile);

  if (normalizedFile === INDEX_CSS_PATH) {
    const tokenName = line.match(/^\s*(--[\w-]+)\s*:/)?.[1];
    return tokenName ? ALLOWED_INDEX_CSS_COLOR_TOKENS.has(tokenName) : false;
  }

  if (normalizedFile === THEME_PATH) {
    return [...ALLOWED_THEME_TOKEN_NAMES].some((tokenName) =>
      new RegExp(`\\b${tokenName}\\s*:`).test(line),
    );
  }

  return false;
}

const files = await collectFiles(SOURCE_ROOT);
const violations = [];

for (const file of files) {
  const content = await readFile(file, 'utf8');
  const lines = content.split(/\r?\n/);
  const relativeFile = path.relative(process.cwd(), file);

  lines.forEach((line, index) => {
    MAGIC_COLOR_PATTERN.lastIndex = 0;

    if (!MAGIC_COLOR_PATTERN.test(line) || isAllowedMagicColor(relativeFile, line)) {
      return;
    }

    violations.push({
      file: relativeFile,
      line: index + 1,
      message:
        'Use Ant Design tokens, shared CSS variables, or a documented global token instead of a raw color.',
      source: line.trim(),
    });
  });
}

if (violations.length > 0) {
  console.error('color lint failed:');

  for (const violation of violations) {
    console.error(
      `${violation.file}:${violation.line} ${violation.message}\n  ${violation.source}`,
    );
  }

  process.exitCode = 1;
}
