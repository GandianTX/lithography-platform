// src/adapters/api/graphql/registration/dto/engineer-registration-application-page.dto.ts

import type { EngineerRegistrationListPage } from '@src/modules/lithography/engineer-registration.types';
import { Field, Int, ObjectType } from '@nestjs/graphql';
import {
  EngineerRegistrationApplicationDTO,
  toEngineerRegistrationApplicationDTO,
} from './engineer-registration-application.dto';

/**
 * 本人申请历史分页 DTO：按提交时间倒序，保留最近一次申请在 `EngineerRegistrationStatusDTO.latest`。
 */
@ObjectType({ description: '工程师注册申请历史分页' })
export class EngineerRegistrationApplicationPageDTO {
  @Field(() => [EngineerRegistrationApplicationDTO], { description: '当前页申请记录' })
  items!: EngineerRegistrationApplicationDTO[];

  @Field(() => Int, { description: '总记录数' })
  total!: number;

  @Field(() => Int, { description: '当前页码（从 1 开始）' })
  page!: number;

  @Field(() => Int, { description: '每页数量' })
  pageSize!: number;
}

/** 申请历史分页 View → DTO 薄映射 */
export function toEngineerRegistrationApplicationPageDTO(
  page: EngineerRegistrationListPage,
): EngineerRegistrationApplicationPageDTO {
  return {
    items: page.items.map((item) => toEngineerRegistrationApplicationDTO(item)),
    total: page.total,
    page: page.page,
    pageSize: page.pageSize,
  };
}
