// src/adapters/api/graphql/registration/dto/engineer-registration-status.dto.ts

import { Field, Int, ObjectType } from '@nestjs/graphql';
import { EngineerRegistrationApplicationDTO } from './engineer-registration-application.dto';
import { EngineerRegistrationApplicationPageDTO } from './engineer-registration-application-page.dto';

/**
 * 本人注册申请状态查询结果：最新一份申请 + 历史分页。
 *
 * 待审账号没有登录态，本查询由受限本人凭据证明后返回；
 * 没有任何申请时 `latest` 为 null，历史列表为空页。
 */
@ObjectType({ description: '本人工程师注册申请状态' })
export class EngineerRegistrationStatusDTO {
  @Field(() => Int, { description: '已证明的申请人账号 ID' })
  accountId!: number;

  @Field(() => EngineerRegistrationApplicationDTO, {
    description: '最近一次申请（无申请时为空）',
    nullable: true,
  })
  latest!: EngineerRegistrationApplicationDTO | null;

  @Field(() => EngineerRegistrationApplicationPageDTO, {
    description: '本人申请历史（提交时间倒序）',
  })
  applications!: EngineerRegistrationApplicationPageDTO;
}
