// scripts/measure-v44-ai-styles.mjs
// 任务05 S4：V44 原型与实现的逐项数值量测（rect + computed style）。
//
// 为什么是独立脚本而不是 e2e spec：
// - 这是证据采集工具，不是回归用例；放进 e2e/ 会被默认 `playwright test` 收集并在每次跑测时写证据文件；
// - 需要同时打开仓库外的原型 HTML（file://）与被测应用，两套页面不适合放进同一个 spec 的 webServer 生命周期。
//
// 用法：
//   cd frontend
//   node scripts/measure-v44-ai-styles.mjs                       # 自动起 4180 端口的 dev server
//   node scripts/measure-v44-ai-styles.mjs --base-url=http://127.0.0.1:4180
//   node scripts/measure-v44-ai-styles.mjs --out=/tmp/v44.json
//
// 输出：默认写入 docs/plan/task05/修复证据-20261120/v44-styles.json（docs/plan 已被 .gitignore 忽略）。

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { chromium } from '@playwright/test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(FRONTEND_ROOT, '..');
const PROTOTYPE_HTML = path.join(
  REPO_ROOT,
  'docs/plan/task05/01-光刻维护平台-DemoV44-中英文切换.html',
);

const PORT = 4180;
const VIEWPORTS = [
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1366x768', width: 1366, height: 768 },
  { name: '390x844', width: 390, height: 844 },
];

/** 原型 selector ↔ 实现 selector ↔ 语义 */
const TARGETS = [
  { key: 'shell', label: '工作区壳层', prototype: '.ai36-shell', implementation: '.ai-workspace' },
  { key: 'workspace', label: '工作区网格', prototype: '.ai33-workspace', implementation: '.ai-workspace-grid' },
  { key: 'scene', label: '左侧场景区', prototype: '.ai33-scene', implementation: '.ai-scene' },
  { key: 'sceneHeader', label: '场景头部', prototype: '.ai36-model-header', implementation: '.ai-scene-header' },
  { key: 'canvas', label: '场景画布', prototype: '.ai33-canvas', implementation: '.ai-scene-canvas' },
  { key: 'sceneFooter', label: '场景底部', prototype: '.ai36-model-footer', implementation: '.ai-scene-footer' },
  { key: 'panel', label: '对话面板', prototype: '.ai33-panel', implementation: '.ai-panel' },
  { key: 'panelHeader', label: '面板头部', prototype: '.ai33-panel-header', implementation: '.ai-panel-header' },
  { key: 'thread', label: '对话线程', prototype: '.ai33-thread', implementation: '.ai-thread' },
  { key: 'message', label: 'AI 消息气泡', prototype: '.ai33-message:not([data-mine="true"])', implementation: '.ai-message:not(.ai-message--mine)' },
  { key: 'messageMine', label: '用户消息气泡', prototype: '.ai33-message[data-mine="true"]', implementation: '.ai-message--mine' },
  { key: 'compose', label: '输入区', prototype: '.ai33-compose', implementation: '.ai-compose' },
  {
    key: 'input',
    label: '输入框',
    prototype: 'textarea[aria-label="AI提问"]',
    // showCount 时可见框体是 affix 包装层；实现侧优先量包装层，缺省回落到裸 textarea
    implementation: '.ai-compose .ant-input-textarea-affix-wrapper, .ai-compose textarea',
  },
  {
    key: 'inputText',
    label: '输入框正文层',
    prototype: 'textarea[aria-label="AI提问"]',
    implementation: '.ai-compose textarea',
  },
  { key: 'send', label: '发送按钮', prototype: '.ai33-send', implementation: '.ai-compose .ant-btn-primary' },
];

const STYLE_KEYS = [
  'display',
  'position',
  'boxSizing',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'letterSpacing',
  'color',
  'backgroundColor',
  'borderTopWidth',
  'borderTopColor',
  'borderTopLeftRadius',
  'borderTopRightRadius',
  'borderBottomLeftRadius',
  'borderBottomRightRadius',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'marginTop',
  'marginBottom',
  'gap',
  'rowGap',
  'columnGap',
  'maxWidth',
  'minHeight',
  'overflowX',
  'overflowY',
];

const PART_IDS = [
  'controller',
  'reticle_cassette',
  'reticle_arm',
  'reticle_table',
  'reticle_vacuum',
  'positioning_laser',
  'wafer_cassette',
  'wafer_arm',
  'alignment_table',
  'wafer_stage',
  'projection_lens',
];

const ANSWER_TEXT = '建议先检查取板台真空吸附与激光定位组件，再确认手臂 1 的到位信号。';

function parseArgs(argv) {
  const args = { baseUrl: null, out: null };
  for (const item of argv.slice(2)) {
    if (item.startsWith('--base-url=')) {
      args.baseUrl = item.slice('--base-url='.length);
    } else if (item.startsWith('--out=')) {
      args.out = item.slice('--out='.length);
    }
  }
  return args;
}

function buildParts(display, overrides = {}) {
  return PART_IDS.map((partId) => ({ partId, display: overrides[partId] ?? display }));
}

async function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return true;
      }
    } catch {
      // 尚未就绪
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function ensureDevServer(baseUrl) {
  if (await waitForServer(baseUrl, 2_000)) {
    return { stop: async () => {}, baseUrl };
  }
  const child = spawn(
    'npm',
    ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
    { cwd: FRONTEND_ROOT, stdio: 'ignore' },
  );
  const ok = await waitForServer(baseUrl, 90_000);
  if (!ok) {
    child.kill('SIGKILL');
    throw new Error(`dev server 未在超时时间内就绪：${baseUrl}`);
  }
  return {
    baseUrl,
    stop: async () => {
      child.kill('SIGTERM');
    },
  };
}

/** 采集：每个 selector 取第一个匹配元素的 rect + computed style */
function collectMetrics(page, pairs, shellSelector) {
  return page.evaluate((input) => {
    const result = {};
    for (const pair of input.pairs) {
      const element = document.querySelector(pair.selector);
      if (!element) {
        result[pair.key] = null;
        continue;
      }
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      const styles = {};
      for (const key of input.styleKeys) {
        styles[key] = style[key];
      }
      result[pair.key] = {
        label: pair.label,
        selector: pair.selector,
        rect: {
          x: Math.round(rect.x * 10) / 10,
          y: Math.round(rect.y * 10) / 10,
          width: Math.round(rect.width * 10) / 10,
          height: Math.round(rect.height * 10) / 10,
        },
        styles,
        inlineStyle: element.getAttribute('style') ?? '',
        textSample: (element.textContent ?? '').trim().slice(0, 24),
      };
    }
    const doc = document.documentElement;
    const thread = document.querySelector(input.threadSelector);

    // 壳层归因：记录工作区祖先链的 rect／padding／height，用于区分
    // 「05 局部布局问题」与「共享壳层外边距造成的坐标差」（S4 允许差异第 3 条）。
    let node = document.querySelector(input.shellSelector);
    const ancestors = [];
    for (let depth = 0; node && depth < 5; depth += 1, node = node.parentElement) {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      ancestors.push({
        tag: node.tagName.toLowerCase(),
        className: typeof node.className === 'string' ? node.className : '',
        rect: {
          x: Math.round(rect.x * 10) / 10,
          y: Math.round(rect.y * 10) / 10,
          width: Math.round(rect.width * 10) / 10,
          height: Math.round(rect.height * 10) / 10,
        },
        padding: `${style.paddingTop} ${style.paddingRight} ${style.paddingBottom} ${style.paddingLeft}`,
        margin: `${style.marginTop} ${style.marginRight} ${style.marginBottom} ${style.marginLeft}`,
        display: style.display,
        heightCss: style.height,
        overflowY: style.overflowY,
      });
    }
    result.__shell = { ancestors, viewportBottomGapPx: window.innerHeight - (ancestors[0]?.rect.y + ancestors[0]?.rect.height) };

    result.__page = {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      documentScrollWidth: doc.scrollWidth,
      documentClientWidth: doc.clientWidth,
      horizontalOverflowPx: doc.scrollWidth - doc.clientWidth,
      scrollY: window.scrollY,
      threadOverflowPx: thread ? thread.scrollWidth - thread.clientWidth : null,
    };
    return result;
  }, {
    pairs,
    styleKeys: STYLE_KEYS,
    threadSelector: '.ai33-thread, .ai-thread',
    shellSelector,
  });
}

async function waitForFonts(page) {
  await page.evaluate(async () => {
    if (document.fonts && document.fonts.ready) {
      await document.fonts.ready;
    }
  });
}

/** —— 原型：真实 V44 页面 #/engineer/ai/chat —— */
async function measurePrototype(browser, viewport) {
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
  const page = await context.newPage();
  const url = `${pathToFileURL(PROTOTYPE_HTML).href}#/engineer/ai/chat`;
  await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
  await page.locator('.ai36-shell').waitFor({ state: 'visible', timeout: 60_000 });
  await waitForFonts(page);

  const empty = await collectMetrics(
    page,
    TARGETS.map((t) => ({ key: t.key, label: t.label, selector: t.prototype })),
    '.ai36-shell',
  );

  await page.locator('textarea[aria-label="AI提问"]').fill('手臂 1 无动作，怎么排查？');
  await page.locator('button.ai33-send').click();
  await page.locator('.ai33-message').nth(1).waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForTimeout(600);

  const qa = await collectMetrics(
    page,
    TARGETS.map((t) => ({ key: t.key, label: t.label, selector: t.prototype })),
    '.ai36-shell',
  );

  await context.close();
  return { empty, qa };
}

/** —— 实现：mock-only 前端，仅拦截 4 个必需 GraphQL 操作 —— */
async function installGraphQLMock(page) {
  const state = {
    conversationId: 901,
    turns: [],
    submitCount: 0,
  };

  await page.route('**/graphql', async (route) => {
    const payload = route.request().postDataJSON();
    const operation = payload?.operationName ?? '';
    const variables = payload?.variables ?? {};

    const dto = () => ({
      id: state.conversationId,
      requestId: null,
      requestNo: '',
      status: 'ACTIVE',
      contentVersion: state.turns.length + 1,
      createdAt: '2026-11-20T02:00:00.000Z',
      completedAt: null,
      messages: state.turns.flatMap((turn) =>
        [turn.question, turn.answer].filter((message) => message !== null),
      ),
      turns: state.turns,
    });

    if (operation === 'MyAiConversations') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            myAiConversations: {
              items: [
                {
                  id: state.conversationId,
                  requestId: null,
                  requestNo: '',
                  status: 'ACTIVE',
                  contentVersion: state.turns.length + 1,
                  messageCount: state.turns.length * 2,
                  createdAt: '2026-11-20T02:00:00.000Z',
                },
              ],
              total: 1,
              page: 1,
              pageSize: 20,
            },
          },
        }),
      });
    }

    if (operation === 'MyAiConversation') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: { myAiConversation: dto() } }),
      });
    }

    if (operation === 'CreateAiConversation') {
      state.turns = [];
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            createAiConversation: {
              id: state.conversationId,
              requestId: null,
              requestNo: '',
              status: 'ACTIVE',
              contentVersion: 1,
              createdAt: '2026-11-20T02:00:00.000Z',
            },
          },
        }),
      });
    }

    if (operation === 'SubmitAiQuestion') {
      state.submitCount += 1;
      const input = variables.input;
      const turnNo = state.turns.length + 1;
      state.turns.push({
        questionUuid: input.questionUuid,
        turnNo,
        question: { id: turnNo * 10, text: input.question, role: 'USER', contentVersion: turnNo },
        answer: null,
        analysisStatus: 'PENDING',
        failureReason: null,
        analysisContentVersion: null,
        completedAt: null,
      });
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            submitAiQuestion: {
              conversationId: state.conversationId,
              questionUuid: input.questionUuid,
              status: 'PENDING',
              turnNo,
              messageSeq: turnNo * 10,
              contentVersion: turnNo,
              replayed: false,
              dispatchStatus: 'QUEUED',
            },
          },
        }),
      });
    }

    if (operation === 'AiQuestionStatus') {
      const input = variables.input;
      const turn = state.turns.find((item) => item.questionUuid === input.questionUuid);
      const answer = {
        id: (turn?.turnNo ?? 1) * 10 + 1,
        text: ANSWER_TEXT,
        role: 'ASSISTANT',
        contentVersion: turn?.turnNo ?? 1,
      };
      if (turn) {
        turn.analysisStatus = 'SUCCEEDED';
        turn.answer = answer;
        turn.analysisContentVersion = turn.turnNo;
        turn.completedAt = '2026-11-20T02:01:00.000Z';
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            aiQuestionStatus: {
              conversationId: state.conversationId,
              questionUuid: input.questionUuid,
              status: 'SUCCEEDED',
              failureReason: null,
              contentVersion: turn?.turnNo ?? 1,
              turnNo: turn?.turnNo ?? 1,
              questionText: turn?.question?.text ?? '',
              answer,
              visualization: {
                sceneId: 'LITHO_WORKFLOW_V1',
                stage: 2,
                parts: buildParts('NORMAL', { reticle_arm: 'WARNING' }),
              },
            },
          },
        }),
      });
    }

    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ errors: [{ message: `unhandled operation: ${operation}` }] }),
    });
  });
}

async function measureImplementation(browser, viewport, baseUrl) {
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
  const page = await context.newPage();
  await installGraphQLMock(page);

  await page.goto(`${baseUrl}/`, { waitUntil: 'load', timeout: 60_000 });
  await page.evaluate(() => {
    sessionStorage.setItem(
      'lithography-platform.auth-session.v1',
      JSON.stringify({
        accessToken: 'measure-only-token',
        accountId: 900201,
        adminLevel: null,
        customerOrganizationId: null,
        engineerOrganizationId: null,
        adminOrganizationId: null,
        registrationOrganizationId: null,
        restriction: 'NONE',
        role: 'ENGINEER',
        userInfo: { accessGroup: ['ENGINEER'], nickname: '量测会话' },
        version: 3,
      }),
    );
  });

  await page.goto(`${baseUrl}/engineer/ai`, { waitUntil: 'load', timeout: 60_000 });
  await page.locator('.ai-workspace').waitFor({ state: 'visible', timeout: 30_000 });
  await waitForFonts(page);
  await page.waitForTimeout(400);

  const empty = await collectMetrics(
    page,
    TARGETS.map((t) => ({ key: t.key, label: t.label, selector: t.implementation })),
    '.ai-workspace',
  );

  await page.getByRole('button', { name: '新建对话' }).click();
  await page.locator('textarea').fill('手臂 1 无动作，怎么排查？');
  await page.getByRole('button', { name: '发送问题' }).click();
  await page.getByText(ANSWER_TEXT).waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForTimeout(400);

  const qa = await collectMetrics(
    page,
    TARGETS.map((t) => ({ key: t.key, label: t.label, selector: t.implementation })),
    '.ai-workspace',
  );

  await context.close();
  return { empty, qa };
}

async function main() {
  const args = parseArgs(process.argv);
  const baseUrl = args.baseUrl ?? `http://127.0.0.1:${PORT}`;
  const outPath =
    args.out ?? path.join(REPO_ROOT, 'docs/plan/task05/修复证据-20261120/v44-styles.json');

  const server = await ensureDevServer(baseUrl);
  const browser = await chromium.launch();
  const result = {
    kind: 'v44-numeric-measurement',
    capturedAt: new Date().toISOString(),
    prototype: path.relative(REPO_ROOT, PROTOTYPE_HTML),
    prototypeRoute: '#/engineer/ai/chat',
    implementation: `${baseUrl}/engineer/ai`,
    note:
      '测量的是最终生效 computed style 与 bounding rect；不写截图。原型侧导航到 #/engineer/ai/chat（AI33Chat），实现侧走 mock-only 前端。',
    viewports: [],
  };

  try {
    for (const viewport of VIEWPORTS) {
      const prototype = await measurePrototype(browser, viewport);
      const implementation = await measureImplementation(browser, viewport, server.baseUrl);
      result.viewports.push({ viewport, prototype, implementation });
      const emptyOverflow = implementation.empty.__page.horizontalOverflowPx;
      const qaOverflow = implementation.qa.__page.horizontalOverflowPx;
      console.log(
        `[${viewport.name}] 实现横向溢出 empty=${emptyOverflow}px qa=${qaOverflow}px；` +
          `原型 empty=${prototype.empty.__page.horizontalOverflowPx}px qa=${prototype.qa.__page.horizontalOverflowPx}px`,
      );
    }
  } finally {
    await browser.close();
    await server.stop();
  }

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(`已写入 ${outPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
