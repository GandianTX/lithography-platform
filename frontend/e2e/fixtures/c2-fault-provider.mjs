// e2e/fixtures/c2-fault-provider.mjs
// 任务05 C2 专用：OpenAI 兼容的 loopback 故障注入 provider。
//
// 目的：让 C2 的「早轮失败」由正式模型调用路径产生（Worker → provider → 解析 → 失败落库），
// 浏览器进程不再需要数据库写权限，测试也不再直接改 analysis/workflow 状态。
//
// 编排规则（不使用全局请求计数）：
// - 请求体 prompt 是 `JSON.stringify(request)`，其中 `question` 带本轮唯一标识；
// - 命中标识的问题在 `/__control/release` 之前一律返回 500（稳定阻断该问题的所有执行）；
// - 其他问题直接返回符合正式信封的成功响应；
// - 放行后同一问题恢复正常，便于验证正式 retry 的成功路径。

import { createServer } from 'node:http';

const port = Number(process.env.C2_PROVIDER_PORT ?? 4399);
const failToken = process.env.C2_FAIL_TOKEN ?? '';
const releasedTokens = new Set();
const calls = [];

/** @param {import('node:http').IncomingMessage} request */
function readJsonBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(raw.length === 0 ? {} : JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
  });
}

/** @param {import('node:http').ServerResponse} response */
function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-length': Buffer.byteLength(body),
    'content-type': 'application/json',
  });
  response.end(body);
}

function buildEnvelope(requestId, question) {
  const trimmed = question.slice(0, 40);
  return {
    schemaVersion: 1,
    requestId,
    content: {
      text: `C2 故障夹具回复：已处理问题「${trimmed}」。这是正式模型调用路径返回的成功信封。`,
    },
  };
}

const server = createServer(async (request, response) => {
  const url = request.url ?? '/';

  if (request.method === 'GET' && url === '/health') {
    sendJson(response, 200, { status: 'ok', service: 'c2-fault-provider' });
    return;
  }

  if (request.method === 'GET' && url === '/__control/state') {
    sendJson(response, 200, {
      calls,
      failToken,
      released: [...releasedTokens],
    });
    return;
  }

  if (request.method === 'POST' && url === '/__control/release') {
    const body = await readJsonBody(request);
    const token = typeof body.token === 'string' && body.token.length > 0 ? body.token : failToken;
    releasedTokens.add(token);
    sendJson(response, 200, { released: token });
    return;
  }

  if (request.method === 'POST' && url.startsWith('/v1/chat/completions')) {
    const body = await readJsonBody(request);
    const prompt = body?.messages?.[0]?.content ?? '';
    let parsedRequest = {};
    try {
      parsedRequest = JSON.parse(prompt);
    } catch {
      parsedRequest = {};
    }
    const question = typeof parsedRequest.question === 'string' ? parsedRequest.question : '';
    const requestId = typeof parsedRequest.requestId === 'string' ? parsedRequest.requestId : '';
    const isFaultQuestion = failToken.length > 0 && question.includes(failToken);
    const blocked = isFaultQuestion && !releasedTokens.has(failToken);

    calls.push({
      blocked,
      isFaultQuestion,
      question: question.slice(0, 80),
      requestId,
      turn: calls.length + 1,
    });
    process.stdout.write(
      `[c2-fault-provider] call turn=${calls.length} blocked=${blocked} requestId=${requestId}\n`,
    );

    if (requestId.length === 0) {
      sendJson(response, 400, { error: { message: 'missing_request_id' } });
      return;
    }
    if (blocked) {
      sendJson(response, 500, { error: { message: 'c2_injected_provider_failure' } });
      return;
    }

    const envelope = buildEnvelope(requestId, question);
    sendJson(response, 200, {
      choices: [{ message: { content: JSON.stringify(envelope) } }],
      id: `c2-${calls.length}`,
      model: body?.model ?? 'c2-mock',
      usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
    });
    return;
  }

  sendJson(response, 404, { error: { message: 'not_found' } });
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`[c2-fault-provider] listening on 127.0.0.1:${port}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
