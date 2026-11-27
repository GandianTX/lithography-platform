#!/usr/bin/env python3
"""为直接构造用例的单元测试补上「恢复期写入冻结闸门」依赖桩。

背景：任务 09 S2-1 为业务写入口接入了 `LocalWriteHoldService`（恢复期冻结闸门）。
既有单测用 `new XxxUsecase(...)` 位置传参构造，新增依赖后参数数量不匹配导致
"Test suite failed to run"。本脚本按**被测类构造函数参数顺序**在正确位置插入桩，
不改变任何断言逻辑。

用法：python3 scripts/patch-write-hold-spec-stubs.py [--check]
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]

STUB = (
    "      {\n"
    "        assertBusinessWritable: async () => undefined,\n"
    "        assertCompanyWritable: async () => undefined,\n"
    "        assertWritable: async () => undefined,\n"
    "      } as unknown as LocalWriteHoldService,"
)

IMPORT_LINE = "import type { LocalWriteHoldService } from '@src/modules/lithography/local-write-hold.service';"


def split_top_level(text: str) -> list[str]:
    """按顶层逗号切分实参列表（忽略括号、字符串、模板串与注释）。"""
    parts: list[str] = []
    depth = 0
    current: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch in "'\"`":
            quote = ch
            current.append(ch)
            i += 1
            while i < n:
                current.append(text[i])
                if text[i] == "\\":
                    if i + 1 < n:
                        current.append(text[i + 1])
                        i += 2
                        continue
                elif text[i] == quote:
                    i += 1
                    break
                i += 1
            continue
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append("".join(current))
            current = []
            i += 1
            continue
        current.append(ch)
        i += 1
    tail = "".join(current)
    if tail.strip():
        parts.append(tail)
    return parts


def find_constructor_params(source: str, class_name: str) -> list[str]:
    """返回构造函数参数名列表。"""
    match = re.search(r"class\s+" + re.escape(class_name) + r"\b", source)
    if match is None:
        raise ValueError(f"class {class_name} not found")
    idx = source.find("constructor(", match.end())
    if idx < 0:
        raise ValueError(f"constructor of {class_name} not found")
    start = idx + len("constructor(")
    depth = 1
    i = start
    while i < len(source) and depth > 0:
        ch = source[i]
        if ch in "'\"`":
            quote = ch
            i += 1
            while i < len(source):
                if source[i] == "\\":
                    i += 2
                    continue
                if source[i] == quote:
                    break
                i += 1
        elif ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
        i += 1
    body = source[start : i - 1]
    names: list[str] = []
    for part in split_top_level(body):
        name = part.strip()
        if not name:
            continue
        name = name.split("=")[0].strip()
        # 形如 `private readonly foo: Foo` / `foo?: Foo` → 取参数名
        if ":" in name:
            name = name.rsplit(":", 1)[0].strip()
        name = name.replace("private", "").replace("readonly", "").replace("protected", "").strip()
        name = name.rstrip("?")
        names.append(name)
    return names


def patch_spec(spec_path: Path, class_sources: dict[str, Path]) -> bool:
    text = spec_path.read_text(encoding="utf-8")
    if "LocalWriteHoldService" in text:
        return False
    changed = False
    for class_name, src_path in class_sources.items():
        if f"new {class_name}(" not in text:
            continue
        params = find_constructor_params(src_path.read_text(encoding="utf-8"), class_name)
        if "localWriteHoldService" not in params:
            continue
        index = params.index("localWriteHoldService")
        search_from = 0
        while True:
            pos = text.find(f"new {class_name}(", search_from)
            if pos < 0:
                break
            open_paren = pos + len(f"new {class_name}(")
            depth = 1
            i = open_paren
            while i < len(text) and depth > 0:
                ch = text[i]
                if ch in "'\"`":
                    quote = ch
                    i += 1
                    while i < len(text):
                        if text[i] == "\\":
                            i += 2
                            continue
                        if text[i] == quote:
                            break
                        i += 1
                elif ch in "([{":
                    depth += 1
                elif ch in ")]}":
                    depth -= 1
                i += 1
            close_paren = i - 1
            args_text = text[open_paren:close_paren]
            args = split_top_level(args_text)
            if len(args) == len(params):
                search_from = close_paren
                continue
            if len(args) != len(params) - 1:
                search_from = close_paren
                continue
            line_start = text.rfind("\n", 0, pos) + 1
            indent = " " * (pos - line_start)
            stub = (
                "\n"
                + indent + "  {\n"
                + indent + "    assertBusinessWritable: async () => undefined,\n"
                + indent + "    assertCompanyWritable: async () => undefined,\n"
                + indent + "    assertWritable: async () => undefined,\n"
                + indent + "  } as unknown as LocalWriteHoldService"
            )
            args.insert(index, stub)
            new_args = ",".join(args)
            text = text[:open_paren] + new_args + text[close_paren:]
            changed = True
            search_from = open_paren + len(new_args)
    if changed and IMPORT_LINE not in text:
        lines = text.split("\n")
        idx = next((i for i, l in enumerate(lines) if l.startswith("import ")), None)
        if idx is None:
            raise ValueError(f"no import in {spec_path}")
        lines.insert(idx, IMPORT_LINE)
        text = "\n".join(lines)
    if changed:
        spec_path.write_text(text, encoding="utf-8")
    return changed


def main() -> int:
    check_only = "--check" in sys.argv
    classes = {
        "AcceptRepairRequestUsecase": "src/usecases/repair-request/accept-repair-request.usecase.ts",
        "CloseRepairRequestUsecase": "src/usecases/repair-request/close-repair-request.usecase.ts",
        "InterruptRepairRequestUsecase": "src/usecases/repair-request/interrupt-repair-request.usecase.ts",
        "CreateRepairProcessEntryUsecase": "src/usecases/repair-request/create-repair-process-entry.usecase.ts",
        "UpdateRepairProcessEntryUsecase": "src/usecases/repair-request/update-repair-process-entry.usecase.ts",
        "SaveRepairRequestMaintenanceUsecase": "src/usecases/repair-request/save-repair-request-maintenance.usecase.ts",
        "CreateRepairRequestUsecase": "src/usecases/repair-request/create-repair-request.usecase.ts",
        "DeleteMyRepairRequestUsecase": "src/usecases/repair-request/delete-my-repair-request.usecase.ts",
        "BindRepairRequestOriginalUsecase": "src/usecases/repair-request/bind-repair-request-original.usecase.ts",
        "BindRepairProcessOriginalUsecase": "src/usecases/repair-request/bind-repair-process-original.usecase.ts",
        "AddMaintenanceReportAttachmentUsecase": "src/usecases/maintenance-report/add-maintenance-report-attachment.usecase.ts",
        "RemoveMaintenanceReportAttachmentUsecase": "src/usecases/maintenance-report/remove-maintenance-report-attachment.usecase.ts",
        "ReorderMaintenanceReportAttachmentsUsecase": "src/usecases/maintenance-report/reorder-maintenance-report-attachments.usecase.ts",
        "SubmitMaintenanceReportUsecase": "src/usecases/maintenance-report/submit-maintenance-report.usecase.ts",
        "SubmitMaintenanceReportFormalUsecase": "src/usecases/maintenance-report/submit-maintenance-report-formal.usecase.ts",
        "UpdateMaintenanceReportDraftUsecase": "src/usecases/maintenance-report/update-maintenance-report-draft.usecase.ts",
        "CreateMaintenanceReportDraftUsecase": "src/usecases/maintenance-report/create-maintenance-report-draft.usecase.ts",
        "ApproveMaintenanceReportUsecase": "src/usecases/maintenance-report/approve-maintenance-report.usecase.ts",
        "ReturnMaintenanceReportUsecase": "src/usecases/maintenance-report/return-maintenance-report.usecase.ts",
        "RecordRepairRequestHandlingResultUsecase": "src/usecases/maintenance-report/record-repair-request-handling-result.usecase.ts",
        "ReviseReferenceDocumentUsecase": "src/usecases/reference-document/revise-reference-document.usecase.ts",
        "ReviseReferenceDocumentStructuredUsecase": "src/usecases/reference-document/revise-reference-document-structured.usecase.ts",
        "OfflineReferenceDocumentUsecase": "src/usecases/reference-document/offline-reference-document.usecase.ts",
        "SoftDeleteReferenceDocumentUsecase": "src/usecases/reference-document/soft-delete-reference-document.usecase.ts",
        "AdminDeleteReferenceDocumentUsecase": "src/usecases/reference-document/admin-delete-reference-document.usecase.ts",
        "CorrectReferenceDocumentOwnershipUsecase": "src/usecases/reference-document/correct-reference-document-ownership.usecase.ts",
        "UpdateReferenceDocumentCaseUsecase": "src/usecases/reference-document/update-reference-document-case.usecase.ts",
        "UploadStoredFileUsecase": "src/usecases/stored-file/upload-stored-file.usecase.ts",
        "AppendRepairRequestRevisionUsecase": "src/usecases/admin-document-database/append-repair-request-revision.usecase.ts",
        "ApplyLocalSyncConflictResolutionUsecase": "src/usecases/admin-document-database/apply-local-sync-conflict-resolution.usecase.ts",
        "StartManualLocalBackupUsecase": "src/usecases/local-runtime/start-manual-local-backup.usecase.ts",
        "EnqueueLocalUploadUsecase": "src/usecases/local-runtime/enqueue-local-upload.usecase.ts",
        "ReconcileBusinessSyncTasksUsecase": "src/usecases/local-runtime/reconcile-business-sync-tasks.usecase.ts",
        "ResolveSyncConflictUsecase": "src/usecases/local-runtime/resolve-sync-conflict.usecase.ts",
        "CleanupLocalBackupPackagesUsecase": "src/usecases/local-runtime/cleanup-local-backup-packages.usecase.ts",
        "ExportRecordPackageUsecase": "src/usecases/local-runtime/export-record-package.usecase.ts",
        "BackupScheduleService": "src/modules/lithography/backup-schedule.service.ts",
        "LocalBackupUploadService": "src/modules/lithography/local-backup-upload.service.ts",
        "LocalBackupCleanupService": "src/modules/lithography/local-backup-cleanup.service.ts",
        "StoredFileRetentionService": "src/modules/lithography/stored-file-retention.service.ts",
    }
    class_sources = {name: BACKEND / rel for name, rel in classes.items()}
    specs = sorted(BACKEND.glob("src/**/*.spec.ts"))
    touched: list[str] = []
    for spec in specs:
        if patch_spec(spec, class_sources):
            touched.append(str(spec.relative_to(BACKEND)))
    print(f"patched {len(touched)} spec files")
    for item in touched:
        print(f"  - {item}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
