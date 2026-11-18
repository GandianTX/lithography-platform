// src/features/registration/ui/registration-form-rules.ts

/**
 * 客户 / 工程师注册表单共用的字段规则。
 *
 * 登录邮箱、密码、登录名、昵称的校验口径在两张表单中完全一致；集中在此，
 * 避免同一规则写两份后长度或文案漂移。仅某一个表单使用的字段（姓名、电话、
 * 公司名称、申请说明）保留在各自表单内。
 *
 * 文案由调用方传入的翻译器解析，保证切换界面语言后校验提示同步变化。
 */

import type { FormRule } from 'antd';

import type { Translate } from '@/shared/i18n';

const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 128;
const NICKNAME_MAX_LENGTH = 20;
const LOGIN_NAME_MIN_LENGTH = 4;
/** 登录名对应 `base_user_account.login_name` 列宽 30 */
const LOGIN_NAME_MAX_LENGTH = 30;
/** 登录邮箱同时写入联系邮箱列（50），Web 可写上限与服务端一致 */
const LOGIN_EMAIL_MAX_LENGTH = 50;

export function createLoginEmailRules(t: Translate): FormRule[] {
  return [
    {
      message: t('register.loginEmailRequired'),
      required: true,
      whitespace: true,
    },
    {
      message: t('register.loginEmailMax', { max: LOGIN_EMAIL_MAX_LENGTH }),
      max: LOGIN_EMAIL_MAX_LENGTH,
    },
    {
      message: t('register.loginEmailInvalid'),
      type: 'email',
    },
  ];
}

export function createLoginPasswordRules(t: Translate): FormRule[] {
  return [
    {
      message: t('register.passwordRequired'),
      required: true,
      whitespace: true,
    },
    {
      message: t('register.passwordMin', { min: PASSWORD_MIN_LENGTH }),
      min: PASSWORD_MIN_LENGTH,
    },
    {
      message: t('register.passwordMax', { max: PASSWORD_MAX_LENGTH }),
      max: PASSWORD_MAX_LENGTH,
    },
  ];
}

export function createOptionalLoginNameRules(t: Translate): FormRule[] {
  return [
    {
      message: t('register.loginNameMin', { min: LOGIN_NAME_MIN_LENGTH }),
      min: LOGIN_NAME_MIN_LENGTH,
    },
    {
      message: t('register.loginNameMax', { max: LOGIN_NAME_MAX_LENGTH }),
      max: LOGIN_NAME_MAX_LENGTH,
    },
    {
      message: t('register.loginNamePattern'),
      pattern: /^[a-zA-Z0-9_-]*$/,
    },
  ];
}

export function createOptionalNicknameRules(t: Translate): FormRule[] {
  return [
    {
      message: t('register.nicknameMax', { max: NICKNAME_MAX_LENGTH }),
      max: NICKNAME_MAX_LENGTH,
    },
  ];
}
