// src/features/registration/ui/registration-form-rules.ts

/**
 * 客户 / 工程师注册表单共用的字段规则。
 *
 * 登录邮箱、密码、登录名、昵称的校验口径在两张表单中完全一致；集中在此，
 * 避免同一规则写两份后长度或文案漂移。仅某一个表单使用的字段（姓名、电话、
 * 公司名称、申请说明）保留在各自表单内。
 */

import type { FormRule } from 'antd';

const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 128;
const NICKNAME_MAX_LENGTH = 20;
const LOGIN_NAME_MIN_LENGTH = 4;

export const LOGIN_EMAIL_RULES: FormRule[] = [
  {
    message: '请输入登录邮箱。',
    required: true,
    whitespace: true,
  },
  {
    message: '邮箱格式不正确。',
    type: 'email',
  },
];

export const LOGIN_PASSWORD_RULES: FormRule[] = [
  {
    message: '请输入密码。',
    required: true,
    whitespace: true,
  },
  {
    message: `密码至少 ${PASSWORD_MIN_LENGTH} 个字符。`,
    min: PASSWORD_MIN_LENGTH,
  },
  {
    message: `密码最多 ${PASSWORD_MAX_LENGTH} 个字符。`,
    max: PASSWORD_MAX_LENGTH,
  },
];

export const OPTIONAL_LOGIN_NAME_RULES: FormRule[] = [
  {
    message: '登录名至少 4 个字符。',
    min: LOGIN_NAME_MIN_LENGTH,
  },
  {
    message: '登录名只能包含英文字母、数字、下划线和短横线。',
    pattern: /^[a-zA-Z0-9_-]*$/,
  },
];

export const OPTIONAL_NICKNAME_RULES: FormRule[] = [
  {
    message: `昵称最多 ${NICKNAME_MAX_LENGTH} 个字符。`,
    max: NICKNAME_MAX_LENGTH,
  },
];
