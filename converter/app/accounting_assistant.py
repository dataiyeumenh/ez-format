from __future__ import annotations

import ipaddress
import os
import re
import uuid
from decimal import Decimal, InvalidOperation
from typing import Any
from urllib.parse import urlparse

import httpx

from app.evidence_packets import create_evidence_packet, validate_citations
from app.document_totals import aggregate_document_totals
from app.misa_readiness import build_readiness_report
from app.operation_models import EvidenceItem, EvidencePacket
from app.operation_store import OperationStore, OperationStoreError
from app.parsing import parse_decimal
from app.student_models import StudentAnswer, StudentAnswerEvidence
from app.student_queries import answer_question
from app.normalization import normalize_header


class AccountingAssistantFeatureDisabledError(OperationStoreError):
    pass


class LocalAiAssistantError(ValueError):
    pass


_SENSITIVE_SEMANTIC_FIELDS = (
    "bank",
    "cccd",
    "cmnd",
    "dia_chi",
    "dien_thoai",
    "email",
    "ho_ten",
    "khach_hang",
    "ma_hoa_don",
    "ma_so_thue",
    "mst",
    "ngan_hang",
    "nha_cung_cap",
    "so_hoa_don",
    "tai_khoan",
    "tax",
    "ten_khach_hang",
    "ten_nha_cung_cap",
)
_LONG_IDENTIFIER = re.compile(r"(?<!\d)\d{8,20}(?!\d)")
_EMAIL = re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.IGNORECASE)
_PHONE = re.compile(r"(?<!\d)(?:\+?84|0)\d{8,10}(?!\d)")
_SENSITIVE_CONTEXT = re.compile(
    r"(?:mã\s*số\s*thuế|mst|điện\s*thoại|số\s*điện\s*thoại|email|"
    r"số\s*tài\s*khoản(?:\s*ngân\s*hàng)?|tên\s*khách\s*hàng|"
    r"tên\s*nhà\s*cung\s*cấp|địa\s*chỉ)\s*[:=]?\s*[^,;|\n]+",
    re.IGNORECASE,
)
_PROMPT_INJECTION = re.compile(
    r"(ignore (all|previous) instructions|system prompt|export secrets|bo qua (chi dan|huong dan))",
    re.IGNORECASE,
)
_MAX_DISPLAY_EVIDENCE = 20
_AI_WORDING_INTENTS = {
    "aggregate_amount",
    "count_documents",
    "file_summary",
    "locate_column",
    "locate_rows",
}
_UNSUPPORTED_AI_CLAIMS = (
    "duoc_mien_thue",
    "mien_thue",
    "khong_chiu_thue",
    "khong_phai_nop_thue",
    "uu_dai_thue",
    "mien_giam_thue",
    "duoc_khau_tru",
    "duoc_hoan_thue",
    "duoc_tru_khi_tinh_thue",
    "dung_luat",
    "hach_toan_vao",
    "hoa_don_hop_phap",
    "hop_le",
    "nen_hach_toan",
    "phai_hach_toan",
    "phai_nop_thue",
    "phu_hop_quy_dinh",
    "tai_khoan_nao",
    "thue_suat",
    "tuan_thu",
)
_AI_NEUTRAL_TOKENS = {
    "bang",
    "canh",
    "cho",
    "chung",
    "co",
    "cot",
    "du",
    "duoc",
    "dong",
    "file",
    "gia",
    "ghi",
    "hien",
    "ket",
    "la",
    "lieu",
    "nhan",
    "qua",
    "tai",
    "theo",
    "thay",
    "tong",
    "tren",
    "tri",
    "tu",
    "va",
}


def accounting_assistant_enabled() -> bool:
    return os.getenv("FEATURE_ACCOUNTING_ASSISTANT", "false").strip().lower() in {
        "1",
        "true",
        "yes",
    }


def ask_accounting_question(
    store: OperationStore,
    *,
    session_id: str,
    revision: int,
    state_hash: str,
    question: str,
    use_ai: bool = False,
    mapping: dict[str, Any] | None = None,
    readiness: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if not accounting_assistant_enabled():
        raise AccountingAssistantFeatureDisabledError("Accounting Assistant đang tắt")
    session = store.assert_current(
        session_id,
        expected_revision=revision,
        expected_state_hash=state_hash,
    )
    table = store.materialize_table(session_id, revision=revision)
    context = store.context_for_revision(session_id, revision)
    backend_mapping = context.get("mapping") if isinstance(context.get("mapping"), dict) else {}
    backend_defaults = context.get("defaults") if isinstance(context.get("defaults"), dict) else {}
    backend_formulas = context.get("formulas") if isinstance(context.get("formulas"), dict) else {}
    backend_readiness = build_readiness_report(
        table,
        session.target_template_id,
        backend_mapping,
        backend_defaults,
        backend_formulas,
    ).model_dump(mode="json")
    # Old parameters remain accepted only for wire compatibility.
    _ = mapping, readiness
    state = {
        "session_id": session_id,
        "upload_id": session.upload_id,
        "state_hash": state_hash,
        "table": table,
        "mapping": backend_mapping,
        "target_headers": table.headers,
        "target_template_id": session.target_template_id,
        "readiness": backend_readiness,
        "summary": {
            "data_row_count": len(table.rows),
            "document_count": None,
            "recognized_columns": len(table.headers),
            "unresolved_columns": 0,
            "mapping_counts": {},
            "issue_counts": {},
        },
        "ai_available": False,
    }
    deterministic = answer_question(question, state)
    if deterministic.intent == "aggregate_amount":
        deterministic = _fallback_amount_answer(question, table) or deterministic
    elif deterministic.outcome != "supported":
        deterministic = _fallback_amount_answer(question, table) or deterministic
    evidence_items = _evidence_items(
        deterministic.evidence,
        rule_sources=deterministic.rule_sources,
        intent=deterministic.intent,
        allow_calculation=not deterministic.needs_professional_review,
    )
    if not evidence_items:
        evidence_items.append(
            EvidenceItem(
                evidence_id=f"session:{session_id}:revision:{revision}",
                type="file_cell",
                label="Thông tin phiên do backend xác nhận",
                locator={"scope": "session_summary"},
                value={
                    "row_count": len(table.rows),
                    "target_template_id": session.target_template_id,
                },
            )
        )
    packet = create_evidence_packet(
        store,
        session_id=session_id,
        revision=revision,
        state_hash=state_hash,
        items=evidence_items,
    )
    if deterministic.outcome == "supported" and (
        not use_ai or deterministic.intent not in _AI_WORDING_INTENTS
    ):
        return _deterministic_answer_payload(deterministic, packet)
    if deterministic.outcome != "supported":
        return _answer_payload(
            answer=deterministic.answer,
            status="ai_unavailable" if deterministic.outcome == "ai_unavailable" else "unsupported",
            answer_type="unsupported",
            confidence="unsupported",
            packet=packet,
            citations=[],
            needs_review=True,
            unsupported_reason=deterministic.unsupported_reason,
        )
    try:
        ai_response = _request_local_ai(
            _ai_payload(
                question,
                packet,
                allowed_intent=deterministic.intent,
                deterministic_answer=deterministic.answer,
            )
        )
    except LocalAiAssistantError:
        return _deterministic_answer_payload(deterministic, packet)
    citations = [str(item) for item in ai_response.get("citations") or []]
    if not validate_citations(packet, citations):
        return _deterministic_answer_payload(deterministic, packet)
    answer = str(ai_response.get("answer") or "").strip()
    if not answer:
        return _deterministic_answer_payload(deterministic, packet)
    if not _ai_claims_entailed(answer, deterministic.answer, packet, citations):
        return _deterministic_answer_payload(deterministic, packet)
    return _answer_payload(
        answer=answer,
        status="answered",
        answer_type="ai_worded",
        confidence="needs_review",
        packet=packet,
        citations=citations,
        needs_review=True,
    )


def _evidence_items(
    evidence: list[Any],
    *,
    rule_sources: list[str],
    intent: str,
    allow_calculation: bool = True,
) -> list[EvidenceItem]:
    items: list[EvidenceItem] = []
    for item in evidence[:_MAX_DISPLAY_EVIDENCE]:
        kind = str(item.kind)
        evidence_type = "misa_document" if kind == "template" else "file_cell"
        items.append(
            EvidenceItem(
                evidence_id=str(item.id),
                type=evidence_type,
                label=_evidence_label(item),
                locator={
                    "sheet": item.sheet,
                    "row": item.row,
                    "column": item.field,
                    "target_field": item.target_field,
                },
                value=item.actual,
                operands=(
                    [{"name": "actual", "value": item.actual}, {"name": "expected", "value": item.expected}]
                    if item.expected is not None
                    else []
                ),
            )
        )
    for source_url in rule_sources:
        source_id = f"source:{uuid.uuid5(uuid.NAMESPACE_URL, source_url).hex[:20]}"
        items.append(
            EvidenceItem(
                evidence_id=source_id,
                type=(
                    "legal_source"
                    if "vanban.chinhphu.vn" in source_url or "mof.gov.vn" in source_url
                    else "misa_document"
                ),
                label="Nguồn tham chiếu đã cấu hình",
                source_url=source_url,
            )
        )
    if intent == "aggregate_amount" and allow_calculation:
        operands: list[dict[str, Any]] = []
        total = None
        for item in evidence:
            parsed = parse_decimal(item.actual)
            if parsed is None:
                continue
            total = (total or 0) + parsed
            operands.append(
                {
                    "evidence_id": item.id,
                    "value": str(parsed),
                    "locator": {
                        "sheet": item.sheet,
                        "row": item.row,
                        "column": item.field,
                    },
                }
            )
        if total is not None and operands:
            items.append(
                EvidenceItem(
                    evidence_id=f"calculation:{uuid.uuid4().hex[:20]}",
                    type="calculation",
                    label="Tổng do backend tính bằng Decimal",
                    value=str(total),
                    operands=operands,
                )
            )
    return items


def _fallback_amount_answer(question: str, table: Any) -> StudentAnswer | None:
    normalized_question = normalize_header(question)
    if not any(token in normalized_question for token in ("tong_tien", "tong_thanh_tien", "tong_cong")):
        return None
    candidate = next(
        (
            header
            for header in table.headers
            if any(
                token in normalize_header(header)
                for token in ("tong_tien", "tong_thanh_toan", "tong_cong")
            )
        ),
        None,
    )
    if candidate is None:
        return None
    invoice_identifier = next(
        (
            header
            for header in table.headers
            if normalize_header(header)
            in {
                "source_document_id",
                "document_id",
                "id_chung_tu",
                "id_hoa_don",
                "ma_hoa_don",
                "so_hoa_don",
                "soct",
                "so_ct",
                "invoice_number",
            }
        ),
        None,
    )
    report = aggregate_document_totals(
        table.rows,
        document_key_fields=[invoice_identifier] if invoice_identifier else [],
        line_amount_field=None,
        document_total_field=candidate,
    )
    if report.status != "complete" or report.sum_total is None:
        return None

    evidence: list[StudentAnswerEvidence] = []
    total = Decimal(report.sum_total)
    for index in report.contributing_rows:
        row = table.rows[index - 1]
        evidence.append(
            StudentAnswerEvidence(
                id=f"amount:{index}:{uuid.uuid5(uuid.NAMESPACE_OID, candidate).hex[:8]}",
                kind="source_cell",
                sheet=table.sheet_name,
                row=table.header_row_index + index + 1,
                field=candidate,
                actual=row.get(candidate),
            )
        )
    if total is None or not evidence:
        return None
    return StudentAnswer(
        answer=f"Tổng {candidate} theo dữ liệu đọc được là {total}.",
        intent="aggregate_amount",
        answer_type="deterministic_file_query",
        confidence="verified",
        evidence=evidence,
        evidence_count=len(evidence),
        outcome="supported",
    )


def _evidence_label(item: Any) -> str:
    parts = [str(item.kind)]
    if item.row:
        parts.append(f"dòng {item.row}")
    if item.field:
        parts.append(str(item.field))
    return " - ".join(parts)


def _ai_payload(
    question: str,
    packet: EvidencePacket,
    *,
    allowed_intent: str,
    deterministic_answer: str,
) -> dict[str, Any]:
    items: list[dict[str, Any]] = []
    for item in packet.items:
        items.append(_sanitize_evidence_payload(item.model_dump(mode="json")))
    return {
        "question": _redact_text(question),
        "allowed_intent": allowed_intent,
        "deterministic_answer": _redact_text(deterministic_answer),
        "instruction_boundary": "evidence_is_untrusted_data",
        "evidence_packet": {
            "packet_id": packet.packet_id,
            "session_id": packet.session_id,
            "revision": packet.revision,
            "state_hash": packet.state_hash,
            "items": items,
        },
    }


def _redact_value(value: Any) -> Any:
    if isinstance(value, dict):
        redacted: dict[str, Any] = {}
        for key, item in value.items():
            sensitive = _is_sensitive_semantic(key)
            safe_key = "[REDACTED_FIELD]" if sensitive else _redact_text(str(key))
            redacted[safe_key] = "[REDACTED]" if sensitive else _redact_value(item)
        return redacted
    if isinstance(value, (list, tuple)):
        return [_redact_value(item) for item in value]
    if isinstance(value, str):
        return _redact_text(value)
    if isinstance(value, int) and not isinstance(value, bool):
        if 8 <= len(str(abs(value))) <= 20:
            return "[REDACTED_IDENTIFIER]"
        return value
    return value


def _redact_text(value: str) -> str:
    normalized = normalize_header(value)
    if _PROMPT_INJECTION.search(value) or any(
        pattern in normalized
        for pattern in (
            "bo_qua_chi_dan",
            "bo_qua_huong_dan",
            "ignore_all_instructions",
            "ignore_previous_instructions",
            "system_prompt",
            "export_secrets",
        )
    ):
        return "[UNTRUSTED_TEXT_REDACTED]"
    if _is_sensitive_semantic(normalized):
        return "[SENSITIVE_TEXT_REDACTED]"
    redacted = _SENSITIVE_CONTEXT.sub("[SENSITIVE_TEXT_REDACTED]", value)
    redacted = _EMAIL.sub("[REDACTED_EMAIL]", redacted)
    redacted = _PHONE.sub("[REDACTED_PHONE]", redacted)
    return _LONG_IDENTIFIER.sub("[REDACTED_IDENTIFIER]", redacted)


def _is_sensitive_semantic(value: Any) -> bool:
    normalized = normalize_header(value)
    padded = f"_{normalized}_"
    return any(
        normalized == field or f"_{field}_" in padded
        for field in _SENSITIVE_SEMANTIC_FIELDS
    )


def _sanitize_evidence_payload(payload: dict[str, Any]) -> dict[str, Any]:
    safe = dict(payload)
    locator = dict(safe.get("locator") or {})
    operands = list(safe.get("operands") or [])
    semantic_values = [safe.get("label"), *locator.values()]
    semantic_values.extend(operand.get("name") for operand in operands)
    sensitive = any(_is_sensitive_semantic(value) for value in semantic_values)

    safe["label"] = (
        "[REDACTED_FIELD]"
        if _is_sensitive_semantic(safe.get("label"))
        else _redact_text(str(safe.get("label") or ""))
    )
    safe["locator"] = {
        key: (
            "[REDACTED_FIELD]"
            if _is_sensitive_semantic(key) or _is_sensitive_semantic(value)
            else _redact_value(value)
        )
        for key, value in locator.items()
    }
    if sensitive:
        safe["value"] = "[REDACTED]"
        safe["operands"] = []
    else:
        safe["value"] = _redact_value(safe.get("value"))
        safe["operands"] = [
            {
                key: (
                    "[REDACTED]"
                    if _is_sensitive_semantic(operand.get("name")) and key == "value"
                    else _redact_value(value)
                )
                for key, value in operand.items()
            }
            for operand in operands
        ]
    return safe


def _sanitize_remote_payload(value: Any) -> Any:
    if isinstance(value, dict):
        if {"evidence_id", "type", "label"} <= set(value):
            return _sanitize_evidence_payload(value)
        return {str(key): _sanitize_remote_payload(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_sanitize_remote_payload(item) for item in value]
    return _redact_value(value)


def _ai_claims_entailed(
    answer: str,
    deterministic_answer: str,
    packet: EvidencePacket,
    citations: list[str],
) -> bool:
    normalized = normalize_header(answer)
    if any(pattern in normalized for pattern in _UNSUPPORTED_AI_CLAIMS):
        return False
    cited = {citation for citation in citations}
    source_text = " ".join(
        [deterministic_answer]
        + [
            str(value)
            for item in packet.items
            if item.evidence_id in cited
            for value in (
                item.label,
                item.value,
                *((item.locator or {}).values()),
                *(operand.get("value") for operand in item.operands),
            )
            if value is not None
        ]
    )
    if not _ai_values_supported(answer, source_text):
        return False
    answer_tokens = set(normalize_header(answer).split("_"))
    source_tokens = set(normalize_header(source_text).split("_"))
    return answer_tokens <= source_tokens | _AI_NEUTRAL_TOKENS


def _ai_values_supported(answer: str, permitted_text: str) -> bool:
    numeric_pattern = re.compile(r"(?<!\w)-?\d+(?:[.,]\d+)?")
    claimed = {_normalize_numeric_token(item) for item in numeric_pattern.findall(answer)}
    if not claimed:
        return True
    permitted = {
        _normalize_numeric_token(item) for item in numeric_pattern.findall(permitted_text)
    }
    return claimed <= permitted


def _normalize_numeric_token(value: str) -> str:
    raw = value.replace(" ", "").lstrip("+")
    if "." in raw and "," in raw:
        raw = raw.replace(".", "").replace(",", ".") if raw.rfind(",") > raw.rfind(".") else raw.replace(",", "")
    elif "," in raw:
        raw = raw.replace(",", ".") if len(raw.rsplit(",", 1)[1]) != 3 else raw.replace(",", "")
    elif "." in raw:
        raw = raw.replace(".", "") if len(raw.rsplit(".", 1)[1]) == 3 else raw
    try:
        return format(Decimal(raw), "f").rstrip("0").rstrip(".") or "0"
    except InvalidOperation:
        return raw


def _request_local_ai(payload: dict[str, Any]) -> dict[str, Any]:
    if os.getenv("AI_PROVIDER", "disabled").strip().lower() != "remote_http":
        raise LocalAiAssistantError("AI Local Gateway chưa được cấu hình")
    url = _assistant_endpoint()
    token = os.getenv("AI_TOKEN", "").strip()
    headers = {"Content-Type": "application/json", "X-Request-ID": uuid.uuid4().hex}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    try:
        response = httpx.post(
            url,
            json=_sanitize_remote_payload(payload),
            headers=headers,
            timeout=float(os.getenv("AI_TIMEOUT_SECONDS", "20")),
        )
    except httpx.HTTPError as exc:
        raise LocalAiAssistantError(f"AI Local unavailable: {exc}") from exc
    if response.status_code >= 400:
        raise LocalAiAssistantError(f"AI Local returned HTTP {response.status_code}")
    try:
        result = response.json()
    except ValueError as exc:
        raise LocalAiAssistantError("AI Local trả JSON không hợp lệ") from exc
    if not isinstance(result, dict):
        raise LocalAiAssistantError("AI Local trả payload không hợp lệ")
    return result


def _assistant_endpoint() -> str:
    explicit = os.getenv("AI_ACCOUNTING_ASSISTANT_BASE_URL", "").strip()
    if explicit:
        return _validate_assistant_endpoint(explicit)
    base = os.getenv("AI_BASE_URL", "").strip()
    parsed = urlparse(base)
    if not parsed.scheme or not parsed.netloc:
        raise LocalAiAssistantError("AI_BASE_URL chưa được cấu hình")
    return _validate_assistant_endpoint(
        f"{parsed.scheme}://{parsed.netloc}/v1/misa/answer-evidence"
    )


def _validate_assistant_endpoint(url: str) -> str:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise LocalAiAssistantError("AI endpoint must use HTTP or HTTPS")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise LocalAiAssistantError("AI endpoint must not contain credentials, query, or fragment")

    host = parsed.hostname.casefold().rstrip(".")
    allowlist = {"localhost", "127.0.0.1", "::1"}
    allowlist.update(
        item.strip().casefold().rstrip(".")
        for item in os.getenv("AI_PRIVATE_LOCAL_HOST_ALLOWLIST", "").split(",")
        if item.strip()
    )
    if _is_private_local_host(host):
        if host not in allowlist:
            raise LocalAiAssistantError("AI private/local host is not in allowlist")
    elif parsed.scheme != "https":
        raise LocalAiAssistantError("Remote AI endpoint requires HTTPS")
    return url


def _is_private_local_host(host: str) -> bool:
    if host == "localhost" or host.endswith(
        (
            ".corp",
            ".home",
            ".internal",
            ".lan",
            ".local",
            ".localdomain",
            ".localhost",
        )
    ):
        return True
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return "." not in host
    return bool(
        address.is_private
        or address.is_loopback
        or address.is_link_local
        or address.is_reserved
    )


def _answer_payload(
    *,
    answer: str,
    status: str,
    answer_type: str,
    confidence: str,
    packet: EvidencePacket,
    citations: list[str],
    needs_review: bool,
    unsupported_reason: str | None = None,
) -> dict[str, Any]:
    return {
        "answer_id": str(uuid.uuid4()),
        "answer": answer,
        "status": status,
        "answer_type": answer_type,
        "confidence": confidence,
        "evidence_packet_id": packet.packet_id,
        "evidence_packet": packet.model_dump(mode="json"),
        "citations": citations,
        "needs_professional_review": needs_review,
        "unsupported_reason": unsupported_reason,
        "suggested_actions": [],
    }


def _deterministic_answer_payload(
    deterministic: StudentAnswer,
    packet: EvidencePacket,
) -> dict[str, Any]:
    return _answer_payload(
        answer=deterministic.answer,
        status="answered",
        answer_type="deterministic",
        confidence="verified",
        packet=packet,
        citations=[item.evidence_id for item in packet.items],
        needs_review=deterministic.needs_professional_review,
    )
