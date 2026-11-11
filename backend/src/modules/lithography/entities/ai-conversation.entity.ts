import { AiConversationStatus } from '../lithography.types';
import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  ForeignKey,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('ai_conversation', { comment: '维修申请AI故障诊断会话表' })
@Index('idx_ai_conversation_request_created', ['requestId', 'createdAt'])
@Index('idx_ai_conversation_engineer_created', ['engineerAccountId', 'createdAt'])
@Index('idx_ai_conversation_status_created', ['status', 'createdAt'])
@Index('idx_ai_conversation_owner_created', ['ownerOrganizationId', 'createdAt'])
@ForeignKey('RepairRequestEntity', ['requestId'], ['id'], {
  name: 'fk_ai_conversation_request',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey('OrganizationEntity', ['ownerOrganizationId'], ['id'], {
  name: 'fk_ai_conversation_owner_organization',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey('AccountEntity', ['engineerAccountId'], ['id'], {
  name: 'fk_ai_conversation_engineer_account',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@Check('chk_ai_conversation_content_version', '`content_version` >= 1')
@Check(
  'chk_ai_conversation_completion',
  "((`status` = 'ACTIVE' AND `ai_feedback` IS NULL AND `completed_at` IS NULL) OR (`status` = 'COMPLETED' AND `ai_feedback` IS NOT NULL AND CHAR_LENGTH(TRIM(`ai_feedback`)) > 0 AND `completed_at` IS NOT NULL))",
)
export class AiConversationEntity {
  @PrimaryGeneratedColumn({ type: 'int', comment: 'AI诊断会话主键ID' })
  id!: number;

  @Column({ name: 'request_id', type: 'int', nullable: true, comment: '维修申请ID；独立会话为空' })
  requestId!: number | null;

  @Column({
    name: 'owner_organization_id',
    type: 'int',
    nullable: true,
    comment: '会话可信公司ID；新会话非空',
  })
  ownerOrganizationId!: number | null;

  @Column({
    name: 'content_version',
    type: 'int',
    unsigned: true,
    default: 1,
    comment: '内容版本；新写入递增',
  })
  contentVersion!: number;

  @Column({ name: 'engineer_account_id', type: 'int', comment: '发起会话的工程师账号ID' })
  engineerAccountId!: number;

  @Column({ type: 'enum', enum: AiConversationStatus, default: AiConversationStatus.ACTIVE })
  status!: AiConversationStatus;

  @Column({
    name: 'ai_feedback',
    type: 'text',
    nullable: true,
    comment: '会话完成时填写的工程师反馈和实际维修过程',
  })
  aiFeedback!: string | null;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamp',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
    comment: '创建时间（系统事件时间）',
  })
  createdAt!: Date;

  @Column({
    name: 'completed_at',
    type: 'timestamp',
    precision: 3,
    nullable: true,
    comment: '会话完成时间（系统事件时间）',
  })
  completedAt!: Date | null;
}
