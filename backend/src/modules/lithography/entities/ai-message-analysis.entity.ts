import { Column, Entity, ForeignKey, Index, PrimaryColumn } from 'typeorm';

@Entity('ai_message_analysis', { comment: 'AI 消息分析结果表' })
@Index('uk_ai_message_analysis_question', ['questionMessageId'], { unique: true })
@Index('idx_ai_message_analysis_conversation_status', ['conversationId', 'status'])
@ForeignKey('AiConversationEntity', ['conversationId'], ['id'], {
  name: 'fk_ai_message_analysis_conversation',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey('AiMessageEntity', ['questionMessageId'], ['id'], {
  name: 'fk_ai_message_analysis_question_message',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
@ForeignKey('AiMessageEntity', ['answerMessageId'], ['id'], {
  name: 'fk_ai_message_analysis_answer_message',
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
})
export class AiMessageAnalysisEntity {
  @PrimaryColumn({ name: 'question_uuid', type: 'char', length: 36, comment: '问题稳定标识' })
  questionUuid!: string;

  @Column({ name: 'conversation_id', type: 'int', comment: '固定会话ID' })
  conversationId!: number;

  @Column({ name: 'question_message_id', type: 'int', comment: '原问题消息ID' })
  questionMessageId!: number;

  @Column({
    name: 'answer_message_id',
    type: 'int',
    nullable: true,
    comment: '实际回答消息ID',
  })
  answerMessageId!: number | null;

  @Column({ type: 'varchar', length: 16, comment: '分析状态' })
  status!: string;

  @Column({ name: 'failure_reason', type: 'text', nullable: true, comment: '真实失败原因' })
  failureReason!: string | null;

  @Column({ name: 'content_version', type: 'int', unsigned: true, comment: '已保存内容版本' })
  contentVersion!: number;

  @Column({
    name: 'saved_at',
    type: 'timestamp',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
  })
  savedAt!: Date;

  @Column({
    name: 'completed_at',
    type: 'timestamp',
    precision: 3,
    nullable: true,
    comment: '实际完成时间',
  })
  completedAt!: Date | null;
}
