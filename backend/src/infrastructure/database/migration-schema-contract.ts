// src/infrastructure/database/migration-schema-contract.ts
import { DataSource } from 'typeorm';

/**
 * 迁移完成后应存在的业务/基础表（不含 migrations 记录表）。
 * 供空库演练与存量库增量迁移入口共用，避免两套清单漂移。
 */
export const REQUIRED_TABLES = [
  'ai_provider_call_record',
  'ai_workflow_context',
  'base_user_account',
  'base_user_info',
  'base_async_task_record',
  'base_third_party_auth',
  'base_verification_record',
  'equipment_model',
  'repair_request',
  'ai_conversation',
  'ai_message',
  'ai_report',
  'engineer_response',
  'reference_document',
  'organization',
  'organization_membership',
  'content_submission',
  'material_submission_detail',
  'fault_case_submission_detail',
  'content_submission_attachment',
  'content_submission_revision',
  'content_submission_review',
  'reference_document_case_detail',
  'maintenance_report',
  'maintenance_report_alarm',
  'maintenance_report_step',
  'maintenance_report_attachment',
  'maintenance_report_version',
  'maintenance_report_version_attachment',
  'maintenance_report_review',
  'local_installation',
  'local_upload_task',
  'local_backup_run',
  'engineer_registration_application',
] as const;

export const REQUIRED_INDEXES: ReadonlyArray<{ table: string; index: string }> = [
  { table: 'base_user_account', index: 'uk_login_email' },
  { table: 'base_third_party_auth', index: 'base_third_party_auth_provider_IDX' },
  { table: 'base_async_task_record', index: 'uk_queue_name_job_id' },
  { table: 'ai_provider_call_record', index: 'uk_ai_provider_call_trace_seq' },
  { table: 'ai_workflow_context', index: 'uk_ai_workflow_context_type_active_dedup_hash' },
  { table: 'ai_workflow_context', index: 'uk_ai_workflow_context_queue_job' },
  { table: 'base_verification_record', index: 'uk_token_fp' },
  { table: 'equipment_model', index: 'uk_equipment_model_code' },
  { table: 'repair_request', index: 'uk_repair_request_no' },
  { table: 'ai_message', index: 'uk_ai_message_conversation_seq' },
  { table: 'ai_report', index: 'uk_ai_report_conversation_type' },
  { table: 'organization', index: 'uk_organization_code' },
  { table: 'organization', index: 'idx_organization_kind_status' },
  { table: 'organization_membership', index: 'uk_organization_membership_org_account' },
  { table: 'organization_membership', index: 'idx_organization_membership_account_status' },
  { table: 'content_submission', index: 'idx_content_submission_org_status_updated' },
  { table: 'content_submission', index: 'idx_content_submission_submitter_status_updated' },
  {
    table: 'material_submission_detail',
    index: 'idx_material_submission_detail_equipment_model',
  },
  {
    table: 'fault_case_submission_detail',
    index: 'idx_fault_case_submission_detail_equipment_model',
  },
  {
    table: 'content_submission_attachment',
    index: 'uk_content_submission_attachment_id_submission',
  },
  {
    table: 'content_submission_attachment',
    index: 'idx_content_submission_attachment_submission_status',
  },
  {
    table: 'content_submission_attachment',
    index: 'idx_content_submission_attachment_uploaded_by',
  },
  { table: 'content_submission_revision', index: 'uk_content_submission_revision_submission_no' },
  { table: 'content_submission_revision', index: 'uk_content_submission_revision_id_submission' },
  { table: 'content_submission_revision', index: 'idx_content_submission_revision_attachment' },
  { table: 'content_submission_revision', index: 'idx_content_submission_revision_confirmed_by' },
  { table: 'content_submission_review', index: 'uk_content_submission_review_revision' },
  {
    table: 'content_submission_review',
    index: 'idx_content_submission_review_revision_submission',
  },
  {
    table: 'content_submission_review',
    index: 'idx_content_submission_review_submission_reviewed',
  },
  { table: 'content_submission_review', index: 'idx_content_submission_review_reviewed_by' },
  { table: 'reference_document', index: 'uk_reference_document_source_submission' },
  { table: 'reference_document', index: 'idx_reference_document_source_revision' },
  { table: 'reference_document', index: 'idx_reference_document_org_deleted_created' },
  { table: 'organization_membership', index: 'uk_organization_membership_active_account' },
  { table: 'organization_membership', index: 'idx_organization_membership_org_role_status' },
  { table: 'repair_request', index: 'uk_repair_request_id_owner' },
  { table: 'repair_request', index: 'idx_repair_request_owner_created' },
  { table: 'repair_request', index: 'idx_repair_request_owner_status' },
  { table: 'repair_request', index: 'idx_repair_request_handling_recorder' },
  { table: 'maintenance_report', index: 'uk_maintenance_report_request' },
  { table: 'maintenance_report', index: 'uk_maintenance_report_id_owner' },
  { table: 'maintenance_report', index: 'idx_maintenance_report_owner_status_created' },
  { table: 'maintenance_report', index: 'idx_maintenance_report_engineer_created' },
  { table: 'maintenance_report', index: 'idx_maintenance_report_source_created' },
  { table: 'maintenance_report_alarm', index: 'uk_maintenance_report_alarm_slot' },
  { table: 'maintenance_report_alarm', index: 'idx_maintenance_report_alarm_code' },
  { table: 'maintenance_report_step', index: 'uk_maintenance_report_step_no' },
  { table: 'maintenance_report_step', index: 'uk_maintenance_report_step_code' },
  { table: 'maintenance_report_step', index: 'idx_maintenance_report_step_phase' },
  { table: 'maintenance_report_attachment', index: 'uk_maintenance_report_attachment_id_report' },
  {
    table: 'maintenance_report_attachment',
    index: 'uk_maintenance_report_attachment_active_slot',
  },
  {
    table: 'maintenance_report_attachment',
    index: 'idx_maintenance_report_attachment_report_status',
  },
  { table: 'maintenance_report_version', index: 'uk_maintenance_report_version_no' },
  { table: 'maintenance_report_version', index: 'uk_maintenance_report_version_id_report' },
  { table: 'maintenance_report_version', index: 'idx_maintenance_report_version_submitted' },
  {
    table: 'maintenance_report_version_attachment',
    index: 'uk_maintenance_report_version_attachment_sort',
  },
  {
    table: 'maintenance_report_version_attachment',
    index: 'idx_maintenance_report_version_attachment_attachment',
  },
  { table: 'maintenance_report_review', index: 'uk_maintenance_report_review_version' },
  { table: 'maintenance_report_review', index: 'uk_maintenance_report_review_id_report' },
  { table: 'maintenance_report_review', index: 'idx_maintenance_report_review_report_time' },
  { table: 'local_installation', index: 'uk_local_installation_installation_id' },
  { table: 'local_installation', index: 'idx_local_installation_organization' },
  { table: 'local_upload_task', index: 'uk_local_upload_task_idempotency' },
  { table: 'local_upload_task', index: 'uk_local_upload_task_entity' },
  { table: 'local_upload_task', index: 'idx_local_upload_task_status_created' },
  { table: 'local_backup_run', index: 'uk_local_backup_run_active' },
  { table: 'local_backup_run', index: 'idx_local_backup_run_started' },
  {
    table: 'engineer_registration_application',
    index: 'uk_engineer_registration_application_pending_account',
  },
  {
    table: 'engineer_registration_application',
    index: 'idx_engineer_registration_application_org_status_submitted',
  },
  {
    table: 'engineer_registration_application',
    index: 'idx_engineer_registration_application_account_submitted',
  },
];

export const REQUIRED_COLUMNS: ReadonlyArray<{
  table: string;
  column: string;
  notNull?: boolean;
}> = [
  { table: 'base_user_info', column: 'company_name' },
  { table: 'ai_conversation', column: 'status' },
  { table: 'ai_conversation', column: 'ai_feedback' },
  { table: 'ai_conversation', column: 'completed_at' },
  { table: 'ai_message', column: 'message_seq' },
  { table: 'ai_message', column: 'turn_no' },
  { table: 'reference_document', column: 'deprecated' },
  { table: 'reference_document', column: 'deleted_at' },
  { table: 'reference_document', column: 'owner_organization_id', notNull: true },
  { table: 'reference_document', column: 'ingest_method', notNull: true },
  { table: 'reference_document', column: 'source_submission_id' },
  { table: 'reference_document', column: 'source_revision_id' },
  { table: 'reference_document', column: 'equipment_model_text' },
  { table: 'reference_document', column: 'updated_by_account_id' },
  { table: 'reference_document', column: 'extension_json' },
  { table: 'reference_document', column: 'schema_version' },
  { table: 'organization_membership', column: 'active_account_id' },
  { table: 'repair_request', column: 'owner_organization_id' },
  { table: 'repair_request', column: 'handling_result' },
  { table: 'repair_request', column: 'handling_status' },
  { table: 'repair_request', column: 'handling_recorded_at' },
  { table: 'repair_request', column: 'handling_recorded_by_account_id' },
  { table: 'repair_request', column: 'handling_ended_at' },
  { table: 'maintenance_report', column: 'owner_organization_id', notNull: true },
  { table: 'maintenance_report', column: 'source_type', notNull: true },
  { table: 'maintenance_report', column: 'repair_request_id' },
  { table: 'maintenance_report', column: 'status', notNull: true },
  { table: 'maintenance_report', column: 'current_version_no', notNull: true },
  { table: 'maintenance_report', column: 'phase_flow_version', notNull: true },
  { table: 'maintenance_report', column: 'maintenance_date' },
  { table: 'maintenance_report', column: 'maintenance_engineer_account_id', notNull: true },
  { table: 'maintenance_report', column: 'ai_usage', notNull: true },
  { table: 'maintenance_report', column: 'ai_source_type' },
  { table: 'maintenance_report', column: 'ai_source_id' },
  { table: 'maintenance_report', column: 'ai_source_version' },
  { table: 'maintenance_report', column: 'ai_score' },
  { table: 'maintenance_report', column: 'ai_correctness' },
  { table: 'maintenance_report', column: 'ai_helpfulness' },
  { table: 'maintenance_report', column: 'ai_note' },
  { table: 'maintenance_report_alarm', column: 'alarm_index', notNull: true },
  { table: 'maintenance_report_alarm', column: 'alarm_code', notNull: true },
  { table: 'maintenance_report_alarm', column: 'phase_code', notNull: true },
  { table: 'maintenance_report_alarm', column: 'reset_result', notNull: true },
  { table: 'maintenance_report_step', column: 'step_no', notNull: true },
  { table: 'maintenance_report_step', column: 'step_code', notNull: true },
  { table: 'maintenance_report_step', column: 'phase_code', notNull: true },
  { table: 'maintenance_report_step', column: 'is_valid_new_branch', notNull: true },
  { table: 'maintenance_report_attachment', column: 'sort_order', notNull: true },
  { table: 'maintenance_report_attachment', column: 'status', notNull: true },
  { table: 'maintenance_report_attachment', column: 'storage_reference', notNull: true },
  { table: 'maintenance_report_attachment', column: 'active_sort_order' },
  { table: 'maintenance_report_version', column: 'version_no', notNull: true },
  { table: 'maintenance_report_version', column: 'change_kind', notNull: true },
  { table: 'maintenance_report_version', column: 'change_reason' },
  { table: 'maintenance_report_version', column: 'schema_version', notNull: true },
  { table: 'maintenance_report_version', column: 'payload_snapshot', notNull: true },
  { table: 'maintenance_report_version_attachment', column: 'sort_order', notNull: true },
  { table: 'maintenance_report_version_attachment', column: 'publish_flag', notNull: true },
  { table: 'maintenance_report_review', column: 'decision', notNull: true },
  { table: 'maintenance_report_review', column: 'comment' },
  { table: 'maintenance_report_review', column: 'reviewed_at', notNull: true },
  { table: 'local_installation', column: 'installation_id', notNull: true },
  { table: 'local_installation', column: 'organization_id' },
  { table: 'local_installation', column: 'backup_interval_days', notNull: true },
  { table: 'local_installation', column: 'last_backup_completed_at' },
  { table: 'local_upload_task', column: 'idempotency_key', notNull: true },
  { table: 'local_upload_task', column: 'entity_version', notNull: true },
  { table: 'local_upload_task', column: 'status', notNull: true },
  { table: 'local_upload_task', column: 'attempt_count', notNull: true },
  { table: 'local_backup_run', column: 'trigger_type', notNull: true },
  { table: 'local_backup_run', column: 'status', notNull: true },
  { table: 'local_backup_run', column: 'active_installation_id' },
  { table: 'local_backup_run', column: 'finished_at' },
  { table: 'engineer_registration_application', column: 'account_id', notNull: true },
  { table: 'engineer_registration_application', column: 'organization_id', notNull: true },
  { table: 'engineer_registration_application', column: 'status', notNull: true },
  { table: 'engineer_registration_application', column: 'submitted_at', notNull: true },
  { table: 'engineer_registration_application', column: 'reviewed_by_account_id' },
  { table: 'engineer_registration_application', column: 'reviewed_at' },
  { table: 'engineer_registration_application', column: 'review_comment' },
  { table: 'engineer_registration_application', column: 'pending_account_id' },
];

export const FORBIDDEN_COLUMNS: ReadonlyArray<{ table: string; column: string }> = [
  { table: 'ai_conversation', column: 'content_md' },
];

export const REQUIRED_CHECKS: ReadonlyArray<{ table: string; constraint: string }> = [
  { table: 'equipment_model', constraint: 'chk_equipment_model_enabled' },
  { table: 'repair_request', constraint: 'chk_repair_request_acceptance_consistency' },
  { table: 'repair_request', constraint: 'chk_repair_request_deletion_consistency' },
  { table: 'ai_conversation', constraint: 'chk_ai_conversation_completion' },
  { table: 'ai_message', constraint: 'chk_ai_message_turn' },
  { table: 'reference_document', constraint: 'chk_reference_document_deletion_consistency' },
  { table: 'reference_document', constraint: 'chk_reference_document_storage_pair' },
  { table: 'reference_document', constraint: 'chk_reference_document_content_source' },
  { table: 'organization', constraint: 'chk_organization_kind' },
  { table: 'organization', constraint: 'chk_organization_status' },
  { table: 'organization_membership', constraint: 'chk_organization_membership_role' },
  { table: 'organization_membership', constraint: 'chk_organization_membership_status' },
  { table: 'organization_membership', constraint: 'chk_organization_membership_period' },
  { table: 'content_submission', constraint: 'chk_content_submission_kind' },
  { table: 'content_submission', constraint: 'chk_content_submission_status' },
  { table: 'content_submission', constraint: 'chk_content_submission_revision_consistency' },
  { table: 'content_submission', constraint: 'chk_content_submission_publish_consistency' },
  {
    table: 'material_submission_detail',
    constraint: 'chk_material_submission_detail_model_exclusive',
  },
  { table: 'material_submission_detail', constraint: 'chk_material_submission_detail_type' },
  {
    table: 'fault_case_submission_detail',
    constraint: 'chk_fault_case_submission_detail_model_exclusive',
  },
  {
    table: 'fault_case_submission_detail',
    constraint: 'chk_fault_case_submission_detail_handling_status',
  },
  {
    table: 'fault_case_submission_detail',
    constraint: 'chk_fault_case_submission_detail_resolution',
  },
  {
    table: 'content_submission_attachment',
    constraint: 'chk_content_submission_attachment_status',
  },
  {
    table: 'content_submission_attachment',
    constraint: 'chk_content_submission_attachment_retire_consistency',
  },
  { table: 'content_submission_revision', constraint: 'chk_content_submission_revision_no' },
  { table: 'content_submission_revision', constraint: 'chk_content_submission_revision_title' },
  { table: 'content_submission_revision', constraint: 'chk_content_submission_revision_notice' },
  { table: 'content_submission_review', constraint: 'chk_content_submission_review_decision' },
  { table: 'content_submission_review', constraint: 'chk_content_submission_review_comment' },
  { table: 'content_submission_review', constraint: 'chk_content_submission_review_publish_flag' },
  {
    table: 'reference_document_case_detail',
    constraint: 'chk_reference_document_case_detail_status',
  },
  {
    table: 'reference_document_case_detail',
    constraint: 'chk_reference_document_case_detail_resolution',
  },
  { table: 'reference_document', constraint: 'chk_reference_document_ingest_method' },
  { table: 'reference_document', constraint: 'chk_reference_document_source_pair' },
  { table: 'reference_document', constraint: 'chk_reference_document_model_exclusive' },
  { table: 'repair_request', constraint: 'chk_repair_request_handling_result' },
  { table: 'repair_request', constraint: 'chk_repair_request_handling_status' },
  { table: 'repair_request', constraint: 'chk_repair_request_handling_mapping' },
  { table: 'repair_request', constraint: 'chk_repair_request_handling_requires_accepted' },
  { table: 'repair_request', constraint: 'chk_repair_request_handling_time' },
  { table: 'maintenance_report', constraint: 'chk_maintenance_report_source' },
  { table: 'maintenance_report', constraint: 'chk_maintenance_report_request_source' },
  { table: 'maintenance_report', constraint: 'chk_maintenance_report_status' },
  { table: 'maintenance_report', constraint: 'chk_maintenance_report_status_consistency' },
  { table: 'maintenance_report', constraint: 'chk_maintenance_report_model_exclusive' },
  { table: 'maintenance_report', constraint: 'chk_maintenance_report_phase_flow' },
  { table: 'maintenance_report', constraint: 'chk_maintenance_report_ai_usage' },
  { table: 'maintenance_report', constraint: 'chk_maintenance_report_ai_score' },
  { table: 'maintenance_report', constraint: 'chk_maintenance_report_ai_helpfulness' },
  { table: 'maintenance_report', constraint: 'chk_maintenance_report_ai_correctness' },
  { table: 'maintenance_report_alarm', constraint: 'chk_maintenance_report_alarm_index' },
  { table: 'maintenance_report_alarm', constraint: 'chk_maintenance_report_alarm_code' },
  { table: 'maintenance_report_alarm', constraint: 'chk_maintenance_report_alarm_phase' },
  { table: 'maintenance_report_alarm', constraint: 'chk_maintenance_report_alarm_reset' },
  { table: 'maintenance_report_step', constraint: 'chk_maintenance_report_step_no' },
  { table: 'maintenance_report_step', constraint: 'chk_maintenance_report_step_code' },
  { table: 'maintenance_report_step', constraint: 'chk_maintenance_report_step_action' },
  { table: 'maintenance_report_step', constraint: 'chk_maintenance_report_step_phase' },
  { table: 'maintenance_report_step', constraint: 'chk_maintenance_report_step_branch' },
  {
    table: 'maintenance_report_attachment',
    constraint: 'chk_maintenance_report_attachment_byte_size',
  },
  { table: 'maintenance_report_attachment', constraint: 'chk_maintenance_report_attachment_sort' },
  {
    table: 'maintenance_report_attachment',
    constraint: 'chk_maintenance_report_attachment_status',
  },
  {
    table: 'maintenance_report_attachment',
    constraint: 'chk_maintenance_report_attachment_retired',
  },
  {
    table: 'maintenance_report_attachment',
    constraint: 'chk_maintenance_report_attachment_storage',
  },
  {
    table: 'maintenance_report_attachment',
    constraint: 'chk_maintenance_report_attachment_filename',
  },
  { table: 'maintenance_report_version', constraint: 'chk_maintenance_report_version_no' },
  {
    table: 'maintenance_report_version',
    constraint: 'chk_maintenance_report_version_change_kind',
  },
  {
    table: 'maintenance_report_version',
    constraint: 'chk_maintenance_report_version_correction_reason',
  },
  {
    table: 'maintenance_report_version',
    constraint: 'chk_maintenance_report_version_payload',
  },
  {
    table: 'maintenance_report_version',
    constraint: 'chk_maintenance_report_version_schema',
  },
  {
    table: 'maintenance_report_version_attachment',
    constraint: 'chk_maintenance_report_version_attachment_sort',
  },
  {
    table: 'maintenance_report_version_attachment',
    constraint: 'chk_maintenance_report_version_attachment_publish',
  },
  {
    table: 'maintenance_report_review',
    constraint: 'chk_maintenance_report_review_decision',
  },
  { table: 'maintenance_report_review', constraint: 'chk_maintenance_report_review_comment' },
  { table: 'local_installation', constraint: 'chk_local_installation_singleton' },
  { table: 'local_installation', constraint: 'chk_local_installation_interval' },
  { table: 'local_upload_task', constraint: 'chk_local_upload_task_entity_type' },
  { table: 'local_upload_task', constraint: 'chk_local_upload_task_status' },
  { table: 'local_upload_task', constraint: 'chk_local_upload_task_attempt' },
  { table: 'local_upload_task', constraint: 'chk_local_upload_task_version' },
  { table: 'local_upload_task', constraint: 'chk_local_upload_task_idempotency' },
  { table: 'local_upload_task', constraint: 'chk_local_upload_task_error' },
  { table: 'local_backup_run', constraint: 'chk_local_backup_run_trigger' },
  { table: 'local_backup_run', constraint: 'chk_local_backup_run_status' },
  { table: 'local_backup_run', constraint: 'chk_local_backup_run_finish' },
  {
    table: 'engineer_registration_application',
    constraint: 'chk_engineer_registration_application_status',
  },
  {
    table: 'engineer_registration_application',
    constraint: 'chk_engineer_registration_application_pending_review',
  },
  {
    table: 'engineer_registration_application',
    constraint: 'chk_engineer_registration_application_reviewed',
  },
  {
    table: 'engineer_registration_application',
    constraint: 'chk_engineer_registration_application_reject_comment',
  },
  {
    table: 'engineer_registration_application',
    constraint: 'chk_engineer_registration_application_review_time',
  },
];

export const REQUIRED_FOREIGN_KEYS: ReadonlyArray<{
  table: string;
  constraint: string;
  referencedTable: string;
}> = [
  {
    table: 'base_user_info',
    constraint: 'base_user_info_ibfk_1',
    referencedTable: 'base_user_account',
  },
  {
    table: 'repair_request',
    constraint: 'fk_repair_request_customer_account',
    referencedTable: 'base_user_account',
  },
  {
    table: 'repair_request',
    constraint: 'fk_repair_request_equipment_model',
    referencedTable: 'equipment_model',
  },
  {
    table: 'repair_request',
    constraint: 'fk_repair_request_engineer_account',
    referencedTable: 'base_user_account',
  },
  {
    table: 'ai_conversation',
    constraint: 'fk_ai_conversation_request',
    referencedTable: 'repair_request',
  },
  {
    table: 'ai_conversation',
    constraint: 'fk_ai_conversation_engineer_account',
    referencedTable: 'base_user_account',
  },
  {
    table: 'ai_message',
    constraint: 'fk_ai_message_conversation',
    referencedTable: 'ai_conversation',
  },
  {
    table: 'ai_report',
    constraint: 'fk_ai_report_request',
    referencedTable: 'repair_request',
  },
  {
    table: 'ai_report',
    constraint: 'fk_ai_report_conversation',
    referencedTable: 'ai_conversation',
  },
  {
    table: 'ai_report',
    constraint: 'fk_ai_report_engineer_account',
    referencedTable: 'base_user_account',
  },
  {
    table: 'engineer_response',
    constraint: 'fk_engineer_response_request',
    referencedTable: 'repair_request',
  },
  {
    table: 'engineer_response',
    constraint: 'fk_engineer_response_engineer_account',
    referencedTable: 'base_user_account',
  },
  {
    table: 'engineer_response',
    constraint: 'fk_engineer_response_customer_account',
    referencedTable: 'base_user_account',
  },
  {
    table: 'reference_document',
    constraint: 'fk_reference_document_equipment_model',
    referencedTable: 'equipment_model',
  },
  {
    table: 'reference_document',
    constraint: 'fk_reference_document_created_by_account',
    referencedTable: 'base_user_account',
  },
  {
    table: 'organization_membership',
    constraint: 'fk_organization_membership_organization',
    referencedTable: 'organization',
  },
  {
    table: 'organization_membership',
    constraint: 'fk_organization_membership_account',
    referencedTable: 'base_user_account',
  },
  {
    table: 'content_submission',
    constraint: 'fk_content_submission_owner_organization',
    referencedTable: 'organization',
  },
  {
    table: 'content_submission',
    constraint: 'fk_content_submission_submitted_by_account',
    referencedTable: 'base_user_account',
  },
  {
    table: 'material_submission_detail',
    constraint: 'fk_material_submission_detail_submission',
    referencedTable: 'content_submission',
  },
  {
    table: 'material_submission_detail',
    constraint: 'fk_material_submission_detail_equipment_model',
    referencedTable: 'equipment_model',
  },
  {
    table: 'fault_case_submission_detail',
    constraint: 'fk_fault_case_submission_detail_submission',
    referencedTable: 'content_submission',
  },
  {
    table: 'fault_case_submission_detail',
    constraint: 'fk_fault_case_submission_detail_equipment_model',
    referencedTable: 'equipment_model',
  },
  {
    table: 'content_submission_attachment',
    constraint: 'fk_content_submission_attachment_submission',
    referencedTable: 'content_submission',
  },
  {
    table: 'content_submission_attachment',
    constraint: 'fk_content_submission_attachment_uploaded_by_account',
    referencedTable: 'base_user_account',
  },
  {
    table: 'content_submission_revision',
    constraint: 'fk_content_submission_revision_submission',
    referencedTable: 'content_submission',
  },
  {
    table: 'content_submission_revision',
    constraint: 'fk_content_submission_revision_attachment',
    referencedTable: 'content_submission_attachment',
  },
  {
    table: 'content_submission_revision',
    constraint: 'fk_content_submission_revision_confirmed_by_account',
    referencedTable: 'base_user_account',
  },
  {
    table: 'content_submission_review',
    constraint: 'fk_content_submission_review_revision',
    referencedTable: 'content_submission_revision',
  },
  {
    table: 'content_submission_review',
    constraint: 'fk_content_submission_review_reviewed_by_account',
    referencedTable: 'base_user_account',
  },
  {
    table: 'reference_document_case_detail',
    constraint: 'fk_reference_document_case_detail_document',
    referencedTable: 'reference_document',
  },
  {
    table: 'reference_document',
    constraint: 'fk_reference_document_owner_organization',
    referencedTable: 'organization',
  },
  {
    table: 'reference_document',
    constraint: 'fk_reference_document_source_submission',
    referencedTable: 'content_submission',
  },
  {
    table: 'reference_document',
    constraint: 'fk_reference_document_source_revision',
    referencedTable: 'content_submission_revision',
  },
  {
    table: 'reference_document',
    constraint: 'fk_reference_document_updated_by_account',
    referencedTable: 'base_user_account',
  },
  {
    table: 'repair_request',
    constraint: 'fk_repair_request_owner_organization',
    referencedTable: 'organization',
  },
  {
    table: 'repair_request',
    constraint: 'fk_repair_request_handling_recorder',
    referencedTable: 'base_user_account',
  },
  {
    table: 'maintenance_report',
    constraint: 'fk_maintenance_report_owner_organization',
    referencedTable: 'organization',
  },
  {
    table: 'maintenance_report',
    constraint: 'fk_maintenance_report_repair_request',
    referencedTable: 'repair_request',
  },
  {
    table: 'maintenance_report',
    constraint: 'fk_maintenance_report_equipment_model',
    referencedTable: 'equipment_model',
  },
  {
    table: 'maintenance_report',
    constraint: 'fk_maintenance_report_engineer_account',
    referencedTable: 'base_user_account',
  },
  {
    table: 'maintenance_report',
    constraint: 'fk_maintenance_report_created_by',
    referencedTable: 'base_user_account',
  },
  {
    table: 'maintenance_report',
    constraint: 'fk_maintenance_report_updated_by',
    referencedTable: 'base_user_account',
  },
  {
    table: 'maintenance_report_alarm',
    constraint: 'fk_maintenance_report_alarm_report',
    referencedTable: 'maintenance_report',
  },
  {
    table: 'maintenance_report_step',
    constraint: 'fk_maintenance_report_step_report',
    referencedTable: 'maintenance_report',
  },
  {
    table: 'maintenance_report_attachment',
    constraint: 'fk_maintenance_report_attachment_report',
    referencedTable: 'maintenance_report',
  },
  {
    table: 'maintenance_report_attachment',
    constraint: 'fk_maintenance_report_attachment_uploaded_by',
    referencedTable: 'base_user_account',
  },
  {
    table: 'maintenance_report_version',
    constraint: 'fk_maintenance_report_version_report',
    referencedTable: 'maintenance_report',
  },
  {
    table: 'maintenance_report_version',
    constraint: 'fk_maintenance_report_version_submitted_by',
    referencedTable: 'base_user_account',
  },
  {
    table: 'maintenance_report_version_attachment',
    constraint: 'fk_maintenance_report_version_attachment_version',
    referencedTable: 'maintenance_report_version',
  },
  {
    table: 'maintenance_report_version_attachment',
    constraint: 'fk_maintenance_report_version_attachment_attachment',
    referencedTable: 'maintenance_report_attachment',
  },
  {
    table: 'maintenance_report_review',
    constraint: 'fk_maintenance_report_review_version',
    referencedTable: 'maintenance_report_version',
  },
  {
    table: 'maintenance_report_review',
    constraint: 'fk_maintenance_report_review_reviewer',
    referencedTable: 'base_user_account',
  },
  {
    table: 'local_installation',
    constraint: 'fk_local_installation_organization',
    referencedTable: 'organization',
  },
  {
    table: 'local_upload_task',
    constraint: 'fk_local_upload_task_installation',
    referencedTable: 'local_installation',
  },
  {
    table: 'local_backup_run',
    constraint: 'fk_local_backup_run_installation',
    referencedTable: 'local_installation',
  },
  {
    table: 'engineer_registration_application',
    constraint: 'fk_engineer_registration_application_account',
    referencedTable: 'base_user_account',
  },
  {
    table: 'engineer_registration_application',
    constraint: 'fk_engineer_registration_application_organization',
    referencedTable: 'organization',
  },
  {
    table: 'engineer_registration_application',
    constraint: 'fk_engineer_registration_application_reviewer',
    referencedTable: 'base_user_account',
  },
];

/* eslint-disable @typescript-eslint/naming-convention -- 键为 `表名.对象名` 的数据库标识，不能改为驼峰 */
/**
 * 登记关键表由哪条迁移创建，用于按“已执行前缀”校验。
 */
const TABLE_CREATED_BY: Readonly<Record<string, number>> = {
  ai_provider_call_record: 1773889200000,
  ai_workflow_context: 1775200800000,
  base_user_account: 1773924900000,
  base_user_info: 1773925000000,
  base_async_task_record: 1773925700000,
  base_third_party_auth: 1773926400000,
  base_verification_record: 1773927600000,
  equipment_model: 1775200900000,
  repair_request: 1775201000000,
  ai_conversation: 1775201100000,
  ai_message: 1775201200000,
  ai_report: 1775201300000,
  engineer_response: 1775201400000,
  reference_document: 1775201500000,
  organization: 1775301000000,
  organization_membership: 1775301100000,
  content_submission: 1775301200000,
  material_submission_detail: 1775301300000,
  fault_case_submission_detail: 1775301400000,
  content_submission_attachment: 1775301500000,
  content_submission_revision: 1775301600000,
  content_submission_review: 1775301700000,
  reference_document_case_detail: 1775301800000,
  maintenance_report: 1775401200000,
  maintenance_report_alarm: 1775401200000,
  maintenance_report_step: 1775401200000,
  maintenance_report_attachment: 1775401300000,
  maintenance_report_version: 1775401300000,
  maintenance_report_version_attachment: 1775401300000,
  maintenance_report_review: 1775401300000,
  local_installation: 1775401400000,
  local_upload_task: 1775401400000,
  local_backup_run: 1775401400000,
  engineer_registration_application: 1775401500000,
};

const INDEX_CREATED_BY: Readonly<Record<string, number>> = {
  'base_user_account.uk_login_email': 1773924900000,
  'base_third_party_auth.base_third_party_auth_provider_IDX': 1773926400000,
  'base_async_task_record.uk_queue_name_job_id': 1773925700000,
  'ai_provider_call_record.uk_ai_provider_call_trace_seq': 1773889200000,
  'ai_workflow_context.uk_ai_workflow_context_type_active_dedup_hash': 1775200800000,
  'ai_workflow_context.uk_ai_workflow_context_queue_job': 1775200800000,
  'base_verification_record.uk_token_fp': 1773927600000,
  'equipment_model.uk_equipment_model_code': 1775200900000,
  'repair_request.uk_repair_request_no': 1775201000000,
  'ai_message.uk_ai_message_conversation_seq': 1775201200000,
  'ai_report.uk_ai_report_conversation_type': 1775201300000,
  'organization.uk_organization_code': 1775301000000,
  'organization.idx_organization_kind_status': 1775301000000,
  'organization_membership.uk_organization_membership_org_account': 1775301100000,
  'organization_membership.idx_organization_membership_account_status': 1775301100000,
  'content_submission.idx_content_submission_org_status_updated': 1775301200000,
  'content_submission.idx_content_submission_submitter_status_updated': 1775301200000,
  'material_submission_detail.idx_material_submission_detail_equipment_model': 1775301300000,
  'fault_case_submission_detail.idx_fault_case_submission_detail_equipment_model': 1775301400000,
  'content_submission_attachment.uk_content_submission_attachment_id_submission': 1775301500000,
  'content_submission_attachment.idx_content_submission_attachment_submission_status': 1775301500000,
  'content_submission_attachment.idx_content_submission_attachment_uploaded_by': 1775301500000,
  'content_submission_revision.uk_content_submission_revision_submission_no': 1775301600000,
  'content_submission_revision.uk_content_submission_revision_id_submission': 1775301600000,
  'content_submission_revision.idx_content_submission_revision_attachment': 1775301600000,
  'content_submission_revision.idx_content_submission_revision_confirmed_by': 1775301600000,
  'content_submission_review.uk_content_submission_review_revision': 1775301700000,
  'content_submission_review.idx_content_submission_review_revision_submission': 1775301700000,
  'content_submission_review.idx_content_submission_review_submission_reviewed': 1775301700000,
  'content_submission_review.idx_content_submission_review_reviewed_by': 1775301700000,
  'reference_document.uk_reference_document_source_submission': 1775301900000,
  'reference_document.idx_reference_document_source_revision': 1775301900000,
  'reference_document.idx_reference_document_org_deleted_created': 1775301900000,
  'organization_membership.uk_organization_membership_active_account': 1775401000000,
  'organization_membership.idx_organization_membership_org_role_status': 1775401000000,
  'repair_request.uk_repair_request_id_owner': 1775401100000,
  'repair_request.idx_repair_request_owner_created': 1775401100000,
  'repair_request.idx_repair_request_owner_status': 1775401100000,
  'repair_request.idx_repair_request_handling_recorder': 1775401100000,
  'maintenance_report.uk_maintenance_report_request': 1775401200000,
  'maintenance_report.uk_maintenance_report_id_owner': 1775401200000,
  'maintenance_report.idx_maintenance_report_owner_status_created': 1775401200000,
  'maintenance_report.idx_maintenance_report_engineer_created': 1775401200000,
  'maintenance_report.idx_maintenance_report_source_created': 1775401200000,
  'maintenance_report_alarm.uk_maintenance_report_alarm_slot': 1775401200000,
  'maintenance_report_alarm.idx_maintenance_report_alarm_code': 1775401200000,
  'maintenance_report_step.uk_maintenance_report_step_no': 1775401200000,
  'maintenance_report_step.uk_maintenance_report_step_code': 1775401200000,
  'maintenance_report_step.idx_maintenance_report_step_phase': 1775401200000,
  'maintenance_report_attachment.uk_maintenance_report_attachment_id_report': 1775401300000,
  'maintenance_report_attachment.uk_maintenance_report_attachment_active_slot': 1775401300000,
  'maintenance_report_attachment.idx_maintenance_report_attachment_report_status': 1775401300000,
  'maintenance_report_version.uk_maintenance_report_version_no': 1775401300000,
  'maintenance_report_version.uk_maintenance_report_version_id_report': 1775401300000,
  'maintenance_report_version.idx_maintenance_report_version_submitted': 1775401300000,
  'maintenance_report_version_attachment.uk_maintenance_report_version_attachment_sort': 1775401300000,
  'maintenance_report_version_attachment.idx_maintenance_report_version_attachment_attachment': 1775401300000,
  'maintenance_report_review.uk_maintenance_report_review_version': 1775401300000,
  'maintenance_report_review.uk_maintenance_report_review_id_report': 1775401300000,
  'maintenance_report_review.idx_maintenance_report_review_report_time': 1775401300000,
  'local_installation.uk_local_installation_installation_id': 1775401400000,
  'local_installation.idx_local_installation_organization': 1775401400000,
  'local_upload_task.uk_local_upload_task_idempotency': 1775401400000,
  'local_upload_task.uk_local_upload_task_entity': 1775401400000,
  'local_upload_task.idx_local_upload_task_status_created': 1775401400000,
  'local_backup_run.uk_local_backup_run_active': 1775401400000,
  'local_backup_run.idx_local_backup_run_started': 1775401400000,
  'engineer_registration_application.uk_engineer_registration_application_pending_account': 1775401500000,
  'engineer_registration_application.idx_engineer_registration_application_org_status_submitted': 1775401500000,
  'engineer_registration_application.idx_engineer_registration_application_account_submitted': 1775401500000,
};

const COLUMN_CREATED_BY: Readonly<Record<string, number>> = {
  'base_user_info.company_name': 1773925000000,
  'ai_conversation.status': 1775201100000,
  'ai_conversation.ai_feedback': 1775201100000,
  'ai_conversation.completed_at': 1775201100000,
  'ai_message.message_seq': 1775201200000,
  'ai_message.turn_no': 1775201200000,
  'reference_document.deprecated': 1775201500000,
  'reference_document.deleted_at': 1775201500000,
  'reference_document.owner_organization_id': 1775301900000,
  'reference_document.ingest_method': 1775301900000,
  'reference_document.source_submission_id': 1775301900000,
  'reference_document.source_revision_id': 1775301900000,
  'reference_document.equipment_model_text': 1775301900000,
  'reference_document.updated_by_account_id': 1775301900000,
  'reference_document.extension_json': 1775301900000,
  'reference_document.schema_version': 1775301900000,
  'organization_membership.active_account_id': 1775401000000,
  'repair_request.owner_organization_id': 1775401100000,
  'repair_request.handling_result': 1775401100000,
  'repair_request.handling_status': 1775401100000,
  'repair_request.handling_recorded_at': 1775401100000,
  'repair_request.handling_recorded_by_account_id': 1775401100000,
  'repair_request.handling_ended_at': 1775401100000,
  'maintenance_report.owner_organization_id': 1775401200000,
  'maintenance_report.source_type': 1775401200000,
  'maintenance_report.repair_request_id': 1775401200000,
  'maintenance_report.status': 1775401200000,
  'maintenance_report.current_version_no': 1775401200000,
  'maintenance_report.phase_flow_version': 1775401200000,
  'maintenance_report.maintenance_date': 1775401200000,
  'maintenance_report.maintenance_engineer_account_id': 1775401200000,
  'maintenance_report.ai_usage': 1775401200000,
  'maintenance_report.ai_source_type': 1775401200000,
  'maintenance_report.ai_source_id': 1775401200000,
  'maintenance_report.ai_source_version': 1775401200000,
  'maintenance_report.ai_score': 1775401200000,
  'maintenance_report.ai_correctness': 1775401200000,
  'maintenance_report.ai_helpfulness': 1775401200000,
  'maintenance_report.ai_note': 1775401200000,
  'maintenance_report_alarm.alarm_index': 1775401200000,
  'maintenance_report_alarm.alarm_code': 1775401200000,
  'maintenance_report_alarm.phase_code': 1775401200000,
  'maintenance_report_alarm.reset_result': 1775401200000,
  'maintenance_report_step.step_no': 1775401200000,
  'maintenance_report_step.step_code': 1775401200000,
  'maintenance_report_step.phase_code': 1775401200000,
  'maintenance_report_step.is_valid_new_branch': 1775401200000,
  'maintenance_report_attachment.sort_order': 1775401300000,
  'maintenance_report_attachment.status': 1775401300000,
  'maintenance_report_attachment.storage_reference': 1775401300000,
  'maintenance_report_attachment.active_sort_order': 1775401300000,
  'maintenance_report_version.version_no': 1775401300000,
  'maintenance_report_version.change_kind': 1775401300000,
  'maintenance_report_version.change_reason': 1775401300000,
  'maintenance_report_version.schema_version': 1775401300000,
  'maintenance_report_version.payload_snapshot': 1775401300000,
  'maintenance_report_version_attachment.sort_order': 1775401300000,
  'maintenance_report_version_attachment.publish_flag': 1775401300000,
  'maintenance_report_review.decision': 1775401300000,
  'maintenance_report_review.comment': 1775401300000,
  'maintenance_report_review.reviewed_at': 1775401300000,
  'local_installation.installation_id': 1775401400000,
  'local_installation.organization_id': 1775401400000,
  'local_installation.backup_interval_days': 1775401400000,
  'local_installation.last_backup_completed_at': 1775401400000,
  'local_upload_task.idempotency_key': 1775401400000,
  'local_upload_task.entity_version': 1775401400000,
  'local_upload_task.status': 1775401400000,
  'local_upload_task.attempt_count': 1775401400000,
  'local_backup_run.trigger_type': 1775401400000,
  'local_backup_run.status': 1775401400000,
  'local_backup_run.active_installation_id': 1775401400000,
  'local_backup_run.finished_at': 1775401400000,
  'engineer_registration_application.account_id': 1775401500000,
  'engineer_registration_application.organization_id': 1775401500000,
  'engineer_registration_application.status': 1775401500000,
  'engineer_registration_application.submitted_at': 1775401500000,
  'engineer_registration_application.reviewed_by_account_id': 1775401500000,
  'engineer_registration_application.reviewed_at': 1775401500000,
  'engineer_registration_application.review_comment': 1775401500000,
  'engineer_registration_application.pending_account_id': 1775401500000,
};

const CHECK_CREATED_BY: Readonly<Record<string, number>> = {
  'equipment_model.chk_equipment_model_enabled': 1775200900000,
  'repair_request.chk_repair_request_acceptance_consistency': 1775201000000,
  'repair_request.chk_repair_request_deletion_consistency': 1775201000000,
  'ai_conversation.chk_ai_conversation_completion': 1775201100000,
  'ai_message.chk_ai_message_turn': 1775201200000,
  'reference_document.chk_reference_document_deletion_consistency': 1775201500000,
  'reference_document.chk_reference_document_storage_pair': 1775201500000,
  'reference_document.chk_reference_document_content_source': 1775201500000,
  'organization.chk_organization_kind': 1775301000000,
  'organization.chk_organization_status': 1775301000000,
  'organization_membership.chk_organization_membership_role': 1775301100000,
  'organization_membership.chk_organization_membership_status': 1775301100000,
  'organization_membership.chk_organization_membership_period': 1775301100000,
  'content_submission.chk_content_submission_kind': 1775301200000,
  'content_submission.chk_content_submission_status': 1775301200000,
  'content_submission.chk_content_submission_revision_consistency': 1775301200000,
  'content_submission.chk_content_submission_publish_consistency': 1775301200000,
  'material_submission_detail.chk_material_submission_detail_model_exclusive': 1775301300000,
  'material_submission_detail.chk_material_submission_detail_type': 1775301300000,
  'fault_case_submission_detail.chk_fault_case_submission_detail_model_exclusive': 1775301400000,
  'fault_case_submission_detail.chk_fault_case_submission_detail_handling_status': 1775301400000,
  'fault_case_submission_detail.chk_fault_case_submission_detail_resolution': 1775301400000,
  'content_submission_attachment.chk_content_submission_attachment_status': 1775301500000,
  'content_submission_attachment.chk_content_submission_attachment_retire_consistency': 1775301500000,
  'content_submission_revision.chk_content_submission_revision_no': 1775301600000,
  'content_submission_revision.chk_content_submission_revision_title': 1775301600000,
  'content_submission_revision.chk_content_submission_revision_notice': 1775301600000,
  'content_submission_review.chk_content_submission_review_decision': 1775301700000,
  'content_submission_review.chk_content_submission_review_comment': 1775301700000,
  'content_submission_review.chk_content_submission_review_publish_flag': 1775301700000,
  'reference_document_case_detail.chk_reference_document_case_detail_status': 1775301800000,
  'reference_document_case_detail.chk_reference_document_case_detail_resolution': 1775301800000,
  'reference_document.chk_reference_document_ingest_method': 1775301900000,
  'reference_document.chk_reference_document_source_pair': 1775301900000,
  'reference_document.chk_reference_document_model_exclusive': 1775301900000,
  'repair_request.chk_repair_request_handling_result': 1775401100000,
  'repair_request.chk_repair_request_handling_status': 1775401100000,
  'repair_request.chk_repair_request_handling_mapping': 1775401100000,
  'repair_request.chk_repair_request_handling_requires_accepted': 1775401100000,
  'repair_request.chk_repair_request_handling_time': 1775401100000,
  'maintenance_report.chk_maintenance_report_source': 1775401200000,
  'maintenance_report.chk_maintenance_report_request_source': 1775401200000,
  'maintenance_report.chk_maintenance_report_status': 1775401200000,
  'maintenance_report.chk_maintenance_report_status_consistency': 1775401200000,
  'maintenance_report.chk_maintenance_report_model_exclusive': 1775401200000,
  'maintenance_report.chk_maintenance_report_phase_flow': 1775401200000,
  'maintenance_report.chk_maintenance_report_ai_usage': 1775401200000,
  'maintenance_report.chk_maintenance_report_ai_score': 1775401200000,
  'maintenance_report.chk_maintenance_report_ai_helpfulness': 1775401200000,
  'maintenance_report.chk_maintenance_report_ai_correctness': 1775401200000,
  'maintenance_report_alarm.chk_maintenance_report_alarm_index': 1775401200000,
  'maintenance_report_alarm.chk_maintenance_report_alarm_code': 1775401200000,
  'maintenance_report_alarm.chk_maintenance_report_alarm_phase': 1775401200000,
  'maintenance_report_alarm.chk_maintenance_report_alarm_reset': 1775401200000,
  'maintenance_report_step.chk_maintenance_report_step_no': 1775401200000,
  'maintenance_report_step.chk_maintenance_report_step_code': 1775401200000,
  'maintenance_report_step.chk_maintenance_report_step_action': 1775401200000,
  'maintenance_report_step.chk_maintenance_report_step_phase': 1775401200000,
  'maintenance_report_step.chk_maintenance_report_step_branch': 1775401200000,
  'maintenance_report_attachment.chk_maintenance_report_attachment_byte_size': 1775401300000,
  'maintenance_report_attachment.chk_maintenance_report_attachment_sort': 1775401300000,
  'maintenance_report_attachment.chk_maintenance_report_attachment_status': 1775401300000,
  'maintenance_report_attachment.chk_maintenance_report_attachment_retired': 1775401300000,
  'maintenance_report_attachment.chk_maintenance_report_attachment_storage': 1775401300000,
  'maintenance_report_attachment.chk_maintenance_report_attachment_filename': 1775401300000,
  'maintenance_report_version.chk_maintenance_report_version_no': 1775401300000,
  'maintenance_report_version.chk_maintenance_report_version_change_kind': 1775401300000,
  'maintenance_report_version.chk_maintenance_report_version_correction_reason': 1775401300000,
  'maintenance_report_version.chk_maintenance_report_version_payload': 1775401300000,
  'maintenance_report_version.chk_maintenance_report_version_schema': 1775401300000,
  'maintenance_report_version_attachment.chk_maintenance_report_version_attachment_sort': 1775401300000,
  'maintenance_report_version_attachment.chk_maintenance_report_version_attachment_publish': 1775401300000,
  'maintenance_report_review.chk_maintenance_report_review_decision': 1775401300000,
  'maintenance_report_review.chk_maintenance_report_review_comment': 1775401300000,
  'local_installation.chk_local_installation_singleton': 1775401400000,
  'local_installation.chk_local_installation_interval': 1775401400000,
  'local_upload_task.chk_local_upload_task_entity_type': 1775401400000,
  'local_upload_task.chk_local_upload_task_status': 1775401400000,
  'local_upload_task.chk_local_upload_task_attempt': 1775401400000,
  'local_upload_task.chk_local_upload_task_version': 1775401400000,
  'local_upload_task.chk_local_upload_task_idempotency': 1775401400000,
  'local_upload_task.chk_local_upload_task_error': 1775401400000,
  'local_backup_run.chk_local_backup_run_trigger': 1775401400000,
  'local_backup_run.chk_local_backup_run_status': 1775401400000,
  'local_backup_run.chk_local_backup_run_finish': 1775401400000,
  'engineer_registration_application.chk_engineer_registration_application_status': 1775401500000,
  'engineer_registration_application.chk_engineer_registration_application_pending_review': 1775401500000,
  'engineer_registration_application.chk_engineer_registration_application_reviewed': 1775401500000,
  'engineer_registration_application.chk_engineer_registration_application_reject_comment': 1775401500000,
  'engineer_registration_application.chk_engineer_registration_application_review_time': 1775401500000,
};

const FOREIGN_KEY_CREATED_BY: Readonly<Record<string, number>> = {
  'repair_request.fk_repair_request_customer_account': 1775201000000,
  'repair_request.fk_repair_request_equipment_model': 1775201000000,
  'repair_request.fk_repair_request_engineer_account': 1775201000000,
  'ai_conversation.fk_ai_conversation_request': 1775201100000,
  'ai_conversation.fk_ai_conversation_engineer_account': 1775201100000,
  'ai_message.fk_ai_message_conversation': 1775201200000,
  'ai_report.fk_ai_report_request': 1775201300000,
  'ai_report.fk_ai_report_conversation': 1775201300000,
  'ai_report.fk_ai_report_engineer_account': 1775201300000,
  'engineer_response.fk_engineer_response_request': 1775201400000,
  'engineer_response.fk_engineer_response_engineer_account': 1775201400000,
  'engineer_response.fk_engineer_response_customer_account': 1775201400000,
  'reference_document.fk_reference_document_equipment_model': 1775201500000,
  'reference_document.fk_reference_document_created_by_account': 1775201500000,
  'organization_membership.fk_organization_membership_organization': 1775301100000,
  'organization_membership.fk_organization_membership_account': 1775301100000,
  'content_submission.fk_content_submission_owner_organization': 1775301200000,
  'content_submission.fk_content_submission_submitted_by_account': 1775301200000,
  'material_submission_detail.fk_material_submission_detail_submission': 1775301300000,
  'material_submission_detail.fk_material_submission_detail_equipment_model': 1775301300000,
  'fault_case_submission_detail.fk_fault_case_submission_detail_submission': 1775301400000,
  'fault_case_submission_detail.fk_fault_case_submission_detail_equipment_model': 1775301400000,
  'content_submission_attachment.fk_content_submission_attachment_submission': 1775301500000,
  'content_submission_attachment.fk_content_submission_attachment_uploaded_by_account': 1775301500000,
  'content_submission_revision.fk_content_submission_revision_submission': 1775301600000,
  'content_submission_revision.fk_content_submission_revision_attachment': 1775301600000,
  'content_submission_revision.fk_content_submission_revision_confirmed_by_account': 1775301600000,
  'content_submission_review.fk_content_submission_review_revision': 1775301700000,
  'content_submission_review.fk_content_submission_review_reviewed_by_account': 1775301700000,
  'reference_document_case_detail.fk_reference_document_case_detail_document': 1775301800000,
  'reference_document.fk_reference_document_owner_organization': 1775301900000,
  'reference_document.fk_reference_document_source_submission': 1775301900000,
  'reference_document.fk_reference_document_source_revision': 1775301900000,
  'reference_document.fk_reference_document_updated_by_account': 1775301900000,
  'base_user_info.base_user_info_ibfk_1': 1773925000000,
  'repair_request.fk_repair_request_owner_organization': 1775401100000,
  'repair_request.fk_repair_request_handling_recorder': 1775401100000,
  'maintenance_report.fk_maintenance_report_owner_organization': 1775401200000,
  'maintenance_report.fk_maintenance_report_repair_request': 1775401200000,
  'maintenance_report.fk_maintenance_report_equipment_model': 1775401200000,
  'maintenance_report.fk_maintenance_report_engineer_account': 1775401200000,
  'maintenance_report.fk_maintenance_report_created_by': 1775401200000,
  'maintenance_report.fk_maintenance_report_updated_by': 1775401200000,
  'maintenance_report_alarm.fk_maintenance_report_alarm_report': 1775401200000,
  'maintenance_report_step.fk_maintenance_report_step_report': 1775401200000,
  'maintenance_report_attachment.fk_maintenance_report_attachment_report': 1775401300000,
  'maintenance_report_attachment.fk_maintenance_report_attachment_uploaded_by': 1775401300000,
  'maintenance_report_version.fk_maintenance_report_version_report': 1775401300000,
  'maintenance_report_version.fk_maintenance_report_version_submitted_by': 1775401300000,
  'maintenance_report_version_attachment.fk_maintenance_report_version_attachment_version': 1775401300000,
  'maintenance_report_version_attachment.fk_maintenance_report_version_attachment_attachment': 1775401300000,
  'maintenance_report_review.fk_maintenance_report_review_version': 1775401300000,
  'maintenance_report_review.fk_maintenance_report_review_reviewer': 1775401300000,
  'local_installation.fk_local_installation_organization': 1775401400000,
  'local_upload_task.fk_local_upload_task_installation': 1775401400000,
  'local_backup_run.fk_local_backup_run_installation': 1775401400000,
  'engineer_registration_application.fk_engineer_registration_application_account': 1775401500000,
  'engineer_registration_application.fk_engineer_registration_application_organization': 1775401500000,
  'engineer_registration_application.fk_engineer_registration_application_reviewer': 1775401500000,
};

/**
 * 关键索引的完整定义：唯一性与有序列。
 */
interface IndexDefinition {
  readonly unique: boolean;
  readonly columns: ReadonlyArray<string>;
}

/**
 * 关键外键的完整定义：有序本地列、引用表与对应有序引用列。
 */
interface ForeignKeyDefinition {
  readonly referenceTable: string;
  readonly localColumns: ReadonlyArray<string>;
  readonly referenceColumns: ReadonlyArray<string>;
}

/**
 * 关键索引列定义，来源为 24 条既有迁移的 DDL，不依赖可能漂移的现网库。
 * 键与 REQUIRED_INDEXES 的 `table.index` 一一对应。
 */
const INDEX_DEFINITIONS: Readonly<Record<string, IndexDefinition>> = {
  'base_user_account.uk_login_email': { unique: true, columns: ['login_email'] },
  'base_third_party_auth.base_third_party_auth_provider_IDX': {
    unique: true,
    columns: ['provider', 'provider_user_id'],
  },
  'base_async_task_record.uk_queue_name_job_id': {
    unique: true,
    columns: ['queue_name', 'job_id'],
  },
  'ai_provider_call_record.uk_ai_provider_call_trace_seq': {
    unique: true,
    columns: ['trace_id', 'call_seq'],
  },
  'ai_workflow_context.uk_ai_workflow_context_type_active_dedup_hash': {
    unique: true,
    columns: ['workflow_type', 'workflow_dedup_active_hash'],
  },
  'ai_workflow_context.uk_ai_workflow_context_queue_job': {
    unique: true,
    columns: ['queue_name', 'job_id'],
  },
  'base_verification_record.uk_token_fp': { unique: true, columns: ['token_fp'] },
  'equipment_model.uk_equipment_model_code': { unique: true, columns: ['model_code'] },
  'repair_request.uk_repair_request_no': { unique: true, columns: ['request_no'] },
  'ai_message.uk_ai_message_conversation_seq': {
    unique: true,
    columns: ['conversation_id', 'message_seq'],
  },
  'ai_report.uk_ai_report_conversation_type': {
    unique: true,
    columns: ['conversation_id', 'report_type'],
  },
  'organization.uk_organization_code': { unique: true, columns: ['organization_code'] },
  'organization.idx_organization_kind_status': { unique: false, columns: ['kind', 'status'] },
  'organization_membership.uk_organization_membership_org_account': {
    unique: true,
    columns: ['organization_id', 'account_id'],
  },
  'organization_membership.idx_organization_membership_account_status': {
    unique: false,
    columns: ['account_id', 'status'],
  },
  'content_submission.idx_content_submission_org_status_updated': {
    unique: false,
    columns: ['owner_organization_id', 'status', 'updated_at'],
  },
  'content_submission.idx_content_submission_submitter_status_updated': {
    unique: false,
    columns: ['submitted_by_account_id', 'status', 'updated_at'],
  },
  'material_submission_detail.idx_material_submission_detail_equipment_model': {
    unique: false,
    columns: ['equipment_model_id'],
  },
  'fault_case_submission_detail.idx_fault_case_submission_detail_equipment_model': {
    unique: false,
    columns: ['equipment_model_id'],
  },
  'content_submission_attachment.uk_content_submission_attachment_id_submission': {
    unique: true,
    columns: ['id', 'submission_id'],
  },
  'content_submission_attachment.idx_content_submission_attachment_submission_status': {
    unique: false,
    columns: ['submission_id', 'status'],
  },
  'content_submission_attachment.idx_content_submission_attachment_uploaded_by': {
    unique: false,
    columns: ['uploaded_by_account_id'],
  },
  'content_submission_revision.uk_content_submission_revision_submission_no': {
    unique: true,
    columns: ['submission_id', 'revision_no'],
  },
  'content_submission_revision.uk_content_submission_revision_id_submission': {
    unique: true,
    columns: ['id', 'submission_id'],
  },
  'content_submission_revision.idx_content_submission_revision_attachment': {
    unique: false,
    columns: ['attachment_id', 'submission_id'],
  },
  'content_submission_revision.idx_content_submission_revision_confirmed_by': {
    unique: false,
    columns: ['confirmed_by_account_id'],
  },
  'content_submission_review.uk_content_submission_review_revision': {
    unique: true,
    columns: ['revision_id'],
  },
  'content_submission_review.idx_content_submission_review_revision_submission': {
    unique: false,
    columns: ['revision_id', 'submission_id'],
  },
  'content_submission_review.idx_content_submission_review_submission_reviewed': {
    unique: false,
    columns: ['submission_id', 'reviewed_at'],
  },
  'content_submission_review.idx_content_submission_review_reviewed_by': {
    unique: false,
    columns: ['reviewed_by_account_id'],
  },
  'reference_document.uk_reference_document_source_submission': {
    unique: true,
    columns: ['source_submission_id'],
  },
  'reference_document.idx_reference_document_source_revision': {
    unique: false,
    columns: ['source_revision_id', 'source_submission_id'],
  },
  'reference_document.idx_reference_document_org_deleted_created': {
    unique: false,
    columns: ['owner_organization_id', 'deleted_at', 'created_at'],
  },
  'organization_membership.uk_organization_membership_active_account': {
    unique: true,
    columns: ['active_account_id'],
  },
  'organization_membership.idx_organization_membership_org_role_status': {
    unique: false,
    columns: ['organization_id', 'member_role', 'status'],
  },
  'repair_request.uk_repair_request_id_owner': {
    unique: true,
    columns: ['id', 'owner_organization_id'],
  },
  'repair_request.idx_repair_request_owner_created': {
    unique: false,
    columns: ['owner_organization_id', 'created_at'],
  },
  'repair_request.idx_repair_request_owner_status': {
    unique: false,
    columns: ['owner_organization_id', 'handling_status'],
  },
  'repair_request.idx_repair_request_handling_recorder': {
    unique: false,
    columns: ['handling_recorded_by_account_id'],
  },
  'maintenance_report.uk_maintenance_report_request': {
    unique: true,
    columns: ['repair_request_id'],
  },
  'maintenance_report.uk_maintenance_report_id_owner': {
    unique: true,
    columns: ['id', 'owner_organization_id'],
  },
  'maintenance_report.idx_maintenance_report_owner_status_created': {
    unique: false,
    columns: ['owner_organization_id', 'status', 'created_at'],
  },
  'maintenance_report.idx_maintenance_report_engineer_created': {
    unique: false,
    columns: ['maintenance_engineer_account_id', 'created_at'],
  },
  'maintenance_report.idx_maintenance_report_source_created': {
    unique: false,
    columns: ['source_type', 'created_at'],
  },
  'maintenance_report_alarm.uk_maintenance_report_alarm_slot': {
    unique: true,
    columns: ['report_id', 'alarm_index'],
  },
  'maintenance_report_alarm.idx_maintenance_report_alarm_code': {
    unique: false,
    columns: ['alarm_code'],
  },
  'maintenance_report_step.uk_maintenance_report_step_no': {
    unique: true,
    columns: ['report_id', 'step_no'],
  },
  'maintenance_report_step.uk_maintenance_report_step_code': {
    unique: true,
    columns: ['report_id', 'step_code'],
  },
  'maintenance_report_step.idx_maintenance_report_step_phase': {
    unique: false,
    columns: ['report_id', 'phase_code'],
  },
  'maintenance_report_attachment.uk_maintenance_report_attachment_id_report': {
    unique: true,
    columns: ['id', 'report_id'],
  },
  'maintenance_report_attachment.uk_maintenance_report_attachment_active_slot': {
    unique: true,
    columns: ['report_id', 'active_sort_order'],
  },
  'maintenance_report_attachment.idx_maintenance_report_attachment_report_status': {
    unique: false,
    columns: ['report_id', 'status', 'sort_order'],
  },
  'maintenance_report_version.uk_maintenance_report_version_no': {
    unique: true,
    columns: ['report_id', 'version_no'],
  },
  'maintenance_report_version.uk_maintenance_report_version_id_report': {
    unique: true,
    columns: ['id', 'report_id'],
  },
  'maintenance_report_version.idx_maintenance_report_version_submitted': {
    unique: false,
    columns: ['report_id', 'submitted_at'],
  },
  'maintenance_report_version_attachment.uk_maintenance_report_version_attachment_sort': {
    unique: true,
    columns: ['version_id', 'sort_order'],
  },
  'maintenance_report_version_attachment.idx_maintenance_report_version_attachment_attachment': {
    unique: false,
    columns: ['attachment_id'],
  },
  'maintenance_report_review.uk_maintenance_report_review_version': {
    unique: true,
    columns: ['version_id'],
  },
  'maintenance_report_review.uk_maintenance_report_review_id_report': {
    unique: true,
    columns: ['id', 'report_id'],
  },
  'maintenance_report_review.idx_maintenance_report_review_report_time': {
    unique: false,
    columns: ['report_id', 'reviewed_at'],
  },
  'local_installation.uk_local_installation_installation_id': {
    unique: true,
    columns: ['installation_id'],
  },
  'local_installation.idx_local_installation_organization': {
    unique: false,
    columns: ['organization_id'],
  },
  'local_upload_task.uk_local_upload_task_idempotency': {
    unique: true,
    columns: ['idempotency_key'],
  },
  'local_upload_task.uk_local_upload_task_entity': {
    unique: true,
    columns: ['installation_id', 'entity_type', 'entity_local_id', 'entity_version'],
  },
  'local_upload_task.idx_local_upload_task_status_created': {
    unique: false,
    columns: ['status', 'created_at'],
  },
  'local_backup_run.uk_local_backup_run_active': {
    unique: true,
    columns: ['active_installation_id'],
  },
  'local_backup_run.idx_local_backup_run_started': {
    unique: false,
    columns: ['started_at'],
  },
  'engineer_registration_application.uk_engineer_registration_application_pending_account': {
    unique: true,
    columns: ['pending_account_id'],
  },
  'engineer_registration_application.idx_engineer_registration_application_org_status_submitted': {
    unique: false,
    columns: ['organization_id', 'status', 'submitted_at', 'id'],
  },
  'engineer_registration_application.idx_engineer_registration_application_account_submitted': {
    unique: false,
    columns: ['account_id', 'submitted_at', 'id'],
  },
};

/**
 * 关键外键列映射，来源为 24 条既有迁移的 DDL。
 * 键与 REQUIRED_FOREIGN_KEYS 的 `table.constraint` 一一对应。
 */
const FOREIGN_KEY_DEFINITIONS: Readonly<Record<string, ForeignKeyDefinition>> = {
  'base_user_info.base_user_info_ibfk_1': {
    referenceTable: 'base_user_account',
    localColumns: ['account_id'],
    referenceColumns: ['id'],
  },
  'repair_request.fk_repair_request_customer_account': {
    referenceTable: 'base_user_account',
    localColumns: ['customer_account_id'],
    referenceColumns: ['id'],
  },
  'repair_request.fk_repair_request_equipment_model': {
    referenceTable: 'equipment_model',
    localColumns: ['equipment_model_id'],
    referenceColumns: ['id'],
  },
  'repair_request.fk_repair_request_engineer_account': {
    referenceTable: 'base_user_account',
    localColumns: ['accepted_by_engineer_account_id'],
    referenceColumns: ['id'],
  },
  'ai_conversation.fk_ai_conversation_request': {
    referenceTable: 'repair_request',
    localColumns: ['request_id'],
    referenceColumns: ['id'],
  },
  'ai_conversation.fk_ai_conversation_engineer_account': {
    referenceTable: 'base_user_account',
    localColumns: ['engineer_account_id'],
    referenceColumns: ['id'],
  },
  'ai_message.fk_ai_message_conversation': {
    referenceTable: 'ai_conversation',
    localColumns: ['conversation_id'],
    referenceColumns: ['id'],
  },
  'ai_report.fk_ai_report_request': {
    referenceTable: 'repair_request',
    localColumns: ['request_id'],
    referenceColumns: ['id'],
  },
  'ai_report.fk_ai_report_conversation': {
    referenceTable: 'ai_conversation',
    localColumns: ['conversation_id'],
    referenceColumns: ['id'],
  },
  'ai_report.fk_ai_report_engineer_account': {
    referenceTable: 'base_user_account',
    localColumns: ['engineer_account_id'],
    referenceColumns: ['id'],
  },
  'engineer_response.fk_engineer_response_request': {
    referenceTable: 'repair_request',
    localColumns: ['request_id'],
    referenceColumns: ['id'],
  },
  'engineer_response.fk_engineer_response_engineer_account': {
    referenceTable: 'base_user_account',
    localColumns: ['engineer_account_id'],
    referenceColumns: ['id'],
  },
  'engineer_response.fk_engineer_response_customer_account': {
    referenceTable: 'base_user_account',
    localColumns: ['customer_account_id'],
    referenceColumns: ['id'],
  },
  'reference_document.fk_reference_document_equipment_model': {
    referenceTable: 'equipment_model',
    localColumns: ['equipment_model_id'],
    referenceColumns: ['id'],
  },
  'reference_document.fk_reference_document_created_by_account': {
    referenceTable: 'base_user_account',
    localColumns: ['created_by_account_id'],
    referenceColumns: ['id'],
  },
  'organization_membership.fk_organization_membership_organization': {
    referenceTable: 'organization',
    localColumns: ['organization_id'],
    referenceColumns: ['id'],
  },
  'organization_membership.fk_organization_membership_account': {
    referenceTable: 'base_user_account',
    localColumns: ['account_id'],
    referenceColumns: ['id'],
  },
  'content_submission.fk_content_submission_owner_organization': {
    referenceTable: 'organization',
    localColumns: ['owner_organization_id'],
    referenceColumns: ['id'],
  },
  'content_submission.fk_content_submission_submitted_by_account': {
    referenceTable: 'base_user_account',
    localColumns: ['submitted_by_account_id'],
    referenceColumns: ['id'],
  },
  'material_submission_detail.fk_material_submission_detail_submission': {
    referenceTable: 'content_submission',
    localColumns: ['submission_id'],
    referenceColumns: ['id'],
  },
  'material_submission_detail.fk_material_submission_detail_equipment_model': {
    referenceTable: 'equipment_model',
    localColumns: ['equipment_model_id'],
    referenceColumns: ['id'],
  },
  'fault_case_submission_detail.fk_fault_case_submission_detail_submission': {
    referenceTable: 'content_submission',
    localColumns: ['submission_id'],
    referenceColumns: ['id'],
  },
  'fault_case_submission_detail.fk_fault_case_submission_detail_equipment_model': {
    referenceTable: 'equipment_model',
    localColumns: ['equipment_model_id'],
    referenceColumns: ['id'],
  },
  'content_submission_attachment.fk_content_submission_attachment_submission': {
    referenceTable: 'content_submission',
    localColumns: ['submission_id'],
    referenceColumns: ['id'],
  },
  'content_submission_attachment.fk_content_submission_attachment_uploaded_by_account': {
    referenceTable: 'base_user_account',
    localColumns: ['uploaded_by_account_id'],
    referenceColumns: ['id'],
  },
  'content_submission_revision.fk_content_submission_revision_submission': {
    referenceTable: 'content_submission',
    localColumns: ['submission_id'],
    referenceColumns: ['id'],
  },
  'content_submission_revision.fk_content_submission_revision_attachment': {
    referenceTable: 'content_submission_attachment',
    localColumns: ['attachment_id', 'submission_id'],
    referenceColumns: ['id', 'submission_id'],
  },
  'content_submission_revision.fk_content_submission_revision_confirmed_by_account': {
    referenceTable: 'base_user_account',
    localColumns: ['confirmed_by_account_id'],
    referenceColumns: ['id'],
  },
  'content_submission_review.fk_content_submission_review_revision': {
    referenceTable: 'content_submission_revision',
    localColumns: ['revision_id', 'submission_id'],
    referenceColumns: ['id', 'submission_id'],
  },
  'content_submission_review.fk_content_submission_review_reviewed_by_account': {
    referenceTable: 'base_user_account',
    localColumns: ['reviewed_by_account_id'],
    referenceColumns: ['id'],
  },
  'reference_document_case_detail.fk_reference_document_case_detail_document': {
    referenceTable: 'reference_document',
    localColumns: ['document_id'],
    referenceColumns: ['id'],
  },
  'reference_document.fk_reference_document_owner_organization': {
    referenceTable: 'organization',
    localColumns: ['owner_organization_id'],
    referenceColumns: ['id'],
  },
  'reference_document.fk_reference_document_source_submission': {
    referenceTable: 'content_submission',
    localColumns: ['source_submission_id'],
    referenceColumns: ['id'],
  },
  'reference_document.fk_reference_document_source_revision': {
    referenceTable: 'content_submission_revision',
    localColumns: ['source_revision_id', 'source_submission_id'],
    referenceColumns: ['id', 'submission_id'],
  },
  'reference_document.fk_reference_document_updated_by_account': {
    referenceTable: 'base_user_account',
    localColumns: ['updated_by_account_id'],
    referenceColumns: ['id'],
  },
  'repair_request.fk_repair_request_owner_organization': {
    referenceTable: 'organization',
    localColumns: ['owner_organization_id'],
    referenceColumns: ['id'],
  },
  'repair_request.fk_repair_request_handling_recorder': {
    referenceTable: 'base_user_account',
    localColumns: ['handling_recorded_by_account_id'],
    referenceColumns: ['id'],
  },
  'maintenance_report.fk_maintenance_report_owner_organization': {
    referenceTable: 'organization',
    localColumns: ['owner_organization_id'],
    referenceColumns: ['id'],
  },
  'maintenance_report.fk_maintenance_report_repair_request': {
    referenceTable: 'repair_request',
    localColumns: ['repair_request_id'],
    referenceColumns: ['id'],
  },
  'maintenance_report.fk_maintenance_report_equipment_model': {
    referenceTable: 'equipment_model',
    localColumns: ['equipment_model_id'],
    referenceColumns: ['id'],
  },
  'maintenance_report.fk_maintenance_report_engineer_account': {
    referenceTable: 'base_user_account',
    localColumns: ['maintenance_engineer_account_id'],
    referenceColumns: ['id'],
  },
  'maintenance_report.fk_maintenance_report_created_by': {
    referenceTable: 'base_user_account',
    localColumns: ['created_by_account_id'],
    referenceColumns: ['id'],
  },
  'maintenance_report.fk_maintenance_report_updated_by': {
    referenceTable: 'base_user_account',
    localColumns: ['updated_by_account_id'],
    referenceColumns: ['id'],
  },
  'maintenance_report_alarm.fk_maintenance_report_alarm_report': {
    referenceTable: 'maintenance_report',
    localColumns: ['report_id'],
    referenceColumns: ['id'],
  },
  'maintenance_report_step.fk_maintenance_report_step_report': {
    referenceTable: 'maintenance_report',
    localColumns: ['report_id'],
    referenceColumns: ['id'],
  },
  'maintenance_report_attachment.fk_maintenance_report_attachment_report': {
    referenceTable: 'maintenance_report',
    localColumns: ['report_id'],
    referenceColumns: ['id'],
  },
  'maintenance_report_attachment.fk_maintenance_report_attachment_uploaded_by': {
    referenceTable: 'base_user_account',
    localColumns: ['uploaded_by_account_id'],
    referenceColumns: ['id'],
  },
  'maintenance_report_version.fk_maintenance_report_version_report': {
    referenceTable: 'maintenance_report',
    localColumns: ['report_id'],
    referenceColumns: ['id'],
  },
  'maintenance_report_version.fk_maintenance_report_version_submitted_by': {
    referenceTable: 'base_user_account',
    localColumns: ['submitted_by_account_id'],
    referenceColumns: ['id'],
  },
  'maintenance_report_version_attachment.fk_maintenance_report_version_attachment_version': {
    referenceTable: 'maintenance_report_version',
    localColumns: ['version_id', 'report_id'],
    referenceColumns: ['id', 'report_id'],
  },
  'maintenance_report_version_attachment.fk_maintenance_report_version_attachment_attachment': {
    referenceTable: 'maintenance_report_attachment',
    localColumns: ['attachment_id', 'report_id'],
    referenceColumns: ['id', 'report_id'],
  },
  'maintenance_report_review.fk_maintenance_report_review_version': {
    referenceTable: 'maintenance_report_version',
    localColumns: ['version_id', 'report_id'],
    referenceColumns: ['id', 'report_id'],
  },
  'maintenance_report_review.fk_maintenance_report_review_reviewer': {
    referenceTable: 'base_user_account',
    localColumns: ['reviewed_by_account_id'],
    referenceColumns: ['id'],
  },
  'local_installation.fk_local_installation_organization': {
    referenceTable: 'organization',
    localColumns: ['organization_id'],
    referenceColumns: ['id'],
  },
  'local_upload_task.fk_local_upload_task_installation': {
    referenceTable: 'local_installation',
    localColumns: ['installation_id'],
    referenceColumns: ['installation_id'],
  },
  'local_backup_run.fk_local_backup_run_installation': {
    referenceTable: 'local_installation',
    localColumns: ['installation_id'],
    referenceColumns: ['installation_id'],
  },
  'engineer_registration_application.fk_engineer_registration_application_account': {
    referenceTable: 'base_user_account',
    localColumns: ['account_id'],
    referenceColumns: ['id'],
  },
  'engineer_registration_application.fk_engineer_registration_application_organization': {
    referenceTable: 'organization',
    localColumns: ['organization_id'],
    referenceColumns: ['id'],
  },
  'engineer_registration_application.fk_engineer_registration_application_reviewer': {
    referenceTable: 'base_user_account',
    localColumns: ['reviewed_by_account_id'],
    referenceColumns: ['id'],
  },
};

export type PrefixStructureKind = 'table' | 'index' | 'column' | 'check' | 'foreign_key';
/* eslint-enable @typescript-eslint/naming-convention */

/**
 * 已执行前缀应具备的一项关键结构。
 * since 为该结构所属迁移的时间戳，只有该迁移已执行时才要求存在。
 * 索引必须带完整有序列与唯一性，外键必须带本地列/引用表/引用列映射，
 * 避免只比较名称而漏掉同名列序被改写的漂移。
 */
interface PrefixStructureBase {
  readonly table: string;
  readonly name: string;
  readonly since: number;
}

export interface PrefixTableRequirement extends PrefixStructureBase {
  readonly kind: 'table';
}

export interface PrefixIndexRequirement extends PrefixStructureBase {
  readonly kind: 'index';
  readonly unique: boolean;
  readonly columns: ReadonlyArray<string>;
}

export interface PrefixColumnRequirement extends PrefixStructureBase {
  readonly kind: 'column';
  readonly notNull?: boolean;
}

export interface PrefixCheckRequirement extends PrefixStructureBase {
  readonly kind: 'check';
}

export interface PrefixForeignKeyRequirement extends PrefixStructureBase {
  readonly kind: 'foreign_key';
  readonly referenceTable: string;
  readonly localColumns: ReadonlyArray<string>;
  readonly referenceColumns: ReadonlyArray<string>;
}

export type PrefixStructureRequirement =
  | PrefixTableRequirement
  | PrefixIndexRequirement
  | PrefixColumnRequirement
  | PrefixCheckRequirement
  | PrefixForeignKeyRequirement;

/**
 * 读取并强校验索引列定义；缺失/空列/重复列/非法唯一性均属契约缺陷。
 */
function requireIndexDefinition(key: string): IndexDefinition {
  const definition = INDEX_DEFINITIONS[key];
  if (!definition) {
    throw new Error(`关键索引未登记列定义: ${key}`);
  }
  if (typeof definition.unique !== 'boolean') {
    throw new Error(`关键索引未登记唯一性: ${key}`);
  }
  assertOrderedColumns(definition.columns, `关键索引 ${key}`);
  return definition;
}

/**
 * 读取并强校验外键列映射；缺失/空列/长度不匹配均属契约缺陷。
 */
function requireForeignKeyDefinition(key: string): ForeignKeyDefinition {
  const definition = FOREIGN_KEY_DEFINITIONS[key];
  if (!definition) {
    throw new Error(`关键外键未登记列映射: ${key}`);
  }
  if (typeof definition.referenceTable !== 'string' || definition.referenceTable.length === 0) {
    throw new Error(`关键外键未登记引用表: ${key}`);
  }
  assertOrderedColumns(definition.localColumns, `关键外键 ${key} 本地列`);
  assertOrderedColumns(definition.referenceColumns, `关键外键 ${key} 引用列`);
  if (definition.localColumns.length !== definition.referenceColumns.length) {
    throw new Error(
      `关键外键列数量不匹配: ${key} 本地 ${definition.localColumns.length}，引用 ${definition.referenceColumns.length}`,
    );
  }
  return definition;
}

/**
 * 校验有序列数组非空、元素有效且不重复。
 */
function assertOrderedColumns(columns: ReadonlyArray<string>, label: string): void {
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new Error(`${label} 的列数组为空`);
  }
  for (const column of columns) {
    if (typeof column !== 'string' || column.length === 0) {
      throw new Error(`${label} 存在无效列名`);
    }
  }
  if (new Set(columns).size !== columns.length) {
    throw new Error(`${label} 的列数组存在重复列`);
  }
}

/**
 * 校验契约内的关键索引/外键定义完整且自洽。
 * 默认校验全部登记项；测试可传入子集以验证缺失定义必须失败。
 */
export function assertStructureDefinitionsComplete(
  indexes: ReadonlyArray<{ table: string; index: string }> = REQUIRED_INDEXES,
  foreignKeys: ReadonlyArray<{
    table: string;
    constraint: string;
    referencedTable: string;
  }> = REQUIRED_FOREIGN_KEYS,
): void {
  for (const item of indexes) {
    requireIndexDefinition(`${item.table}.${item.index}`);
  }
  for (const item of foreignKeys) {
    const key = `${item.table}.${item.constraint}`;
    const definition = requireForeignKeyDefinition(key);
    if (definition.referenceTable !== item.referencedTable) {
      throw new Error(
        `关键外键引用表不一致: ${key} 登记 ${item.referencedTable}，列映射 ${definition.referenceTable}`,
      );
    }
  }
}

/**
 * 读取登记时间戳；缺少登记属契约缺陷，必须显式停止而不是静默跳过。
 */
function requireOwner(
  ownerMap: Readonly<Record<string, number>>,
  key: string,
  kind: PrefixStructureKind,
): number {
  const since = ownerMap[key];
  if (typeof since !== 'number') {
    throw new Error(`关键结构未登记所属迁移: ${kind} ${key}`);
  }
  return since;
}

/**
 * 按已执行迁移集合生成“应已存在”的关键结构清单。
 * 未执行的迁移所创建的对象不提前要求，避免误伤合法中间前缀。
 */
export function collectPrefixStructureRequirements(
  executedTimestamps: ReadonlySet<number>,
): ReadonlyArray<PrefixStructureRequirement> {
  assertStructureDefinitionsComplete();
  const requirements: PrefixStructureRequirement[] = [];
  const add = (requirement: PrefixStructureRequirement): void => {
    if (executedTimestamps.has(requirement.since)) {
      requirements.push(requirement);
    }
  };

  for (const table of REQUIRED_TABLES) {
    add({
      kind: 'table',
      table,
      name: table,
      since: requireOwner(TABLE_CREATED_BY, table, 'table'),
    });
  }

  for (const item of REQUIRED_INDEXES) {
    const key = `${item.table}.${item.index}`;
    const definition = requireIndexDefinition(key);
    add({
      kind: 'index',
      table: item.table,
      name: item.index,
      since: requireOwner(INDEX_CREATED_BY, key, 'index'),
      unique: definition.unique,
      columns: definition.columns,
    });
  }

  for (const item of REQUIRED_COLUMNS) {
    const key = `${item.table}.${item.column}`;
    add({
      kind: 'column',
      table: item.table,
      name: item.column,
      since: requireOwner(COLUMN_CREATED_BY, key, 'column'),
      notNull: item.notNull,
    });
  }

  for (const item of REQUIRED_CHECKS) {
    const key = `${item.table}.${item.constraint}`;
    add({
      kind: 'check',
      table: item.table,
      name: item.constraint,
      since: requireOwner(CHECK_CREATED_BY, key, 'check'),
    });
  }

  for (const item of REQUIRED_FOREIGN_KEYS) {
    const key = `${item.table}.${item.constraint}`;
    const definition = requireForeignKeyDefinition(key);
    add({
      kind: 'foreign_key',
      table: item.table,
      name: item.constraint,
      since: requireOwner(FOREIGN_KEY_CREATED_BY, key, 'foreign_key'),
      referenceTable: definition.referenceTable,
      localColumns: definition.localColumns,
      referenceColumns: definition.referenceColumns,
    });
  }

  return requirements;
}

/**
 * 全部关键结构清单，供最终校验使用（不区分迁移是否已执行）。
 */
export function collectAllStructureRequirements(): ReadonlyArray<PrefixStructureRequirement> {
  return collectPrefixStructureRequirements(
    new Set<number>([
      ...Object.values(TABLE_CREATED_BY),
      ...Object.values(INDEX_CREATED_BY),
      ...Object.values(COLUMN_CREATED_BY),
      ...Object.values(CHECK_CREATED_BY),
      ...Object.values(FOREIGN_KEY_CREATED_BY),
    ]),
  );
}

/**
 * 判断查询结果是否为数组结构。
 */
export function isQueryRows(value: unknown): value is ReadonlyArray<Record<string, unknown>> {
  return Array.isArray(value);
}

/**
 * 执行存在性查询并返回结果。
 */
export async function hasQueryResult(
  dataSource: DataSource,
  query: string,
  params: Array<string | number>,
): Promise<boolean> {
  const rows: unknown = await dataSource.query(query, params);
  if (!isQueryRows(rows)) {
    throw new Error('查询返回格式异常，预期为数组');
  }
  return rows.length > 0;
}

/**
 * 校验关键表是否存在。
 */
export async function assertRequiredTables(
  dataSource: DataSource,
  databaseName: string,
): Promise<void> {
  for (const tableName of REQUIRED_TABLES) {
    const exists = await hasQueryResult(
      dataSource,
      `
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = ?
          AND table_name = ?
        LIMIT 1
      `,
      [databaseName, tableName],
    );

    if (!exists) {
      throw new Error(`关键表缺失: ${tableName}`);
    }
  }
}

/**
 * 校验关键索引是否存在。
 */
export async function assertRequiredIndexes(
  dataSource: DataSource,
  databaseName: string,
): Promise<void> {
  for (const item of REQUIRED_INDEXES) {
    const exists = await hasQueryResult(
      dataSource,
      `
        SELECT 1
        FROM information_schema.statistics
        WHERE table_schema = ?
          AND table_name = ?
          AND index_name = ?
        LIMIT 1
      `,
      [databaseName, item.table, item.index],
    );

    if (!exists) {
      throw new Error(`关键索引缺失: ${item.table}.${item.index}`);
    }
  }
}

/**
 * 校验关键字段存在，并防止已废弃字段回归。
 */
export async function assertRequiredColumns(
  dataSource: DataSource,
  databaseName: string,
): Promise<void> {
  for (const item of REQUIRED_COLUMNS) {
    const rows: unknown = await dataSource.query(
      `
        SELECT is_nullable
        FROM information_schema.columns
        WHERE table_schema = ?
          AND table_name = ?
          AND column_name = ?
        LIMIT 1
      `,
      [databaseName, item.table, item.column],
    );

    if (!isQueryRows(rows) || rows.length === 0) {
      throw new Error(`关键字段缺失: ${item.table}.${item.column}`);
    }

    if (item.notNull) {
      // is_nullable 必须确为字符串才继续规范化；非字符串属查询结果异常，
      // 失败关闭而不是用 String() 折叠成 "[object Object]" 掩盖问题。
      const rawNullable = rows[0]['is_nullable'] ?? rows[0]['IS_NULLABLE'];
      if (typeof rawNullable !== 'string') {
        throw new Error(`关键字段 is_nullable 查询结果格式无效: ${item.table}.${item.column}`);
      }
      const isNullable = rawNullable.trim().toUpperCase();
      if (isNullable !== 'NO') {
        throw new Error(`关键字段允许 NULL，未完成收紧: ${item.table}.${item.column}`);
      }
    }
  }

  for (const item of FORBIDDEN_COLUMNS) {
    const exists = await hasQueryResult(
      dataSource,
      `
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = ?
          AND table_name = ?
          AND column_name = ?
        LIMIT 1
      `,
      [databaseName, item.table, item.column],
    );

    if (exists) {
      throw new Error(`已废弃字段仍存在: ${item.table}.${item.column}`);
    }
  }
}

/**
 * 校验关键 CHECK 约束存在。
 */
export async function assertRequiredChecks(
  dataSource: DataSource,
  databaseName: string,
): Promise<void> {
  for (const item of REQUIRED_CHECKS) {
    const exists = await hasQueryResult(
      dataSource,
      `
        SELECT 1
        FROM information_schema.table_constraints
        WHERE constraint_schema = ?
          AND table_name = ?
          AND constraint_name = ?
          AND constraint_type = 'CHECK'
        LIMIT 1
      `,
      [databaseName, item.table, item.constraint],
    );

    if (!exists) {
      throw new Error(`关键 CHECK 约束缺失: ${item.table}.${item.constraint}`);
    }
  }
}

/**
 * 校验关键外键是否存在。
 */
export async function assertRequiredForeignKeys(
  dataSource: DataSource,
  databaseName: string,
): Promise<void> {
  for (const item of REQUIRED_FOREIGN_KEYS) {
    const exists = await hasQueryResult(
      dataSource,
      `
        SELECT 1
        FROM information_schema.referential_constraints
        WHERE constraint_schema = ?
          AND table_name = ?
          AND constraint_name = ?
          AND referenced_table_name = ?
        LIMIT 1
      `,
      [databaseName, item.table, item.constraint, item.referencedTable],
    );

    if (!exists) {
      throw new Error(`关键外键缺失: ${item.table}.${item.constraint} -> ${item.referencedTable}`);
    }
  }
}

/**
 * 提取迁移类名，用于比对已执行迁移记录。
 */
export function resolveMigrationName(migration: unknown): string {
  const candidate = (migration as { name?: unknown }).name;
  if (typeof candidate === 'string' && candidate.length > 0) {
    return candidate;
  }
  throw new Error('迁移项缺少可识别的名称，无法进行升级演练校验');
}

/**
 * 解析迁移时间戳（类名末尾 13 位数字），与 TypeORM 的排序口径一致。
 */
export function resolveMigrationTimestamp(migration: unknown): number {
  const name = resolveMigrationName(migration);
  const timestamp = Number.parseInt(name.slice(-13), 10);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`无法从迁移名解析时间戳: ${name}`);
  }
  return timestamp;
}

/**
 * 将 dataSource 上的迁移实例还原为按时间戳升序的迁移类。
 */
export function toMigrationClasses(
  instances: ReadonlyArray<unknown>,
): ReadonlyArray<new () => unknown> {
  return [...instances]
    .sort((a, b) => resolveMigrationTimestamp(a) - resolveMigrationTimestamp(b))
    .map((migration) => (migration as { constructor: new () => unknown }).constructor);
}
