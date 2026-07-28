param(
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [string]$ReleaseId = (Get-Date -Format "yyyyMMdd-HHmmss"),
    [ValidateRange(1, 10)][int]$Runs = 3,
    [switch]$SkipBroadTests,
    [switch]$SkipPerformance,
    [switch]$AllowIncompleteDiagnostics,
    [switch]$ManifestOnly,
    [string]$AccountingQaReport,
    [string]$SalesRawFixture,
    [string]$PurchaseRawFixture,
    [string]$SalesMisaFixture,
    [string]$PurchaseMisaFixture
)

$ErrorActionPreference = "Stop"
$artifactRoot = Join-Path $RepoRoot ".artifacts\qa\$ReleaseId"
New-Item -ItemType Directory -Path $artifactRoot -Force | Out-Null

$results = [System.Collections.Generic.List[object]]::new()
$failed = [System.Collections.Generic.List[string]]::new()
$skipped = [System.Collections.Generic.List[string]]::new()

function Resolve-FixtureSetting {
    param([string]$Value, [string]$EnvironmentName, [string]$Default)
    if (-not [string]::IsNullOrWhiteSpace($Value)) { return $Value }
    $environmentValue = [Environment]::GetEnvironmentVariable($EnvironmentName)
    if (-not [string]::IsNullOrWhiteSpace($environmentValue)) { return $environmentValue }
    return $Default
}

$SalesRawFixture = Resolve-FixtureSetting $SalesRawFixture "QA_SALES_RAW_FIXTURE" "E:\0. EXE2\Chi tiết bán hàng 05.12 - 25.12.xlsx"
$PurchaseRawFixture = Resolve-FixtureSetting $PurchaseRawFixture "QA_PURCHASE_RAW_FIXTURE" (Join-Path $env:USERPROFILE "Downloads\MUA_VAO_0317262773 (7).xlsx")
$SalesMisaFixture = Resolve-FixtureSetting $SalesMisaFixture "QA_SALES_MISA_FIXTURE" "E:\0. EXE2\Import misa 05.12 - 25.12.xls"
$PurchaseMisaFixture = Resolve-FixtureSetting $PurchaseMisaFixture "QA_PURCHASE_MISA_FIXTURE" (Join-Path $env:USERPROFILE "Downloads\mua_hang_trong_nuoc_full.xls")

function Write-EvidenceFile {
    param([string]$Name, [object]$Value)
    $path = Join-Path $artifactRoot $Name
    if ($Value -is [string] -or $Value -is [array]) {
        $Value | Set-Content -LiteralPath $path -Encoding utf8
    } else {
        $Value | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath $path -Encoding utf8
    }
    return $path
}

function Add-GateResult {
    param([string]$Name, [ValidateSet("pass", "fail", "skip")][string]$Status, [string]$Reason = "", [string]$Log = $null, [double]$Seconds = 0)
    if ($Status -eq "fail") { $failed.Add($Name) }
    if ($Status -eq "skip") { $skipped.Add($Name) }
    $results.Add([ordered]@{ name = $Name; status = $Status; seconds = [math]::Round($Seconds, 3); reason = $Reason; log = $Log })
    $colour = @{ pass = "Green"; fail = "Red"; skip = "Yellow" }[$Status]
    Write-Host "$($Status.ToUpperInvariant()) $Name $Reason" -ForegroundColor $colour
}

function Invoke-GateStep {
    param([string]$Name, [string]$WorkingDirectory, [string]$Executable, [string[]]$Arguments)
    $logPath = Join-Path $artifactRoot ((($Name -replace "[^a-zA-Z0-9._-]", "-").ToLowerInvariant()) + ".log")
    $watch = [Diagnostics.Stopwatch]::StartNew()
    Push-Location $WorkingDirectory
    try {
        & $Executable @Arguments 2>&1 | Tee-Object -FilePath $logPath
        if ($LASTEXITCODE -ne 0) { throw "$Executable exited with code $LASTEXITCODE" }
        Add-GateResult $Name pass -Log $logPath -Seconds $watch.Elapsed.TotalSeconds
    } catch {
        $_ | Out-String | Add-Content -LiteralPath $logPath -Encoding utf8
        Add-GateResult $Name fail $_.Exception.Message $logPath $watch.Elapsed.TotalSeconds
    } finally {
        Pop-Location
        $watch.Stop()
    }
}

function Add-ExternalPrerequisite {
    param([string]$Name, [string]$Reason)
    if ($AllowIncompleteDiagnostics) { Add-GateResult $Name skip $Reason } else { Add-GateResult $Name fail $Reason }
}

function Get-FileSha256 {
    param([string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-TextSha256 {
    param([string]$Value)
    $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
    return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
}

function Assert-RequiredFile {
    param([string]$RelativePath)
    if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot $RelativePath) -PathType Leaf)) {
        throw "Missing required gate file: $RelativePath"
    }
}

function Get-WorkingTreeHash {
    $entries = git -C $RepoRoot ls-files --cached --others --exclude-standard | Sort-Object -Unique
    $lines = foreach ($relative in $entries) {
        if ($relative -like ".artifacts/*" -or $relative -like "*/node_modules/*") { continue }
        $absolute = Join-Path $RepoRoot $relative
        if (Test-Path -LiteralPath $absolute -PathType Leaf) { "$relative=$(Get-FileSha256 $absolute)" }
    }
    return Get-TextSha256 ($lines -join "`n")
}

function Invoke-AccountingFixtureValidation {
    $fixtureMap = [ordered]@{
        sales_raw = $SalesRawFixture
        purchase_raw = $PurchaseRawFixture
        sales_misa = $SalesMisaFixture
        purchase_misa = $PurchaseMisaFixture
    }
    $missing = @($fixtureMap.GetEnumerator() | Where-Object { -not (Test-Path -LiteralPath $_.Value -PathType Leaf) })
    if ($missing.Count -gt 0) {
        foreach ($item in $missing) { Add-ExternalPrerequisite "fixture-$($item.Key)" "Missing fixture: $($item.Value)" }
        return $null
    }

    $validatorPath = Join-Path $artifactRoot "validate-accounting-fixtures.py"
    $reportPath = Join-Path $artifactRoot "accounting-fixture-validation.json"
    @'
from __future__ import annotations

import hashlib
import json
import re
import sys
from collections import defaultdict
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

import xlrd

from app.document_totals import aggregate_document_totals
from app.excel_io import read_input_table, read_template
from app.mapping_semantics import validate_mapping_semantics
from app.misa_mapping import apply_mapping, detect_target_template_id, heuristic_suggestion, validate_mapping
from app.misa_templates import get_misa_template
from app.parsing import parse_decimal


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def decimal(value: object) -> Decimal:
    parsed = parse_decimal(value)
    return parsed if parsed is not None else Decimal("0")


def key(row: dict[str, object], fields: tuple[str, ...]) -> tuple[str, ...]:
    return tuple(str(row.get(field) or "").strip().casefold() for field in fields)


def sales_invoice_key(value: object) -> tuple[str, ...]:
    normalized = str(value or "").strip().casefold()
    return (re.sub(r"_\d+$", "", normalized),)


def style_signature(book, sheet, row: int, col: int) -> tuple:
    xf = book.xf_list[sheet.cell_xf_index(row, col)]
    font = book.font_list[xf.font_index]
    fmt = book.format_map[xf.format_key].format_str
    return (
        fmt, font.name, font.bold, font.height,
        xf.alignment.hor_align, xf.alignment.vert_align, xf.alignment.text_wrapped,
        xf.border.left_line_style, xf.border.right_line_style,
        xf.border.top_line_style, xf.border.bottom_line_style,
        xf.background.fill_pattern, xf.background.pattern_colour_index,
        xf.background.background_colour_index,
        xf.protection.cell_locked, xf.protection.formula_hidden,
    )


def validate_template(external: Path, template_id: str) -> dict[str, object]:
    canonical = get_misa_template(template_id)
    external_template = read_template(external)
    require(external_template.headers == canonical.headers, f"{template_id}: headers differ from canonical template")
    source_book = xlrd.open_workbook(str(canonical.path), formatting_info=True)
    source_sheet = source_book.sheet_by_index(0)
    fixture_book = xlrd.open_workbook(str(external), formatting_info=True)
    fixture_sheet = fixture_book.sheet_by_index(0)
    require(set(fixture_sheet.merged_cells) == set(source_sheet.merged_cells), f"{template_id}: merged cells differ")
    width_limit = len(canonical.headers)
    source_widths = [getattr(source_sheet.colinfo_map.get(col), "width", None) for col in range(width_limit)]
    fixture_widths = [getattr(fixture_sheet.colinfo_map.get(col), "width", None) for col in range(width_limit)]
    require(fixture_widths == source_widths, f"{template_id}: column widths differ")
    row_limit = canonical.workbook.header_row_index + 2
    source_heights = [getattr(source_sheet.rowinfo_map.get(row), "height", None) for row in range(row_limit)]
    fixture_heights = [getattr(fixture_sheet.rowinfo_map.get(row), "height", None) for row in range(row_limit)]
    require(fixture_heights == source_heights, f"{template_id}: preamble/header row heights differ")
    row = canonical.workbook.header_row_index
    style_rows = range(min(row + 2, source_sheet.nrows, fixture_sheet.nrows))
    style_mismatches = [
        (row_index + 1, col_index + 1)
        for row_index in style_rows
        for col_index in range(width_limit)
        if style_signature(source_book, source_sheet, row_index, col_index)
        != style_signature(fixture_book, fixture_sheet, row_index, col_index)
    ]
    require(
        not style_mismatches,
        f"{template_id}: template style drift at {style_mismatches[:10]}",
    )
    header_xf_indexes = [fixture_sheet.cell_xf_index(row, col) for col in range(width_limit)]
    require(all(index > 0 for index in header_xf_indexes), f"{template_id}: header styles are missing")
    require(len(set(header_xf_indexes)) >= 2, f"{template_id}: header styles are not differentiated")
    data_row = row + 1
    if data_row < fixture_sheet.nrows:
        data_xf_indexes = [fixture_sheet.cell_xf_index(data_row, col) for col in range(width_limit)]
        require(any(index > 0 for index in data_xf_indexes), f"{template_id}: data-row styles are missing")
    require(len(fixture_book.xf_list) > 1 and bool(fixture_sheet.colinfo_map), f"{template_id}: formatting metadata is missing")
    return {
        "headers": width_limit,
        "merged": len(fixture_sheet.merged_cells),
        "xf": len(fixture_book.xf_list),
        "header_style_count": len(set(header_xf_indexes)),
        "style_mismatches": len(style_mismatches),
    }


def validate_sales(raw_path: Path, misa_path: Path) -> dict[str, object]:
    raw = read_input_table(raw_path)
    misa = read_input_table(misa_path)
    require(detect_target_template_id(raw) == "bsn_sales", "sales raw detected as wrong domain")
    template = get_misa_template("bsn_sales")
    suggestion = heuristic_suggestion(raw, "bsn_sales", template.headers)
    required_issues = validate_mapping("bsn_sales", suggestion.mapping, template.headers, suggestion.defaults, suggestion.formulas)
    missing = {issue["field"] for issue in required_issues if issue["code"] == "missing_required_mapping"}
    require(missing == {"TK Tiền/Chi phí/Nợ (*)", "TK Doanh thu/Có (*)"}, f"sales required-field detection drifted: {sorted(missing)}")

    wrong_domain = validate_mapping_semantics(
        target_template_id="bsn_sales",
        template_headers=template.headers,
        source_headers=raw.headers,
        mapping={"Phường/Xã (Khách hàng)": "Hình thức bán hàng"},
        defaults={}, formulas={}, sample_rows=raw.rows[:20],
    )
    require(any(issue.code == "mapping_domain_mismatch" and issue.severity == "blocker" for issue in wrong_domain), "wrong-domain profile was not blocked")

    required_headers = [header for header in template.headers if "(*)" in header]
    require(all(str(row.get(header) or "").strip() for row in misa.rows for header in required_headers), "sales MISA fixture has blank required values")
    require(len(raw.rows) == len(misa.rows), "sales raw/MISA line counts differ")

    raw_totals = aggregate_document_totals(raw.rows, document_key_fields=["Mã hóa đơn"], line_amount_field=None, document_total_field="Tổng tiền hàng")
    require(raw_totals.status == "complete", f"sales duplicate document totals invalid: {raw_totals.issues}")
    raw_groups: dict[tuple[str, ...], list[dict[str, object]]] = defaultdict(list)
    for row in raw.rows:
        raw_groups[sales_invoice_key(row.get("Mã hóa đơn"))].append(row)
    for document, rows in raw_groups.items():
        line_sum = sum((decimal(row.get("Thành tiền")) for row in rows), Decimal("0"))
        document_values = {decimal(row.get("Tổng tiền hàng")) for row in rows}
        require(len(document_values) == 1 and abs(line_sum - next(iter(document_values))) <= 1, f"sales document total mismatch: {document}")
        first = rows[0]
        expected_payable = decimal(first.get("Tổng tiền hàng")) - decimal(first.get("Giảm giá hóa đơn")) + decimal(first.get("VAT")) + decimal(first.get("Thu khác"))
        require(abs(expected_payable - decimal(first.get("Khách cần trả"))) <= 1, f"sales payable mismatch: {document}")

    misa_groups: dict[tuple[str, ...], list[dict[str, object]]] = defaultdict(list)
    for row in misa.rows:
        misa_groups[sales_invoice_key(row.get("Số chứng từ (*)"))].append(row)
        expected_amount = decimal(row.get("Số lượng")) * decimal(row.get("Đơn giá"))
        require(abs(expected_amount - decimal(row.get("Thành tiền"))) <= 1, "sales MISA quantity x price mismatch")
    require(set(misa_groups) == set(raw_groups), "sales document keys differ after conversion")
    for document, rows in misa_groups.items():
        net = sum((decimal(row.get("Thành tiền")) - decimal(row.get("Tiền chiết khấu")) for row in rows), Decimal("0"))
        raw_total = decimal(raw_groups[document][0].get("Tổng tiền hàng"))
        require(abs(net - raw_total) <= 1, f"sales converted net total mismatch: {document}")
    return {"rows": len(raw.rows), "documents": len(raw_groups), "sum_total": raw_totals.sum_total}


def validate_purchase(raw_path: Path) -> dict[str, object]:
    raw = read_input_table(raw_path)
    require(detect_target_template_id(raw) == "misa_purchase_domestic", "purchase raw detected as wrong domain")
    template = get_misa_template("misa_purchase_domestic")
    suggestion = heuristic_suggestion(raw, "misa_purchase_domestic", template.headers)
    required_issues = validate_mapping("misa_purchase_domestic", suggestion.mapping, template.headers, suggestion.defaults, suggestion.formulas)
    missing = {issue["field"] for issue in required_issues if issue["code"] == "missing_required_mapping"}
    require(missing == {"TK kho/TK chi phí (*)"}, f"purchase required-field detection drifted: {sorted(missing)}")
    output = apply_mapping(raw, template.headers, suggestion.mapping, suggestion.defaults, suggestion.formulas)
    require(len(output) == len(raw.rows), "purchase mapping changed line count")
    required_without_manual_account = [header for header in template.headers if "(*)" in header and header != "TK kho/TK chi phí (*)"]
    require(all(str(row.get(header) or "").strip() for row in output for header in required_without_manual_account), "purchase mapped output has unexpected blank required values")

    groups: dict[tuple[str, ...], list[dict[str, object]]] = defaultdict(list)
    for row in raw.rows:
        document = key(row, ("SR_HD", "SO_HD", "MS_DN"))
        require(all(document), "purchase document key is blank")
        groups[document].append(row)
        base = decimal(row.get("TTVND"))
        vat = decimal(row.get("THUEVND"))
        total = decimal(row.get("TTVND_TT"))
        require(abs(base + vat - total) <= 1, f"purchase row total mismatch: {document}")
        raw_rate = str(row.get("TS_GTGT") or "").strip().upper()
        if raw_rate in {"KCT", "KKKNT", "KHÔNG CHỊU THUẾ", "KHÔNG KÊ KHAI NỘP THUẾ", "0", "0%"}:
            require(vat == 0, f"purchase non-taxable/0% row has VAT: {document}")
        elif raw_rate:
            rate = decimal(raw_rate.replace("%", "")) / Decimal("100")
            require(rate in {Decimal("0.05"), Decimal("0.08"), Decimal("0.10")}, f"unsupported purchase VAT rate: {raw_rate}")
            expected_vat = (base * rate).quantize(Decimal("1"), rounding=ROUND_HALF_UP)
            require(abs(expected_vat - vat) <= 1, f"purchase VAT mismatch: {document}")

    deduplicated_rows = []
    expected_sum = Decimal("0")
    for document, rows in groups.items():
        total = sum((decimal(row.get("TTVND_TT")) for row in rows), Decimal("0"))
        expected_sum += total
        for _ in range(2):
            deduplicated_rows.append({"document": "|".join(document), "total": total})
    duplicate_report = aggregate_document_totals(deduplicated_rows, document_key_fields=["document"], line_amount_field=None, document_total_field="total")
    require(duplicate_report.status == "complete", f"purchase duplicate-total validation failed: {duplicate_report.issues}")
    require(duplicate_report.document_count == len(groups), "purchase document count mismatch")
    require(decimal(duplicate_report.sum_total) == expected_sum, "purchase duplicate totals were double-counted")
    return {"rows": len(raw.rows), "documents": len(groups), "sum_total": str(expected_sum)}


sales_raw, purchase_raw, sales_misa, purchase_misa, output_path = map(Path, sys.argv[1:6])
result = {
    "fixture_sha256": {
        "sales_raw": sha256(sales_raw),
        "purchase_raw": sha256(purchase_raw),
        "sales_misa": sha256(sales_misa),
        "purchase_misa": sha256(purchase_misa),
    },
    "sales": validate_sales(sales_raw, sales_misa),
    "purchase": validate_purchase(purchase_raw),
    "templates": {
        "sales": validate_template(sales_misa, "bsn_sales"),
        "purchase": validate_template(purchase_misa, "misa_purchase_domestic"),
    },
}
output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(result, ensure_ascii=False))
'@ | Set-Content -LiteralPath $validatorPath -Encoding utf8

    $previousPythonPath = $env:PYTHONPATH
    $env:PYTHONPATH = Join-Path $RepoRoot "converter"
    try {
        Invoke-GateStep "external-accounting-fixtures" (Join-Path $RepoRoot "converter") "python" @(
            $validatorPath, $SalesRawFixture, $PurchaseRawFixture, $SalesMisaFixture, $PurchaseMisaFixture, $reportPath
        )
    } finally {
        $env:PYTHONPATH = $previousPythonPath
    }
    if (-not (Test-Path -LiteralPath $reportPath -PathType Leaf)) { return $null }
    return [IO.File]::ReadAllText($reportPath) | ConvertFrom-Json
}

function Assert-AccountingQaReport {
    param([string]$Path, [object]$Manifest)
    $resolved = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
    $report = [IO.File]::ReadAllText($resolved) | ConvertFrom-Json
    if ([int]$report.schema_version -ne 1) { throw "QA report schema_version must be 1" }
    foreach ($field in @("release_id", "commit_hash", "tree_hash", "working_tree_hash", "qa_input_hash", "reviewed_at", "verdict", "reviewer", "fixture_sha256", "qa_artifact", "attestations")) {
        if ($null -eq $report.$field) { throw "QA report missing $field" }
    }
    foreach ($field in @("release_id", "commit_hash", "tree_hash", "working_tree_hash", "qa_input_hash")) {
        if ([string]$report.$field -ne [string]$Manifest.$field) { throw "QA report $field mismatch" }
    }
    foreach ($fixture in $Manifest.fixture_sha256.PSObject.Properties) {
        if ([string]$report.fixture_sha256.($fixture.Name) -ne [string]$fixture.Value) { throw "QA report fixture_sha256.$($fixture.Name) mismatch" }
    }
    if ([string]$report.verdict -cne "PASS" -or [int]$report.p0 -ne 0 -or [int]$report.p1 -ne 0) {
        throw "QA report verdict/P0/P1 is contradictory"
    }
    if ($report.unresolved -and @($report.unresolved).Count -gt 0) { throw "QA report contains unresolved findings" }
    foreach ($finding in @($report.findings)) {
        if ([string]$finding.severity -in @("P0", "P1") -and [string]$finding.status -notin @("resolved", "closed")) {
            throw "QA report contains open P0/P1 finding"
        }
    }
    if (-not $report.reviewer.independent -or [string]$report.reviewer.implementation_involvement -ne "none" -or [string]$report.reviewer.accounting_domain -ne "ke-toan" -or [string]::IsNullOrWhiteSpace([string]$report.reviewer.name)) {
        throw "QA report reviewer is not independently attested"
    }
    foreach ($attestation in @("fixture_validation", "accounting_logic", "production_readiness")) {
        if ([string]$report.attestations.$attestation -cne "PASS") { throw "QA report attestation $attestation is not PASS" }
    }
    $reviewedAt = [DateTimeOffset]::Parse([string]$report.reviewed_at)
    $now = [DateTimeOffset]::UtcNow
    if ($reviewedAt -gt $now.AddMinutes(5) -or $now - $reviewedAt -gt [TimeSpan]::FromHours(24)) { throw "QA report is stale or future-dated" }

    $artifactPath = [string]$report.qa_artifact.path
    if (-not [IO.Path]::IsPathRooted($artifactPath)) { $artifactPath = Join-Path (Split-Path $resolved) $artifactPath }
    $artifactPath = (Resolve-Path -LiteralPath $artifactPath -ErrorAction Stop).Path
    if ($artifactPath -eq $resolved) { throw "QA artifact must be separate from the attestation report" }
    if ((Get-FileSha256 $artifactPath) -ne [string]$report.qa_artifact_sha256 -and (Get-FileSha256 $artifactPath) -ne [string]$report.qa_artifact.sha256) {
        throw "qa_artifact_sha256 mismatch"
    }
    $artifact = [IO.File]::ReadAllText($artifactPath) | ConvertFrom-Json
    if ([string]$artifact.release_id -ne $ReleaseId -or [string]$artifact.status -ne "pass") { throw "QA artifact release/status mismatch" }
    $artifactGeneratedAt = [DateTimeOffset]::Parse([string]$artifact.generated_at)
    if ($reviewedAt -lt $artifactGeneratedAt) { throw "QA report predates its QA artifact" }
    Copy-Item -LiteralPath $resolved -Destination (Join-Path $artifactRoot "independent-accounting-qa.json")
    Copy-Item -LiteralPath $artifactPath -Destination (Join-Path $artifactRoot "independent-accounting-qa-artifact.json")
}

$requiredFiles = @(
    "backend\tests\mappingProfileV2.test.js",
    "backend\tests\mappingProfileV2Migration.test.js",
    "converter\tests\test_operation_store.py",
    "converter\tests\test_anomaly_workflow.py",
    "converter\tests\test_correction_workflow.py",
    "converter\tests\test_reconciliation_workflow_v2.py",
    "converter\tests\test_accounting_assistant.py",
    "converter\tests\test_accounting_operations_performance.py",
    "frontend\src\utils\operationSession.test.mjs"
)
foreach ($requiredFile in $requiredFiles) { Assert-RequiredFile $requiredFile }

if ($Runs -lt 3) { Add-GateResult "release-run-count" skip "Release requires at least 3 runs; Runs=$Runs" }
if ($SkipBroadTests) { Add-GateResult "release-broad-tests" skip "Broad tests were skipped" }
if ($SkipPerformance) { Add-GateResult "release-performance" skip "Performance thresholds were skipped" }

$fixtureReport = Invoke-AccountingFixtureValidation
$commitHash = (git -C $RepoRoot rev-parse HEAD).Trim()
$treeHash = (git -C $RepoRoot rev-parse "HEAD^{tree}").Trim()
$workingTreeHash = Get-WorkingTreeHash
$fixtureHashes = if ($fixtureReport) { $fixtureReport.fixture_sha256 } else { [pscustomobject]@{} }
$manifestSeed = [ordered]@{
    release_id = $ReleaseId
    commit_hash = $commitHash
    tree_hash = $treeHash
    working_tree_hash = $workingTreeHash
    fixture_sha256 = $fixtureHashes
}
$manifest = [ordered]@{
    schema_version = 1
    release_id = $ReleaseId
    generated_at = [DateTimeOffset]::UtcNow.ToString("o")
    commit_hash = $commitHash
    tree_hash = $treeHash
    working_tree_hash = $workingTreeHash
    qa_input_hash = Get-TextSha256 ($manifestSeed | ConvertTo-Json -Depth 8 -Compress)
    fixture_sha256 = $fixtureHashes
}
Write-EvidenceFile "release-manifest.json" $manifest | Out-Null
Write-EvidenceFile "runtime.json" ([ordered]@{ node = (& node --version); npm = (& npm --version); python = (& python --version 2>&1); runs = $Runs; skip_broad_tests = $SkipBroadTests.IsPresent; skip_performance = $SkipPerformance.IsPresent }) | Out-Null

if (-not $ManifestOnly) {
    for ($run = 1; $run -le $Runs; $run++) {
        Invoke-GateStep "run-$run-backend-focused" (Join-Path $RepoRoot "backend") "node" @("--test", "tests/mappingProfileV2.test.js", "tests/mappingProfileV2Migration.test.js")
        Invoke-GateStep "run-$run-converter-focused" (Join-Path $RepoRoot "converter") "python" @(
            "-m", "pytest", "-q", "tests/test_excel_pipeline.py", "tests/test_misa_template_export_contract.py",
            "tests/test_document_totals.py", "tests/test_mapping_semantics.py", "tests/test_misa_readiness.py",
            "tests/test_operation_store.py", "tests/test_operation_session_api.py", "tests/test_anomaly_workflow.py",
            "tests/test_correction_workflow.py", "tests/test_reconciliation_workflow_v2.py", "tests/test_accounting_assistant.py"
        )
        Invoke-GateStep "run-$run-frontend-unit" (Join-Path $RepoRoot "frontend") "npm" @("test")
    }

    if (-not $SkipBroadTests) {
        Invoke-GateStep "backend-full" (Join-Path $RepoRoot "backend") "node" @("--test")
        Invoke-GateStep "converter-full" (Join-Path $RepoRoot "converter") "python" @("-m", "pytest", "-q")
        Invoke-GateStep "frontend-lint" (Join-Path $RepoRoot "frontend") "npm" @("run", "lint")
        Invoke-GateStep "frontend-build" (Join-Path $RepoRoot "frontend") "npm" @("run", "build")
        Invoke-GateStep "workspace-qa-fast" $RepoRoot "npm" @("run", "qa:fast")
    }

    if (-not $SkipPerformance) {
        $previousPerformanceFlag = $env:RUN_ACCOUNTING_OPERATIONS_PERFORMANCE
        $env:RUN_ACCOUNTING_OPERATIONS_PERFORMANCE = "1"
        try {
            Invoke-GateStep "accounting-operations-performance-10k-20s-50k-75s" (Join-Path $RepoRoot "converter") "python" @("-m", "pytest", "-q", "tests/test_accounting_operations_performance.py")
        } finally {
            $env:RUN_ACCOUNTING_OPERATIONS_PERFORMANCE = $previousPerformanceFlag
        }
    }

    if ([string]::IsNullOrWhiteSpace($AccountingQaReport)) {
        Add-ExternalPrerequisite "independent-accounting-qa" "Accounting QA report path was not supplied"
    } else {
        try {
            Assert-AccountingQaReport $AccountingQaReport ([pscustomobject]$manifest)
            Add-GateResult "independent-accounting-qa" pass "Commit/tree/release/fixtures/reviewer/artifact binding verified"
        } catch {
            Add-GateResult "independent-accounting-qa" fail $_.Exception.Message
        }
    }
} else {
    Add-GateResult "manifest-only" skip "Manifest generated; tests and independent review remain required"
}

$releasePolicyComplete = $Runs -ge 3 -and -not $SkipBroadTests -and -not $SkipPerformance -and -not $ManifestOnly
$releaseEligible = $releasePolicyComplete -and $failed.Count -eq 0 -and $skipped.Count -eq 0
$summary = [ordered]@{
    release_id = $ReleaseId
    generated_at = [DateTimeOffset]::UtcNow.ToString("o")
    status = if ($failed.Count -gt 0) { "fail" } elseif ($releaseEligible) { "pass" } else { "incomplete" }
    release_eligible = $releaseEligible
    release_policy = @{ minimum_runs = 3; broad_tests_required = $true; performance_required = $true }
    failed = @($failed)
    skipped = @($skipped)
    results = @($results)
}
Write-EvidenceFile "summary.json" $summary | Out-Null

if ($failed.Count -gt 0) {
    Write-Host "`nACCOUNTING OPERATIONS GATE FAILED: $($failed -join ', ')" -ForegroundColor Red
    Write-Host "Evidence: $artifactRoot" -ForegroundColor Yellow
    exit 1
}
if (-not $releaseEligible) {
    Write-Host "`nACCOUNTING OPERATIONS GATE INCOMPLETE" -ForegroundColor Yellow
    Write-Host "Evidence: $artifactRoot" -ForegroundColor Yellow
    if ($AllowIncompleteDiagnostics) { exit 0 }
    exit 2
}

Write-Host "`nACCOUNTING OPERATIONS RELEASE GATE PASSED" -ForegroundColor Green
Write-Host "Evidence: $artifactRoot" -ForegroundColor Gray
exit 0
