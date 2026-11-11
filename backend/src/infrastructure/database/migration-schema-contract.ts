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
  'stored_file',
  'repair_request_intake',
  'intake_analysis_attempt',
  'repair_process_entry',
  'ai_message_analysis',
  'maintenance_report_fault',
  'repair_request_revision',
  'reference_document_revision',
  'local_account_authorization',
  'local_company_setting',
  'sync_receipt',
  'sync_conflict',
  'record_package_import',
  'record_package_item',
  'backup_asset',
  'backup_restore_run',
  'management_audit_event',
] as const;

export const REQUIRED_INDEXES: ReadonlyArray<{ table: string; index: string }> = [
  { table: 'base_user_account', index: 'uk_login_email' },
  { table: 'base_user_account', index: 'uk_login_name' },
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
  { table: 'local_upload_task', index: 'idx_local_upload_task_record_uuid' },
  { table: 'local_backup_run', index: 'uk_local_backup_run_active_company' },
  { table: 'local_backup_run', index: 'idx_local_backup_run_started' },
  { table: 'local_backup_run', index: 'idx_local_backup_run_organization' },
  { table: 'base_user_info', index: 'idx_base_user_info_customer_organization' },
  { table: 'repair_request', index: 'uk_repair_request_intake' },
  { table: 'repair_request', index: 'idx_repair_request_customer_organization' },
  { table: 'repair_request', index: 'idx_repair_request_service_organization' },
  { table: 'ai_message', index: 'uk_ai_message_question_uuid' },
  { table: 'ai_conversation', index: 'idx_ai_conversation_owner_created' },
  { table: 'maintenance_report', index: 'uk_maintenance_report_submission' },
  { table: 'reference_document', index: 'uk_reference_document_source_report_version' },
  { table: 'stored_file', index: 'uk_stored_file_upload_context' },
  { table: 'stored_file', index: 'idx_stored_file_business' },
  { table: 'stored_file', index: 'idx_stored_file_owner_created' },
  { table: 'stored_file', index: 'idx_stored_file_status_created' },
  { table: 'repair_request_intake', index: 'uk_repair_request_intake_record_uuid' },
  { table: 'repair_request_intake', index: 'uk_repair_request_intake_converted' },
  { table: 'repair_request_intake', index: 'idx_repair_request_intake_customer_created' },
  { table: 'repair_request_intake', index: 'idx_repair_request_intake_organization_status' },
  { table: 'intake_analysis_attempt', index: 'uk_intake_analysis_attempt_generation' },
  { table: 'repair_process_entry', index: 'uk_repair_process_entry_uuid' },
  { table: 'repair_process_entry', index: 'idx_repair_process_entry_request_created' },
  { table: 'ai_message_analysis', index: 'uk_ai_message_analysis_question' },
  { table: 'ai_message_analysis', index: 'idx_ai_message_analysis_conversation_status' },
  { table: 'maintenance_report_fault', index: 'uk_maintenance_report_fault_uuid' },
  { table: 'maintenance_report_fault', index: 'idx_maintenance_report_fault_report' },
  { table: 'repair_request_revision', index: 'uk_repair_request_revision_no' },
  { table: 'reference_document_revision', index: 'uk_reference_document_revision_no' },
  { table: 'local_account_authorization', index: 'uk_local_account_authorization_scope' },
  { table: 'local_account_authorization', index: 'idx_local_account_authorization_account' },
  { table: 'local_company_setting', index: 'uk_local_company_setting_scope' },
  { table: 'sync_receipt', index: 'uk_sync_receipt_scope_v13' },
  { table: 'sync_receipt', index: 'idx_sync_receipt_organization_status' },
  { table: 'sync_conflict', index: 'uk_sync_conflict_scope' },
  { table: 'sync_conflict', index: 'idx_sync_conflict_organization_status' },
  { table: 'record_package_import', index: 'idx_record_package_import_organization' },
  { table: 'record_package_item', index: 'uk_record_package_item_scope' },
  { table: 'backup_asset', index: 'idx_backup_asset_organization_status' },
  { table: 'backup_asset', index: 'idx_backup_asset_installation' },
  { table: 'backup_restore_run', index: 'idx_backup_restore_run_organization' },
  { table: 'management_audit_event', index: 'idx_management_audit_actor' },
  { table: 'management_audit_event', index: 'idx_management_audit_organization' },
  { table: 'management_audit_event', index: 'idx_management_audit_target' },
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
  { table: 'reference_document', column: 'owner_organization_id' },
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
  { table: 'base_user_account', column: 'admin_level' },
  { table: 'base_user_account', column: 'must_change_password', notNull: true },
  { table: 'base_user_info', column: 'real_name' },
  { table: 'base_user_info', column: 'customer_organization_id' },
  { table: 'organization', column: 'short_name' },
  { table: 'organization', column: 'contact_name' },
  { table: 'organization', column: 'contact_phone' },
  { table: 'organization', column: 'contact_email' },
  { table: 'organization', column: 'address' },
  { table: 'organization', column: 'remark' },
  { table: 'organization', column: 'is_service_provider', notNull: true },
  { table: 'organization', column: 'is_managed_company', notNull: true },
  { table: 'repair_request', column: 'intake_id' },
  { table: 'repair_request', column: 'customer_organization_id' },
  { table: 'repair_request', column: 'service_organization_id' },
  { table: 'repair_request', column: 'closure_status' },
  { table: 'repair_request', column: 'closed_at' },
  { table: 'repair_request', column: 'closure_reason' },
  { table: 'repair_request', column: 'current_revision_no', notNull: true },
  { table: 'ai_conversation', column: 'owner_organization_id' },
  { table: 'ai_conversation', column: 'content_version', notNull: true },
  { table: 'ai_message', column: 'question_uuid' },
  { table: 'ai_message', column: 'content_version', notNull: true },
  { table: 'maintenance_report_step', column: 'error_code' },
  { table: 'maintenance_report_step', column: 'result_code' },
  { table: 'maintenance_report', column: 'supplementary_note' },
  { table: 'maintenance_report', column: 'handling_result' },
  { table: 'maintenance_report', column: 'closure_reason' },
  { table: 'maintenance_report', column: 'reset_result' },
  { table: 'maintenance_report', column: 'actual_cause' },
  { table: 'maintenance_report', column: 'repair_actions' },
  { table: 'maintenance_report', column: 'verification_result' },
  { table: 'maintenance_report', column: 'submission_request_id' },
  { table: 'maintenance_report', column: 'submission_payload_hash' },
  { table: 'reference_document', column: 'publication_status', notNull: true },
  { table: 'reference_document', column: 'ownership_status', notNull: true },
  { table: 'reference_document', column: 'current_revision_no', notNull: true },
  { table: 'reference_document', column: 'source_kind', notNull: true },
  { table: 'reference_document', column: 'source_report_id' },
  { table: 'reference_document', column: 'source_report_version_id' },
  { table: 'local_upload_task', column: 'record_uuid' },
  { table: 'local_upload_task', column: 'source_version' },
  { table: 'local_upload_task', column: 'task_kind' },
  { table: 'local_upload_task', column: 'manifest_checksum' },
  { table: 'local_backup_run', column: 'organization_id' },
  { table: 'local_backup_run', column: 'manual_upload_status' },
  { table: 'local_backup_run', column: 'manual_cleanup_status' },
  { table: 'stored_file', column: 'file_id', notNull: true },
  { table: 'stored_file', column: 'status', notNull: true },
  { table: 'stored_file', column: 'binding_status', notNull: true },
  { table: 'stored_file', column: 'checksum_sha256', notNull: true },
  { table: 'repair_request_intake', column: 'record_uuid', notNull: true },
  { table: 'repair_request_intake', column: 'analysis_status', notNull: true },
  { table: 'repair_request_intake', column: 'converted_request_id' },
  { table: 'intake_analysis_attempt', column: 'status', notNull: true },
  { table: 'intake_analysis_attempt', column: 'failure_reason' },
  { table: 'repair_process_entry', column: 'entry_uuid', notNull: true },
  { table: 'repair_process_entry', column: 'version_no', notNull: true },
  { table: 'ai_message_analysis', column: 'question_uuid', notNull: true },
  { table: 'ai_message_analysis', column: 'status', notNull: true },
  { table: 'maintenance_report_fault', column: 'fault_uuid', notNull: true },
  { table: 'maintenance_report_fault', column: 'branch_kind', notNull: true },
  { table: 'repair_request_revision', column: 'revision_no', notNull: true },
  { table: 'repair_request_revision', column: 'previous_version' },
  { table: 'repair_request_revision', column: 'schema_version', notNull: true },
  { table: 'reference_document_revision', column: 'revision_no', notNull: true },
  { table: 'local_account_authorization', column: 'authorization_status', notNull: true },
  { table: 'local_company_setting', column: 'setting_source', notNull: true },
  { table: 'local_company_setting', column: 'is_current', notNull: true },
  { table: 'sync_receipt', column: 'receipt_status', notNull: true },
  { table: 'sync_receipt', column: 'manifest_checksum', notNull: true },
  { table: 'sync_conflict', column: 'status', notNull: true },
  { table: 'record_package_import', column: 'status', notNull: true },
  { table: 'record_package_import', column: 'check_status' },
  { table: 'record_package_import', column: 'manifest_checksum', notNull: true },
  { table: 'record_package_item', column: 'check_result' },
  { table: 'record_package_item', column: 'result' },
  { table: 'backup_asset', column: 'cloud_status', notNull: true },
  { table: 'backup_asset', column: 'local_status', notNull: true },
  { table: 'backup_restore_run', column: 'status', notNull: true },
  { table: 'management_audit_event', column: 'actor_admin_level', notNull: true },
  { table: 'management_audit_event', column: 'result', notNull: true },
  // S5（1775501900000）：历史工单身份
  { table: 'repair_request', column: 'is_historical', notNull: true },
  // S5：公司备份计划、调度时间与自动上传开关
  { table: 'local_company_setting', column: 'initialized_at', notNull: true },
  { table: 'local_company_setting', column: 'backup_interval_hours', notNull: true },
  { table: 'local_company_setting', column: 'backup_enabled', notNull: true },
  { table: 'local_company_setting', column: 'next_backup_at' },
  { table: 'local_company_setting', column: 'last_auto_success_at' },
  { table: 'local_company_setting', column: 'last_auto_failure_at' },
  { table: 'local_company_setting', column: 'failure_reason' },
  { table: 'local_company_setting', column: 'auto_upload_enabled', notNull: true },
  // S5：离线资格签名事实
  { table: 'local_account_authorization', column: 'signed_claims' },
  { table: 'local_account_authorization', column: 'permission_version' },
  { table: 'local_account_authorization', column: 'last_verified_at' },
  // S5：同步来源与四列唯一键
  { table: 'sync_receipt', column: 'source_installation_id' },
  { table: 'sync_receipt', column: 'remote_resource_id' },
  { table: 'sync_receipt', column: 'received_at' },
  // S5：备份本地/云端引用、版本、校验、保留与清理
  // 这些事实列对历史行保持 NULL（历史未知），新流程由应用层必填校验。
  { table: 'backup_asset', column: 'installation_id' },
  { table: 'backup_asset', column: 'format_version' },
  { table: 'backup_asset', column: 'data_version' },
  { table: 'backup_asset', column: 'manifest_checksum' },
  { table: 'backup_asset', column: 'local_reference' },
  { table: 'backup_asset', column: 'cloud_reference' },
  { table: 'backup_asset', column: 'encryption_key_id' },
  { table: 'backup_asset', column: 'verified_at' },
  { table: 'backup_asset', column: 'retention_until' },
  { table: 'backup_asset', column: 'failure_reason' },
  { table: 'backup_asset', column: 'deleted_at' },
  { table: 'backup_asset', column: 'local_cleanup_error' },
  // S5：恢复预检/执行事实（历史未知为 NULL，新流程执行阶段由应用层保证完整性）
  { table: 'backup_restore_run', column: 'target_installation_id' },
  { table: 'backup_restore_run', column: 'check_status' },
  { table: 'backup_restore_run', column: 'confirmation' },
  // S5：故障原始八字段、phase_code 与生命周期分离
  { table: 'maintenance_report_fault', column: 'main_error' },
  { table: 'maintenance_report_fault', column: 'unit_error' },
  { table: 'maintenance_report_fault', column: 'error_type' },
  { table: 'maintenance_report_fault', column: 'gpib_status' },
  { table: 'maintenance_report_fault', column: 'status' },
  { table: 'maintenance_report_fault', column: 'source' },
  { table: 'maintenance_report_fault', column: 'phase_code' },
  { table: 'maintenance_report_fault', column: 'is_active' },
  { table: 'maintenance_report_fault', column: 'lifecycle_status', notNull: true },
  { table: 'maintenance_report_fault', column: 'lifecycle_source', notNull: true },
  // D3（1775502000000）：同步冲突本地/云端/已展示版本与选择事实
  // 旧行保持 NULL（历史未知），新流程由应用层保证完整性。
  { table: 'sync_conflict', column: 'local_version' },
  { table: 'sync_conflict', column: 'cloud_version' },
  { table: 'sync_conflict', column: 'displayed_cloud_version' },
  { table: 'sync_conflict', column: 'decision' },
  // V13 本期交付（1775501000000—1775502100000）：新增/调整字段全量登记
  { table: 'ai_conversation', column: 'request_id' },
  { table: 'ai_message_analysis', column: 'answer_message_id' },
  { table: 'ai_message_analysis', column: 'completed_at' },
  { table: 'ai_message_analysis', column: 'content_version', notNull: true },
  { table: 'ai_message_analysis', column: 'conversation_id', notNull: true },
  { table: 'ai_message_analysis', column: 'failure_reason' },
  { table: 'ai_message_analysis', column: 'question_message_id', notNull: true },
  { table: 'ai_message_analysis', column: 'saved_at', notNull: true },
  { table: 'backup_asset', column: 'attempt_count', notNull: true },
  { table: 'backup_asset', column: 'backup_id', notNull: true },
  { table: 'backup_asset', column: 'byte_size', notNull: true },
  { table: 'backup_asset', column: 'cloud_receipt' },
  { table: 'backup_asset', column: 'created_at', notNull: true },
  { table: 'backup_asset', column: 'file_sha256', notNull: true },
  { table: 'backup_asset', column: 'last_attempt_at' },
  { table: 'backup_asset', column: 'local_cleanup_run_id' },
  { table: 'backup_asset', column: 'organization_id', notNull: true },
  { table: 'backup_asset', column: 'run_id', notNull: true },
  { table: 'backup_asset', column: 'storage_reference', notNull: true },
  { table: 'backup_asset', column: 'updated_at', notNull: true },
  { table: 'backup_restore_run', column: 'backup_id', notNull: true },
  { table: 'backup_restore_run', column: 'check_snapshot', notNull: true },
  { table: 'backup_restore_run', column: 'finished_at' },
  { table: 'backup_restore_run', column: 'organization_id', notNull: true },
  { table: 'backup_restore_run', column: 'protection_backup_id' },
  { table: 'backup_restore_run', column: 'restore_id', notNull: true },
  { table: 'backup_restore_run', column: 'restored_scope' },
  { table: 'backup_restore_run', column: 'result_summary' },
  { table: 'backup_restore_run', column: 'started_at' },
  { table: 'backup_restore_run', column: 'started_by_account_id', notNull: true },
  { table: 'intake_analysis_attempt', column: 'finished_at' },
  { table: 'intake_analysis_attempt', column: 'generation_no', notNull: true },
  { table: 'intake_analysis_attempt', column: 'id', notNull: true },
  { table: 'intake_analysis_attempt', column: 'intake_id', notNull: true },
  { table: 'intake_analysis_attempt', column: 'output_text' },
  { table: 'intake_analysis_attempt', column: 'provider_call_id' },
  { table: 'intake_analysis_attempt', column: 'started_at' },
  { table: 'local_account_authorization', column: 'account_id', notNull: true },
  { table: 'local_account_authorization', column: 'authorized_at', notNull: true },
  { table: 'local_account_authorization', column: 'created_at', notNull: true },
  { table: 'local_account_authorization', column: 'id', notNull: true },
  { table: 'local_account_authorization', column: 'installation_id', notNull: true },
  { table: 'local_account_authorization', column: 'organization_id', notNull: true },
  { table: 'local_account_authorization', column: 'revoked_at' },
  { table: 'local_company_setting', column: 'created_at', notNull: true },
  { table: 'local_company_setting', column: 'id', notNull: true },
  { table: 'local_company_setting', column: 'installation_id', notNull: true },
  { table: 'local_company_setting', column: 'organization_id', notNull: true },
  { table: 'local_company_setting', column: 'updated_at', notNull: true },
  { table: 'maintenance_report_fault', column: 'created_at', notNull: true },
  { table: 'maintenance_report_fault', column: 'fault_cause' },
  { table: 'maintenance_report_fault', column: 'fault_description', notNull: true },
  { table: 'maintenance_report_fault', column: 'handling_action' },
  { table: 'maintenance_report_fault', column: 'id', notNull: true },
  { table: 'maintenance_report_fault', column: 'panel_snapshot' },
  { table: 'maintenance_report_fault', column: 'report_id', notNull: true },
  { table: 'maintenance_report_fault', column: 'step_code' },
  { table: 'maintenance_report_step', column: 'action_text', notNull: true },
  { table: 'maintenance_report_step', column: 'part_name' },
  { table: 'maintenance_report', column: 'customer_factory_name' },
  { table: 'maintenance_report', column: 'equipment_model_text' },
  { table: 'maintenance_report', column: 'maintenance_engineer_name_snapshot', notNull: true },
  { table: 'management_audit_event', column: 'actor_account_id', notNull: true },
  { table: 'management_audit_event', column: 'created_at', notNull: true },
  { table: 'management_audit_event', column: 'detail' },
  { table: 'management_audit_event', column: 'event_id', notNull: true },
  { table: 'management_audit_event', column: 'operation', notNull: true },
  { table: 'management_audit_event', column: 'organization_id' },
  { table: 'management_audit_event', column: 'target_id', notNull: true },
  { table: 'management_audit_event', column: 'target_type', notNull: true },
  { table: 'organization', column: 'name', notNull: true },
  { table: 'record_package_import', column: 'completed_at' },
  { table: 'record_package_import', column: 'created_at', notNull: true },
  { table: 'record_package_import', column: 'imported_by_account_id', notNull: true },
  { table: 'record_package_import', column: 'item_failed', notNull: true },
  { table: 'record_package_import', column: 'item_succeeded', notNull: true },
  { table: 'record_package_import', column: 'item_total', notNull: true },
  { table: 'record_package_import', column: 'manifest_json', notNull: true },
  { table: 'record_package_import', column: 'organization_id', notNull: true },
  { table: 'record_package_import', column: 'package_id', notNull: true },
  { table: 'record_package_item', column: 'created_at', notNull: true },
  { table: 'record_package_item', column: 'error_message' },
  { table: 'record_package_item', column: 'id', notNull: true },
  { table: 'record_package_item', column: 'package_id', notNull: true },
  { table: 'record_package_item', column: 'receipt_id' },
  { table: 'record_package_item', column: 'record_uuid', notNull: true },
  { table: 'record_package_item', column: 'resource_type', notNull: true },
  { table: 'record_package_item', column: 'version_no', notNull: true },
  { table: 'reference_document_revision', column: 'actor_account_id', notNull: true },
  { table: 'reference_document_revision', column: 'after_snapshot', notNull: true },
  { table: 'reference_document_revision', column: 'before_snapshot', notNull: true },
  { table: 'reference_document_revision', column: 'created_at', notNull: true },
  { table: 'reference_document_revision', column: 'document_id', notNull: true },
  { table: 'reference_document_revision', column: 'id', notNull: true },
  { table: 'reference_document_revision', column: 'reason', notNull: true },
  { table: 'repair_process_entry', column: 'author_account_id', notNull: true },
  { table: 'repair_process_entry', column: 'created_at', notNull: true },
  { table: 'repair_process_entry', column: 'file_id' },
  { table: 'repair_process_entry', column: 'id', notNull: true },
  { table: 'repair_process_entry', column: 'occurred_at' },
  { table: 'repair_process_entry', column: 'operation_text', notNull: true },
  { table: 'repair_process_entry', column: 'request_id', notNull: true },
  { table: 'repair_process_entry', column: 'test_result' },
  { table: 'repair_process_entry', column: 'time_source', notNull: true },
  { table: 'repair_request_intake', column: 'analysis_generation', notNull: true },
  { table: 'repair_request_intake', column: 'created_at', notNull: true },
  { table: 'repair_request_intake', column: 'customer_account_id', notNull: true },
  { table: 'repair_request_intake', column: 'customer_organization_id', notNull: true },
  { table: 'repair_request_intake', column: 'deleted_at' },
  { table: 'repair_request_intake', column: 'equipment_model_id', notNull: true },
  { table: 'repair_request_intake', column: 'error_code', notNull: true },
  { table: 'repair_request_intake', column: 'fault_description', notNull: true },
  { table: 'repair_request_intake', column: 'file_id' },
  { table: 'repair_request_intake', column: 'id', notNull: true },
  { table: 'repair_request_intake', column: 'service_organization_id', notNull: true },
  { table: 'repair_request_revision', column: 'actor_account_id', notNull: true },
  { table: 'repair_request_revision', column: 'after_snapshot', notNull: true },
  { table: 'repair_request_revision', column: 'before_snapshot', notNull: true },
  { table: 'repair_request_revision', column: 'created_at', notNull: true },
  { table: 'repair_request_revision', column: 'id', notNull: true },
  { table: 'repair_request_revision', column: 'reason', notNull: true },
  { table: 'repair_request_revision', column: 'request_id', notNull: true },
  { table: 'stored_file', column: 'business_id' },
  { table: 'stored_file', column: 'business_type', notNull: true },
  { table: 'stored_file', column: 'byte_size', notNull: true },
  { table: 'stored_file', column: 'created_at', notNull: true },
  { table: 'stored_file', column: 'mime_type', notNull: true },
  { table: 'stored_file', column: 'original_filename', notNull: true },
  { table: 'stored_file', column: 'owner_organization_id', notNull: true },
  { table: 'stored_file', column: 'storage_reference', notNull: true },
  { table: 'stored_file', column: 'upload_context_id', notNull: true },
  { table: 'stored_file', column: 'uploaded_by_account_id', notNull: true },
  { table: 'stored_file', column: 'verified_at' },
  { table: 'sync_conflict', column: 'cloud_snapshot', notNull: true },
  { table: 'sync_conflict', column: 'confirmed_at' },
  { table: 'sync_conflict', column: 'confirmed_by_account_id' },
  { table: 'sync_conflict', column: 'conflict_id', notNull: true },
  { table: 'sync_conflict', column: 'conflict_reason', notNull: true },
  { table: 'sync_conflict', column: 'created_at', notNull: true },
  { table: 'sync_conflict', column: 'local_snapshot', notNull: true },
  { table: 'sync_conflict', column: 'organization_id', notNull: true },
  { table: 'sync_conflict', column: 'record_uuid', notNull: true },
  { table: 'sync_conflict', column: 'resource_type', notNull: true },
  { table: 'sync_conflict', column: 'version_no', notNull: true },
  { table: 'sync_receipt', column: 'confirmed_at' },
  { table: 'sync_receipt', column: 'created_at', notNull: true },
  { table: 'sync_receipt', column: 'organization_id', notNull: true },
  { table: 'sync_receipt', column: 'receipt_id', notNull: true },
  { table: 'sync_receipt', column: 'record_uuid', notNull: true },
  { table: 'sync_receipt', column: 'resource_type', notNull: true },
  { table: 'sync_receipt', column: 'source_system', notNull: true },
  { table: 'sync_receipt', column: 'version_no', notNull: true },
];

export const FORBIDDEN_COLUMNS: ReadonlyArray<{ table: string; column: string }> = [
  { table: 'ai_conversation', column: 'content_md' },
];

/**
 * 必须由数据库计算的生成列。
 *
 * 精确表达式文本由 MySQL 版本归一化（大小写、反引号、字符集引导符各不相同），
 * 校验先按 CHECK 口径归一化再逐字比较 GENERATED_COLUMN_DEFINITIONS；
 * 列的具体类型与唯一性仍由 REQUIRED_COLUMNS / REQUIRED_INDEXES 覆盖。
 */
export const REQUIRED_GENERATED_COLUMNS: ReadonlyArray<{
  table: string;
  column: string;
}> = [
  { table: 'organization_membership', column: 'active_account_id' },
  { table: 'maintenance_report_attachment', column: 'active_sort_order' },
  { table: 'local_backup_run', column: 'active_installation_id' },
  { table: 'engineer_registration_application', column: 'pending_account_id' },
];

/**
 * 生成列精确表达式契约：expression 使用与建表迁移一致的文本；
 * stored 记录存储方式（STORED/VIRTUAL）。
 * 校验时按 CHECK 口径归一化后逐字比较表达式，并比对存储方式。
 */
export const GENERATED_COLUMN_DEFINITIONS: Readonly<
  Record<string, { readonly since: number; readonly expression: string; readonly stored: boolean }>
> = {
  // eslint-disable-next-line @typescript-eslint/naming-convention -- 键为 table.column 结构标识
  'organization_membership.active_account_id': {
    since: 1775401000000,
    expression: "IF(`status` = 'ACTIVE', `account_id`, NULL)",
    stored: true,
  },
  // eslint-disable-next-line @typescript-eslint/naming-convention -- 键为 table.column 结构标识
  'maintenance_report_attachment.active_sort_order': {
    since: 1775401300000,
    expression: "IF(`status` = 'CURRENT', `sort_order`, NULL)",
    stored: true,
  },
  // eslint-disable-next-line @typescript-eslint/naming-convention -- 键为 table.column 结构标识
  'local_backup_run.active_installation_id': {
    since: 1775401400000,
    expression: "IF(`status` = 'RUNNING', `installation_id`, NULL)",
    stored: true,
  },
  // eslint-disable-next-line @typescript-eslint/naming-convention -- 键为 table.column 结构标识
  'engineer_registration_application.pending_account_id': {
    since: 1775401500000,
    expression: "IF(`status` = 'PENDING', `account_id`, NULL)",
    stored: true,
  },
};

/**
 * 本期交付（V13 增量迁移 1775501000000—1775502100000）新增表的全字段清单。
 *
 * 范围来自冻结设计、字段字典与最终迁移的逐项核对，不从既有定义字典反推；
 * 新增表的每个字段都必须同时登记在 REQUIRED_COLUMNS 与 COLUMN_DEFINITIONS。
 */
export const DELIVERY_NEW_TABLE_COLUMNS: Readonly<Record<string, ReadonlyArray<string>>> = {
  ai_message_analysis: [
    'answer_message_id',
    'completed_at',
    'content_version',
    'conversation_id',
    'failure_reason',
    'question_message_id',
    'question_uuid',
    'saved_at',
    'status',
  ],
  backup_asset: [
    'attempt_count',
    'backup_id',
    'byte_size',
    'cloud_receipt',
    'cloud_reference',
    'cloud_status',
    'created_at',
    'data_version',
    'deleted_at',
    'encryption_key_id',
    'failure_reason',
    'file_sha256',
    'format_version',
    'installation_id',
    'last_attempt_at',
    'local_cleanup_error',
    'local_cleanup_run_id',
    'local_reference',
    'local_status',
    'manifest_checksum',
    'organization_id',
    'retention_until',
    'run_id',
    'storage_reference',
    'updated_at',
    'verified_at',
  ],
  backup_restore_run: [
    'backup_id',
    'check_snapshot',
    'check_status',
    'confirmation',
    'finished_at',
    'organization_id',
    'protection_backup_id',
    'restore_id',
    'restored_scope',
    'result_summary',
    'started_at',
    'started_by_account_id',
    'status',
    'target_installation_id',
  ],
  intake_analysis_attempt: [
    'failure_reason',
    'finished_at',
    'generation_no',
    'id',
    'intake_id',
    'output_text',
    'provider_call_id',
    'started_at',
    'status',
  ],
  local_account_authorization: [
    'account_id',
    'authorization_status',
    'authorized_at',
    'created_at',
    'id',
    'installation_id',
    'last_verified_at',
    'organization_id',
    'permission_version',
    'revoked_at',
    'signed_claims',
  ],
  local_company_setting: [
    'auto_upload_enabled',
    'backup_enabled',
    'backup_interval_hours',
    'created_at',
    'failure_reason',
    'id',
    'initialized_at',
    'installation_id',
    'is_current',
    'last_auto_failure_at',
    'last_auto_success_at',
    'next_backup_at',
    'organization_id',
    'setting_source',
    'updated_at',
  ],
  maintenance_report_fault: [
    'branch_kind',
    'created_at',
    'error_type',
    'fault_cause',
    'fault_description',
    'fault_uuid',
    'gpib_status',
    'handling_action',
    'id',
    'is_active',
    'lifecycle_source',
    'lifecycle_status',
    'main_error',
    'panel_snapshot',
    'phase_code',
    'report_id',
    'source',
    'status',
    'step_code',
    'unit_error',
  ],
  management_audit_event: [
    'actor_account_id',
    'actor_admin_level',
    'created_at',
    'detail',
    'event_id',
    'operation',
    'organization_id',
    'result',
    'target_id',
    'target_type',
  ],
  record_package_import: [
    'check_status',
    'completed_at',
    'created_at',
    'imported_by_account_id',
    'item_failed',
    'item_succeeded',
    'item_total',
    'manifest_checksum',
    'manifest_json',
    'organization_id',
    'package_id',
    'status',
  ],
  record_package_item: [
    'check_result',
    'created_at',
    'error_message',
    'id',
    'package_id',
    'receipt_id',
    'record_uuid',
    'resource_type',
    'result',
    'version_no',
  ],
  reference_document_revision: [
    'actor_account_id',
    'after_snapshot',
    'before_snapshot',
    'created_at',
    'document_id',
    'id',
    'reason',
    'revision_no',
  ],
  repair_process_entry: [
    'author_account_id',
    'created_at',
    'entry_uuid',
    'file_id',
    'id',
    'occurred_at',
    'operation_text',
    'request_id',
    'test_result',
    'time_source',
    'version_no',
  ],
  repair_request_intake: [
    'analysis_generation',
    'analysis_status',
    'converted_request_id',
    'created_at',
    'customer_account_id',
    'customer_organization_id',
    'deleted_at',
    'equipment_model_id',
    'error_code',
    'fault_description',
    'file_id',
    'id',
    'record_uuid',
    'service_organization_id',
  ],
  repair_request_revision: [
    'actor_account_id',
    'after_snapshot',
    'before_snapshot',
    'created_at',
    'id',
    'previous_version',
    'reason',
    'request_id',
    'revision_no',
    'schema_version',
  ],
  stored_file: [
    'binding_status',
    'business_id',
    'business_type',
    'byte_size',
    'checksum_sha256',
    'created_at',
    'file_id',
    'mime_type',
    'original_filename',
    'owner_organization_id',
    'status',
    'storage_reference',
    'upload_context_id',
    'uploaded_by_account_id',
    'verified_at',
  ],
  sync_conflict: [
    'cloud_snapshot',
    'cloud_version',
    'confirmed_at',
    'confirmed_by_account_id',
    'conflict_id',
    'conflict_reason',
    'created_at',
    'decision',
    'displayed_cloud_version',
    'local_snapshot',
    'local_version',
    'organization_id',
    'record_uuid',
    'resource_type',
    'status',
    'version_no',
  ],
  sync_receipt: [
    'confirmed_at',
    'created_at',
    'manifest_checksum',
    'organization_id',
    'receipt_id',
    'receipt_status',
    'received_at',
    'record_uuid',
    'remote_resource_id',
    'resource_type',
    'source_installation_id',
    'source_system',
    'version_no',
  ],
};

/** 本期既有表中新增或调整的字段。 */
export const DELIVERY_EXISTING_TABLE_COLUMNS: ReadonlyArray<string> = [
  'ai_conversation.content_version',
  'ai_conversation.owner_organization_id',
  'ai_conversation.request_id',
  'ai_message.content_version',
  'ai_message.question_uuid',
  'base_user_account.admin_level',
  'base_user_account.must_change_password',
  'base_user_info.customer_organization_id',
  'base_user_info.real_name',
  'local_backup_run.manual_cleanup_status',
  'local_backup_run.manual_upload_status',
  'local_backup_run.organization_id',
  'local_upload_task.manifest_checksum',
  'local_upload_task.record_uuid',
  'local_upload_task.source_version',
  'local_upload_task.task_kind',
  'maintenance_report_step.action_text',
  'maintenance_report_step.error_code',
  'maintenance_report_step.part_name',
  'maintenance_report_step.result_code',
  'maintenance_report_step.step_no',
  'maintenance_report.actual_cause',
  'maintenance_report.closure_reason',
  'maintenance_report.customer_factory_name',
  'maintenance_report.equipment_model_text',
  'maintenance_report.handling_result',
  'maintenance_report.maintenance_engineer_name_snapshot',
  'maintenance_report.repair_actions',
  'maintenance_report.reset_result',
  'maintenance_report.submission_payload_hash',
  'maintenance_report.submission_request_id',
  'maintenance_report.supplementary_note',
  'maintenance_report.verification_result',
  'organization.address',
  'organization.contact_email',
  'organization.contact_name',
  'organization.contact_phone',
  'organization.is_managed_company',
  'organization.is_service_provider',
  'organization.name',
  'organization.remark',
  'organization.short_name',
  'reference_document.current_revision_no',
  'reference_document.owner_organization_id',
  'reference_document.ownership_status',
  'reference_document.publication_status',
  'reference_document.source_kind',
  'reference_document.source_report_id',
  'reference_document.source_report_version_id',
  'repair_request.closed_at',
  'repair_request.closure_reason',
  'repair_request.closure_status',
  'repair_request.current_revision_no',
  'repair_request.customer_organization_id',
  'repair_request.intake_id',
  'repair_request.is_historical',
  'repair_request.service_organization_id',
];

/** 本期交付字段全集（新增表全字段 + 既有表新增/调整字段）。 */
export const DELIVERY_COLUMNS: ReadonlyArray<string> = [
  ...Object.entries(DELIVERY_NEW_TABLE_COLUMNS).flatMap(([table, columns]) =>
    columns.map((column) => `${table}.${column}`),
  ),
  ...DELIVERY_EXISTING_TABLE_COLUMNS,
];

/** 本期交付的 CHECK（新增表全量 + 既有表新增/调整）。 */
export const DELIVERY_CHECKS: ReadonlyArray<string> = [
  'ai_conversation.chk_ai_conversation_completion',
  'ai_conversation.chk_ai_conversation_content_version',
  'ai_message_analysis.chk_ai_message_analysis_completed',
  'ai_message_analysis.chk_ai_message_analysis_content_version',
  'ai_message_analysis.chk_ai_message_analysis_failure',
  'ai_message_analysis.chk_ai_message_analysis_status',
  'ai_message.chk_ai_message_content_version',
  'backup_asset.chk_backup_asset_attempts',
  'backup_asset.chk_backup_asset_cloud_receipt',
  'backup_asset.chk_backup_asset_cloud_status',
  'backup_asset.chk_backup_asset_format_version',
  'backup_asset.chk_backup_asset_local_cleanup',
  'backup_asset.chk_backup_asset_local_status',
  'backup_asset.chk_backup_asset_manifest',
  'backup_asset.chk_backup_asset_sha',
  'backup_asset.chk_backup_asset_size',
  'backup_restore_run.chk_backup_restore_run_check_outcome',
  'backup_restore_run.chk_backup_restore_run_check_status',
  'backup_restore_run.chk_backup_restore_run_execution_guard',
  'backup_restore_run.chk_backup_restore_run_finish',
  'backup_restore_run.chk_backup_restore_run_protection',
  'backup_restore_run.chk_backup_restore_run_schema',
  'backup_restore_run.chk_backup_restore_run_status',
  'base_user_account.chk_base_user_account_admin_level',
  'intake_analysis_attempt.chk_intake_analysis_attempt_failure',
  'intake_analysis_attempt.chk_intake_analysis_attempt_generation',
  'intake_analysis_attempt.chk_intake_analysis_attempt_status',
  'local_account_authorization.chk_local_account_authorization_permission_version',
  'local_account_authorization.chk_local_account_authorization_signed_claims',
  'local_account_authorization.chk_local_account_authorization_status',
  'local_backup_run.chk_local_backup_run_manual_status',
  'local_backup_run.chk_local_backup_run_trigger',
  'local_company_setting.chk_local_company_setting_auto_upload',
  'local_company_setting.chk_local_company_setting_backup_interval',
  'local_company_setting.chk_local_company_setting_backup_schedule',
  'local_company_setting.chk_local_company_setting_current',
  'local_company_setting.chk_local_company_setting_source',
  'local_upload_task.chk_local_upload_task_manifest_checksum',
  'local_upload_task.chk_local_upload_task_task_kind',
  'maintenance_report_fault.chk_maintenance_report_fault_action_len',
  'maintenance_report_fault.chk_maintenance_report_fault_active',
  'maintenance_report_fault.chk_maintenance_report_fault_branch',
  'maintenance_report_fault.chk_maintenance_report_fault_description',
  'maintenance_report_fault.chk_maintenance_report_fault_description_len',
  'maintenance_report_fault.chk_maintenance_report_fault_lifecycle_source',
  'maintenance_report_fault.chk_maintenance_report_fault_lifecycle_status',
  'maintenance_report_fault.chk_maintenance_report_fault_phase_code',
  'maintenance_report_fault.chk_maintenance_report_fault_step',
  'maintenance_report_step.chk_maintenance_report_step_result_code',
  'maintenance_report.chk_maintenance_report_ai_correctness',
  'maintenance_report.chk_maintenance_report_ai_helpfulness',
  'maintenance_report.chk_maintenance_report_closure_reason',
  'maintenance_report.chk_maintenance_report_handling_result',
  'maintenance_report.chk_maintenance_report_reset_result',
  'maintenance_report.chk_maintenance_report_status',
  'maintenance_report.chk_maintenance_report_status_consistency',
  'maintenance_report.chk_maintenance_report_submission_pair',
  'management_audit_event.chk_management_audit_level',
  'management_audit_event.chk_management_audit_operation',
  'management_audit_event.chk_management_audit_result',
  'management_audit_event.chk_management_audit_target',
  'organization.chk_organization_managed_company',
  'organization.chk_organization_service_provider',
  'record_package_import.chk_record_package_import_check_stage',
  'record_package_import.chk_record_package_import_check_status',
  'record_package_import.chk_record_package_import_counts',
  'record_package_import.chk_record_package_import_manifest',
  'record_package_import.chk_record_package_import_status',
  'record_package_item.chk_record_package_item_check_result',
  'record_package_item.chk_record_package_item_check_stage',
  'record_package_item.chk_record_package_item_error',
  'record_package_item.chk_record_package_item_result',
  'reference_document_revision.chk_reference_document_revision_no',
  'reference_document_revision.chk_reference_document_revision_reason',
  'reference_document_revision.chk_reference_document_revision_schema',
  'reference_document.chk_reference_document_content_source_v13',
  'reference_document.chk_reference_document_ingest_method',
  'reference_document.chk_reference_document_ownership',
  'reference_document.chk_reference_document_publication',
  'reference_document.chk_reference_document_report_source_pair',
  'repair_process_entry.chk_repair_process_entry_operation',
  'repair_process_entry.chk_repair_process_entry_time_source',
  'repair_process_entry.chk_repair_process_entry_version',
  'repair_request_intake.chk_repair_request_intake_analysis_status',
  'repair_request_intake.chk_repair_request_intake_description',
  'repair_request_intake.chk_repair_request_intake_generation',
  'repair_request_revision.chk_repair_request_revision_no',
  'repair_request_revision.chk_repair_request_revision_previous_version',
  'repair_request_revision.chk_repair_request_revision_reason',
  'repair_request_revision.chk_repair_request_revision_schema',
  'repair_request.chk_repair_request_closure',
  'repair_request.chk_repair_request_closure_reason',
  'repair_request.chk_repair_request_current_revision',
  'repair_request.chk_repair_request_new_intake_companies',
  'stored_file.chk_stored_file_binding_pair',
  'stored_file.chk_stored_file_binding_status',
  'stored_file.chk_stored_file_business_type',
  'stored_file.chk_stored_file_checksum',
  'stored_file.chk_stored_file_size',
  'stored_file.chk_stored_file_status',
  'stored_file.chk_stored_file_verified',
  'sync_conflict.chk_sync_conflict_confirmed',
  'sync_conflict.chk_sync_conflict_decision',
  'sync_conflict.chk_sync_conflict_schema',
  'sync_conflict.chk_sync_conflict_status',
  'sync_conflict.chk_sync_conflict_versions',
  'sync_receipt.chk_sync_receipt_confirm_time',
  'sync_receipt.chk_sync_receipt_manifest',
  'sync_receipt.chk_sync_receipt_source',
  'sync_receipt.chk_sync_receipt_status',
];

/** 本期交付的索引（新增表全量 + 既有表新增/调整）。 */
export const DELIVERY_INDEXES: ReadonlyArray<string> = [
  'ai_conversation.idx_ai_conversation_owner_created',
  'ai_message_analysis.idx_ai_message_analysis_conversation_status',
  'ai_message_analysis.uk_ai_message_analysis_question',
  'ai_message.uk_ai_message_question_uuid',
  'backup_asset.idx_backup_asset_installation',
  'backup_asset.idx_backup_asset_organization_status',
  'backup_restore_run.idx_backup_restore_run_organization',
  'base_user_info.idx_base_user_info_customer_organization',
  'intake_analysis_attempt.uk_intake_analysis_attempt_generation',
  'local_account_authorization.idx_local_account_authorization_account',
  'local_account_authorization.uk_local_account_authorization_scope',
  'local_backup_run.idx_local_backup_run_organization',
  'local_backup_run.uk_local_backup_run_active_company',
  'local_company_setting.uk_local_company_setting_scope',
  'local_upload_task.idx_local_upload_task_record_uuid',
  'maintenance_report_fault.idx_maintenance_report_fault_report',
  'maintenance_report_fault.uk_maintenance_report_fault_uuid',
  'maintenance_report.uk_maintenance_report_submission',
  'management_audit_event.idx_management_audit_actor',
  'management_audit_event.idx_management_audit_organization',
  'management_audit_event.idx_management_audit_target',
  'record_package_import.idx_record_package_import_organization',
  'record_package_item.uk_record_package_item_scope',
  'reference_document_revision.uk_reference_document_revision_no',
  'reference_document.uk_reference_document_source_report_version',
  'repair_process_entry.idx_repair_process_entry_request_created',
  'repair_process_entry.uk_repair_process_entry_uuid',
  'repair_request_intake.idx_repair_request_intake_customer_created',
  'repair_request_intake.idx_repair_request_intake_organization_status',
  'repair_request_intake.uk_repair_request_intake_converted',
  'repair_request_intake.uk_repair_request_intake_record_uuid',
  'repair_request_revision.uk_repair_request_revision_no',
  'repair_request.idx_repair_request_customer_organization',
  'repair_request.idx_repair_request_service_organization',
  'repair_request.uk_repair_request_intake',
  'stored_file.idx_stored_file_business',
  'stored_file.idx_stored_file_owner_created',
  'stored_file.idx_stored_file_status_created',
  'stored_file.uk_stored_file_upload_context',
  'sync_conflict.idx_sync_conflict_organization_status',
  'sync_conflict.uk_sync_conflict_scope',
  'sync_receipt.idx_sync_receipt_organization_status',
  'sync_receipt.uk_sync_receipt_scope_v13',
];

/** 本期交付的外键（新增表全量 + 既有表新增/调整）。 */
export const DELIVERY_FOREIGN_KEYS: ReadonlyArray<string> = [
  'ai_conversation.fk_ai_conversation_owner_organization',
  'ai_message_analysis.fk_ai_message_analysis_answer_message',
  'ai_message_analysis.fk_ai_message_analysis_conversation',
  'ai_message_analysis.fk_ai_message_analysis_question_message',
  'backup_asset.fk_backup_asset_cleanup_run',
  'backup_asset.fk_backup_asset_organization',
  'backup_asset.fk_backup_asset_run',
  'backup_restore_run.fk_backup_restore_run_actor',
  'backup_restore_run.fk_backup_restore_run_backup',
  'backup_restore_run.fk_backup_restore_run_organization',
  'backup_restore_run.fk_backup_restore_run_protection',
  'backup_restore_run.fk_backup_restore_run_target',
  'base_user_info.fk_base_user_info_customer_organization',
  'intake_analysis_attempt.fk_intake_analysis_attempt_intake',
  'intake_analysis_attempt.fk_intake_analysis_attempt_provider_call',
  'local_account_authorization.fk_local_account_authorization_account',
  'local_account_authorization.fk_local_account_authorization_installation',
  'local_account_authorization.fk_local_account_authorization_organization',
  'local_backup_run.fk_local_backup_run_organization',
  'local_company_setting.fk_local_company_setting_installation',
  'local_company_setting.fk_local_company_setting_organization',
  'maintenance_report_fault.fk_maintenance_report_fault_report',
  'maintenance_report_fault.fk_maintenance_report_fault_step',
  'management_audit_event.fk_management_audit_actor',
  'management_audit_event.fk_management_audit_organization',
  'record_package_import.fk_record_package_import_actor',
  'record_package_import.fk_record_package_import_organization',
  'record_package_item.fk_record_package_item_package',
  'record_package_item.fk_record_package_item_receipt',
  'reference_document_revision.fk_reference_document_revision_actor',
  'reference_document_revision.fk_reference_document_revision_document',
  'reference_document.fk_reference_document_source_report_version',
  'repair_process_entry.fk_repair_process_entry_author',
  'repair_process_entry.fk_repair_process_entry_file',
  'repair_process_entry.fk_repair_process_entry_request',
  'repair_request_intake.fk_repair_request_intake_converted_request',
  'repair_request_intake.fk_repair_request_intake_customer_account',
  'repair_request_intake.fk_repair_request_intake_customer_organization',
  'repair_request_intake.fk_repair_request_intake_equipment_model',
  'repair_request_intake.fk_repair_request_intake_file',
  'repair_request_intake.fk_repair_request_intake_service_organization',
  'repair_request_revision.fk_repair_request_revision_actor',
  'repair_request_revision.fk_repair_request_revision_request',
  'repair_request.fk_repair_request_customer_organization',
  'repair_request.fk_repair_request_intake',
  'repair_request.fk_repair_request_service_organization',
  'stored_file.fk_stored_file_owner_organization',
  'stored_file.fk_stored_file_uploader',
  'sync_conflict.fk_sync_conflict_confirmer',
  'sync_conflict.fk_sync_conflict_organization',
  'sync_receipt.fk_sync_receipt_organization',
];

/** 本期交付涉及的生成列；V13 增量迁移未新增生成列，历史生成列列为沿用。 */
export const DELIVERY_GENERATED_COLUMNS: ReadonlyArray<string> = [];

export interface DeliveryStructureRegistry {
  readonly newTableColumns: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly existingTableColumns: ReadonlyArray<string>;
  readonly columns: ReadonlyArray<string>;
  readonly checks: ReadonlyArray<string>;
  readonly indexes: ReadonlyArray<string>;
  readonly foreignKeys: ReadonlyArray<string>;
  readonly generatedColumns: ReadonlyArray<string>;
}

/** 本期交付结构登记表；定义覆盖校验只以此显式清单为准。 */
export const DELIVERY_STRUCTURE_REGISTRY: DeliveryStructureRegistry = {
  newTableColumns: DELIVERY_NEW_TABLE_COLUMNS,
  existingTableColumns: DELIVERY_EXISTING_TABLE_COLUMNS,
  columns: DELIVERY_COLUMNS,
  checks: DELIVERY_CHECKS,
  indexes: DELIVERY_INDEXES,
  foreignKeys: DELIVERY_FOREIGN_KEYS,
  generatedColumns: DELIVERY_GENERATED_COLUMNS,
};

export interface InheritedStructureKeys {
  readonly columns: ReadonlyArray<string>;
  readonly checks: ReadonlyArray<string>;
  readonly indexes: ReadonlyArray<string>;
  readonly foreignKeys: ReadonlyArray<string>;
  readonly generatedColumns: ReadonlyArray<string>;
}

const differenceKeys = (
  all: ReadonlyArray<string>,
  delivery: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const deliveryKeys = new Set(delivery);
  return all.filter((key) => !deliveryKeys.has(key));
};

/**
 * 历史沿用对象：REQUIRED_* 中未被本期交付显式登记的部分。
 * 这些对象只保留名称级校验，不要求补齐历史精确定义。
 */
export function collectInheritedStructureKeys(): InheritedStructureKeys {
  return {
    columns: differenceKeys(
      REQUIRED_COLUMNS.map((item) => `${item.table}.${item.column}`),
      DELIVERY_COLUMNS,
    ),
    checks: differenceKeys(
      REQUIRED_CHECKS.map((item) => `${item.table}.${item.constraint}`),
      DELIVERY_CHECKS,
    ),
    indexes: differenceKeys(
      REQUIRED_INDEXES.map((item) => `${item.table}.${item.index}`),
      DELIVERY_INDEXES,
    ),
    foreignKeys: differenceKeys(
      REQUIRED_FOREIGN_KEYS.map((item) => `${item.table}.${item.constraint}`),
      DELIVERY_FOREIGN_KEYS,
    ),
    generatedColumns: differenceKeys(
      REQUIRED_GENERATED_COLUMNS.map((item) => `${item.table}.${item.column}`),
      DELIVERY_GENERATED_COLUMNS,
    ),
  };
}

// 注：chk_repair_request_revision_schema / chk_reference_document_revision_schema /
// chk_sync_conflict_schema / chk_backup_restore_run_schema 的表达式由追加迁移
// 1775501600000 重建（要求快照版本键存在且非 JSON null）；其首次创建时间仍记录在
// CHECK_CREATED_BY，故这里的名称契约保持不变。
// 注：chk_record_package_import_manifest / chk_record_package_item_result 的表达式由
// 追加迁移 1775501700000 重建（版本键存在且非 JSON null；导入结果允许 NULL 并增加
// CONFLICT）；其首次创建时间仍记录在 CHECK_CREATED_BY。
export const REQUIRED_CHECKS: ReadonlyArray<{ table: string; constraint: string }> = [
  { table: 'equipment_model', constraint: 'chk_equipment_model_enabled' },
  { table: 'repair_request', constraint: 'chk_repair_request_acceptance_consistency' },
  { table: 'repair_request', constraint: 'chk_repair_request_deletion_consistency' },
  { table: 'repair_request', constraint: 'chk_repair_request_is_accepted' },
  { table: 'repair_request', constraint: 'chk_repair_request_deprecated' },
  { table: 'ai_conversation', constraint: 'chk_ai_conversation_completion' },
  { table: 'ai_message', constraint: 'chk_ai_message_seq' },
  { table: 'ai_message', constraint: 'chk_ai_message_turn' },
  { table: 'ai_message', constraint: 'chk_ai_message_role_turn' },
  { table: 'ai_message', constraint: 'chk_ai_message_content' },
  { table: 'reference_document', constraint: 'chk_reference_document_deletion_consistency' },
  { table: 'reference_document', constraint: 'chk_reference_document_storage_pair' },
  { table: 'reference_document', constraint: 'chk_reference_document_deprecated' },
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
  { table: 'engineer_response', constraint: 'chk_engineer_response_text' },
  { table: 'base_user_account', constraint: 'chk_base_user_account_admin_level' },
  { table: 'organization', constraint: 'chk_organization_service_provider' },
  { table: 'organization', constraint: 'chk_organization_managed_company' },
  { table: 'repair_request', constraint: 'chk_repair_request_new_intake_companies' },
  { table: 'repair_request', constraint: 'chk_repair_request_closure' },
  { table: 'repair_request', constraint: 'chk_repair_request_closure_reason' },
  { table: 'repair_request', constraint: 'chk_repair_request_current_revision' },
  { table: 'ai_conversation', constraint: 'chk_ai_conversation_content_version' },
  { table: 'ai_message', constraint: 'chk_ai_message_content_version' },
  { table: 'maintenance_report_step', constraint: 'chk_maintenance_report_step_result_code' },
  { table: 'maintenance_report', constraint: 'chk_maintenance_report_handling_result' },
  { table: 'maintenance_report', constraint: 'chk_maintenance_report_reset_result' },
  { table: 'maintenance_report', constraint: 'chk_maintenance_report_closure_reason' },
  { table: 'maintenance_report', constraint: 'chk_maintenance_report_submission_pair' },
  { table: 'reference_document', constraint: 'chk_reference_document_publication' },
  { table: 'reference_document', constraint: 'chk_reference_document_ownership' },
  { table: 'reference_document', constraint: 'chk_reference_document_report_source_pair' },
  { table: 'reference_document', constraint: 'chk_reference_document_content_source_v13' },
  { table: 'local_upload_task', constraint: 'chk_local_upload_task_task_kind' },
  { table: 'local_upload_task', constraint: 'chk_local_upload_task_manifest_checksum' },
  { table: 'local_backup_run', constraint: 'chk_local_backup_run_manual_status' },
  { table: 'stored_file', constraint: 'chk_stored_file_size' },
  { table: 'stored_file', constraint: 'chk_stored_file_status' },
  { table: 'stored_file', constraint: 'chk_stored_file_binding_status' },
  { table: 'stored_file', constraint: 'chk_stored_file_binding_pair' },
  { table: 'stored_file', constraint: 'chk_stored_file_verified' },
  { table: 'stored_file', constraint: 'chk_stored_file_checksum' },
  { table: 'stored_file', constraint: 'chk_stored_file_business_type' },
  { table: 'repair_request_intake', constraint: 'chk_repair_request_intake_analysis_status' },
  { table: 'repair_request_intake', constraint: 'chk_repair_request_intake_generation' },
  { table: 'repair_request_intake', constraint: 'chk_repair_request_intake_description' },
  { table: 'intake_analysis_attempt', constraint: 'chk_intake_analysis_attempt_generation' },
  { table: 'intake_analysis_attempt', constraint: 'chk_intake_analysis_attempt_status' },
  { table: 'intake_analysis_attempt', constraint: 'chk_intake_analysis_attempt_failure' },
  { table: 'repair_process_entry', constraint: 'chk_repair_process_entry_operation' },
  { table: 'repair_process_entry', constraint: 'chk_repair_process_entry_version' },
  { table: 'repair_process_entry', constraint: 'chk_repair_process_entry_time_source' },
  { table: 'ai_message_analysis', constraint: 'chk_ai_message_analysis_status' },
  { table: 'ai_message_analysis', constraint: 'chk_ai_message_analysis_failure' },
  { table: 'ai_message_analysis', constraint: 'chk_ai_message_analysis_content_version' },
  { table: 'ai_message_analysis', constraint: 'chk_ai_message_analysis_completed' },
  { table: 'maintenance_report_fault', constraint: 'chk_maintenance_report_fault_branch' },
  { table: 'maintenance_report_fault', constraint: 'chk_maintenance_report_fault_step' },
  { table: 'maintenance_report_fault', constraint: 'chk_maintenance_report_fault_description' },
  // S5（1775501900000）：旧 status/source 约束随列重命名由 lifecycle_* 取代
  {
    table: 'maintenance_report_fault',
    constraint: 'chk_maintenance_report_fault_lifecycle_status',
  },
  {
    table: 'maintenance_report_fault',
    constraint: 'chk_maintenance_report_fault_lifecycle_source',
  },
  { table: 'maintenance_report_fault', constraint: 'chk_maintenance_report_fault_description_len' },
  { table: 'maintenance_report_fault', constraint: 'chk_maintenance_report_fault_action_len' },
  { table: 'repair_request_revision', constraint: 'chk_repair_request_revision_no' },
  {
    table: 'repair_request_revision',
    constraint: 'chk_repair_request_revision_previous_version',
  },
  { table: 'repair_request_revision', constraint: 'chk_repair_request_revision_schema' },
  { table: 'repair_request_revision', constraint: 'chk_repair_request_revision_reason' },
  { table: 'reference_document_revision', constraint: 'chk_reference_document_revision_no' },
  { table: 'reference_document_revision', constraint: 'chk_reference_document_revision_schema' },
  { table: 'reference_document_revision', constraint: 'chk_reference_document_revision_reason' },
  { table: 'local_account_authorization', constraint: 'chk_local_account_authorization_status' },
  { table: 'local_company_setting', constraint: 'chk_local_company_setting_source' },
  { table: 'local_company_setting', constraint: 'chk_local_company_setting_current' },
  { table: 'sync_receipt', constraint: 'chk_sync_receipt_status' },
  { table: 'sync_receipt', constraint: 'chk_sync_receipt_source' },
  { table: 'sync_receipt', constraint: 'chk_sync_receipt_manifest' },
  { table: 'sync_receipt', constraint: 'chk_sync_receipt_confirm_time' },
  { table: 'sync_conflict', constraint: 'chk_sync_conflict_status' },
  { table: 'sync_conflict', constraint: 'chk_sync_conflict_confirmed' },
  { table: 'sync_conflict', constraint: 'chk_sync_conflict_schema' },
  { table: 'sync_conflict', constraint: 'chk_sync_conflict_versions' },
  { table: 'sync_conflict', constraint: 'chk_sync_conflict_decision' },
  { table: 'record_package_import', constraint: 'chk_record_package_import_status' },
  { table: 'record_package_import', constraint: 'chk_record_package_import_check_status' },
  { table: 'record_package_import', constraint: 'chk_record_package_import_check_stage' },
  { table: 'record_package_import', constraint: 'chk_record_package_import_manifest' },
  { table: 'record_package_import', constraint: 'chk_record_package_import_counts' },
  { table: 'record_package_item', constraint: 'chk_record_package_item_result' },
  { table: 'record_package_item', constraint: 'chk_record_package_item_check_result' },
  { table: 'record_package_item', constraint: 'chk_record_package_item_check_stage' },
  { table: 'record_package_item', constraint: 'chk_record_package_item_error' },
  { table: 'backup_asset', constraint: 'chk_backup_asset_sha' },
  { table: 'backup_asset', constraint: 'chk_backup_asset_size' },
  { table: 'backup_asset', constraint: 'chk_backup_asset_cloud_status' },
  { table: 'backup_asset', constraint: 'chk_backup_asset_local_status' },
  { table: 'backup_asset', constraint: 'chk_backup_asset_cloud_receipt' },
  { table: 'backup_asset', constraint: 'chk_backup_asset_attempts' },
  { table: 'backup_restore_run', constraint: 'chk_backup_restore_run_status' },
  { table: 'backup_restore_run', constraint: 'chk_backup_restore_run_finish' },
  { table: 'backup_restore_run', constraint: 'chk_backup_restore_run_protection' },
  { table: 'backup_restore_run', constraint: 'chk_backup_restore_run_schema' },
  { table: 'backup_restore_run', constraint: 'chk_backup_restore_run_execution_guard' },
  // S5（1775501900000）：备份/授权/设置新增约束
  { table: 'backup_asset', constraint: 'chk_backup_asset_manifest' },
  { table: 'backup_asset', constraint: 'chk_backup_asset_format_version' },
  { table: 'backup_asset', constraint: 'chk_backup_asset_local_cleanup' },
  { table: 'local_company_setting', constraint: 'chk_local_company_setting_backup_interval' },
  { table: 'local_company_setting', constraint: 'chk_local_company_setting_backup_schedule' },
  { table: 'local_company_setting', constraint: 'chk_local_company_setting_auto_upload' },
  { table: 'backup_restore_run', constraint: 'chk_backup_restore_run_check_status' },
  { table: 'backup_restore_run', constraint: 'chk_backup_restore_run_check_outcome' },
  { table: 'maintenance_report_fault', constraint: 'chk_maintenance_report_fault_phase_code' },
  { table: 'maintenance_report_fault', constraint: 'chk_maintenance_report_fault_active' },
  {
    table: 'local_account_authorization',
    constraint: 'chk_local_account_authorization_signed_claims',
  },
  {
    table: 'local_account_authorization',
    constraint: 'chk_local_account_authorization_permission_version',
  },
  { table: 'management_audit_event', constraint: 'chk_management_audit_level' },
  { table: 'management_audit_event', constraint: 'chk_management_audit_operation' },
  { table: 'management_audit_event', constraint: 'chk_management_audit_result' },
  { table: 'management_audit_event', constraint: 'chk_management_audit_target' },
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
  {
    table: 'base_user_info',
    constraint: 'fk_base_user_info_customer_organization',
    referencedTable: 'organization',
  },
  {
    table: 'repair_request',
    constraint: 'fk_repair_request_customer_organization',
    referencedTable: 'organization',
  },
  {
    table: 'repair_request',
    constraint: 'fk_repair_request_service_organization',
    referencedTable: 'organization',
  },
  {
    table: 'repair_request',
    constraint: 'fk_repair_request_intake',
    referencedTable: 'repair_request_intake',
  },
  {
    table: 'ai_conversation',
    constraint: 'fk_ai_conversation_owner_organization',
    referencedTable: 'organization',
  },
  {
    table: 'reference_document',
    constraint: 'fk_reference_document_source_report_version',
    referencedTable: 'maintenance_report_version',
  },
  {
    table: 'local_backup_run',
    constraint: 'fk_local_backup_run_organization',
    referencedTable: 'organization',
  },
  {
    table: 'stored_file',
    constraint: 'fk_stored_file_uploader',
    referencedTable: 'base_user_account',
  },
  {
    table: 'stored_file',
    constraint: 'fk_stored_file_owner_organization',
    referencedTable: 'organization',
  },
  {
    table: 'repair_request_intake',
    constraint: 'fk_repair_request_intake_customer_account',
    referencedTable: 'base_user_account',
  },
  {
    table: 'repair_request_intake',
    constraint: 'fk_repair_request_intake_customer_organization',
    referencedTable: 'organization',
  },
  {
    table: 'repair_request_intake',
    constraint: 'fk_repair_request_intake_service_organization',
    referencedTable: 'organization',
  },
  {
    table: 'repair_request_intake',
    constraint: 'fk_repair_request_intake_equipment_model',
    referencedTable: 'equipment_model',
  },
  {
    table: 'repair_request_intake',
    constraint: 'fk_repair_request_intake_file',
    referencedTable: 'stored_file',
  },
  {
    table: 'repair_request_intake',
    constraint: 'fk_repair_request_intake_converted_request',
    referencedTable: 'repair_request',
  },
  {
    table: 'intake_analysis_attempt',
    constraint: 'fk_intake_analysis_attempt_intake',
    referencedTable: 'repair_request_intake',
  },
  {
    table: 'intake_analysis_attempt',
    constraint: 'fk_intake_analysis_attempt_provider_call',
    referencedTable: 'ai_provider_call_record',
  },
  {
    table: 'repair_process_entry',
    constraint: 'fk_repair_process_entry_request',
    referencedTable: 'repair_request',
  },
  {
    table: 'repair_process_entry',
    constraint: 'fk_repair_process_entry_author',
    referencedTable: 'base_user_account',
  },
  {
    table: 'repair_process_entry',
    constraint: 'fk_repair_process_entry_file',
    referencedTable: 'stored_file',
  },
  {
    table: 'ai_message_analysis',
    constraint: 'fk_ai_message_analysis_conversation',
    referencedTable: 'ai_conversation',
  },
  {
    table: 'ai_message_analysis',
    constraint: 'fk_ai_message_analysis_question_message',
    referencedTable: 'ai_message',
  },
  {
    table: 'ai_message_analysis',
    constraint: 'fk_ai_message_analysis_answer_message',
    referencedTable: 'ai_message',
  },
  {
    table: 'maintenance_report_fault',
    constraint: 'fk_maintenance_report_fault_report',
    referencedTable: 'maintenance_report',
  },
  {
    table: 'maintenance_report_fault',
    constraint: 'fk_maintenance_report_fault_step',
    referencedTable: 'maintenance_report_step',
  },
  {
    table: 'repair_request_revision',
    constraint: 'fk_repair_request_revision_request',
    referencedTable: 'repair_request',
  },
  {
    table: 'repair_request_revision',
    constraint: 'fk_repair_request_revision_actor',
    referencedTable: 'base_user_account',
  },
  {
    table: 'reference_document_revision',
    constraint: 'fk_reference_document_revision_document',
    referencedTable: 'reference_document',
  },
  {
    table: 'reference_document_revision',
    constraint: 'fk_reference_document_revision_actor',
    referencedTable: 'base_user_account',
  },
  {
    table: 'local_account_authorization',
    constraint: 'fk_local_account_authorization_installation',
    referencedTable: 'local_installation',
  },
  {
    table: 'local_account_authorization',
    constraint: 'fk_local_account_authorization_account',
    referencedTable: 'base_user_account',
  },
  {
    table: 'local_account_authorization',
    constraint: 'fk_local_account_authorization_organization',
    referencedTable: 'organization',
  },
  {
    table: 'local_company_setting',
    constraint: 'fk_local_company_setting_installation',
    referencedTable: 'local_installation',
  },
  {
    table: 'local_company_setting',
    constraint: 'fk_local_company_setting_organization',
    referencedTable: 'organization',
  },
  {
    table: 'sync_receipt',
    constraint: 'fk_sync_receipt_organization',
    referencedTable: 'organization',
  },
  {
    table: 'sync_conflict',
    constraint: 'fk_sync_conflict_organization',
    referencedTable: 'organization',
  },
  {
    table: 'sync_conflict',
    constraint: 'fk_sync_conflict_confirmer',
    referencedTable: 'base_user_account',
  },
  {
    table: 'record_package_import',
    constraint: 'fk_record_package_import_organization',
    referencedTable: 'organization',
  },
  {
    table: 'record_package_import',
    constraint: 'fk_record_package_import_actor',
    referencedTable: 'base_user_account',
  },
  {
    table: 'record_package_item',
    constraint: 'fk_record_package_item_package',
    referencedTable: 'record_package_import',
  },
  {
    table: 'record_package_item',
    constraint: 'fk_record_package_item_receipt',
    referencedTable: 'sync_receipt',
  },
  {
    table: 'backup_asset',
    constraint: 'fk_backup_asset_run',
    referencedTable: 'local_backup_run',
  },
  {
    table: 'backup_asset',
    constraint: 'fk_backup_asset_organization',
    referencedTable: 'organization',
  },
  {
    table: 'backup_asset',
    constraint: 'fk_backup_asset_cleanup_run',
    referencedTable: 'local_backup_run',
  },
  {
    table: 'backup_restore_run',
    constraint: 'fk_backup_restore_run_backup',
    referencedTable: 'backup_asset',
  },
  {
    table: 'backup_restore_run',
    constraint: 'fk_backup_restore_run_protection',
    referencedTable: 'backup_asset',
  },
  {
    table: 'backup_restore_run',
    constraint: 'fk_backup_restore_run_organization',
    referencedTable: 'organization',
  },
  {
    table: 'backup_restore_run',
    constraint: 'fk_backup_restore_run_actor',
    referencedTable: 'base_user_account',
  },
  {
    table: 'backup_restore_run',
    constraint: 'fk_backup_restore_run_target',
    referencedTable: 'local_installation',
  },
  {
    table: 'management_audit_event',
    constraint: 'fk_management_audit_actor',
    referencedTable: 'base_user_account',
  },
  {
    table: 'management_audit_event',
    constraint: 'fk_management_audit_organization',
    referencedTable: 'organization',
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
  stored_file: 1775501200000,
  repair_request_intake: 1775501200000,
  intake_analysis_attempt: 1775501200000,
  repair_process_entry: 1775501200000,
  ai_message_analysis: 1775501200000,
  maintenance_report_fault: 1775501300000,
  repair_request_revision: 1775501300000,
  reference_document_revision: 1775501300000,
  local_account_authorization: 1775501400000,
  local_company_setting: 1775501400000,
  sync_receipt: 1775501400000,
  sync_conflict: 1775501400000,
  record_package_import: 1775501400000,
  record_package_item: 1775501400000,
  backup_asset: 1775501500000,
  backup_restore_run: 1775501500000,
  management_audit_event: 1775501500000,
};

const INDEX_CREATED_BY: Readonly<Record<string, number>> = {
  'base_user_account.uk_login_email': 1773924900000,
  'base_user_account.uk_login_name': 1773924900000,
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
  'local_upload_task.idx_local_upload_task_record_uuid': 1775501100000,
  'local_backup_run.uk_local_backup_run_active_company': 1775501100000,
  'local_backup_run.idx_local_backup_run_started': 1775401400000,
  'local_backup_run.idx_local_backup_run_organization': 1775501100000,
  'base_user_info.idx_base_user_info_customer_organization': 1775501000000,
  'repair_request.uk_repair_request_intake': 1775501100000,
  'repair_request.idx_repair_request_customer_organization': 1775501100000,
  'repair_request.idx_repair_request_service_organization': 1775501100000,
  'ai_message.uk_ai_message_question_uuid': 1775501100000,
  'ai_conversation.idx_ai_conversation_owner_created': 1775501100000,
  'maintenance_report.uk_maintenance_report_submission': 1775501100000,
  'reference_document.uk_reference_document_source_report_version': 1775501100000,
  'stored_file.uk_stored_file_upload_context': 1775501200000,
  'stored_file.idx_stored_file_business': 1775501200000,
  'stored_file.idx_stored_file_owner_created': 1775501200000,
  'stored_file.idx_stored_file_status_created': 1775501200000,
  'repair_request_intake.uk_repair_request_intake_record_uuid': 1775501200000,
  'repair_request_intake.uk_repair_request_intake_converted': 1775501200000,
  'repair_request_intake.idx_repair_request_intake_customer_created': 1775501200000,
  'repair_request_intake.idx_repair_request_intake_organization_status': 1775501200000,
  'intake_analysis_attempt.uk_intake_analysis_attempt_generation': 1775501200000,
  'repair_process_entry.uk_repair_process_entry_uuid': 1775501200000,
  'repair_process_entry.idx_repair_process_entry_request_created': 1775501200000,
  'ai_message_analysis.uk_ai_message_analysis_question': 1775501200000,
  'ai_message_analysis.idx_ai_message_analysis_conversation_status': 1775501200000,
  'maintenance_report_fault.uk_maintenance_report_fault_uuid': 1775501300000,
  'maintenance_report_fault.idx_maintenance_report_fault_report': 1775501300000,
  'repair_request_revision.uk_repair_request_revision_no': 1775501300000,
  'reference_document_revision.uk_reference_document_revision_no': 1775501300000,
  'local_account_authorization.uk_local_account_authorization_scope': 1775501400000,
  'local_account_authorization.idx_local_account_authorization_account': 1775501400000,
  'local_company_setting.uk_local_company_setting_scope': 1775501400000,
  'sync_receipt.uk_sync_receipt_scope_v13': 1775501900000,
  'sync_receipt.idx_sync_receipt_organization_status': 1775501400000,
  'sync_conflict.uk_sync_conflict_scope': 1775501400000,
  'sync_conflict.idx_sync_conflict_organization_status': 1775501400000,
  'record_package_import.idx_record_package_import_organization': 1775501400000,
  'record_package_item.uk_record_package_item_scope': 1775501400000,
  'backup_asset.idx_backup_asset_organization_status': 1775501500000,
  'backup_asset.idx_backup_asset_installation': 1775501900000,
  'backup_restore_run.idx_backup_restore_run_organization': 1775501500000,
  'management_audit_event.idx_management_audit_actor': 1775501500000,
  'management_audit_event.idx_management_audit_organization': 1775501500000,
  'management_audit_event.idx_management_audit_target': 1775501500000,
  'engineer_registration_application.uk_engineer_registration_application_pending_account': 1775401500000,
  'engineer_registration_application.idx_engineer_registration_application_org_status_submitted': 1775401500000,
  'engineer_registration_application.idx_engineer_registration_application_account_submitted': 1775401500000,
};

export const COLUMN_CREATED_BY: Readonly<Record<string, number>> = {
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
  'base_user_account.admin_level': 1775501000000,
  'base_user_account.must_change_password': 1775501000000,
  'base_user_info.real_name': 1775501000000,
  'base_user_info.customer_organization_id': 1775501000000,
  'organization.short_name': 1775501000000,
  'organization.contact_name': 1775501000000,
  'organization.contact_phone': 1775501000000,
  'organization.contact_email': 1775501000000,
  'organization.address': 1775501000000,
  'organization.remark': 1775501000000,
  'organization.is_service_provider': 1775501000000,
  'organization.is_managed_company': 1775501000000,
  'repair_request.intake_id': 1775501100000,
  'repair_request.customer_organization_id': 1775501100000,
  'repair_request.service_organization_id': 1775501100000,
  'repair_request.closure_status': 1775501100000,
  'repair_request.closed_at': 1775501100000,
  'repair_request.closure_reason': 1775501100000,
  'repair_request.current_revision_no': 1775501100000,
  'ai_conversation.owner_organization_id': 1775501100000,
  'ai_conversation.content_version': 1775501100000,
  'ai_message.question_uuid': 1775501100000,
  'ai_message.content_version': 1775501100000,
  'maintenance_report_step.error_code': 1775501100000,
  'maintenance_report_step.result_code': 1775501100000,
  'maintenance_report.supplementary_note': 1775501100000,
  'maintenance_report.handling_result': 1775501100000,
  'maintenance_report.closure_reason': 1775501100000,
  'maintenance_report.reset_result': 1775501100000,
  'maintenance_report.actual_cause': 1775501100000,
  'maintenance_report.repair_actions': 1775501100000,
  'maintenance_report.verification_result': 1775501100000,
  'maintenance_report.submission_request_id': 1775501100000,
  'maintenance_report.submission_payload_hash': 1775501100000,
  'reference_document.publication_status': 1775501100000,
  'reference_document.ownership_status': 1775501100000,
  'reference_document.current_revision_no': 1775501100000,
  'reference_document.source_kind': 1775501100000,
  'reference_document.source_report_id': 1775501100000,
  'reference_document.source_report_version_id': 1775501100000,
  'local_upload_task.record_uuid': 1775501100000,
  'local_upload_task.source_version': 1775501100000,
  'local_upload_task.task_kind': 1775501100000,
  'local_upload_task.manifest_checksum': 1775501100000,
  'local_backup_run.organization_id': 1775501100000,
  'local_backup_run.manual_upload_status': 1775501100000,
  'local_backup_run.manual_cleanup_status': 1775501100000,
  'stored_file.file_id': 1775501200000,
  'stored_file.status': 1775501200000,
  'stored_file.binding_status': 1775501200000,
  'stored_file.checksum_sha256': 1775501200000,
  'repair_request_intake.record_uuid': 1775501200000,
  'repair_request_intake.analysis_status': 1775501200000,
  'repair_request_intake.converted_request_id': 1775501200000,
  'intake_analysis_attempt.status': 1775501200000,
  'intake_analysis_attempt.failure_reason': 1775501200000,
  'repair_process_entry.entry_uuid': 1775501200000,
  'repair_process_entry.version_no': 1775501200000,
  'ai_message_analysis.question_uuid': 1775501200000,
  'ai_message_analysis.status': 1775501200000,
  'maintenance_report_fault.fault_uuid': 1775501300000,
  'maintenance_report_fault.branch_kind': 1775501300000,
  'repair_request_revision.revision_no': 1775501300000,
  'repair_request_revision.previous_version': 1775502100000,
  'repair_request_revision.schema_version': 1775501300000,
  'reference_document_revision.revision_no': 1775501300000,
  'local_account_authorization.authorization_status': 1775501400000,
  'local_company_setting.setting_source': 1775501400000,
  'local_company_setting.is_current': 1775501400000,
  'sync_receipt.receipt_status': 1775501400000,
  'sync_receipt.manifest_checksum': 1775501400000,
  'sync_conflict.status': 1775501400000,
  'record_package_import.status': 1775501400000,
  'record_package_import.check_status': 1775501700000,
  'record_package_import.manifest_checksum': 1775501400000,
  'record_package_item.check_result': 1775501700000,
  'record_package_item.result': 1775501400000,
  'backup_asset.cloud_status': 1775501500000,
  'backup_asset.local_status': 1775501500000,
  'backup_restore_run.status': 1775501500000,
  'management_audit_event.actor_admin_level': 1775501500000,
  'management_audit_event.result': 1775501500000,
  // S5（1775501900000）
  'repair_request.is_historical': 1775501900000,
  'local_company_setting.initialized_at': 1775501900000,
  'local_company_setting.backup_interval_hours': 1775501900000,
  'local_company_setting.backup_enabled': 1775501900000,
  'local_company_setting.next_backup_at': 1775501900000,
  'local_company_setting.last_auto_success_at': 1775501900000,
  'local_company_setting.last_auto_failure_at': 1775501900000,
  'local_company_setting.failure_reason': 1775501900000,
  'local_company_setting.auto_upload_enabled': 1775501900000,
  'local_account_authorization.signed_claims': 1775501900000,
  'local_account_authorization.permission_version': 1775501900000,
  'local_account_authorization.last_verified_at': 1775501900000,
  'sync_receipt.source_installation_id': 1775501900000,
  'sync_receipt.remote_resource_id': 1775501900000,
  'sync_receipt.received_at': 1775501900000,
  'backup_asset.installation_id': 1775501900000,
  'backup_asset.format_version': 1775501900000,
  'backup_asset.data_version': 1775501900000,
  'backup_asset.manifest_checksum': 1775501900000,
  'backup_asset.local_reference': 1775501900000,
  'backup_asset.cloud_reference': 1775501900000,
  'backup_asset.encryption_key_id': 1775501900000,
  'backup_asset.verified_at': 1775501900000,
  'backup_asset.retention_until': 1775501900000,
  'backup_asset.failure_reason': 1775501900000,
  'backup_asset.deleted_at': 1775501900000,
  'backup_asset.local_cleanup_error': 1775501900000,
  'backup_restore_run.target_installation_id': 1775501900000,
  'backup_restore_run.check_status': 1775501900000,
  'backup_restore_run.confirmation': 1775501900000,
  'maintenance_report_fault.main_error': 1775501900000,
  'maintenance_report_fault.unit_error': 1775501900000,
  'maintenance_report_fault.error_type': 1775501900000,
  'maintenance_report_fault.gpib_status': 1775501900000,
  'maintenance_report_fault.status': 1775501900000,
  'maintenance_report_fault.source': 1775501900000,
  'maintenance_report_fault.phase_code': 1775501900000,
  'maintenance_report_fault.is_active': 1775501900000,
  'maintenance_report_fault.lifecycle_status': 1775501900000,
  'maintenance_report_fault.lifecycle_source': 1775501900000,
  // D3（1775502000000）
  'sync_conflict.local_version': 1775502000000,
  'sync_conflict.cloud_version': 1775502000000,
  'sync_conflict.displayed_cloud_version': 1775502000000,
  'sync_conflict.decision': 1775502000000,
  // V13 本期交付（1775501000000—1775502100000）
  'ai_conversation.request_id': 1775501100000,
  'ai_message_analysis.answer_message_id': 1775501200000,
  'ai_message_analysis.completed_at': 1775501200000,
  'ai_message_analysis.content_version': 1775501200000,
  'ai_message_analysis.conversation_id': 1775501200000,
  'ai_message_analysis.failure_reason': 1775501200000,
  'ai_message_analysis.question_message_id': 1775501200000,
  'ai_message_analysis.saved_at': 1775501200000,
  'backup_asset.attempt_count': 1775501500000,
  'backup_asset.backup_id': 1775501500000,
  'backup_asset.byte_size': 1775501500000,
  'backup_asset.cloud_receipt': 1775501500000,
  'backup_asset.created_at': 1775501500000,
  'backup_asset.file_sha256': 1775501500000,
  'backup_asset.last_attempt_at': 1775501500000,
  'backup_asset.local_cleanup_run_id': 1775501500000,
  'backup_asset.organization_id': 1775501500000,
  'backup_asset.run_id': 1775501500000,
  'backup_asset.storage_reference': 1775501500000,
  'backup_asset.updated_at': 1775501500000,
  'backup_restore_run.backup_id': 1775501500000,
  'backup_restore_run.check_snapshot': 1775501500000,
  'backup_restore_run.finished_at': 1775501500000,
  'backup_restore_run.organization_id': 1775501500000,
  'backup_restore_run.protection_backup_id': 1775501900000,
  'backup_restore_run.restore_id': 1775501500000,
  'backup_restore_run.restored_scope': 1775501500000,
  'backup_restore_run.result_summary': 1775501500000,
  'backup_restore_run.started_at': 1775501900000,
  'backup_restore_run.started_by_account_id': 1775501500000,
  'intake_analysis_attempt.finished_at': 1775501200000,
  'intake_analysis_attempt.generation_no': 1775501200000,
  'intake_analysis_attempt.id': 1775501200000,
  'intake_analysis_attempt.intake_id': 1775501200000,
  'intake_analysis_attempt.output_text': 1775501200000,
  'intake_analysis_attempt.provider_call_id': 1775501200000,
  'intake_analysis_attempt.started_at': 1775501200000,
  'local_account_authorization.account_id': 1775501400000,
  'local_account_authorization.authorized_at': 1775501400000,
  'local_account_authorization.created_at': 1775501400000,
  'local_account_authorization.id': 1775501400000,
  'local_account_authorization.installation_id': 1775501400000,
  'local_account_authorization.organization_id': 1775501400000,
  'local_account_authorization.revoked_at': 1775501400000,
  'local_company_setting.created_at': 1775501400000,
  'local_company_setting.id': 1775501400000,
  'local_company_setting.installation_id': 1775501400000,
  'local_company_setting.organization_id': 1775501400000,
  'local_company_setting.updated_at': 1775501400000,
  'maintenance_report_fault.created_at': 1775501300000,
  'maintenance_report_fault.fault_cause': 1775501300000,
  'maintenance_report_fault.fault_description': 1775501300000,
  'maintenance_report_fault.handling_action': 1775501300000,
  'maintenance_report_fault.id': 1775501300000,
  'maintenance_report_fault.panel_snapshot': 1775501300000,
  'maintenance_report_fault.report_id': 1775501300000,
  'maintenance_report_fault.step_code': 1775501300000,
  'maintenance_report_step.action_text': 1775501100000,
  'maintenance_report_step.part_name': 1775501100000,
  'maintenance_report.customer_factory_name': 1775501100000,
  'maintenance_report.equipment_model_text': 1775501100000,
  'maintenance_report.maintenance_engineer_name_snapshot': 1775501100000,
  'management_audit_event.actor_account_id': 1775501500000,
  'management_audit_event.created_at': 1775501500000,
  'management_audit_event.detail': 1775501500000,
  'management_audit_event.event_id': 1775501500000,
  'management_audit_event.operation': 1775502000000,
  'management_audit_event.organization_id': 1775501500000,
  'management_audit_event.target_id': 1775501500000,
  'management_audit_event.target_type': 1775501500000,
  'organization.name': 1775501000000,
  'record_package_import.completed_at': 1775501400000,
  'record_package_import.created_at': 1775501400000,
  'record_package_import.imported_by_account_id': 1775501400000,
  'record_package_import.item_failed': 1775501400000,
  'record_package_import.item_succeeded': 1775501400000,
  'record_package_import.item_total': 1775501400000,
  'record_package_import.manifest_json': 1775501400000,
  'record_package_import.organization_id': 1775501400000,
  'record_package_import.package_id': 1775501400000,
  'record_package_item.created_at': 1775501400000,
  'record_package_item.error_message': 1775501400000,
  'record_package_item.id': 1775501400000,
  'record_package_item.package_id': 1775501400000,
  'record_package_item.receipt_id': 1775501400000,
  'record_package_item.record_uuid': 1775501400000,
  'record_package_item.resource_type': 1775501400000,
  'record_package_item.version_no': 1775501400000,
  'reference_document_revision.actor_account_id': 1775501300000,
  'reference_document_revision.after_snapshot': 1775501300000,
  'reference_document_revision.before_snapshot': 1775501300000,
  'reference_document_revision.created_at': 1775501300000,
  'reference_document_revision.document_id': 1775501300000,
  'reference_document_revision.id': 1775501300000,
  'reference_document_revision.reason': 1775501300000,
  'repair_process_entry.author_account_id': 1775501200000,
  'repair_process_entry.created_at': 1775501200000,
  'repair_process_entry.file_id': 1775501200000,
  'repair_process_entry.id': 1775501200000,
  'repair_process_entry.occurred_at': 1775501200000,
  'repair_process_entry.operation_text': 1775501200000,
  'repair_process_entry.request_id': 1775501200000,
  'repair_process_entry.test_result': 1775501200000,
  'repair_process_entry.time_source': 1775501200000,
  'repair_request_intake.analysis_generation': 1775501200000,
  'repair_request_intake.created_at': 1775501200000,
  'repair_request_intake.customer_account_id': 1775501200000,
  'repair_request_intake.customer_organization_id': 1775501200000,
  'repair_request_intake.deleted_at': 1775501200000,
  'repair_request_intake.equipment_model_id': 1775501200000,
  'repair_request_intake.error_code': 1775501200000,
  'repair_request_intake.fault_description': 1775501200000,
  'repair_request_intake.file_id': 1775501200000,
  'repair_request_intake.id': 1775501200000,
  'repair_request_intake.service_organization_id': 1775501200000,
  'repair_request_revision.actor_account_id': 1775501300000,
  'repair_request_revision.after_snapshot': 1775501300000,
  'repair_request_revision.before_snapshot': 1775501300000,
  'repair_request_revision.created_at': 1775501300000,
  'repair_request_revision.id': 1775501300000,
  'repair_request_revision.reason': 1775501300000,
  'repair_request_revision.request_id': 1775501300000,
  'stored_file.business_id': 1775501200000,
  'stored_file.business_type': 1775501200000,
  'stored_file.byte_size': 1775501200000,
  'stored_file.created_at': 1775501200000,
  'stored_file.mime_type': 1775501200000,
  'stored_file.original_filename': 1775501200000,
  'stored_file.owner_organization_id': 1775501200000,
  'stored_file.storage_reference': 1775501200000,
  'stored_file.upload_context_id': 1775501200000,
  'stored_file.uploaded_by_account_id': 1775501200000,
  'stored_file.verified_at': 1775501200000,
  'sync_conflict.cloud_snapshot': 1775501400000,
  'sync_conflict.confirmed_at': 1775501400000,
  'sync_conflict.confirmed_by_account_id': 1775501400000,
  'sync_conflict.conflict_id': 1775501400000,
  'sync_conflict.conflict_reason': 1775501400000,
  'sync_conflict.created_at': 1775501400000,
  'sync_conflict.local_snapshot': 1775501400000,
  'sync_conflict.organization_id': 1775501400000,
  'sync_conflict.record_uuid': 1775501400000,
  'sync_conflict.resource_type': 1775501400000,
  'sync_conflict.version_no': 1775501400000,
  'sync_receipt.confirmed_at': 1775501900000,
  'sync_receipt.created_at': 1775501400000,
  'sync_receipt.organization_id': 1775501400000,
  'sync_receipt.receipt_id': 1775501400000,
  'sync_receipt.record_uuid': 1775501400000,
  'sync_receipt.resource_type': 1775501400000,
  'sync_receipt.source_system': 1775501900000,
  'sync_receipt.version_no': 1775501400000,
};

export const CHECK_CREATED_BY: Readonly<Record<string, number>> = {
  'equipment_model.chk_equipment_model_enabled': 1775200900000,
  'repair_request.chk_repair_request_acceptance_consistency': 1775201000000,
  'repair_request.chk_repair_request_deletion_consistency': 1775201000000,
  'repair_request.chk_repair_request_is_accepted': 1775201000000,
  'repair_request.chk_repair_request_deprecated': 1775201000000,
  'ai_conversation.chk_ai_conversation_completion': 1775201100000,
  'ai_message.chk_ai_message_seq': 1775201200000,
  'ai_message.chk_ai_message_turn': 1775201200000,
  'ai_message.chk_ai_message_role_turn': 1775201200000,
  'ai_message.chk_ai_message_content': 1775201200000,
  'engineer_response.chk_engineer_response_text': 1775201400000,
  'reference_document.chk_reference_document_deletion_consistency': 1775201500000,
  'reference_document.chk_reference_document_storage_pair': 1775201500000,
  'reference_document.chk_reference_document_deprecated': 1775201500000,
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
  // 31 号迁移在保持约束名不变的前提下替换表达式（NULL 安全）；名称登记仍按 26 号，
  // 因此 24 态不要求、29/30/31 各态均按同一名称预检，旧库不会被新语义提前阻断。
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
  'base_user_account.chk_base_user_account_admin_level': 1775501000000,
  'organization.chk_organization_service_provider': 1775501000000,
  'organization.chk_organization_managed_company': 1775501000000,
  'repair_request.chk_repair_request_new_intake_companies': 1775501100000,
  'repair_request.chk_repair_request_closure': 1775501100000,
  'repair_request.chk_repair_request_closure_reason': 1775501100000,
  'repair_request.chk_repair_request_current_revision': 1775501100000,
  'ai_conversation.chk_ai_conversation_content_version': 1775501100000,
  'ai_message.chk_ai_message_content_version': 1775501100000,
  'maintenance_report_step.chk_maintenance_report_step_result_code': 1775501100000,
  'maintenance_report.chk_maintenance_report_handling_result': 1775501100000,
  'maintenance_report.chk_maintenance_report_reset_result': 1775501100000,
  'maintenance_report.chk_maintenance_report_closure_reason': 1775501100000,
  'maintenance_report.chk_maintenance_report_submission_pair': 1775501100000,
  'reference_document.chk_reference_document_publication': 1775501100000,
  'reference_document.chk_reference_document_ownership': 1775501100000,
  'reference_document.chk_reference_document_report_source_pair': 1775501100000,
  'reference_document.chk_reference_document_content_source_v13': 1775501100000,
  'local_upload_task.chk_local_upload_task_task_kind': 1775501100000,
  'local_upload_task.chk_local_upload_task_manifest_checksum': 1775501100000,
  'local_backup_run.chk_local_backup_run_manual_status': 1775501100000,
  'stored_file.chk_stored_file_size': 1775501200000,
  'stored_file.chk_stored_file_status': 1775501200000,
  'stored_file.chk_stored_file_binding_status': 1775501200000,
  'stored_file.chk_stored_file_binding_pair': 1775501200000,
  'stored_file.chk_stored_file_verified': 1775501200000,
  'stored_file.chk_stored_file_checksum': 1775501200000,
  'stored_file.chk_stored_file_business_type': 1775501200000,
  'repair_request_intake.chk_repair_request_intake_analysis_status': 1775501200000,
  'repair_request_intake.chk_repair_request_intake_generation': 1775501200000,
  'repair_request_intake.chk_repair_request_intake_description': 1775501200000,
  'intake_analysis_attempt.chk_intake_analysis_attempt_generation': 1775501200000,
  'intake_analysis_attempt.chk_intake_analysis_attempt_status': 1775501200000,
  'intake_analysis_attempt.chk_intake_analysis_attempt_failure': 1775501200000,
  'repair_process_entry.chk_repair_process_entry_operation': 1775501200000,
  'repair_process_entry.chk_repair_process_entry_version': 1775501200000,
  'repair_process_entry.chk_repair_process_entry_time_source': 1775501200000,
  'ai_message_analysis.chk_ai_message_analysis_status': 1775501200000,
  'ai_message_analysis.chk_ai_message_analysis_failure': 1775501200000,
  'ai_message_analysis.chk_ai_message_analysis_content_version': 1775501200000,
  'ai_message_analysis.chk_ai_message_analysis_completed': 1775501200000,
  'maintenance_report_fault.chk_maintenance_report_fault_branch': 1775501300000,
  'maintenance_report_fault.chk_maintenance_report_fault_step': 1775501300000,
  'maintenance_report_fault.chk_maintenance_report_fault_description': 1775501300000,
  'maintenance_report_fault.chk_maintenance_report_fault_lifecycle_status': 1775501900000,
  'maintenance_report_fault.chk_maintenance_report_fault_lifecycle_source': 1775501900000,
  'maintenance_report_fault.chk_maintenance_report_fault_description_len': 1775501900000,
  'maintenance_report_fault.chk_maintenance_report_fault_action_len': 1775501900000,
  'repair_request_revision.chk_repair_request_revision_no': 1775501300000,
  'repair_request_revision.chk_repair_request_revision_previous_version': 1775502100000,
  'repair_request_revision.chk_repair_request_revision_schema': 1775501300000,
  'repair_request_revision.chk_repair_request_revision_reason': 1775501300000,
  'reference_document_revision.chk_reference_document_revision_no': 1775501300000,
  'reference_document_revision.chk_reference_document_revision_schema': 1775501300000,
  'reference_document_revision.chk_reference_document_revision_reason': 1775501300000,
  'local_account_authorization.chk_local_account_authorization_status': 1775501400000,
  'local_company_setting.chk_local_company_setting_source': 1775501400000,
  'local_company_setting.chk_local_company_setting_current': 1775501400000,
  'sync_receipt.chk_sync_receipt_status': 1775501400000,
  'sync_receipt.chk_sync_receipt_source': 1775501400000,
  'sync_receipt.chk_sync_receipt_manifest': 1775501400000,
  'sync_receipt.chk_sync_receipt_confirm_time': 1775501900000,
  'sync_conflict.chk_sync_conflict_status': 1775501400000,
  'sync_conflict.chk_sync_conflict_confirmed': 1775501400000,
  'sync_conflict.chk_sync_conflict_schema': 1775501400000,
  'record_package_import.chk_record_package_import_status': 1775501400000,
  'record_package_import.chk_record_package_import_manifest': 1775501400000,
  'record_package_import.chk_record_package_import_counts': 1775501400000,
  'record_package_import.chk_record_package_import_check_status': 1775501700000,
  'record_package_import.chk_record_package_import_check_stage': 1775501700000,
  'record_package_item.chk_record_package_item_result': 1775501400000,
  'record_package_item.chk_record_package_item_error': 1775501400000,
  'record_package_item.chk_record_package_item_check_result': 1775501700000,
  'record_package_item.chk_record_package_item_check_stage': 1775501700000,
  'backup_asset.chk_backup_asset_sha': 1775501500000,
  'backup_asset.chk_backup_asset_size': 1775501500000,
  'backup_asset.chk_backup_asset_cloud_status': 1775501500000,
  'backup_asset.chk_backup_asset_local_status': 1775501500000,
  'backup_asset.chk_backup_asset_cloud_receipt': 1775501500000,
  'backup_asset.chk_backup_asset_attempts': 1775501500000,
  'backup_restore_run.chk_backup_restore_run_status': 1775501500000,
  'backup_restore_run.chk_backup_restore_run_finish': 1775501500000,
  'backup_restore_run.chk_backup_restore_run_protection': 1775501500000,
  'backup_restore_run.chk_backup_restore_run_schema': 1775501500000,
  // S5（1775501900000）
  'backup_restore_run.chk_backup_restore_run_execution_guard': 1775501900000,
  'backup_asset.chk_backup_asset_manifest': 1775501900000,
  'backup_asset.chk_backup_asset_format_version': 1775501900000,
  'backup_asset.chk_backup_asset_local_cleanup': 1775501900000,
  'local_company_setting.chk_local_company_setting_backup_interval': 1775501900000,
  'local_company_setting.chk_local_company_setting_backup_schedule': 1775501900000,
  'local_company_setting.chk_local_company_setting_auto_upload': 1775501900000,
  'backup_restore_run.chk_backup_restore_run_check_status': 1775501900000,
  'backup_restore_run.chk_backup_restore_run_check_outcome': 1775501900000,
  'maintenance_report_fault.chk_maintenance_report_fault_phase_code': 1775501900000,
  'maintenance_report_fault.chk_maintenance_report_fault_active': 1775501900000,
  'local_account_authorization.chk_local_account_authorization_signed_claims': 1775501900000,
  'local_account_authorization.chk_local_account_authorization_permission_version': 1775501900000,
  'management_audit_event.chk_management_audit_level': 1775501500000,
  'management_audit_event.chk_management_audit_operation': 1775501500000,
  'management_audit_event.chk_management_audit_result': 1775501500000,
  'management_audit_event.chk_management_audit_target': 1775501500000,
  // D3（1775502000000）
  'sync_conflict.chk_sync_conflict_versions': 1775502000000,
  'sync_conflict.chk_sync_conflict_decision': 1775502000000,
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
  'base_user_info.fk_base_user_info_customer_organization': 1775501000000,
  'repair_request.fk_repair_request_customer_organization': 1775501100000,
  'repair_request.fk_repair_request_service_organization': 1775501100000,
  'repair_request.fk_repair_request_intake': 1775501200000,
  'ai_conversation.fk_ai_conversation_owner_organization': 1775501100000,
  'reference_document.fk_reference_document_source_report_version': 1775501100000,
  'local_backup_run.fk_local_backup_run_organization': 1775501100000,
  'stored_file.fk_stored_file_uploader': 1775501200000,
  'stored_file.fk_stored_file_owner_organization': 1775501200000,
  'repair_request_intake.fk_repair_request_intake_customer_account': 1775501200000,
  'repair_request_intake.fk_repair_request_intake_customer_organization': 1775501200000,
  'repair_request_intake.fk_repair_request_intake_service_organization': 1775501200000,
  'repair_request_intake.fk_repair_request_intake_equipment_model': 1775501200000,
  'repair_request_intake.fk_repair_request_intake_file': 1775501200000,
  'repair_request_intake.fk_repair_request_intake_converted_request': 1775501200000,
  'intake_analysis_attempt.fk_intake_analysis_attempt_intake': 1775501200000,
  'intake_analysis_attempt.fk_intake_analysis_attempt_provider_call': 1775501200000,
  'repair_process_entry.fk_repair_process_entry_request': 1775501200000,
  'repair_process_entry.fk_repair_process_entry_author': 1775501200000,
  'repair_process_entry.fk_repair_process_entry_file': 1775501200000,
  'ai_message_analysis.fk_ai_message_analysis_conversation': 1775501200000,
  'ai_message_analysis.fk_ai_message_analysis_question_message': 1775501200000,
  'ai_message_analysis.fk_ai_message_analysis_answer_message': 1775501200000,
  'maintenance_report_fault.fk_maintenance_report_fault_report': 1775501300000,
  'maintenance_report_fault.fk_maintenance_report_fault_step': 1775501300000,
  'repair_request_revision.fk_repair_request_revision_request': 1775501300000,
  'repair_request_revision.fk_repair_request_revision_actor': 1775501300000,
  'reference_document_revision.fk_reference_document_revision_document': 1775501300000,
  'reference_document_revision.fk_reference_document_revision_actor': 1775501300000,
  'local_account_authorization.fk_local_account_authorization_installation': 1775501400000,
  'local_account_authorization.fk_local_account_authorization_account': 1775501400000,
  'local_account_authorization.fk_local_account_authorization_organization': 1775501400000,
  'local_company_setting.fk_local_company_setting_installation': 1775501400000,
  'local_company_setting.fk_local_company_setting_organization': 1775501400000,
  'sync_receipt.fk_sync_receipt_organization': 1775501400000,
  'sync_conflict.fk_sync_conflict_organization': 1775501400000,
  'sync_conflict.fk_sync_conflict_confirmer': 1775501400000,
  'record_package_import.fk_record_package_import_organization': 1775501400000,
  'record_package_import.fk_record_package_import_actor': 1775501400000,
  'record_package_item.fk_record_package_item_package': 1775501400000,
  'record_package_item.fk_record_package_item_receipt': 1775501400000,
  'backup_asset.fk_backup_asset_run': 1775501500000,
  'backup_asset.fk_backup_asset_organization': 1775501500000,
  'backup_asset.fk_backup_asset_cleanup_run': 1775501500000,
  'backup_restore_run.fk_backup_restore_run_backup': 1775501500000,
  'backup_restore_run.fk_backup_restore_run_protection': 1775501500000,
  'backup_restore_run.fk_backup_restore_run_organization': 1775501500000,
  'backup_restore_run.fk_backup_restore_run_actor': 1775501500000,
  'backup_restore_run.fk_backup_restore_run_target': 1775501900000,
  'management_audit_event.fk_management_audit_actor': 1775501500000,
  'management_audit_event.fk_management_audit_organization': 1775501500000,
};

/**
 * 关键索引的完整定义：唯一性与有序列。
 */
export interface IndexDefinition {
  readonly unique: boolean;
  readonly columns: ReadonlyArray<string>;
}

/**
 * 关键外键的完整定义：有序本地列、引用表与对应有序引用列。
 */
export interface ForeignKeyDefinition {
  readonly referenceTable: string;
  readonly localColumns: ReadonlyArray<string>;
  readonly referenceColumns: ReadonlyArray<string>;
  /** information_schema.referential_constraints.delete_rule；登记后参与校验 */
  readonly onDelete?: string;
  /** information_schema.referential_constraints.update_rule；登记后参与校验 */
  readonly onUpdate?: string;
}

/**
 * 关键索引列定义，来源为 24 条既有迁移的 DDL，不依赖可能漂移的现网库。
 * 键与 REQUIRED_INDEXES 的 `table.index` 一一对应。
 */
export const INDEX_DEFINITIONS: Readonly<Record<string, IndexDefinition>> = {
  'base_user_account.uk_login_email': { unique: true, columns: ['login_email'] },
  'base_user_account.uk_login_name': { unique: true, columns: ['login_name'] },
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
  'local_upload_task.idx_local_upload_task_record_uuid': {
    unique: false,
    columns: ['record_uuid'],
  },
  'local_backup_run.uk_local_backup_run_active_company': {
    unique: true,
    columns: ['active_installation_id', 'organization_id'],
  },
  'local_backup_run.idx_local_backup_run_started': {
    unique: false,
    columns: ['started_at'],
  },
  'local_backup_run.idx_local_backup_run_organization': {
    unique: false,
    columns: ['organization_id', 'started_at'],
  },
  'base_user_info.idx_base_user_info_customer_organization': {
    unique: false,
    columns: ['customer_organization_id'],
  },
  'repair_request.uk_repair_request_intake': {
    unique: true,
    columns: ['intake_id'],
  },
  'repair_request.idx_repair_request_customer_organization': {
    unique: false,
    columns: ['customer_organization_id', 'created_at'],
  },
  'repair_request.idx_repair_request_service_organization': {
    unique: false,
    columns: ['service_organization_id', 'created_at'],
  },
  'ai_message.uk_ai_message_question_uuid': {
    unique: true,
    columns: ['question_uuid'],
  },
  'ai_conversation.idx_ai_conversation_owner_created': {
    unique: false,
    columns: ['owner_organization_id', 'created_at'],
  },
  'maintenance_report.uk_maintenance_report_submission': {
    unique: true,
    columns: ['created_by_account_id', 'owner_organization_id', 'submission_request_id'],
  },
  'reference_document.uk_reference_document_source_report_version': {
    unique: true,
    columns: ['source_report_version_id'],
  },
  'stored_file.uk_stored_file_upload_context': {
    unique: true,
    columns: ['upload_context_id'],
  },
  'stored_file.idx_stored_file_business': {
    unique: false,
    columns: ['business_type', 'business_id'],
  },
  'stored_file.idx_stored_file_owner_created': {
    unique: false,
    columns: ['owner_organization_id', 'created_at'],
  },
  'stored_file.idx_stored_file_status_created': {
    unique: false,
    columns: ['status', 'created_at'],
  },
  'repair_request_intake.uk_repair_request_intake_record_uuid': {
    unique: true,
    columns: ['record_uuid'],
  },
  'repair_request_intake.uk_repair_request_intake_converted': {
    unique: true,
    columns: ['converted_request_id'],
  },
  'repair_request_intake.idx_repair_request_intake_customer_created': {
    unique: false,
    columns: ['customer_account_id', 'created_at'],
  },
  'repair_request_intake.idx_repair_request_intake_organization_status': {
    unique: false,
    columns: ['customer_organization_id', 'analysis_status'],
  },
  'intake_analysis_attempt.uk_intake_analysis_attempt_generation': {
    unique: true,
    columns: ['intake_id', 'generation_no'],
  },
  'repair_process_entry.uk_repair_process_entry_uuid': {
    unique: true,
    columns: ['entry_uuid'],
  },
  'repair_process_entry.idx_repair_process_entry_request_created': {
    unique: false,
    columns: ['request_id', 'created_at'],
  },
  'ai_message_analysis.uk_ai_message_analysis_question': {
    unique: true,
    columns: ['question_message_id'],
  },
  'ai_message_analysis.idx_ai_message_analysis_conversation_status': {
    unique: false,
    columns: ['conversation_id', 'status'],
  },
  'maintenance_report_fault.uk_maintenance_report_fault_uuid': {
    unique: true,
    columns: ['fault_uuid'],
  },
  'maintenance_report_fault.idx_maintenance_report_fault_report': {
    unique: false,
    columns: ['report_id', 'branch_kind'],
  },
  'repair_request_revision.uk_repair_request_revision_no': {
    unique: true,
    columns: ['request_id', 'revision_no'],
  },
  'reference_document_revision.uk_reference_document_revision_no': {
    unique: true,
    columns: ['document_id', 'revision_no'],
  },
  'local_account_authorization.uk_local_account_authorization_scope': {
    unique: true,
    columns: ['installation_id', 'account_id', 'organization_id'],
  },
  'local_account_authorization.idx_local_account_authorization_account': {
    unique: false,
    columns: ['account_id', 'authorization_status'],
  },
  'local_company_setting.uk_local_company_setting_scope': {
    unique: true,
    columns: ['installation_id', 'organization_id'],
  },
  'sync_receipt.uk_sync_receipt_scope_v13': {
    unique: true,
    columns: ['organization_id', 'resource_type', 'record_uuid', 'version_no'],
  },
  'sync_receipt.idx_sync_receipt_organization_status': {
    unique: false,
    columns: ['organization_id', 'receipt_status', 'created_at'],
  },
  'sync_conflict.uk_sync_conflict_scope': {
    unique: true,
    columns: ['record_uuid', 'organization_id', 'resource_type', 'version_no'],
  },
  'sync_conflict.idx_sync_conflict_organization_status': {
    unique: false,
    columns: ['organization_id', 'status', 'created_at'],
  },
  'record_package_import.idx_record_package_import_organization': {
    unique: false,
    columns: ['organization_id', 'created_at'],
  },
  'record_package_item.uk_record_package_item_scope': {
    unique: true,
    columns: ['package_id', 'record_uuid', 'resource_type', 'version_no'],
  },
  'backup_asset.idx_backup_asset_organization_status': {
    unique: false,
    columns: ['organization_id', 'cloud_status', 'created_at'],
  },
  'backup_asset.idx_backup_asset_installation': {
    unique: false,
    columns: ['installation_id', 'created_at'],
  },
  'backup_restore_run.idx_backup_restore_run_organization': {
    unique: false,
    columns: ['organization_id', 'started_at'],
  },
  'management_audit_event.idx_management_audit_actor': {
    unique: false,
    columns: ['actor_account_id', 'created_at'],
  },
  'management_audit_event.idx_management_audit_organization': {
    unique: false,
    columns: ['organization_id', 'created_at'],
  },
  'management_audit_event.idx_management_audit_target': {
    unique: false,
    columns: ['target_type', 'target_id', 'created_at'],
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
export const FOREIGN_KEY_DEFINITIONS: Readonly<Record<string, ForeignKeyDefinition>> = {
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
  'base_user_info.fk_base_user_info_customer_organization': {
    referenceTable: 'organization',
    localColumns: ['customer_organization_id'],
    referenceColumns: ['id'],
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  },
  'repair_request.fk_repair_request_customer_organization': {
    referenceTable: 'organization',
    localColumns: ['customer_organization_id'],
    referenceColumns: ['id'],
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  },
  'repair_request.fk_repair_request_service_organization': {
    referenceTable: 'organization',
    localColumns: ['service_organization_id'],
    referenceColumns: ['id'],
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  },
  'repair_request.fk_repair_request_intake': {
    referenceTable: 'repair_request_intake',
    localColumns: ['intake_id'],
    referenceColumns: ['id'],
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  },
  'ai_conversation.fk_ai_conversation_owner_organization': {
    referenceTable: 'organization',
    localColumns: ['owner_organization_id'],
    referenceColumns: ['id'],
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  },
  'reference_document.fk_reference_document_source_report_version': {
    referenceTable: 'maintenance_report_version',
    localColumns: ['source_report_version_id', 'source_report_id'],
    referenceColumns: ['id', 'report_id'],
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  },
  'local_backup_run.fk_local_backup_run_organization': {
    referenceTable: 'organization',
    localColumns: ['organization_id'],
    referenceColumns: ['id'],
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  },
  'stored_file.fk_stored_file_uploader': {
    referenceTable: 'base_user_account',
    localColumns: ['uploaded_by_account_id'],
    referenceColumns: ['id'],
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  },
  'stored_file.fk_stored_file_owner_organization': {
    referenceTable: 'organization',
    localColumns: ['owner_organization_id'],
    referenceColumns: ['id'],
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  },
  'repair_request_intake.fk_repair_request_intake_customer_account': {
    referenceTable: 'base_user_account',
    localColumns: ['customer_account_id'],
    referenceColumns: ['id'],
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  },
  'repair_request_intake.fk_repair_request_intake_customer_organization': {
    referenceTable: 'organization',
    localColumns: ['customer_organization_id'],
    referenceColumns: ['id'],
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  },
  'repair_request_intake.fk_repair_request_intake_service_organization': {
    referenceTable: 'organization',
    localColumns: ['service_organization_id'],
    referenceColumns: ['id'],
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  },
  'repair_request_intake.fk_repair_request_intake_equipment_model': {
    referenceTable: 'equipment_model',
    localColumns: ['equipment_model_id'],
    referenceColumns: ['id'],
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  },
  'repair_request_intake.fk_repair_request_intake_file': {
    referenceTable: 'stored_file',
    localColumns: ['file_id'],
    referenceColumns: ['file_id'],
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  },
  'repair_request_intake.fk_repair_request_intake_converted_request': {
    referenceTable: 'repair_request',
    localColumns: ['converted_request_id'],
    referenceColumns: ['id'],
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  },
  'intake_analysis_attempt.fk_intake_analysis_attempt_intake': {
    referenceTable: 'repair_request_intake',
    localColumns: ['intake_id'],
    referenceColumns: ['id'],
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  },
  'intake_analysis_attempt.fk_intake_analysis_attempt_provider_call': {
    referenceTable: 'ai_provider_call_record',
    localColumns: ['provider_call_id'],
    referenceColumns: ['id'],
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  },
  'repair_process_entry.fk_repair_process_entry_request': {
    referenceTable: 'repair_request',
    localColumns: ['request_id'],
    referenceColumns: ['id'],
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  },
  'repair_process_entry.fk_repair_process_entry_author': {
    referenceTable: 'base_user_account',
    localColumns: ['author_account_id'],
    referenceColumns: ['id'],
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  },
  'repair_process_entry.fk_repair_process_entry_file': {
    referenceTable: 'stored_file',
    localColumns: ['file_id'],
    referenceColumns: ['file_id'],
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  },
  'ai_message_analysis.fk_ai_message_analysis_conversation': {
    referenceTable: 'ai_conversation',
    localColumns: ['conversation_id'],
    referenceColumns: ['id'],
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  },
  'ai_message_analysis.fk_ai_message_analysis_question_message': {
    referenceTable: 'ai_message',
    localColumns: ['question_message_id'],
    referenceColumns: ['id'],
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  },
  'ai_message_analysis.fk_ai_message_analysis_answer_message': {
    referenceTable: 'ai_message',
    localColumns: ['answer_message_id'],
    referenceColumns: ['id'],
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  },
  'maintenance_report_fault.fk_maintenance_report_fault_report': {
    referenceTable: 'maintenance_report',
    localColumns: ['report_id'],
    referenceColumns: ['id'],
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  },
  'maintenance_report_fault.fk_maintenance_report_fault_step': {
    referenceTable: 'maintenance_report_step',
    localColumns: ['report_id', 'step_code'],
    referenceColumns: ['report_id', 'step_code'],
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  },
  'repair_request_revision.fk_repair_request_revision_request': {
    referenceTable: 'repair_request',
    localColumns: ['request_id'],
    referenceColumns: ['id'],
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  },
  'repair_request_revision.fk_repair_request_revision_actor': {
    referenceTable: 'base_user_account',
    localColumns: ['actor_account_id'],
    referenceColumns: ['id'],
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  },
  'reference_document_revision.fk_reference_document_revision_document': {
    referenceTable: 'reference_document',
    localColumns: ['document_id'],
    referenceColumns: ['id'],
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  },
  'reference_document_revision.fk_reference_document_revision_actor': {
    referenceTable: 'base_user_account',
    localColumns: ['actor_account_id'],
    referenceColumns: ['id'],
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  },
  'local_account_authorization.fk_local_account_authorization_installation': {
    referenceTable: 'local_installation',
    localColumns: ['installation_id'],
    referenceColumns: ['installation_id'],
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  },
  'local_account_authorization.fk_local_account_authorization_account': {
    referenceTable: 'base_user_account',
    localColumns: ['account_id'],
    referenceColumns: ['id'],
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  },
  'local_account_authorization.fk_local_account_authorization_organization': {
    referenceTable: 'organization',
    localColumns: ['organization_id'],
    referenceColumns: ['id'],
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  },
  'local_company_setting.fk_local_company_setting_installation': {
    referenceTable: 'local_installation',
    localColumns: ['installation_id'],
    referenceColumns: ['installation_id'],
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  },
  'local_company_setting.fk_local_company_setting_organization': {
    referenceTable: 'organization',
    localColumns: ['organization_id'],
    referenceColumns: ['id'],
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  },
  'sync_receipt.fk_sync_receipt_organization': {
    referenceTable: 'organization',
    localColumns: ['organization_id'],
    referenceColumns: ['id'],
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  },
  'sync_conflict.fk_sync_conflict_organization': {
    referenceTable: 'organization',
    localColumns: ['organization_id'],
    referenceColumns: ['id'],
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  },
  'sync_conflict.fk_sync_conflict_confirmer': {
    referenceTable: 'base_user_account',
    localColumns: ['confirmed_by_account_id'],
    referenceColumns: ['id'],
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  },
  'record_package_import.fk_record_package_import_organization': {
    referenceTable: 'organization',
    localColumns: ['organization_id'],
    referenceColumns: ['id'],
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  },
  'record_package_import.fk_record_package_import_actor': {
    referenceTable: 'base_user_account',
    localColumns: ['imported_by_account_id'],
    referenceColumns: ['id'],
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  },
  'record_package_item.fk_record_package_item_package': {
    referenceTable: 'record_package_import',
    localColumns: ['package_id'],
    referenceColumns: ['package_id'],
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  },
  'record_package_item.fk_record_package_item_receipt': {
    referenceTable: 'sync_receipt',
    localColumns: ['receipt_id'],
    referenceColumns: ['receipt_id'],
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  },
  'backup_asset.fk_backup_asset_run': {
    referenceTable: 'local_backup_run',
    localColumns: ['run_id'],
    referenceColumns: ['id'],
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  },
  'backup_asset.fk_backup_asset_organization': {
    referenceTable: 'organization',
    localColumns: ['organization_id'],
    referenceColumns: ['id'],
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  },
  'backup_asset.fk_backup_asset_cleanup_run': {
    referenceTable: 'local_backup_run',
    localColumns: ['local_cleanup_run_id'],
    referenceColumns: ['id'],
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  },
  'backup_restore_run.fk_backup_restore_run_backup': {
    referenceTable: 'backup_asset',
    localColumns: ['backup_id'],
    referenceColumns: ['backup_id'],
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  },
  'backup_restore_run.fk_backup_restore_run_protection': {
    referenceTable: 'backup_asset',
    localColumns: ['protection_backup_id'],
    referenceColumns: ['backup_id'],
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  },
  'backup_restore_run.fk_backup_restore_run_organization': {
    referenceTable: 'organization',
    localColumns: ['organization_id'],
    referenceColumns: ['id'],
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  },
  'backup_restore_run.fk_backup_restore_run_actor': {
    referenceTable: 'base_user_account',
    localColumns: ['started_by_account_id'],
    referenceColumns: ['id'],
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  },
  'backup_restore_run.fk_backup_restore_run_target': {
    referenceTable: 'local_installation',
    localColumns: ['target_installation_id'],
    referenceColumns: ['installation_id'],
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  },
  'management_audit_event.fk_management_audit_actor': {
    referenceTable: 'base_user_account',
    localColumns: ['actor_account_id'],
    referenceColumns: ['id'],
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  },
  'management_audit_event.fk_management_audit_organization': {
    referenceTable: 'organization',
    localColumns: ['organization_id'],
    referenceColumns: ['id'],
    onDelete: 'RESTRICT',
    onUpdate: 'RESTRICT',
  },
};

export type PrefixStructureKind = 'table' | 'index' | 'column' | 'check' | 'foreign_key';
/* eslint-enable @typescript-eslint/naming-convention */

/**
 * 列定义契约：类型/长度/符号、可空、默认值与生成表达式。
 * since 为生效该定义的迁移时间戳；只有该迁移已执行时才比较，避免误伤合法中间前缀。
 */
export interface ColumnDefinition {
  readonly since: number;
  /** information_schema.columns.column_type，如 int unsigned / varchar(64) / tinyint(1) */
  readonly columnType: string;
  readonly nullable: boolean;
  /** information_schema 口径的默认值；null 表示 SQL NULL（含未显式声明默认） */
  readonly defaultValue?: string | null;
  /** 生成列表达式；普通列必须为 null */
  readonly generatedExpression?: string | null;
}

/**
 * CHECK 约束表达式契约。clause 使用与迁移 DDL 一致的文本，
 * 校验时按 token 规范化后比较，保留字符串字面量、JSON 路径与括号优先级。
 */
export interface CheckStageDefinition {
  readonly since: number;
  readonly clause: string;
}

export interface CheckDefinition extends CheckStageDefinition {
  /**
   * 早期阶段有效定义，按 since 升序排列；当前 since/clause 为最新阶段。
   * 仅登记确有表达式变化的阶段，用于旧前缀按旧定义校验、终态按最新定义校验。
   */
  readonly stages?: ReadonlyArray<CheckStageDefinition>;
}

/**
 * 本期交付（V13 增量迁移 1775501000000—1775502100000）新增/变更列的精确定义。
 * 键与 REQUIRED_COLUMNS 的 `table.column` 对应，且是该列在 since 时刻之后的终态定义。
 * 覆盖范围由 DELIVERY_STRUCTURE_REGISTRY 显式登记，不再按时间戳推断。
 */
/* eslint-disable @typescript-eslint/naming-convention -- 键为 table.column / table.constraint 结构标识 */
export const COLUMN_DEFINITIONS: Readonly<Record<string, ColumnDefinition>> = {
  'repair_request.is_historical': {
    since: 1775501900000,
    columnType: 'tinyint(1)',
    nullable: false,
    defaultValue: '0',
  },
  'local_company_setting.initialized_at': {
    since: 1775501900000,
    columnType: 'timestamp(3)',
    nullable: false,
    defaultValue: 'CURRENT_TIMESTAMP(3)',
  },
  'local_company_setting.backup_interval_hours': {
    since: 1775501900000,
    columnType: 'int unsigned',
    nullable: false,
    defaultValue: '72',
  },
  'local_company_setting.backup_enabled': {
    since: 1775501900000,
    columnType: 'tinyint(1)',
    nullable: false,
    defaultValue: '0',
  },
  'local_company_setting.next_backup_at': {
    since: 1775501900000,
    columnType: 'timestamp(3)',
    nullable: true,
    defaultValue: null,
  },
  'local_company_setting.last_auto_success_at': {
    since: 1775501900000,
    columnType: 'timestamp(3)',
    nullable: true,
    defaultValue: null,
  },
  'local_company_setting.last_auto_failure_at': {
    since: 1775501900000,
    columnType: 'timestamp(3)',
    nullable: true,
    defaultValue: null,
  },
  'local_company_setting.failure_reason': {
    since: 1775501900000,
    columnType: 'text',
    nullable: true,
    defaultValue: null,
  },
  'local_company_setting.auto_upload_enabled': {
    since: 1775501900000,
    columnType: 'tinyint(1)',
    nullable: false,
    defaultValue: '0',
  },
  'local_account_authorization.signed_claims': {
    since: 1775501900000,
    columnType: 'json',
    nullable: true,
    defaultValue: null,
  },
  'local_account_authorization.permission_version': {
    since: 1775501900000,
    columnType: 'int unsigned',
    nullable: true,
    defaultValue: null,
  },
  'local_account_authorization.last_verified_at': {
    since: 1775501900000,
    columnType: 'timestamp(3)',
    nullable: true,
    defaultValue: null,
  },
  'sync_receipt.source_installation_id': {
    since: 1775501900000,
    columnType: 'char(36)',
    nullable: true,
    defaultValue: null,
  },
  'sync_receipt.remote_resource_id': {
    since: 1775501900000,
    columnType: 'varchar(64)',
    nullable: true,
    defaultValue: null,
  },
  'sync_receipt.received_at': {
    since: 1775501900000,
    columnType: 'timestamp(3)',
    nullable: true,
    defaultValue: null,
  },
  'backup_asset.installation_id': {
    since: 1775501900000,
    columnType: 'char(36)',
    nullable: true,
    defaultValue: null,
  },
  'backup_asset.format_version': {
    since: 1775501900000,
    columnType: 'int unsigned',
    nullable: true,
    defaultValue: null,
  },
  'backup_asset.data_version': {
    since: 1775501900000,
    columnType: 'varchar(64)',
    nullable: true,
    defaultValue: null,
  },
  'backup_asset.manifest_checksum': {
    since: 1775501900000,
    columnType: 'char(64)',
    nullable: true,
    defaultValue: null,
  },
  'backup_asset.local_reference': {
    since: 1775501900000,
    columnType: 'varchar(1024)',
    nullable: true,
    defaultValue: null,
  },
  'backup_asset.cloud_reference': {
    since: 1775501900000,
    columnType: 'varchar(1024)',
    nullable: true,
    defaultValue: null,
  },
  'backup_asset.encryption_key_id': {
    since: 1775501900000,
    columnType: 'varchar(128)',
    nullable: true,
    defaultValue: null,
  },
  'backup_asset.verified_at': {
    since: 1775501900000,
    columnType: 'timestamp(3)',
    nullable: true,
    defaultValue: null,
  },
  'backup_asset.retention_until': {
    since: 1775501900000,
    columnType: 'timestamp(3)',
    nullable: true,
    defaultValue: null,
  },
  'backup_asset.failure_reason': {
    since: 1775501900000,
    columnType: 'text',
    nullable: true,
    defaultValue: null,
  },
  'backup_asset.deleted_at': {
    since: 1775501900000,
    columnType: 'timestamp(3)',
    nullable: true,
    defaultValue: null,
  },
  'backup_asset.local_cleanup_error': {
    since: 1775501900000,
    columnType: 'text',
    nullable: true,
    defaultValue: null,
  },
  'backup_restore_run.target_installation_id': {
    since: 1775501900000,
    columnType: 'char(36)',
    nullable: true,
    defaultValue: null,
  },
  'backup_restore_run.check_status': {
    since: 1775501900000,
    columnType: 'varchar(16)',
    nullable: true,
    defaultValue: null,
  },
  'backup_restore_run.confirmation': {
    since: 1775501900000,
    columnType: 'json',
    nullable: true,
    defaultValue: null,
  },
  'maintenance_report_fault.main_error': {
    since: 1775501900000,
    columnType: 'varchar(300)',
    nullable: true,
    defaultValue: null,
  },
  'maintenance_report_fault.unit_error': {
    since: 1775501900000,
    columnType: 'varchar(300)',
    nullable: true,
    defaultValue: null,
  },
  'maintenance_report_fault.error_type': {
    since: 1775501900000,
    columnType: 'varchar(300)',
    nullable: true,
    defaultValue: null,
  },
  'maintenance_report_fault.gpib_status': {
    since: 1775501900000,
    columnType: 'varchar(300)',
    nullable: true,
    defaultValue: null,
  },
  'maintenance_report_fault.status': {
    since: 1775501900000,
    columnType: 'varchar(300)',
    nullable: true,
    defaultValue: null,
  },
  'maintenance_report_fault.source': {
    since: 1775501900000,
    columnType: 'varchar(300)',
    nullable: true,
    defaultValue: null,
  },
  'maintenance_report_fault.phase_code': {
    since: 1775501900000,
    columnType: 'varchar(32)',
    nullable: true,
    defaultValue: null,
  },
  'maintenance_report_fault.is_active': {
    since: 1775501900000,
    columnType: 'tinyint(1)',
    nullable: true,
    defaultValue: null,
  },
  'maintenance_report_fault.lifecycle_status': {
    since: 1775501900000,
    columnType: 'varchar(16)',
    nullable: false,
    defaultValue: null,
  },
  'maintenance_report_fault.lifecycle_source': {
    since: 1775501900000,
    columnType: 'varchar(16)',
    nullable: false,
    defaultValue: null,
  },
  // D3（1775502000000）：同步冲突版本与选择事实；旧行 NULL 表示历史未知
  'sync_conflict.local_version': {
    since: 1775502000000,
    columnType: 'int unsigned',
    nullable: true,
    defaultValue: null,
  },
  'sync_conflict.cloud_version': {
    since: 1775502000000,
    columnType: 'int unsigned',
    nullable: true,
    defaultValue: null,
  },
  'sync_conflict.displayed_cloud_version': {
    since: 1775502000000,
    columnType: 'int unsigned',
    nullable: true,
    defaultValue: null,
  },
  'sync_conflict.decision': {
    since: 1775502000000,
    columnType: 'varchar(24)',
    nullable: true,
    defaultValue: 'PENDING',
  },
  // V13 本期交付（1775501000000—1775502100000）：字段精确定义
  'ai_conversation.content_version': {
    since: 1775501100000,
    columnType: 'int unsigned',
    nullable: false,
    defaultValue: '1',
  },
  'ai_conversation.owner_organization_id': {
    since: 1775501100000,
    columnType: 'int',
    nullable: true,
    defaultValue: null,
  },
  'ai_conversation.request_id': {
    since: 1775501100000,
    columnType: 'int',
    nullable: true,
    defaultValue: null,
  },
  'ai_message_analysis.answer_message_id': {
    since: 1775501200000,
    columnType: 'int',
    nullable: true,
    defaultValue: null,
  },
  'ai_message_analysis.completed_at': {
    since: 1775501200000,
    columnType: 'timestamp(3)',
    nullable: true,
    defaultValue: null,
  },
  'ai_message_analysis.content_version': {
    since: 1775501200000,
    columnType: 'int unsigned',
    nullable: false,
    defaultValue: null,
  },
  'ai_message_analysis.conversation_id': {
    since: 1775501200000,
    columnType: 'int',
    nullable: false,
    defaultValue: null,
  },
  'ai_message_analysis.failure_reason': {
    since: 1775501200000,
    columnType: 'text',
    nullable: true,
    defaultValue: null,
  },
  'ai_message_analysis.question_message_id': {
    since: 1775501200000,
    columnType: 'int',
    nullable: false,
    defaultValue: null,
  },
  'ai_message_analysis.question_uuid': {
    since: 1775501200000,
    columnType: 'char(36)',
    nullable: false,
    defaultValue: null,
  },
  'ai_message_analysis.saved_at': {
    since: 1775501200000,
    columnType: 'timestamp(3)',
    nullable: false,
    defaultValue: 'CURRENT_TIMESTAMP(3)',
  },
  'ai_message_analysis.status': {
    since: 1775501200000,
    columnType: 'varchar(16)',
    nullable: false,
    defaultValue: null,
  },
  'ai_message.content_version': {
    since: 1775501100000,
    columnType: 'int unsigned',
    nullable: false,
    defaultValue: '1',
  },
  'ai_message.question_uuid': {
    since: 1775501100000,
    columnType: 'char(36)',
    nullable: true,
    defaultValue: null,
  },
  'backup_asset.attempt_count': {
    since: 1775501500000,
    columnType: 'int unsigned',
    nullable: false,
    defaultValue: '0',
  },
  'backup_asset.backup_id': {
    since: 1775501500000,
    columnType: 'char(36)',
    nullable: false,
    defaultValue: null,
  },
  'backup_asset.byte_size': {
    since: 1775501500000,
    columnType: 'bigint unsigned',
    nullable: false,
    defaultValue: null,
  },
  'backup_asset.cloud_receipt': {
    since: 1775501500000,
    columnType: 'text',
    nullable: true,
    defaultValue: null,
  },
  'backup_asset.cloud_status': {
    since: 1775501500000,
    columnType: 'varchar(16)',
    nullable: false,
    defaultValue: null,
  },
  'backup_asset.created_at': {
    since: 1775501500000,
    columnType: 'timestamp(3)',
    nullable: false,
    defaultValue: 'CURRENT_TIMESTAMP(3)',
  },
  'backup_asset.file_sha256': {
    since: 1775501500000,
    columnType: 'char(64)',
    nullable: false,
    defaultValue: null,
  },
  'backup_asset.last_attempt_at': {
    since: 1775501500000,
    columnType: 'timestamp(3)',
    nullable: true,
    defaultValue: null,
  },
  'backup_asset.local_cleanup_run_id': {
    since: 1775501500000,
    columnType: 'int',
    nullable: true,
    defaultValue: null,
  },
  'backup_asset.local_status': {
    since: 1775501500000,
    columnType: 'varchar(16)',
    nullable: false,
    defaultValue: null,
  },
  'backup_asset.organization_id': {
    since: 1775501500000,
    columnType: 'int',
    nullable: false,
    defaultValue: null,
  },
  'backup_asset.run_id': {
    since: 1775501500000,
    columnType: 'int',
    nullable: false,
    defaultValue: null,
  },
  'backup_asset.storage_reference': {
    since: 1775501500000,
    columnType: 'varchar(1024)',
    nullable: false,
    defaultValue: null,
  },
  'backup_asset.updated_at': {
    since: 1775501500000,
    columnType: 'timestamp(3)',
    nullable: false,
    defaultValue: 'CURRENT_TIMESTAMP(3)',
  },
  'backup_restore_run.backup_id': {
    since: 1775501500000,
    columnType: 'char(36)',
    nullable: false,
    defaultValue: null,
  },
  'backup_restore_run.check_snapshot': {
    since: 1775501500000,
    columnType: 'longtext',
    nullable: false,
    defaultValue: null,
  },
  'backup_restore_run.finished_at': {
    since: 1775501500000,
    columnType: 'timestamp(3)',
    nullable: true,
    defaultValue: null,
  },
  'backup_restore_run.organization_id': {
    since: 1775501500000,
    columnType: 'int',
    nullable: false,
    defaultValue: null,
  },
  'backup_restore_run.protection_backup_id': {
    since: 1775501900000,
    columnType: 'char(36)',
    nullable: true,
    defaultValue: null,
  },
  'backup_restore_run.restore_id': {
    since: 1775501500000,
    columnType: 'char(36)',
    nullable: false,
    defaultValue: null,
  },
  'backup_restore_run.restored_scope': {
    since: 1775501500000,
    columnType: 'text',
    nullable: true,
    defaultValue: null,
  },
  'backup_restore_run.result_summary': {
    since: 1775501500000,
    columnType: 'text',
    nullable: true,
    defaultValue: null,
  },
  'backup_restore_run.started_at': {
    since: 1775501900000,
    columnType: 'timestamp(3)',
    nullable: true,
    defaultValue: null,
  },
  'backup_restore_run.started_by_account_id': {
    since: 1775501500000,
    columnType: 'int',
    nullable: false,
    defaultValue: null,
  },
  'backup_restore_run.status': {
    since: 1775501500000,
    columnType: 'varchar(16)',
    nullable: false,
    defaultValue: null,
  },
  'base_user_account.admin_level': {
    since: 1775501000000,
    columnType: 'tinyint',
    nullable: true,
    defaultValue: null,
  },
  'base_user_account.must_change_password': {
    since: 1775501000000,
    columnType: 'tinyint(1)',
    nullable: false,
    defaultValue: '0',
  },
  'base_user_info.customer_organization_id': {
    since: 1775501000000,
    columnType: 'int',
    nullable: true,
    defaultValue: null,
  },
  'base_user_info.real_name': {
    since: 1775501000000,
    columnType: 'varchar(200)',
    nullable: true,
    defaultValue: null,
  },
  'intake_analysis_attempt.failure_reason': {
    since: 1775501200000,
    columnType: 'text',
    nullable: true,
    defaultValue: null,
  },
  'intake_analysis_attempt.finished_at': {
    since: 1775501200000,
    columnType: 'timestamp(3)',
    nullable: true,
    defaultValue: null,
  },
  'intake_analysis_attempt.generation_no': {
    since: 1775501200000,
    columnType: 'int unsigned',
    nullable: false,
    defaultValue: null,
  },
  'intake_analysis_attempt.id': {
    since: 1775501200000,
    columnType: 'bigint',
    nullable: false,
    defaultValue: null,
  },
  'intake_analysis_attempt.intake_id': {
    since: 1775501200000,
    columnType: 'int',
    nullable: false,
    defaultValue: null,
  },
  'intake_analysis_attempt.output_text': {
    since: 1775501200000,
    columnType: 'longtext',
    nullable: true,
    defaultValue: null,
  },
  'intake_analysis_attempt.provider_call_id': {
    since: 1775501200000,
    columnType: 'int',
    nullable: true,
    defaultValue: null,
  },
  'intake_analysis_attempt.started_at': {
    since: 1775501200000,
    columnType: 'timestamp(3)',
    nullable: true,
    defaultValue: null,
  },
  'intake_analysis_attempt.status': {
    since: 1775501200000,
    columnType: 'varchar(16)',
    nullable: false,
    defaultValue: null,
  },
  'local_account_authorization.account_id': {
    since: 1775501400000,
    columnType: 'int',
    nullable: false,
    defaultValue: null,
  },
  'local_account_authorization.authorization_status': {
    since: 1775501400000,
    columnType: 'varchar(16)',
    nullable: false,
    defaultValue: null,
  },
  'local_account_authorization.authorized_at': {
    since: 1775501400000,
    columnType: 'timestamp(3)',
    nullable: false,
    defaultValue: 'CURRENT_TIMESTAMP(3)',
  },
  'local_account_authorization.created_at': {
    since: 1775501400000,
    columnType: 'timestamp(3)',
    nullable: false,
    defaultValue: 'CURRENT_TIMESTAMP(3)',
  },
  'local_account_authorization.id': {
    since: 1775501400000,
    columnType: 'bigint',
    nullable: false,
    defaultValue: null,
  },
  'local_account_authorization.installation_id': {
    since: 1775501400000,
    columnType: 'char(36)',
    nullable: false,
    defaultValue: null,
  },
  'local_account_authorization.organization_id': {
    since: 1775501400000,
    columnType: 'int',
    nullable: false,
    defaultValue: null,
  },
  'local_account_authorization.revoked_at': {
    since: 1775501400000,
    columnType: 'timestamp(3)',
    nullable: true,
    defaultValue: null,
  },
  'local_backup_run.manual_cleanup_status': {
    since: 1775501100000,
    columnType: 'varchar(16)',
    nullable: true,
    defaultValue: null,
  },
  'local_backup_run.manual_upload_status': {
    since: 1775501100000,
    columnType: 'varchar(16)',
    nullable: true,
    defaultValue: null,
  },
  'local_backup_run.organization_id': {
    since: 1775501100000,
    columnType: 'int',
    nullable: true,
    defaultValue: null,
  },
  'local_company_setting.created_at': {
    since: 1775501400000,
    columnType: 'timestamp(3)',
    nullable: false,
    defaultValue: 'CURRENT_TIMESTAMP(3)',
  },
  'local_company_setting.id': {
    since: 1775501400000,
    columnType: 'bigint',
    nullable: false,
    defaultValue: null,
  },
  'local_company_setting.installation_id': {
    since: 1775501400000,
    columnType: 'char(36)',
    nullable: false,
    defaultValue: null,
  },
  'local_company_setting.is_current': {
    since: 1775501400000,
    columnType: 'tinyint(1)',
    nullable: false,
    defaultValue: '0',
  },
  'local_company_setting.organization_id': {
    since: 1775501400000,
    columnType: 'int',
    nullable: false,
    defaultValue: null,
  },
  'local_company_setting.setting_source': {
    since: 1775501400000,
    columnType: 'varchar(24)',
    nullable: false,
    defaultValue: null,
  },
  'local_company_setting.updated_at': {
    since: 1775501400000,
    columnType: 'timestamp(3)',
    nullable: false,
    defaultValue: 'CURRENT_TIMESTAMP(3)',
  },
  'local_upload_task.manifest_checksum': {
    since: 1775501100000,
    columnType: 'char(64)',
    nullable: true,
    defaultValue: null,
  },
  'local_upload_task.record_uuid': {
    since: 1775501100000,
    columnType: 'char(36)',
    nullable: true,
    defaultValue: null,
  },
  'local_upload_task.source_version': {
    since: 1775501100000,
    columnType: 'int unsigned',
    nullable: true,
    defaultValue: null,
  },
  'local_upload_task.task_kind': {
    since: 1775501100000,
    columnType: 'varchar(32)',
    nullable: true,
    defaultValue: null,
  },
  'maintenance_report_fault.branch_kind': {
    since: 1775501300000,
    columnType: 'varchar(32)',
    nullable: false,
    defaultValue: null,
  },
  'maintenance_report_fault.created_at': {
    since: 1775501300000,
    columnType: 'timestamp(3)',
    nullable: false,
    defaultValue: 'CURRENT_TIMESTAMP(3)',
  },
  'maintenance_report_fault.fault_cause': {
    since: 1775501300000,
    columnType: 'text',
    nullable: true,
    defaultValue: null,
  },
  'maintenance_report_fault.fault_description': {
    since: 1775501300000,
    columnType: 'text',
    nullable: false,
    defaultValue: null,
  },
  'maintenance_report_fault.fault_uuid': {
    since: 1775501300000,
    columnType: 'char(36)',
    nullable: false,
    defaultValue: null,
  },
  'maintenance_report_fault.handling_action': {
    since: 1775501300000,
    columnType: 'longtext',
    nullable: true,
    defaultValue: null,
  },
  'maintenance_report_fault.id': {
    since: 1775501300000,
    columnType: 'bigint',
    nullable: false,
    defaultValue: null,
  },
  'maintenance_report_fault.panel_snapshot': {
    since: 1775501300000,
    columnType: 'longtext',
    nullable: true,
    defaultValue: null,
  },
  'maintenance_report_fault.report_id': {
    since: 1775501300000,
    columnType: 'int',
    nullable: false,
    defaultValue: null,
  },
  'maintenance_report_fault.step_code': {
    since: 1775501300000,
    columnType: 'varchar(64)',
    nullable: true,
    defaultValue: null,
  },
  'maintenance_report_step.action_text': {
    since: 1775501100000,
    columnType: 'longtext',
    nullable: false,
    defaultValue: null,
  },
  'maintenance_report_step.error_code': {
    since: 1775501100000,
    columnType: 'varchar(300)',
    nullable: true,
    defaultValue: null,
  },
  'maintenance_report_step.part_name': {
    since: 1775501100000,
    columnType: 'varchar(300)',
    nullable: true,
    defaultValue: null,
  },
  'maintenance_report_step.result_code': {
    since: 1775501100000,
    columnType: 'varchar(16)',
    nullable: true,
    defaultValue: null,
  },
  'maintenance_report_step.step_no': {
    since: 1775501100000,
    columnType: 'int unsigned',
    nullable: false,
    defaultValue: null,
  },
  'maintenance_report.actual_cause': {
    since: 1775501100000,
    columnType: 'text',
    nullable: true,
    defaultValue: null,
  },
  'maintenance_report.closure_reason': {
    since: 1775501100000,
    columnType: 'text',
    nullable: true,
    defaultValue: null,
  },
  'maintenance_report.customer_factory_name': {
    since: 1775501100000,
    columnType: 'varchar(200)',
    nullable: true,
    defaultValue: null,
  },
  'maintenance_report.equipment_model_text': {
    since: 1775501100000,
    columnType: 'varchar(200)',
    nullable: true,
    defaultValue: null,
  },
  'maintenance_report.handling_result': {
    since: 1775501100000,
    columnType: 'varchar(32)',
    nullable: true,
    defaultValue: null,
  },
  'maintenance_report.maintenance_engineer_name_snapshot': {
    since: 1775501100000,
    columnType: 'varchar(200)',
    nullable: false,
    defaultValue: null,
  },
  'maintenance_report.repair_actions': {
    since: 1775501100000,
    columnType: 'longtext',
    nullable: true,
    defaultValue: null,
  },
  'maintenance_report.reset_result': {
    since: 1775501100000,
    columnType: 'varchar(24)',
    nullable: true,
    defaultValue: null,
  },
  'maintenance_report.submission_payload_hash': {
    since: 1775501100000,
    columnType: 'char(64)',
    nullable: true,
    defaultValue: null,
  },
  'maintenance_report.submission_request_id': {
    since: 1775501100000,
    columnType: 'varchar(64)',
    nullable: true,
    defaultValue: null,
  },
  'maintenance_report.supplementary_note': {
    since: 1775501100000,
    columnType: 'longtext',
    nullable: true,
    defaultValue: null,
  },
  'maintenance_report.verification_result': {
    since: 1775501100000,
    columnType: 'text',
    nullable: true,
    defaultValue: null,
  },
  'management_audit_event.actor_account_id': {
    since: 1775501500000,
    columnType: 'int',
    nullable: false,
    defaultValue: null,
  },
  'management_audit_event.actor_admin_level': {
    since: 1775501500000,
    columnType: 'tinyint',
    nullable: false,
    defaultValue: null,
  },
  'management_audit_event.created_at': {
    since: 1775501500000,
    columnType: 'timestamp(3)',
    nullable: false,
    defaultValue: 'CURRENT_TIMESTAMP(3)',
  },
  'management_audit_event.detail': {
    since: 1775501500000,
    columnType: 'text',
    nullable: true,
    defaultValue: null,
  },
  'management_audit_event.event_id': {
    since: 1775501500000,
    columnType: 'char(36)',
    nullable: false,
    defaultValue: null,
  },
  'management_audit_event.operation': {
    since: 1775502000000,
    columnType: 'varchar(32)',
    nullable: false,
    defaultValue: null,
  },
  'management_audit_event.organization_id': {
    since: 1775501500000,
    columnType: 'int',
    nullable: true,
    defaultValue: null,
  },
  'management_audit_event.result': {
    since: 1775501500000,
    columnType: 'varchar(16)',
    nullable: false,
    defaultValue: null,
  },
  'management_audit_event.target_id': {
    since: 1775501500000,
    columnType: 'varchar(64)',
    nullable: false,
    defaultValue: null,
  },
  'management_audit_event.target_type': {
    since: 1775501500000,
    columnType: 'varchar(32)',
    nullable: false,
    defaultValue: null,
  },
  'organization.address': {
    since: 1775501000000,
    columnType: 'varchar(1000)',
    nullable: true,
    defaultValue: null,
  },
  'organization.contact_email': {
    since: 1775501000000,
    columnType: 'varchar(254)',
    nullable: true,
    defaultValue: null,
  },
  'organization.contact_name': {
    since: 1775501000000,
    columnType: 'varchar(200)',
    nullable: true,
    defaultValue: null,
  },
  'organization.contact_phone': {
    since: 1775501000000,
    columnType: 'varchar(100)',
    nullable: true,
    defaultValue: null,
  },
  'organization.is_managed_company': {
    since: 1775501000000,
    columnType: 'tinyint(1)',
    nullable: false,
    defaultValue: '0',
  },
  'organization.is_service_provider': {
    since: 1775501000000,
    columnType: 'tinyint(1)',
    nullable: false,
    defaultValue: '0',
  },
  'organization.name': {
    since: 1775501000000,
    columnType: 'varchar(200)',
    nullable: false,
    defaultValue: null,
  },
  'organization.remark': {
    since: 1775501000000,
    columnType: 'text',
    nullable: true,
    defaultValue: null,
  },
  'organization.short_name': {
    since: 1775501000000,
    columnType: 'varchar(100)',
    nullable: true,
    defaultValue: null,
  },
  'record_package_import.check_status': {
    since: 1775501700000,
    columnType: 'varchar(16)',
    nullable: true,
    defaultValue: null,
  },
  'record_package_import.completed_at': {
    since: 1775501400000,
    columnType: 'timestamp(3)',
    nullable: true,
    defaultValue: null,
  },
  'record_package_import.created_at': {
    since: 1775501400000,
    columnType: 'timestamp(3)',
    nullable: false,
    defaultValue: 'CURRENT_TIMESTAMP(3)',
  },
  'record_package_import.imported_by_account_id': {
    since: 1775501400000,
    columnType: 'int',
    nullable: false,
    defaultValue: null,
  },
  'record_package_import.item_failed': {
    since: 1775501400000,
    columnType: 'int unsigned',
    nullable: false,
    defaultValue: '0',
  },
  'record_package_import.item_succeeded': {
    since: 1775501400000,
    columnType: 'int unsigned',
    nullable: false,
    defaultValue: '0',
  },
  'record_package_import.item_total': {
    since: 1775501400000,
    columnType: 'int unsigned',
    nullable: false,
    defaultValue: '0',
  },
  'record_package_import.manifest_checksum': {
    since: 1775501400000,
    columnType: 'char(64)',
    nullable: false,
    defaultValue: null,
  },
  'record_package_import.manifest_json': {
    since: 1775501400000,
    columnType: 'longtext',
    nullable: false,
    defaultValue: null,
  },
  'record_package_import.organization_id': {
    since: 1775501400000,
    columnType: 'int',
    nullable: false,
    defaultValue: null,
  },
  'record_package_import.package_id': {
    since: 1775501400000,
    columnType: 'char(36)',
    nullable: false,
    defaultValue: null,
  },
  'record_package_import.status': {
    since: 1775501400000,
    columnType: 'varchar(16)',
    nullable: false,
    defaultValue: null,
  },
  'record_package_item.check_result': {
    since: 1775501700000,
    columnType: 'varchar(16)',
    nullable: true,
    defaultValue: null,
  },
  'record_package_item.created_at': {
    since: 1775501400000,
    columnType: 'timestamp(3)',
    nullable: false,
    defaultValue: 'CURRENT_TIMESTAMP(3)',
  },
  'record_package_item.error_message': {
    since: 1775501400000,
    columnType: 'text',
    nullable: true,
    defaultValue: null,
  },
  'record_package_item.id': {
    since: 1775501400000,
    columnType: 'bigint',
    nullable: false,
    defaultValue: null,
  },
  'record_package_item.package_id': {
    since: 1775501400000,
    columnType: 'char(36)',
    nullable: false,
    defaultValue: null,
  },
  'record_package_item.receipt_id': {
    since: 1775501400000,
    columnType: 'char(36)',
    nullable: true,
    defaultValue: null,
  },
  'record_package_item.record_uuid': {
    since: 1775501400000,
    columnType: 'char(36)',
    nullable: false,
    defaultValue: null,
  },
  'record_package_item.resource_type': {
    since: 1775501400000,
    columnType: 'varchar(32)',
    nullable: false,
    defaultValue: null,
  },
  'record_package_item.result': {
    since: 1775501700000,
    columnType: 'varchar(16)',
    nullable: true,
    defaultValue: null,
  },
  'record_package_item.version_no': {
    since: 1775501400000,
    columnType: 'int unsigned',
    nullable: false,
    defaultValue: null,
  },
  'reference_document_revision.actor_account_id': {
    since: 1775501300000,
    columnType: 'int',
    nullable: false,
    defaultValue: null,
  },
  'reference_document_revision.after_snapshot': {
    since: 1775501300000,
    columnType: 'longtext',
    nullable: false,
    defaultValue: null,
  },
  'reference_document_revision.before_snapshot': {
    since: 1775501300000,
    columnType: 'longtext',
    nullable: false,
    defaultValue: null,
  },
  'reference_document_revision.created_at': {
    since: 1775501300000,
    columnType: 'timestamp(3)',
    nullable: false,
    defaultValue: 'CURRENT_TIMESTAMP(3)',
  },
  'reference_document_revision.document_id': {
    since: 1775501300000,
    columnType: 'int',
    nullable: false,
    defaultValue: null,
  },
  'reference_document_revision.id': {
    since: 1775501300000,
    columnType: 'bigint',
    nullable: false,
    defaultValue: null,
  },
  'reference_document_revision.reason': {
    since: 1775501300000,
    columnType: 'text',
    nullable: false,
    defaultValue: null,
  },
  'reference_document_revision.revision_no': {
    since: 1775501300000,
    columnType: 'int unsigned',
    nullable: false,
    defaultValue: null,
  },
  'reference_document.current_revision_no': {
    since: 1775501100000,
    columnType: 'int unsigned',
    nullable: false,
    defaultValue: '0',
  },
  'reference_document.owner_organization_id': {
    since: 1775501100000,
    columnType: 'int',
    nullable: true,
    defaultValue: null,
  },
  'reference_document.ownership_status': {
    since: 1775501100000,
    columnType: 'varchar(16)',
    nullable: false,
    defaultValue: null,
  },
  'reference_document.publication_status': {
    since: 1775501100000,
    columnType: 'varchar(16)',
    nullable: false,
    defaultValue: null,
  },
  'reference_document.source_kind': {
    since: 1775501100000,
    columnType: 'varchar(32)',
    nullable: false,
    defaultValue: null,
  },
  'reference_document.source_report_id': {
    since: 1775501100000,
    columnType: 'int',
    nullable: true,
    defaultValue: null,
  },
  'reference_document.source_report_version_id': {
    since: 1775501100000,
    columnType: 'int',
    nullable: true,
    defaultValue: null,
  },
  'repair_process_entry.author_account_id': {
    since: 1775501200000,
    columnType: 'int',
    nullable: false,
    defaultValue: null,
  },
  'repair_process_entry.created_at': {
    since: 1775501200000,
    columnType: 'timestamp(3)',
    nullable: false,
    defaultValue: 'CURRENT_TIMESTAMP(3)',
  },
  'repair_process_entry.entry_uuid': {
    since: 1775501200000,
    columnType: 'char(36)',
    nullable: false,
    defaultValue: null,
  },
  'repair_process_entry.file_id': {
    since: 1775501200000,
    columnType: 'char(36)',
    nullable: true,
    defaultValue: null,
  },
  'repair_process_entry.id': {
    since: 1775501200000,
    columnType: 'bigint',
    nullable: false,
    defaultValue: null,
  },
  'repair_process_entry.occurred_at': {
    since: 1775501200000,
    columnType: 'datetime',
    nullable: true,
    defaultValue: null,
  },
  'repair_process_entry.operation_text': {
    since: 1775501200000,
    columnType: 'longtext',
    nullable: false,
    defaultValue: null,
  },
  'repair_process_entry.request_id': {
    since: 1775501200000,
    columnType: 'int',
    nullable: false,
    defaultValue: null,
  },
  'repair_process_entry.test_result': {
    since: 1775501200000,
    columnType: 'longtext',
    nullable: true,
    defaultValue: null,
  },
  'repair_process_entry.time_source': {
    since: 1775501200000,
    columnType: 'varchar(32)',
    nullable: false,
    defaultValue: null,
  },
  'repair_process_entry.version_no': {
    since: 1775501200000,
    columnType: 'int unsigned',
    nullable: false,
    defaultValue: null,
  },
  'repair_request_intake.analysis_generation': {
    since: 1775501200000,
    columnType: 'int unsigned',
    nullable: false,
    defaultValue: '0',
  },
  'repair_request_intake.analysis_status': {
    since: 1775501200000,
    columnType: 'varchar(16)',
    nullable: false,
    defaultValue: null,
  },
  'repair_request_intake.converted_request_id': {
    since: 1775501200000,
    columnType: 'int',
    nullable: true,
    defaultValue: null,
  },
  'repair_request_intake.created_at': {
    since: 1775501200000,
    columnType: 'timestamp(3)',
    nullable: false,
    defaultValue: 'CURRENT_TIMESTAMP(3)',
  },
  'repair_request_intake.customer_account_id': {
    since: 1775501200000,
    columnType: 'int',
    nullable: false,
    defaultValue: null,
  },
  'repair_request_intake.customer_organization_id': {
    since: 1775501200000,
    columnType: 'int',
    nullable: false,
    defaultValue: null,
  },
  'repair_request_intake.deleted_at': {
    since: 1775501200000,
    columnType: 'timestamp(3)',
    nullable: true,
    defaultValue: null,
  },
  'repair_request_intake.equipment_model_id': {
    since: 1775501200000,
    columnType: 'int',
    nullable: false,
    defaultValue: null,
  },
  'repair_request_intake.error_code': {
    since: 1775501200000,
    columnType: 'varchar(100)',
    nullable: false,
    defaultValue: null,
  },
  'repair_request_intake.fault_description': {
    since: 1775501200000,
    columnType: 'longtext',
    nullable: false,
    defaultValue: null,
  },
  'repair_request_intake.file_id': {
    since: 1775501200000,
    columnType: 'char(36)',
    nullable: true,
    defaultValue: null,
  },
  'repair_request_intake.id': {
    since: 1775501200000,
    columnType: 'int',
    nullable: false,
    defaultValue: null,
  },
  'repair_request_intake.record_uuid': {
    since: 1775501200000,
    columnType: 'char(36)',
    nullable: false,
    defaultValue: null,
  },
  'repair_request_intake.service_organization_id': {
    since: 1775501200000,
    columnType: 'int',
    nullable: false,
    defaultValue: null,
  },
  'repair_request_revision.actor_account_id': {
    since: 1775501300000,
    columnType: 'int',
    nullable: false,
    defaultValue: null,
  },
  'repair_request_revision.after_snapshot': {
    since: 1775501300000,
    columnType: 'longtext',
    nullable: false,
    defaultValue: null,
  },
  'repair_request_revision.before_snapshot': {
    since: 1775501300000,
    columnType: 'longtext',
    nullable: false,
    defaultValue: null,
  },
  'repair_request_revision.created_at': {
    since: 1775501300000,
    columnType: 'timestamp(3)',
    nullable: false,
    defaultValue: 'CURRENT_TIMESTAMP(3)',
  },
  'repair_request_revision.id': {
    since: 1775501300000,
    columnType: 'bigint',
    nullable: false,
    defaultValue: null,
  },
  'repair_request_revision.reason': {
    since: 1775501300000,
    columnType: 'text',
    nullable: false,
    defaultValue: null,
  },
  'repair_request_revision.request_id': {
    since: 1775501300000,
    columnType: 'int',
    nullable: false,
    defaultValue: null,
  },
  'repair_request_revision.revision_no': {
    since: 1775501300000,
    columnType: 'int unsigned',
    nullable: false,
    defaultValue: null,
  },
  'repair_request_revision.previous_version': {
    since: 1775502200000,
    columnType: 'int unsigned',
    nullable: false,
    defaultValue: null,
  },
  'repair_request_revision.schema_version': {
    since: 1775501300000,
    columnType: 'int unsigned',
    nullable: false,
    defaultValue: null,
  },
  'repair_request.closed_at': {
    since: 1775501100000,
    columnType: 'timestamp(3)',
    nullable: true,
    defaultValue: null,
  },
  'repair_request.closure_reason': {
    since: 1775501100000,
    columnType: 'text',
    nullable: true,
    defaultValue: null,
  },
  'repair_request.closure_status': {
    since: 1775501100000,
    columnType: 'varchar(16)',
    nullable: true,
    defaultValue: null,
  },
  'repair_request.current_revision_no': {
    since: 1775501100000,
    columnType: 'int unsigned',
    nullable: false,
    defaultValue: '0',
  },
  'repair_request.customer_organization_id': {
    since: 1775501100000,
    columnType: 'int',
    nullable: true,
    defaultValue: null,
  },
  'repair_request.intake_id': {
    since: 1775501100000,
    columnType: 'int',
    nullable: true,
    defaultValue: null,
  },
  'repair_request.service_organization_id': {
    since: 1775501100000,
    columnType: 'int',
    nullable: true,
    defaultValue: null,
  },
  'stored_file.binding_status': {
    since: 1775501200000,
    columnType: 'varchar(16)',
    nullable: false,
    defaultValue: null,
  },
  'stored_file.business_id': {
    since: 1775501200000,
    columnType: 'varchar(64)',
    nullable: true,
    defaultValue: null,
  },
  'stored_file.business_type': {
    since: 1775501200000,
    columnType: 'varchar(32)',
    nullable: false,
    defaultValue: null,
  },
  'stored_file.byte_size': {
    since: 1775501200000,
    columnType: 'bigint unsigned',
    nullable: false,
    defaultValue: null,
  },
  'stored_file.checksum_sha256': {
    since: 1775501200000,
    columnType: 'char(64)',
    nullable: false,
    defaultValue: null,
  },
  'stored_file.created_at': {
    since: 1775501200000,
    columnType: 'timestamp(3)',
    nullable: false,
    defaultValue: 'CURRENT_TIMESTAMP(3)',
  },
  'stored_file.file_id': {
    since: 1775501200000,
    columnType: 'char(36)',
    nullable: false,
    defaultValue: null,
  },
  'stored_file.mime_type': {
    since: 1775501200000,
    columnType: 'varchar(255)',
    nullable: false,
    defaultValue: null,
  },
  'stored_file.original_filename': {
    since: 1775501200000,
    columnType: 'varchar(255)',
    nullable: false,
    defaultValue: null,
  },
  'stored_file.owner_organization_id': {
    since: 1775501200000,
    columnType: 'int',
    nullable: false,
    defaultValue: null,
  },
  'stored_file.status': {
    since: 1775501200000,
    columnType: 'varchar(16)',
    nullable: false,
    defaultValue: null,
  },
  'stored_file.storage_reference': {
    since: 1775501200000,
    columnType: 'varchar(1024)',
    nullable: false,
    defaultValue: null,
  },
  'stored_file.upload_context_id': {
    since: 1775501200000,
    columnType: 'char(36)',
    nullable: false,
    defaultValue: null,
  },
  'stored_file.uploaded_by_account_id': {
    since: 1775501200000,
    columnType: 'int',
    nullable: false,
    defaultValue: null,
  },
  'stored_file.verified_at': {
    since: 1775501200000,
    columnType: 'timestamp(3)',
    nullable: true,
    defaultValue: null,
  },
  'sync_conflict.cloud_snapshot': {
    since: 1775501400000,
    columnType: 'longtext',
    nullable: false,
    defaultValue: null,
  },
  'sync_conflict.confirmed_at': {
    since: 1775501400000,
    columnType: 'timestamp(3)',
    nullable: true,
    defaultValue: null,
  },
  'sync_conflict.confirmed_by_account_id': {
    since: 1775501400000,
    columnType: 'int',
    nullable: true,
    defaultValue: null,
  },
  'sync_conflict.conflict_id': {
    since: 1775501400000,
    columnType: 'char(36)',
    nullable: false,
    defaultValue: null,
  },
  'sync_conflict.conflict_reason': {
    since: 1775501400000,
    columnType: 'text',
    nullable: false,
    defaultValue: null,
  },
  'sync_conflict.created_at': {
    since: 1775501400000,
    columnType: 'timestamp(3)',
    nullable: false,
    defaultValue: 'CURRENT_TIMESTAMP(3)',
  },
  'sync_conflict.local_snapshot': {
    since: 1775501400000,
    columnType: 'longtext',
    nullable: false,
    defaultValue: null,
  },
  'sync_conflict.organization_id': {
    since: 1775501400000,
    columnType: 'int',
    nullable: false,
    defaultValue: null,
  },
  'sync_conflict.record_uuid': {
    since: 1775501400000,
    columnType: 'char(36)',
    nullable: false,
    defaultValue: null,
  },
  'sync_conflict.resource_type': {
    since: 1775501400000,
    columnType: 'varchar(32)',
    nullable: false,
    defaultValue: null,
  },
  'sync_conflict.status': {
    since: 1775501400000,
    columnType: 'varchar(16)',
    nullable: false,
    defaultValue: null,
  },
  'sync_conflict.version_no': {
    since: 1775501400000,
    columnType: 'int unsigned',
    nullable: false,
    defaultValue: null,
  },
  'sync_receipt.confirmed_at': {
    since: 1775501900000,
    columnType: 'timestamp(3)',
    nullable: true,
    defaultValue: null,
  },
  'sync_receipt.created_at': {
    since: 1775501400000,
    columnType: 'timestamp(3)',
    nullable: false,
    defaultValue: 'CURRENT_TIMESTAMP(3)',
  },
  'sync_receipt.manifest_checksum': {
    since: 1775501400000,
    columnType: 'char(64)',
    nullable: false,
    defaultValue: null,
  },
  'sync_receipt.organization_id': {
    since: 1775501400000,
    columnType: 'int',
    nullable: false,
    defaultValue: null,
  },
  'sync_receipt.receipt_id': {
    since: 1775501400000,
    columnType: 'char(36)',
    nullable: false,
    defaultValue: null,
  },
  'sync_receipt.receipt_status': {
    since: 1775501900000,
    columnType: 'varchar(16)',
    nullable: false,
    defaultValue: null,
  },
  'sync_receipt.record_uuid': {
    since: 1775501400000,
    columnType: 'char(36)',
    nullable: false,
    defaultValue: null,
  },
  'sync_receipt.resource_type': {
    since: 1775501400000,
    columnType: 'varchar(32)',
    nullable: false,
    defaultValue: null,
  },
  'sync_receipt.source_system': {
    since: 1775501900000,
    columnType: 'varchar(16)',
    nullable: false,
    defaultValue: null,
  },
  'sync_receipt.version_no': {
    since: 1775501400000,
    columnType: 'int unsigned',
    nullable: false,
    defaultValue: null,
  },
};

/**
 * 关键 CHECK 的精确表达式。
 * 本期交付项必须有定义；历史沿用项补登记定义后同样参与实库核验。
 * 同名不同定义属于真实漂移，必须由 verify 拒绝。
 */
export const CHECK_DEFINITIONS: Readonly<Record<string, CheckDefinition>> = {
  // 一轮完整性补登记：以下 CHECK 由前 44 条迁移创建、从未被后续迁移替换，
  // 但此前只登记了名称/所属迁移，未登记精确表达式。生效阶段以创建迁移为准，
  // 不得按本期交付阶段要求（旧态不提前要求）。
  'ai_message.chk_ai_message_seq': {
    since: 1775201200000,
    clause: '`message_seq` >= 1',
  },
  'ai_message.chk_ai_message_role_turn': {
    since: 1775201200000,
    clause: "`role` IN ('SYSTEM', 'TOOL') OR `turn_no` IS NOT NULL",
  },
  'ai_message.chk_ai_message_content': {
    since: 1775201200000,
    clause: 'CHAR_LENGTH(TRIM(`content_text`)) > 0',
  },
  'engineer_response.chk_engineer_response_text': {
    since: 1775201400000,
    clause: 'CHAR_LENGTH(TRIM(`response_text`)) > 0',
  },
  'reference_document.chk_reference_document_deprecated': {
    since: 1775201500000,
    clause: '`deprecated` IN (0, 1)',
  },
  'repair_request.chk_repair_request_is_accepted': {
    since: 1775201000000,
    clause: '`is_accepted` IN (0, 1)',
  },
  'repair_request.chk_repair_request_deprecated': {
    since: 1775201000000,
    clause: '`deprecated` IN (0, 1)',
  },
  'repair_request.chk_repair_request_closure': {
    since: 1775502000000,
    clause:
      '(CASE WHEN `closure_status` IS NULL THEN `closed_at` IS NULL ' +
      "WHEN `closure_status` = 'OPEN' THEN `closed_at` IS NULL " +
      "WHEN `closure_status` = 'CLOSED' THEN `closed_at` IS NOT NULL " +
      'ELSE FALSE END) = TRUE',
    stages: [
      {
        since: 1775501100000,
        clause:
          "(`closure_status` IS NULL AND `closed_at` IS NULL) OR (`closure_status` = 'OPEN' AND `closed_at` IS NULL) OR (`closure_status` = 'CLOSED' AND `closed_at` IS NOT NULL)",
      },
    ],
  },
  'repair_request.chk_repair_request_closure_reason': {
    since: 1775501100000,
    clause:
      '(`is_historical` = 1 OR `handling_result` IS NULL ' +
      "OR `handling_result` NOT IN ('INTERRUPTED', 'UNREPAIRABLE') " +
      'OR (`closure_reason` IS NOT NULL AND CHAR_LENGTH(TRIM(`closure_reason`)) > 0))',
  },
  'local_company_setting.chk_local_company_setting_backup_interval': {
    since: 1775501900000,
    clause: '(`backup_interval_hours` > 0)',
  },
  'sync_receipt.chk_sync_receipt_confirm_time': {
    since: 1775501900000,
    clause:
      "(`receipt_status` IN ('PENDING', 'CONFLICT') " +
      'OR `received_at` IS NOT NULL OR `confirmed_at` IS NOT NULL)',
  },
  'local_company_setting.chk_local_company_setting_backup_schedule': {
    since: 1775501900000,
    clause: '(`backup_enabled` = 0 OR `next_backup_at` IS NOT NULL)',
  },
  'local_company_setting.chk_local_company_setting_auto_upload': {
    since: 1775501900000,
    clause: '(`auto_upload_enabled` = 0 OR `backup_enabled` = 1)',
  },
  'local_account_authorization.chk_local_account_authorization_signed_claims': {
    since: 1775501900000,
    clause:
      '((`signed_claims` IS NULL AND `permission_version` IS NULL AND `last_verified_at` IS NULL) ' +
      'OR (`signed_claims` IS NOT NULL AND `permission_version` IS NOT NULL ' +
      'AND `last_verified_at` IS NOT NULL))',
  },
  'local_account_authorization.chk_local_account_authorization_permission_version': {
    since: 1775501900000,
    clause: '(`permission_version` IS NULL OR `permission_version` >= 1)',
  },
  'backup_asset.chk_backup_asset_manifest': {
    since: 1775501900000,
    clause: '(`manifest_checksum` IS NULL OR CHAR_LENGTH(`manifest_checksum`) = 64)',
  },
  'backup_asset.chk_backup_asset_format_version': {
    since: 1775501900000,
    clause: '(`format_version` IS NULL OR `format_version` >= 1)',
  },
  'backup_asset.chk_backup_asset_local_cleanup': {
    since: 1775501900000,
    clause:
      "((`local_status` = 'CLEANED' AND `local_reference` IS NULL) " +
      "OR (`local_status` <> 'CLEANED' AND `deleted_at` IS NULL))",
  },
  'backup_restore_run.chk_backup_restore_run_status': {
    since: 1775501900000,
    clause: "(`status` IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'INTERRUPTED'))",
    stages: [
      {
        since: 1775501500000,
        clause: "`status` IN ('RUNNING', 'SUCCEEDED', 'FAILED', 'INTERRUPTED')",
      },
    ],
  },
  'backup_restore_run.chk_backup_restore_run_finish': {
    since: 1775501900000,
    clause:
      "((`status` = 'PENDING' AND `started_at` IS NULL AND `finished_at` IS NULL) " +
      "OR (`status` = 'RUNNING' AND `started_at` IS NOT NULL AND `finished_at` IS NULL) " +
      "OR (`status` IN ('SUCCEEDED', 'FAILED', 'INTERRUPTED') AND `finished_at` IS NOT NULL))",
    stages: [
      {
        since: 1775501500000,
        clause:
          "(`status` = 'RUNNING' AND `finished_at` IS NULL) OR (`status` <> 'RUNNING' AND `finished_at` IS NOT NULL)",
      },
    ],
  },
  'backup_restore_run.chk_backup_restore_run_protection': {
    since: 1775501900000,
    clause: '(`protection_backup_id` IS NULL OR `protection_backup_id` <> `backup_id`)',
    stages: [
      {
        since: 1775501500000,
        clause: '`backup_id` <> `protection_backup_id`',
      },
    ],
  },
  'backup_restore_run.chk_backup_restore_run_execution_guard': {
    since: 1775501900000,
    clause:
      "((`status` = 'PENDING' AND `protection_backup_id` IS NULL " +
      "AND `confirmation` IS NULL) OR (`status` IN ('RUNNING', 'SUCCEEDED', 'FAILED', 'INTERRUPTED') " +
      'AND `started_at` IS NOT NULL AND `protection_backup_id` IS NOT NULL))',
  },
  'backup_restore_run.chk_backup_restore_run_check_status': {
    since: 1775501900000,
    clause: "(`check_status` IS NULL OR `check_status` IN ('PENDING', 'PASSED', 'FAILED'))",
  },
  'backup_restore_run.chk_backup_restore_run_check_outcome': {
    since: 1775501900000,
    clause:
      "((`check_status` IS NULL OR (`status` = 'SUCCEEDED' AND `check_status` <> 'FAILED') " +
      "OR (`status` NOT IN ('SUCCEEDED', 'FAILED', 'INTERRUPTED'))) " +
      "AND (`check_status` IS NULL OR `status` NOT IN ('FAILED', 'INTERRUPTED') " +
      "OR `check_status` <> 'PASSED'))",
  },
  'maintenance_report_fault.chk_maintenance_report_fault_lifecycle_status': {
    since: 1775501900000,
    clause: "(`lifecycle_status` IN ('OPEN', 'IN_PROGRESS', 'RESOLVED'))",
  },
  'maintenance_report_fault.chk_maintenance_report_fault_lifecycle_source': {
    since: 1775501900000,
    clause: "(`lifecycle_source` IN ('USER', 'ADMIN', 'SYSTEM'))",
  },
  'maintenance_report_fault.chk_maintenance_report_fault_description_len': {
    since: 1775501900000,
    clause: '(`fault_description` IS NULL OR CHAR_LENGTH(`fault_description`) <= 10000)',
  },
  'maintenance_report_fault.chk_maintenance_report_fault_action_len': {
    since: 1775501900000,
    clause: '(`handling_action` IS NULL OR CHAR_LENGTH(`handling_action`) <= 10000)',
  },
  'maintenance_report_fault.chk_maintenance_report_fault_phase_code': {
    since: 1775501900000,
    clause:
      "(`phase_code` IS NULL OR `phase_code` IN ('PHASE_01', 'PHASE_02', 'PHASE_03', " +
      "'PHASE_04', 'PHASE_05', 'PHASE_06', 'PHASE_07', 'PHASE_08', 'PHASE_09', 'PHASE_10'))",
  },
  'maintenance_report_fault.chk_maintenance_report_fault_active': {
    since: 1775501900000,
    clause: '(`is_active` IS NULL OR `is_active` IN (0, 1))',
  },
  // D3（1775502000000）：本轮交付字段与约束
  'management_audit_event.chk_management_audit_operation': {
    since: 1775502000000,
    clause:
      "(`operation` IN ('ADMIN_DELETE_DOCUMENT', 'CORRECT_DOCUMENT_OWNERSHIP', 'RESTORE_LOCAL_BUSINESS'))",
    stages: [
      {
        since: 1775501500000,
        clause: "`operation` IN ('MANAGE_ACCOUNT', 'ASSIGN_RESOURCE', 'MANAGE_COMPANY')",
      },
    ],
  },
  'sync_conflict.chk_sync_conflict_versions': {
    since: 1775502000000,
    clause:
      '((`local_version` IS NULL AND `cloud_version` IS NULL) ' +
      'OR (`local_version` IS NOT NULL AND `cloud_version` IS NOT NULL))',
  },
  'sync_conflict.chk_sync_conflict_decision': {
    since: 1775502000000,
    clause: "(`decision` IS NULL OR `decision` IN ('PENDING', 'LOCAL', 'CLOUD'))",
  },
  // V13 本期交付（1775501000000—1775502100000）：CHECK 精确表达式
  'ai_conversation.chk_ai_conversation_completion': {
    since: 1775501100000,
    clause:
      "(`status` = 'ACTIVE' AND `ai_feedback` IS NULL AND `completed_at` IS NULL) OR (`status` = 'COMPLETED' AND `ai_feedback` IS NOT NULL AND CHAR_LENGTH(TRIM(`ai_feedback`)) > 0 AND `completed_at` IS NOT NULL)",
    stages: [
      {
        since: 1775201100000,
        clause:
          "(`status` = 'ACTIVE' AND `completed_at` IS NULL) OR (`status` = 'COMPLETED' AND `ai_feedback` IS NOT NULL AND CHAR_LENGTH(TRIM(`ai_feedback`)) > 0 AND `completed_at` IS NOT NULL)",
      },
    ],
  },
  'ai_conversation.chk_ai_conversation_content_version': {
    since: 1775501100000,
    clause: '`content_version` >= 1',
  },
  'ai_message_analysis.chk_ai_message_analysis_completed': {
    since: 1775501200000,
    clause: "`status` IN ('PENDING', 'RUNNING') OR `completed_at` IS NOT NULL",
  },
  'ai_message_analysis.chk_ai_message_analysis_content_version': {
    since: 1775501200000,
    clause: '`content_version` >= 1',
  },
  'ai_message_analysis.chk_ai_message_analysis_failure': {
    since: 1775501200000,
    clause:
      "`status` <> 'FAILED' OR (`failure_reason` IS NOT NULL AND CHAR_LENGTH(TRIM(`failure_reason`)) > 0)",
  },
  'ai_message_analysis.chk_ai_message_analysis_status': {
    since: 1775501200000,
    clause: "`status` IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED')",
  },
  'ai_message.chk_ai_message_content_version': {
    since: 1775501100000,
    clause: '`content_version` >= 1',
  },
  'backup_asset.chk_backup_asset_attempts': {
    since: 1775501500000,
    clause: '`attempt_count` >= 0',
  },
  'backup_asset.chk_backup_asset_cloud_receipt': {
    since: 1775501500000,
    clause: "`cloud_status` <> 'SUCCEEDED' OR `cloud_receipt` IS NOT NULL",
  },
  'backup_asset.chk_backup_asset_cloud_status': {
    since: 1775501500000,
    clause: "`cloud_status` IN ('PENDING', 'UPLOADING', 'SUCCEEDED', 'FAILED')",
  },
  'backup_asset.chk_backup_asset_local_status': {
    since: 1775501500000,
    clause: "`local_status` IN ('PENDING', 'CLEANING', 'CLEANED', 'FAILED')",
  },
  'backup_asset.chk_backup_asset_sha': {
    since: 1775501500000,
    clause: 'CHAR_LENGTH(`file_sha256`) = 64',
  },
  'backup_asset.chk_backup_asset_size': {
    since: 1775501500000,
    clause: '`byte_size` >= 0',
  },
  'backup_restore_run.chk_backup_restore_run_schema': {
    since: 1775501600000,
    clause:
      "(json_valid(`check_snapshot`) and (json_extract(`check_snapshot`,'$.schema_version') is not null) and (json_type(json_extract(`check_snapshot`,'$.schema_version')) <> 'NULL'))",
    stages: [
      {
        since: 1775501500000,
        clause:
          "JSON_VALID(`check_snapshot`) AND JSON_EXTRACT(`check_snapshot`, '$.schema_version') IS NOT NULL",
      },
    ],
  },
  'base_user_account.chk_base_user_account_admin_level': {
    since: 1775501000000,
    clause: '`admin_level` IS NULL OR `admin_level` IN (1, 2)',
  },
  'intake_analysis_attempt.chk_intake_analysis_attempt_failure': {
    since: 1775501200000,
    clause:
      "`status` <> 'FAILED' OR (`failure_reason` IS NOT NULL AND CHAR_LENGTH(TRIM(`failure_reason`)) > 0)",
  },
  'intake_analysis_attempt.chk_intake_analysis_attempt_generation': {
    since: 1775501200000,
    clause: '`generation_no` IN (0, 1)',
  },
  'intake_analysis_attempt.chk_intake_analysis_attempt_status': {
    since: 1775501200000,
    clause: "`status` IN ('RUNNING', 'SUCCEEDED', 'FAILED')",
  },
  'local_account_authorization.chk_local_account_authorization_status': {
    since: 1775501400000,
    clause:
      "(`authorization_status` = 'ACTIVE' AND `revoked_at` IS NULL) OR (`authorization_status` = 'REVOKED' AND `revoked_at` IS NOT NULL)",
  },
  'local_backup_run.chk_local_backup_run_manual_status': {
    since: 1775501100000,
    clause:
      "(`manual_upload_status` IS NULL OR `manual_upload_status` IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'NOT_REQUIRED')) AND (`manual_cleanup_status` IS NULL OR `manual_cleanup_status` IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'NOT_REQUIRED'))",
  },
  'local_backup_run.chk_local_backup_run_trigger': {
    since: 1775501100000,
    clause: "`trigger_type` IN ('SCHEDULED', 'MANUAL', 'AUTO', 'RETRY', 'USB_EXPORT')",
    stages: [
      {
        since: 1775401400000,
        clause: "`trigger_type` IN ('SCHEDULED', 'MANUAL', 'USB_EXPORT')",
      },
    ],
  },
  'local_company_setting.chk_local_company_setting_current': {
    since: 1775501400000,
    clause: '`is_current` IN (0, 1)',
  },
  'local_company_setting.chk_local_company_setting_source': {
    since: 1775501400000,
    clause: "`setting_source` IN ('LOCAL_MANUAL', 'CLOUD_MAPPING')",
  },
  'local_upload_task.chk_local_upload_task_manifest_checksum': {
    since: 1775501100000,
    clause: '`manifest_checksum` IS NULL OR CHAR_LENGTH(`manifest_checksum`) = 64',
  },
  'local_upload_task.chk_local_upload_task_task_kind': {
    since: 1775501100000,
    clause: "`task_kind` IS NULL OR `task_kind` IN ('BUSINESS_SYNC', 'BACKUP_UPLOAD')",
  },
  'maintenance_report_fault.chk_maintenance_report_fault_branch': {
    since: 1775501300000,
    clause: "`branch_kind` IN ('INITIAL_PANEL', 'NEW_FAULT_BRANCH', 'STEP_NEW_FAULT')",
  },
  'maintenance_report_fault.chk_maintenance_report_fault_description': {
    since: 1775501300000,
    clause: 'CHAR_LENGTH(TRIM(`fault_description`)) > 0',
  },
  'maintenance_report_fault.chk_maintenance_report_fault_step': {
    since: 1775501300000,
    clause:
      "(`branch_kind` = 'STEP_NEW_FAULT' AND `step_code` IS NOT NULL) OR (`branch_kind` <> 'STEP_NEW_FAULT' AND `step_code` IS NULL)",
  },
  'maintenance_report_step.chk_maintenance_report_step_result_code': {
    since: 1775501100000,
    clause: "`result_code` IS NULL OR `result_code` IN ('RESOLVED', 'UNRESOLVED', 'NEW_FAULT')",
  },
  'maintenance_report.chk_maintenance_report_ai_correctness': {
    since: 1775501100000,
    clause:
      "`ai_correctness` IS NULL OR `ai_correctness` IN ('CORRECT', 'PARTIAL', 'INCORRECT', 'UNKNOWN')",
    stages: [
      {
        since: 1775401200000,
        clause:
          "`ai_correctness` IS NULL OR `ai_correctness` IN ('CORRECT', 'PARTIAL', 'INCORRECT')",
      },
    ],
  },
  'maintenance_report.chk_maintenance_report_ai_helpfulness': {
    since: 1775401200000,
    clause: '`ai_helpfulness` IS NULL OR `ai_helpfulness` BETWEEN 1 AND 5',
  },
  'maintenance_report.chk_maintenance_report_closure_reason': {
    since: 1775501100000,
    clause:
      "`handling_result` IS NULL OR `handling_result` NOT IN ('INTERRUPTED', 'UNREPAIRABLE') OR (`closure_reason` IS NOT NULL AND CHAR_LENGTH(TRIM(`closure_reason`)) > 0)",
  },
  'maintenance_report.chk_maintenance_report_handling_result': {
    since: 1775501100000,
    clause:
      "`handling_result` IS NULL OR `handling_result` IN ( 'FIXED', 'PART_PURCHASED', 'PROVIDE_PLAN_SELF_EXECUTE', 'INTERRUPTED', 'UNREPAIRABLE' )",
  },
  'maintenance_report.chk_maintenance_report_reset_result': {
    since: 1775501100000,
    clause: "`reset_result` IS NULL OR `reset_result` IN ('NORMAL', 'SAME_FAULT', 'NEW_FAULT')",
  },
  'maintenance_report.chk_maintenance_report_status': {
    since: 1775501100000,
    clause: "`status` IN ('DRAFT', 'SUBMITTED', 'PENDING_REVIEW', 'RETURNED', 'APPROVED')",
    stages: [
      {
        since: 1775401200000,
        clause: "`status` IN ('DRAFT', 'PENDING_REVIEW', 'RETURNED', 'APPROVED')",
      },
    ],
  },
  'maintenance_report.chk_maintenance_report_status_consistency': {
    since: 1775501100000,
    clause:
      "(`status` = 'DRAFT' AND `current_version_no` = 0 AND `last_submitted_at` IS NULL AND `last_reviewed_at` IS NULL) OR (`status` IN ('SUBMITTED', 'PENDING_REVIEW') AND `current_version_no` >= 1 AND `last_submitted_at` IS NOT NULL AND `last_reviewed_at` IS NULL) OR (`status` IN ('RETURNED', 'APPROVED') AND `current_version_no` >= 1 AND `last_submitted_at` IS NOT NULL AND `last_reviewed_at` IS NOT NULL)",
    stages: [
      {
        since: 1775401200000,
        clause:
          "(`status` = 'DRAFT' AND `current_version_no` = 0 AND `last_submitted_at` IS NULL AND `last_reviewed_at` IS NULL) OR (`status` = 'PENDING_REVIEW' AND `current_version_no` >= 1 AND `last_submitted_at` IS NOT NULL AND `last_reviewed_at` IS NULL) OR (`status` IN ('RETURNED', 'APPROVED') AND `current_version_no` >= 1 AND `last_submitted_at` IS NOT NULL AND `last_reviewed_at` IS NOT NULL)",
      },
    ],
  },
  'maintenance_report.chk_maintenance_report_submission_pair': {
    since: 1775501100000,
    clause:
      '(`submission_request_id` IS NULL AND `submission_payload_hash` IS NULL) OR (`submission_request_id` IS NOT NULL AND CHAR_LENGTH(TRIM(`submission_request_id`)) > 0 AND `submission_payload_hash` IS NOT NULL AND CHAR_LENGTH(`submission_payload_hash`) = 64)',
  },
  'management_audit_event.chk_management_audit_level': {
    since: 1775501500000,
    clause: '`actor_admin_level` IN (1, 2)',
  },
  'management_audit_event.chk_management_audit_result': {
    since: 1775501500000,
    clause: "`result` IN ('SUCCEEDED', 'FAILED', 'DENIED')",
  },
  'management_audit_event.chk_management_audit_target': {
    since: 1775501500000,
    clause: 'CHAR_LENGTH(TRIM(`target_type`)) > 0 AND CHAR_LENGTH(TRIM(`target_id`)) > 0',
  },
  'organization.chk_organization_managed_company': {
    since: 1775501000000,
    clause: '`is_managed_company` IN (0, 1)',
  },
  'organization.chk_organization_service_provider': {
    since: 1775501000000,
    clause: '`is_service_provider` IN (0, 1)',
  },
  'record_package_import.chk_record_package_import_check_stage': {
    since: 1775501700000,
    clause:
      "(`status` NOT IN ('RUNNING', 'SUCCEEDED', 'PARTIAL') OR COALESCE(`check_status`, '') = 'PASSED') AND (COALESCE(`check_status`, '') <> 'REJECTED' OR `status` = 'PENDING') AND (COALESCE(`check_status`, '') <> 'PENDING' OR `status` = 'PENDING')",
  },
  'record_package_import.chk_record_package_import_check_status': {
    since: 1775501700000,
    clause: "`check_status` IS NULL OR `check_status` IN ('PENDING', 'PASSED', 'REJECTED')",
  },
  'record_package_import.chk_record_package_import_counts': {
    since: 1775501400000,
    // MySQL 8.0 会把算术比较改写为 ((a + b) <= total)，契约按物理定义固定。
    clause: '((`item_succeeded` + `item_failed`) <= `item_total`)',
  },
  'record_package_import.chk_record_package_import_manifest': {
    since: 1775501700000,
    clause:
      "JSON_VALID(`manifest_json`) AND JSON_EXTRACT(`manifest_json`, '$.schema_version') IS NOT NULL AND JSON_TYPE(JSON_EXTRACT(`manifest_json`, '$.schema_version')) <> 'NULL' AND CHAR_LENGTH(`manifest_checksum`) = 64",
    stages: [
      {
        since: 1775501400000,
        clause:
          "JSON_VALID(`manifest_json`) AND JSON_EXTRACT(`manifest_json`, '$.schema_version') IS NOT NULL AND CHAR_LENGTH(`manifest_checksum`) = 64",
      },
    ],
  },
  'record_package_import.chk_record_package_import_status': {
    since: 1775501400000,
    clause: "`status` IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED')",
  },
  'record_package_item.chk_record_package_item_check_result': {
    since: 1775501700000,
    clause: "`check_result` IS NULL OR `check_result` IN ('PASSED', 'REJECTED')",
  },
  'record_package_item.chk_record_package_item_check_stage': {
    since: 1775501700000,
    clause:
      "(COALESCE(`check_result`, '') <> 'REJECTED' OR `result` IS NULL) AND (`result` <> 'SUCCEEDED' OR COALESCE(`check_result`, '') = 'PASSED')",
  },
  'record_package_item.chk_record_package_item_error': {
    since: 1775501400000,
    clause:
      "`result` <> 'FAILED' OR (`error_message` IS NOT NULL AND CHAR_LENGTH(TRIM(`error_message`)) > 0)",
  },
  'record_package_item.chk_record_package_item_result': {
    since: 1775501700000,
    clause: "`result` IS NULL OR `result` IN ('SUCCEEDED', 'FAILED', 'SKIPPED', 'CONFLICT')",
    stages: [
      {
        since: 1775501400000,
        clause: "`result` IN ('SUCCEEDED', 'FAILED', 'SKIPPED')",
      },
    ],
  },
  'reference_document_revision.chk_reference_document_revision_no': {
    since: 1775501300000,
    clause: '`revision_no` >= 1',
  },
  'reference_document_revision.chk_reference_document_revision_reason': {
    since: 1775501300000,
    clause: 'CHAR_LENGTH(TRIM(`reason`)) > 0',
  },
  'reference_document_revision.chk_reference_document_revision_schema': {
    since: 1775501600000,
    clause:
      "(json_valid(`before_snapshot`) and json_valid(`after_snapshot`) and (json_extract(`before_snapshot`,'$.schema_version') is not null) and (json_type(json_extract(`before_snapshot`,'$.schema_version')) <> 'NULL') and (json_extract(`after_snapshot`,'$.schema_version') is not null) and (json_type(json_extract(`after_snapshot`,'$.schema_version')) <> 'NULL'))",
    stages: [
      {
        since: 1775501300000,
        clause:
          "JSON_VALID(`before_snapshot`) AND JSON_VALID(`after_snapshot`) AND JSON_EXTRACT(`before_snapshot`, '$.schema_version') IS NOT NULL AND JSON_EXTRACT(`after_snapshot`, '$.schema_version') IS NOT NULL",
      },
    ],
  },
  'reference_document.chk_reference_document_content_source_v13': {
    since: 1775501100000,
    clause:
      "(`source_kind` = 'MATERIAL' AND (`content_text` IS NOT NULL OR `storage_reference` IS NOT NULL)) OR (`source_kind` IN ('INDEPENDENT_REPORT', 'WORK_ORDER_SUMMARY') AND `source_report_id` IS NOT NULL AND `source_report_version_id` IS NOT NULL)",
  },
  'reference_document.chk_reference_document_ingest_method': {
    since: 1775501100000,
    clause:
      "`ingest_method` IN ('ADMIN_DIRECT', 'REVIEWED_SUBMISSION', 'SYSTEM_IMPORT', 'DIRECT_SUBMISSION')",
    stages: [
      {
        since: 1775301900000,
        clause: "`ingest_method` IN ('ADMIN_DIRECT', 'REVIEWED_SUBMISSION', 'SYSTEM_IMPORT')",
      },
    ],
  },
  'reference_document.chk_reference_document_ownership': {
    since: 1775501100000,
    clause:
      "`ownership_status` IN ('CONFIRMED', 'PENDING') AND (`ownership_status` = 'PENDING' OR `owner_organization_id` IS NOT NULL)",
  },
  'reference_document.chk_reference_document_publication': {
    since: 1775501100000,
    clause: "`publication_status` IN ('ONLINE', 'OFFLINE')",
  },
  'reference_document.chk_reference_document_report_source_pair': {
    since: 1775501100000,
    clause:
      '(`source_report_id` IS NULL AND `source_report_version_id` IS NULL) OR (`source_report_id` IS NOT NULL AND `source_report_version_id` IS NOT NULL)',
  },
  'repair_process_entry.chk_repair_process_entry_operation': {
    since: 1775501200000,
    clause: 'CHAR_LENGTH(TRIM(`operation_text`)) > 0',
  },
  'repair_process_entry.chk_repair_process_entry_time_source': {
    since: 1775501200000,
    clause: 'CHAR_LENGTH(TRIM(`time_source`)) > 0',
  },
  'repair_process_entry.chk_repair_process_entry_version': {
    since: 1775501200000,
    clause: '`version_no` >= 1',
  },
  'repair_request_intake.chk_repair_request_intake_analysis_status': {
    since: 1775501200000,
    clause: "`analysis_status` IN ('WAITING', 'RUNNING', 'SUCCEEDED', 'FAILED')",
  },
  'repair_request_intake.chk_repair_request_intake_description': {
    since: 1775501200000,
    clause: 'CHAR_LENGTH(`fault_description`) <= 5000',
  },
  'repair_request_intake.chk_repair_request_intake_generation': {
    since: 1775501200000,
    clause: '`analysis_generation` IN (0, 1)',
  },
  'repair_request_revision.chk_repair_request_revision_no': {
    since: 1775501300000,
    clause: '`revision_no` >= 1',
  },
  'repair_request_revision.chk_repair_request_revision_previous_version': {
    since: 1775502100000,
    clause: '`previous_version` IS NULL OR `previous_version` < `revision_no`',
  },
  'repair_request_revision.chk_repair_request_revision_reason': {
    since: 1775501300000,
    clause: 'CHAR_LENGTH(TRIM(`reason`)) > 0',
  },
  'repair_request_revision.chk_repair_request_revision_schema': {
    since: 1775501600000,
    clause:
      "((`schema_version` >= 1) and json_valid(`before_snapshot`) and json_valid(`after_snapshot`) and (json_extract(`before_snapshot`,'$.schema_version') is not null) and (json_type(json_extract(`before_snapshot`,'$.schema_version')) <> 'NULL') and (json_extract(`after_snapshot`,'$.schema_version') is not null) and (json_type(json_extract(`after_snapshot`,'$.schema_version')) <> 'NULL') and (json_extract(`before_snapshot`,'$.schema_version') = `schema_version`) and (json_extract(`after_snapshot`,'$.schema_version') = `schema_version`))",
    stages: [
      {
        since: 1775501300000,
        clause:
          "`schema_version` >= 1 AND JSON_VALID(`before_snapshot`) AND JSON_VALID(`after_snapshot`) AND JSON_EXTRACT(`before_snapshot`, '$.schema_version') = `schema_version` AND JSON_EXTRACT(`after_snapshot`, '$.schema_version') = `schema_version`",
      },
    ],
  },
  'repair_request.chk_repair_request_current_revision': {
    since: 1775501100000,
    clause: '`current_revision_no` >= 0',
  },
  'repair_request.chk_repair_request_new_intake_companies': {
    since: 1775501100000,
    clause:
      '`intake_id` IS NULL OR (`customer_organization_id` IS NOT NULL AND `service_organization_id` IS NOT NULL)',
  },
  'stored_file.chk_stored_file_binding_pair': {
    since: 1775501200000,
    clause:
      "(`binding_status` = 'TEMPORARY' AND `business_id` IS NULL) OR (`binding_status` = 'BOUND' AND `business_id` IS NOT NULL AND CHAR_LENGTH(TRIM(`business_id`)) > 0)",
  },
  'stored_file.chk_stored_file_binding_status': {
    since: 1775501200000,
    clause: "`binding_status` IN ('TEMPORARY', 'BOUND')",
  },
  'stored_file.chk_stored_file_business_type': {
    since: 1775501200000,
    clause: 'CHAR_LENGTH(TRIM(`business_type`)) > 0',
  },
  'stored_file.chk_stored_file_checksum': {
    since: 1775501200000,
    clause: 'CHAR_LENGTH(`checksum_sha256`) = 64',
  },
  'stored_file.chk_stored_file_size': {
    since: 1775501200000,
    clause: '`byte_size` >= 1 AND `byte_size` <= 20000000',
  },
  'stored_file.chk_stored_file_status': {
    since: 1775501200000,
    clause: "`status` IN ('STAGING', 'VALID', 'FAILED')",
  },
  'stored_file.chk_stored_file_verified': {
    since: 1775501200000,
    clause: "`status` <> 'VALID' OR `verified_at` IS NOT NULL",
  },
  'sync_conflict.chk_sync_conflict_confirmed': {
    since: 1775501400000,
    clause:
      "(`status` = 'PENDING' AND `confirmed_by_account_id` IS NULL AND `confirmed_at` IS NULL) OR (`status` IN ('RESOLVED', 'IGNORED') AND `confirmed_by_account_id` IS NOT NULL AND `confirmed_at` IS NOT NULL)",
  },
  'sync_conflict.chk_sync_conflict_schema': {
    since: 1775501600000,
    clause:
      "(json_valid(`local_snapshot`) and json_valid(`cloud_snapshot`) and (json_extract(`local_snapshot`,'$.schema_version') is not null) and (json_type(json_extract(`local_snapshot`,'$.schema_version')) <> 'NULL') and (json_extract(`cloud_snapshot`,'$.schema_version') is not null) and (json_type(json_extract(`cloud_snapshot`,'$.schema_version')) <> 'NULL'))",
    stages: [
      {
        since: 1775501400000,
        clause:
          "JSON_VALID(`local_snapshot`) AND JSON_VALID(`cloud_snapshot`) AND JSON_EXTRACT(`local_snapshot`, '$.schema_version') IS NOT NULL AND JSON_EXTRACT(`cloud_snapshot`, '$.schema_version') IS NOT NULL",
      },
    ],
  },
  'sync_conflict.chk_sync_conflict_status': {
    since: 1775501400000,
    clause: "`status` IN ('PENDING', 'RESOLVED', 'IGNORED')",
  },
  'sync_receipt.chk_sync_receipt_manifest': {
    since: 1775501400000,
    clause: 'CHAR_LENGTH(`manifest_checksum`) = 64',
  },
  'sync_receipt.chk_sync_receipt_source': {
    since: 1775501400000,
    clause: "`source_system` IN ('LOCAL', 'CLOUD')",
  },
  'sync_receipt.chk_sync_receipt_status': {
    since: 1775501400000,
    clause: "`receipt_status` IN ('PENDING', 'SUCCEEDED', 'FAILED', 'CONFLICT')",
  },
  // 继承 CHECK 精确定义（由前 44 条迁移创建，按创建阶段登记；后续替换项见 stages）。
  'ai_message.chk_ai_message_turn': {
    since: 1775201200000,
    clause: '(`turn_no` IS NULL OR `turn_no` BETWEEN 1 AND 100)',
  },
  'content_submission_attachment.chk_content_submission_attachment_retire_consistency': {
    since: 1775301500000,
    clause:
      "((`status` = 'CURRENT' AND `retired_at` IS NULL) OR (`status` = 'RETIRED' AND `retired_at` IS NOT NULL))",
  },
  'content_submission_attachment.chk_content_submission_attachment_status': {
    since: 1775301500000,
    clause: "`status` IN ('CURRENT', 'RETIRED')",
  },
  'content_submission_review.chk_content_submission_review_comment': {
    since: 1775301700000,
    clause:
      "(`decision` <> 'RETURN' OR (`comment` IS NOT NULL AND CHAR_LENGTH(TRIM(`comment`)) > 0))",
  },
  'content_submission_review.chk_content_submission_review_decision': {
    since: 1775301700000,
    clause: "`decision` IN ('RETURN', 'APPROVE')",
  },
  'content_submission_review.chk_content_submission_review_publish_flag': {
    since: 1775301700000,
    clause: "(`decision` <> 'RETURN' OR `publish_attachment` = 0)",
  },
  'content_submission_revision.chk_content_submission_revision_no': {
    since: 1775301600000,
    clause: '`revision_no` >= 1',
  },
  'content_submission_revision.chk_content_submission_revision_notice': {
    since: 1775301600000,
    clause: 'CHAR_LENGTH(TRIM(`notice_version`)) > 0',
  },
  'content_submission_revision.chk_content_submission_revision_title': {
    since: 1775301600000,
    clause: 'CHAR_LENGTH(TRIM(`title_snapshot`)) > 0',
  },
  'content_submission.chk_content_submission_kind': {
    since: 1775301200000,
    clause: "`submission_kind` IN ('MATERIAL', 'FAULT_CASE')",
  },
  'content_submission.chk_content_submission_publish_consistency': {
    since: 1775301200000,
    clause:
      "((`status` = 'PUBLISHED' AND `published_at` IS NOT NULL) OR (`status` <> 'PUBLISHED' AND `published_at` IS NULL))",
  },
  'content_submission.chk_content_submission_revision_consistency': {
    since: 1775301200000,
    clause:
      "((`status` = 'DRAFT' AND `current_revision_no` = 0 AND `last_submitted_at` IS NULL) OR (`status` <> 'DRAFT' AND `current_revision_no` >= 1 AND `last_submitted_at` IS NOT NULL))",
  },
  'content_submission.chk_content_submission_status': {
    since: 1775301200000,
    clause: "`status` IN ('DRAFT', 'PENDING_REVIEW', 'RETURNED', 'PUBLISHED')",
  },
  'engineer_registration_application.chk_engineer_registration_application_pending_review': {
    since: 1775401500000,
    clause:
      "((`status` = 'PENDING' AND `reviewed_by_account_id` IS NULL AND `reviewed_at` IS NULL AND `review_comment` IS NULL) OR (`status` <> 'PENDING'))",
  },
  'engineer_registration_application.chk_engineer_registration_application_reject_comment': {
    since: 1775401500000,
    clause:
      "(`status` <> 'REJECTED' OR (`review_comment` IS NOT NULL AND CHAR_LENGTH(TRIM(`review_comment`)) > 0))",
  },
  'engineer_registration_application.chk_engineer_registration_application_review_time': {
    since: 1775401500000,
    clause: '(`reviewed_at` IS NULL OR `reviewed_at` >= `submitted_at`)',
  },
  'engineer_registration_application.chk_engineer_registration_application_reviewed': {
    since: 1775401500000,
    clause:
      "((`status` = 'PENDING') OR (`reviewed_by_account_id` IS NOT NULL AND `reviewed_at` IS NOT NULL))",
  },
  'engineer_registration_application.chk_engineer_registration_application_status': {
    since: 1775401500000,
    clause: "`status` IN ('PENDING', 'APPROVED', 'REJECTED')",
  },
  'equipment_model.chk_equipment_model_enabled': {
    since: 1775200900000,
    clause: '`enabled` IN (0, 1)',
  },
  'fault_case_submission_detail.chk_fault_case_submission_detail_handling_status': {
    since: 1775301400000,
    clause:
      "(`handling_status` IS NULL OR `handling_status` IN ('UNRESOLVED', 'IN_PROGRESS', 'RESOLVED'))",
  },
  'fault_case_submission_detail.chk_fault_case_submission_detail_model_exclusive': {
    since: 1775301400000,
    clause: '(`equipment_model_id` IS NULL OR `equipment_model_text` IS NULL)',
  },
  'fault_case_submission_detail.chk_fault_case_submission_detail_resolution': {
    since: 1775301400000,
    clause:
      "(`handling_status` IS NULL OR `handling_status` <> 'RESOLVED' OR (`resolution` IS NOT NULL AND CHAR_LENGTH(TRIM(`resolution`)) > 0))",
  },
  'local_backup_run.chk_local_backup_run_finish': {
    since: 1775401400000,
    clause:
      "((`status` = 'RUNNING' AND `finished_at` IS NULL) OR (`status` <> 'RUNNING' AND `finished_at` IS NOT NULL))",
  },
  'local_backup_run.chk_local_backup_run_status': {
    since: 1775401400000,
    clause: "`status` IN ('RUNNING', 'SUCCEEDED', 'FAILED', 'INTERRUPTED')",
  },
  'local_installation.chk_local_installation_interval': {
    since: 1775401400000,
    clause: '`backup_interval_days` >= 1',
  },
  'local_installation.chk_local_installation_singleton': {
    since: 1775401400000,
    clause: '`id` = 1',
  },
  'local_upload_task.chk_local_upload_task_attempt': {
    since: 1775401400000,
    clause: '`attempt_count` >= 0',
  },
  'local_upload_task.chk_local_upload_task_entity_type': {
    since: 1775401400000,
    clause: "`entity_type` IN ('REPORT_VERSION', 'ATTACHMENT', 'BACKUP_MANIFEST')",
  },
  'local_upload_task.chk_local_upload_task_error': {
    since: 1775401400000,
    clause: "`status` <> 'FAILED' OR (`error_code` IS NOT NULL AND `error_message` IS NOT NULL)",
  },
  'local_upload_task.chk_local_upload_task_idempotency': {
    since: 1775401400000,
    clause: 'CHAR_LENGTH(TRIM(`idempotency_key`)) > 0',
  },
  'local_upload_task.chk_local_upload_task_status': {
    since: 1775401400000,
    clause: "`status` IN ('PENDING', 'UPLOADING', 'SUCCEEDED', 'FAILED', 'CANCELLED')",
  },
  'local_upload_task.chk_local_upload_task_version': {
    since: 1775401400000,
    clause: 'CHAR_LENGTH(TRIM(`entity_version`)) > 0',
  },
  'maintenance_report_alarm.chk_maintenance_report_alarm_code': {
    since: 1775401200000,
    clause: 'CHAR_LENGTH(TRIM(`alarm_code`)) > 0',
  },
  'maintenance_report_alarm.chk_maintenance_report_alarm_index': {
    since: 1775401200000,
    clause: '`alarm_index` BETWEEN 1 AND 8',
  },
  'maintenance_report_alarm.chk_maintenance_report_alarm_phase': {
    since: 1775401200000,
    clause:
      "`phase_code` IN ('PHASE_01','PHASE_02','PHASE_03','PHASE_04','PHASE_05','PHASE_06','PHASE_07','PHASE_08','PHASE_09','PHASE_10')",
  },
  'maintenance_report_alarm.chk_maintenance_report_alarm_reset': {
    since: 1775401200000,
    clause: "`reset_result` IN ('RESET_OK', 'RESET_FAILED', 'NOT_ATTEMPTED')",
  },
  'maintenance_report_attachment.chk_maintenance_report_attachment_byte_size': {
    since: 1775401300000,
    clause: '`byte_size` > 0 AND `byte_size` <= 20971520',
  },
  'maintenance_report_attachment.chk_maintenance_report_attachment_filename': {
    since: 1775401300000,
    clause: 'CHAR_LENGTH(TRIM(`original_filename`)) > 0',
  },
  'maintenance_report_attachment.chk_maintenance_report_attachment_retired': {
    since: 1775401300000,
    clause:
      "((`status` = 'CURRENT' AND `retired_at` IS NULL) OR (`status` = 'RETIRED' AND `retired_at` IS NOT NULL))",
  },
  'maintenance_report_attachment.chk_maintenance_report_attachment_sort': {
    since: 1775401300000,
    clause: '`sort_order` BETWEEN 1 AND 10',
  },
  'maintenance_report_attachment.chk_maintenance_report_attachment_status': {
    since: 1775401300000,
    clause: "`status` IN ('CURRENT', 'RETIRED')",
  },
  'maintenance_report_attachment.chk_maintenance_report_attachment_storage': {
    since: 1775401300000,
    clause: "`storage_backend` IN ('LOCAL', 'OBJECT')",
  },
  'maintenance_report_review.chk_maintenance_report_review_comment': {
    since: 1775401300000,
    clause: "`decision` = 'APPROVE' OR `comment` IS NOT NULL",
  },
  'maintenance_report_review.chk_maintenance_report_review_decision': {
    since: 1775401300000,
    clause: "`decision` IN ('APPROVE', 'RETURN')",
  },
  'maintenance_report_step.chk_maintenance_report_step_action': {
    since: 1775401200000,
    clause: 'CHAR_LENGTH(TRIM(`action_text`)) > 0',
  },
  'maintenance_report_step.chk_maintenance_report_step_branch': {
    since: 1775401200000,
    clause:
      '`is_valid_new_branch` IN (0, 1) AND (`is_valid_new_branch` = 0 OR `new_alarm_code` IS NOT NULL)',
  },
  'maintenance_report_step.chk_maintenance_report_step_code': {
    since: 1775401200000,
    clause: 'CHAR_LENGTH(TRIM(`step_code`)) > 0',
  },
  'maintenance_report_step.chk_maintenance_report_step_no': {
    since: 1775401200000,
    clause: '`step_no` >= 1',
  },
  'maintenance_report_step.chk_maintenance_report_step_phase': {
    since: 1775401200000,
    clause:
      "`phase_code` IN ('PHASE_01','PHASE_02','PHASE_03','PHASE_04','PHASE_05','PHASE_06','PHASE_07','PHASE_08','PHASE_09','PHASE_10')",
  },
  'maintenance_report_version_attachment.chk_maintenance_report_version_attachment_publish': {
    since: 1775401300000,
    clause: '`publish_flag` IN (0, 1)',
  },
  'maintenance_report_version_attachment.chk_maintenance_report_version_attachment_sort': {
    since: 1775401300000,
    clause: '`sort_order` BETWEEN 1 AND 10',
  },
  'maintenance_report_version.chk_maintenance_report_version_change_kind': {
    since: 1775401300000,
    clause: "`change_kind` IN ('SUBMIT', 'FORMAL_CORRECTION')",
  },
  'maintenance_report_version.chk_maintenance_report_version_correction_reason': {
    since: 1775401300000,
    clause: "`change_kind` = 'SUBMIT' OR `change_reason` IS NOT NULL",
  },
  'maintenance_report_version.chk_maintenance_report_version_no': {
    since: 1775401300000,
    clause: '`version_no` >= 1',
  },
  'maintenance_report_version.chk_maintenance_report_version_payload': {
    since: 1775401300000,
    clause: 'JSON_VALID(`payload_snapshot`)',
  },
  'maintenance_report_version.chk_maintenance_report_version_schema': {
    since: 1775401300000,
    clause: '`schema_version` >= 2',
  },
  'maintenance_report.chk_maintenance_report_ai_score': {
    since: 1775401200000,
    clause: '`ai_score` IS NULL OR `ai_score` BETWEEN 1 AND 5',
  },
  'maintenance_report.chk_maintenance_report_ai_usage': {
    since: 1775401200000,
    clause:
      "((`ai_usage` = 'NOT_USED' AND `ai_source_type` IS NULL AND `ai_source_id` IS NULL AND `ai_source_version` IS NULL AND `ai_score` IS NULL AND `ai_correctness` IS NULL AND `ai_helpfulness` IS NULL AND `ai_note` IS NULL) OR (`ai_usage` = 'USED' AND `ai_source_type` IS NOT NULL AND CHAR_LENGTH(TRIM(`ai_source_type`)) > 0 AND `ai_source_id` IS NOT NULL AND `ai_source_version` IS NOT NULL))",
  },
  'maintenance_report.chk_maintenance_report_model_exclusive': {
    since: 1775401200000,
    clause: '`equipment_model_id` IS NULL OR `equipment_model_text` IS NULL',
  },
  'maintenance_report.chk_maintenance_report_phase_flow': {
    since: 1775401200000,
    clause: '`phase_flow_version` >= 1',
  },
  'maintenance_report.chk_maintenance_report_request_source': {
    since: 1775401200000,
    clause:
      "((`source_type` = 'WORK_ORDER_SUMMARY' AND `repair_request_id` IS NOT NULL) OR (`source_type` = 'HISTORICAL_CASE' AND `repair_request_id` IS NULL))",
  },
  'maintenance_report.chk_maintenance_report_source': {
    since: 1775401200000,
    clause: "`source_type` IN ('HISTORICAL_CASE', 'WORK_ORDER_SUMMARY')",
  },
  'material_submission_detail.chk_material_submission_detail_model_exclusive': {
    since: 1775301300000,
    clause: '(`equipment_model_id` IS NULL OR `equipment_model_text` IS NULL)',
  },
  'material_submission_detail.chk_material_submission_detail_type': {
    since: 1775301300000,
    clause: "(`document_type` IS NULL OR `document_type` <> 'FAULT_CASE')",
  },
  'organization_membership.chk_organization_membership_period': {
    since: 1775301100000,
    clause:
      "((`status` = 'ACTIVE' AND `left_at` IS NULL) OR (`status` = 'LEFT' AND `left_at` IS NOT NULL))",
  },
  'organization_membership.chk_organization_membership_status': {
    since: 1775301100000,
    clause: "`status` IN ('ACTIVE', 'LEFT')",
  },
  'organization_membership.chk_organization_membership_role': {
    since: 1775401000000,
    clause: "`member_role` IN ('SUPER_ADMIN', 'ENGINEER', 'CUSTOMER')",
    stages: [
      {
        since: 1775301100000,
        clause: "`member_role` IN ('SUPER_ADMIN', 'ENGINEER')",
      },
    ],
  },
  'organization.chk_organization_kind': {
    since: 1775301000000,
    clause: "`kind` IN ('CLIENT', 'PEER')",
  },
  'organization.chk_organization_status': {
    since: 1775301000000,
    clause: "`status` IN ('ACTIVE', 'DISABLED')",
  },
  'reference_document_case_detail.chk_reference_document_case_detail_resolution': {
    since: 1775301800000,
    clause:
      "(`handling_status` <> 'RESOLVED' OR (`resolution` IS NOT NULL AND CHAR_LENGTH(TRIM(`resolution`)) > 0))",
  },
  'reference_document_case_detail.chk_reference_document_case_detail_status': {
    since: 1775301800000,
    clause: "`handling_status` IN ('UNRESOLVED', 'IN_PROGRESS', 'RESOLVED')",
  },
  'reference_document.chk_reference_document_deletion_consistency': {
    since: 1775201500000,
    clause:
      '((`deprecated` = 0 AND `deleted_at` IS NULL) OR (`deprecated` = 1 AND `deleted_at` IS NOT NULL))',
  },
  'reference_document.chk_reference_document_model_exclusive': {
    since: 1775301900000,
    clause: '(`equipment_model_id` IS NULL OR `equipment_model_text` IS NULL)',
  },
  'reference_document.chk_reference_document_source_pair': {
    since: 1775301900000,
    clause:
      '((`source_submission_id` IS NULL AND `source_revision_id` IS NULL) OR (`source_submission_id` IS NOT NULL AND `source_revision_id` IS NOT NULL))',
  },
  'reference_document.chk_reference_document_storage_pair': {
    since: 1775201500000,
    clause:
      '((`storage_backend` IS NULL AND `storage_reference` IS NULL) OR (`storage_backend` IS NOT NULL AND `storage_reference` IS NOT NULL))',
  },
  'repair_request.chk_repair_request_acceptance_consistency': {
    since: 1775201000000,
    clause:
      '((`is_accepted` = 0 AND `accepted_by_engineer_account_id` IS NULL AND `accepted_at` IS NULL) OR (`is_accepted` = 1 AND `accepted_by_engineer_account_id` IS NOT NULL AND `accepted_at` IS NOT NULL))',
  },
  'repair_request.chk_repair_request_deletion_consistency': {
    since: 1775201000000,
    clause:
      '((`deprecated` = 0 AND `deleted_at` IS NULL) OR (`deprecated` = 1 AND `deleted_at` IS NOT NULL AND `is_accepted` = 0))',
  },
  'repair_request.chk_repair_request_handling_requires_accepted': {
    since: 1775401100000,
    clause: '`handling_result` IS NULL OR `is_accepted` = 1',
  },
  'repair_request.chk_repair_request_handling_result': {
    since: 1775401100000,
    clause:
      "`handling_result` IS NULL OR `handling_result` IN ('FIXED', 'PART_PURCHASED', 'PROVIDE_PLAN_SELF_EXECUTE', 'INTERRUPTED', 'UNREPAIRABLE')",
  },
  'repair_request.chk_repair_request_handling_status': {
    since: 1775401100000,
    clause:
      "`handling_status` IS NULL OR `handling_status` IN ('COMPLETED', 'IN_PROGRESS', 'UNRESOLVED')",
  },
  'repair_request.chk_repair_request_handling_mapping': {
    since: 1775401600000,
    clause:
      "(((`handling_result` is null) and (`handling_status` is null)) or ((`handling_result` is not null) and (`handling_status` is not null) and (((`handling_result` = 'FIXED') and (`handling_status` = 'COMPLETED')) or ((`handling_result` = 'PART_PURCHASED') and (`handling_status` = 'COMPLETED')) or ((`handling_result` = 'PROVIDE_PLAN_SELF_EXECUTE') and (`handling_status` = 'COMPLETED')) or ((`handling_result` = 'INTERRUPTED') and (`handling_status` = 'IN_PROGRESS')) or ((`handling_result` = 'UNREPAIRABLE') and (`handling_status` = 'UNRESOLVED')))))",
    stages: [
      {
        since: 1775401100000,
        clause:
          "(`handling_result` IS NULL AND `handling_status` IS NULL) OR (`handling_result` = 'FIXED' AND `handling_status` = 'COMPLETED') OR (`handling_result` = 'PART_PURCHASED' AND `handling_status` = 'COMPLETED') OR (`handling_result` = 'PROVIDE_PLAN_SELF_EXECUTE' AND `handling_status` = 'COMPLETED') OR (`handling_result` = 'INTERRUPTED' AND `handling_status` = 'IN_PROGRESS') OR (`handling_result` = 'UNREPAIRABLE' AND `handling_status` = 'UNRESOLVED')",
      },
    ],
  },
  'repair_request.chk_repair_request_handling_time': {
    since: 1775401600000,
    clause:
      "(((`handling_result` is null) and (`handling_status` is null) and (`handling_recorded_at` is null) and (`handling_ended_at` is null)) or ((`handling_result` is not null) and (`handling_status` is not null) and (`handling_recorded_at` is not null) and (((`handling_status` = 'IN_PROGRESS') and (`handling_ended_at` is null)) or ((`handling_status` in ('COMPLETED','UNRESOLVED')) and (`handling_ended_at` is not null)))))",
    stages: [
      {
        since: 1775401100000,
        clause:
          "(`handling_result` IS NULL AND `handling_ended_at` IS NULL AND `handling_recorded_at` IS NULL) OR (`handling_result` IS NOT NULL AND `handling_recorded_at` IS NOT NULL AND ((`handling_status` = 'IN_PROGRESS' AND `handling_ended_at` IS NULL) OR (`handling_status` IN ('COMPLETED', 'UNRESOLVED') AND `handling_ended_at` IS NOT NULL)))",
      },
    ],
  },
};
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
  /** 精确定义；仅在定义生效迁移已执行时携带 */
  readonly definition?: ColumnDefinition;
}

export interface PrefixCheckRequirement extends PrefixStructureBase {
  readonly kind: 'check';
  /** 规范化比较用表达式；仅在定义生效迁移已执行时携带 */
  readonly definition?: CheckDefinition;
}

export interface PrefixForeignKeyRequirement extends PrefixStructureBase {
  readonly kind: 'foreign_key';
  readonly referenceTable: string;
  readonly localColumns: ReadonlyArray<string>;
  readonly referenceColumns: ReadonlyArray<string>;
  readonly onDelete?: string;
  readonly onUpdate?: string;
}

export type PrefixStructureRequirement =
  | PrefixTableRequirement
  | PrefixIndexRequirement
  | PrefixColumnRequirement
  | PrefixCheckRequirement
  | PrefixForeignKeyRequirement;

/**
 * 读取列精确定义；登记项必须与 REQUIRED_COLUMNS 对应且自洽。
 */
function requireColumnDefinition(key: string): ColumnDefinition | undefined {
  const definition = COLUMN_DEFINITIONS[key];
  if (!definition) {
    return undefined;
  }
  if (typeof definition.since !== 'number') {
    throw new Error(`关键列定义未登记生效迁移: ${key}`);
  }
  if (typeof definition.columnType !== 'string' || definition.columnType.length === 0) {
    throw new Error(`关键列定义缺少 columnType: ${key}`);
  }
  const item = REQUIRED_COLUMNS.find((column) => `${column.table}.${column.column}` === key);
  if (!item) {
    throw new Error(`关键列定义未在 REQUIRED_COLUMNS 登记: ${key}`);
  }
  if (item.notNull !== undefined && item.notNull !== !definition.nullable) {
    throw new Error(`关键列可空性与定义不一致: ${key}`);
  }
  return definition;
}

/**
 * 读取 CHECK 表达式定义；缺失/空表达式/非法阶段均属契约缺陷，必须显式停止。
 */
function requireCheckDefinition(key: string): CheckDefinition {
  const definition = CHECK_DEFINITIONS[key];
  if (!definition) {
    throw new Error(`关键 CHECK 缺少表达式定义: ${key}`);
  }
  if (typeof definition.since !== 'number') {
    throw new Error(`关键 CHECK 缺少 since: ${key}`);
  }
  if (typeof definition.clause !== 'string' || definition.clause.trim().length === 0) {
    throw new Error(`关键 CHECK 定义缺少表达式: ${key}`);
  }
  if (!REQUIRED_CHECKS.some((check) => `${check.table}.${check.constraint}` === key)) {
    throw new Error(`关键 CHECK 定义未在 REQUIRED_CHECKS 登记: ${key}`);
  }
  const stages = definition.stages;
  if (stages !== undefined) {
    if (!Array.isArray(stages) || stages.length === 0) {
      throw new Error(`关键 CHECK 阶段定义为空: ${key}`);
    }
    // Array.isArray 会把只读数组窄化为 any[]；显式回注契约类型，避免动态校验处于 any。
    const declaredStages = stages as ReadonlyArray<CheckStageDefinition>;
    let previousSince = 0;
    for (const stage of declaredStages) {
      if (typeof stage.since !== 'number' || stage.since <= previousSince) {
        throw new Error(`关键 CHECK 阶段 since 非递增: ${key}`);
      }
      if (stage.since >= definition.since) {
        throw new Error(`关键 CHECK 阶段 since 不早于终态: ${key}`);
      }
      if (typeof stage.clause !== 'string' || stage.clause.trim().length === 0) {
        throw new Error(`关键 CHECK 阶段缺少表达式: ${key} @ ${stage.since}`);
      }
      previousSince = stage.since;
    }
  }
  return definition;
}

/**
 * 按已执行迁移集合解析 CHECK 在该前缀的有效定义。
 * stages 登记旧态有效定义，终态 since/clause 为最新阶段。
 */
function resolveCheckDefinitionAt(
  definition: CheckDefinition,
  executedTimestamps: ReadonlySet<number>,
): CheckDefinition | undefined {
  let effective: CheckDefinition | undefined;
  for (const stage of definition.stages ?? []) {
    if (executedTimestamps.has(stage.since)) {
      effective = { since: stage.since, clause: stage.clause };
    }
  }
  if (executedTimestamps.has(definition.since)) {
    effective = { since: definition.since, clause: definition.clause };
  }
  return effective;
}

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
  for (const key of Object.keys(COLUMN_DEFINITIONS)) {
    requireColumnDefinition(key);
  }
  for (const item of REQUIRED_CHECKS) {
    requireCheckDefinition(`${item.table}.${item.constraint}`);
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
    const definition = requireColumnDefinition(key);
    add({
      kind: 'column',
      table: item.table,
      name: item.column,
      since: requireOwner(COLUMN_CREATED_BY, key, 'column'),
      notNull: item.notNull,
      definition: definition && executedTimestamps.has(definition.since) ? definition : undefined,
    });
  }

  for (const item of REQUIRED_CHECKS) {
    const key = `${item.table}.${item.constraint}`;
    const definition = requireCheckDefinition(key);
    add({
      kind: 'check',
      table: item.table,
      name: item.constraint,
      since: requireOwner(CHECK_CREATED_BY, key, 'check'),
      definition: resolveCheckDefinitionAt(definition, executedTimestamps),
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
      onDelete: definition.onDelete,
      onUpdate: definition.onUpdate,
    });
  }

  return requirements;
}

/**
 * 追加迁移复用旧列名但改变语义时（如 maintenance_report_fault.status/source），
 * 仅按列名判断会把已执行旧迁移创建的合法列误判为半迁移。
 * 这里登记可核验的旧定义，供预检按实际类型排除误报。
 */
export const REDEFINED_COLUMN_OWNERS: ReadonlyArray<{
  readonly table: string;
  readonly column: string;
  readonly since: number;
  readonly legacyColumnType: string;
}> = [
  {
    table: 'maintenance_report_fault',
    column: 'status',
    since: 1775501300000,
    legacyColumnType: 'varchar(16)',
  },
  {
    table: 'maintenance_report_fault',
    column: 'source',
    since: 1775501300000,
    legacyColumnType: 'varchar(16)',
  },
];

/**
 * 判断某个结构是否由更早的已执行迁移创建。
 * 追加迁移中的条件 ADD COLUMN（如 repair_request.is_historical）不应被误报为半迁移。
 */
export function isStructureOwnedByExecutedMigration(
  kind: 'column' | 'object',
  table: string,
  name: string,
  executedTimestamps: ReadonlySet<number>,
): boolean {
  const key = `${table}.${name}`;
  const owners =
    kind === 'column'
      ? [COLUMN_CREATED_BY[key]]
      : [INDEX_CREATED_BY[key], CHECK_CREATED_BY[key], FOREIGN_KEY_CREATED_BY[key]];
  return owners.some((since) => typeof since === 'number' && executedTimestamps.has(since));
}

/**
 * 全部关键结构清单，供最终校验使用（不区分迁移是否已执行）。
 */
export function collectAllStructureRequirements(): ReadonlyArray<PrefixStructureRequirement> {
  const executedTimestamps = new Set<number>([
    ...Object.values(TABLE_CREATED_BY),
    ...Object.values(INDEX_CREATED_BY),
    ...Object.values(COLUMN_CREATED_BY),
    ...Object.values(CHECK_CREATED_BY),
    ...Object.values(FOREIGN_KEY_CREATED_BY),
  ]);
  // 同名 CHECK 可能在后续迁移替换表达式；终态校验必须包含这些阶段的 since，
  // 否则会回退到旧阶段并误报终态漂移。
  for (const definition of Object.values(CHECK_DEFINITIONS)) {
    if (typeof definition.since === 'number') {
      executedTimestamps.add(definition.since);
    }
    for (const stage of definition.stages ?? []) {
      executedTimestamps.add(stage.since);
    }
  }
  return collectPrefixStructureRequirements(executedTimestamps);
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
