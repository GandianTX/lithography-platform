// e2e-real/credential-probes/probe-environment.ts
//
// 凭据失败附件探针的合成环境。
//
// 探针配置从两个正式配置派生，正式配置在加载期会解析专用库连接并注入
// DB_NAME / E2E_BACKEND_ORIGIN。探针不连后端、不写任何数据库，因此在导入
// 正式配置之前补齐一份**合成**、非秘密的连接参数，避免依赖本机
// backend/env/.env.development 才能完成配置解析。
//
// 本文件只被 e2e-real/credential-probes/ 下的探针配置引用，
// 不进入默认 Playwright 收集范围，也不进入 Vitest。

import { resolveDedicatedE2EDbName } from '../dedicated-e2e-environment';

function fillIfEmpty(key: string, value: string): void {
  const current = process.env[key];

  if (current === undefined || current.trim() === '') {
    process.env[key] = value;
  }
}

// 与正式配置同口径解析专用库名（默认 lithography_e2e，或白名单内的本地覆盖）
process.env.DB_NAME = resolveDedicatedE2EDbName();
fillIfEmpty('DB_HOST', '127.0.0.1');
fillIfEmpty('DB_PORT', '3306');
fillIfEmpty('DB_USER', 'credential-probe-synthetic');
fillIfEmpty('DB_PASS', 'credential-probe-synthetic');
fillIfEmpty('E2E_BACKEND_ORIGIN', 'http://127.0.0.1:3100');
// 用户管理正式配置要求该变量非空；探针不执行重置，只提供合成值满足加载期校验
fillIfEmpty('ADMIN_DEFAULT_RESET_PASSWORD', 'credential-probe-synthetic');
