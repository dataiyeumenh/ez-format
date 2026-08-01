from __future__ import annotations

import hashlib
import struct
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

import olefile
import xlrd
from xlrd.book import unpack_SST_table
from xlrd.compdoc import CompDoc
from xlrd.formula import FMLA_TYPE_CELL, FMLA_TYPE_NAME, decompile_formula


_BOF = 0x0809
_EOF = 0x000A
_SST = 0x00FC
_CONTINUE = 0x003C
_LABELSST = 0x00FD
_FILESHARING = 0x005B
_WRITEACCESS = 0x005C
_BOUNDSHEET = 0x0085
_NAME = 0x0018
_SUPBOOK = 0x01AE
_EXTERNNAME = 0x0023
_HLINK = 0x01B8
_OBPROJ = 0x00D3
_OLE_PROPERTY_STREAMS = (
    "\x05SummaryInformation",
    "\x05DocumentSummaryInformation",
)
_OLE_PROPERTY_FORMAT_IDS = {
    "\x05SummaryInformation": bytes.fromhex("e0859ff2f94f6810ab9108002b27b3d9"),
    "\x05DocumentSummaryInformation": bytes.fromhex(
        "02d5cdd59c2e1b10939708002b2cf9ae"
    ),
}
_WORKBOOK_STREAMS = {"Workbook", "Book"}
_AUXILIARY_OLE_STREAM_HASHES = {
    "\x01CompObj": {
        "1f75698fc71fdb2a15e971edbbeeb47e7bd67af8dca42b3994e337008c299ec6",
        "87ade35570052baa0206f10a3fb754b7bb427fe019f2450989f6ba329254566e",
    },
    "\x01Ole": {
        "c36c8a4b7dee703b9ce6e288032033b718feef01ca283cfaa4332a8334b2adf3",
    },
}
_ALLOWED_OLE_STREAMS = _WORKBOOK_STREAMS | set(_OLE_PROPERTY_STREAMS) | set(
    _AUXILIARY_OLE_STREAM_HASHES
)
_FORMULA_IDS = {0x0006, 0x0206, 0x0406}
_UNSAFE_FORMULA_FUNCTIONS = ("HYPERLINK(", "RTD(")
_FORMULA_FEATURE_IDS = _FORMULA_IDS | {
    0x0021,  # ARRAY (BIFF2)
    0x0036,  # TABLEOP (BIFF2)
    0x0037,  # TABLEOP2
    0x0221,  # ARRAY
    0x0236,  # TABLEOP
    0x04BC,  # SHRFMLA
}
_LITERAL_CELL_IDS = {
    0x00BD,  # MULRK
    0x00D6,  # RSTRING
    0x00FD,  # LABELSST
    0x0203,  # NUMBER
    0x0204,  # LABEL
    0x0205,  # BOOLERR
    0x027E,  # RK
}
_FEATURE_RECORD_IDS = {
    "formulas": _FORMULA_FEATURE_IDS,
    "defined_names": {0x0018},
    "drawings_objects": {
        0x001C,
        0x005D,
        0x007F,
        0x00EB,
        0x00EC,
        0x00ED,
        0x01B6,
    },
    "data_validations": {0x01B2, 0x01BE},
}


@dataclass(frozen=True)
class BiffRecord:
    record_id: int
    offset: int
    payload: bytes

    @property
    def encoded(self) -> bytes:
        return struct.pack("<HH", self.record_id, len(self.payload)) + self.payload


@dataclass(frozen=True)
class TemplateContentScan:
    post_header_workbook_value_count: int
    post_header_literal_record_count: int
    unreferenced_nonblank_sst_count: int
    ole_property_value_count: int
    ole_property_parse_error_count: int
    file_sharing_username_count: int
    write_access_username_count: int
    unknown_ole_stream_count: int
    unsafe_ole_stream_count: int
    property_stream_residual_count: int
    pre_header_formula_count: int
    unsafe_formula_count: int
    external_link_count: int
    dde_link_count: int
    macro_sheet_count: int
    active_content_record_count: int

    @property
    def clean(self) -> bool:
        return not any(
            (
                self.post_header_workbook_value_count,
                self.post_header_literal_record_count,
                self.unreferenced_nonblank_sst_count,
                self.ole_property_value_count,
                self.ole_property_parse_error_count,
                self.file_sharing_username_count,
                self.write_access_username_count,
                self.unknown_ole_stream_count,
                self.unsafe_ole_stream_count,
                self.property_stream_residual_count,
                self.pre_header_formula_count,
                self.unsafe_formula_count,
                self.external_link_count,
                self.dde_link_count,
                self.macro_sheet_count,
                self.active_content_record_count,
            )
        )


@dataclass(frozen=True)
class OleMetadataScan:
    ole_property_value_count: int
    ole_property_parse_error_count: int
    file_sharing_username_count: int
    write_access_username_count: int
    unknown_ole_stream_count: int
    unsafe_ole_stream_count: int
    property_stream_residual_count: int

    @property
    def clean(self) -> bool:
        return not any(
            (
                self.ole_property_value_count,
                self.ole_property_parse_error_count,
                self.file_sharing_username_count,
                self.write_access_username_count,
                self.unknown_ole_stream_count,
                self.unsafe_ole_stream_count,
                self.property_stream_residual_count,
            )
        )


def iter_biff_records(file_contents: bytes) -> Iterator[BiffRecord]:
    stream = workbook_stream(file_contents)
    yield from _iter_stream_records(stream)


def _iter_stream_records(stream: bytes) -> Iterator[BiffRecord]:
    offset = 0
    while offset + 4 <= len(stream):
        record_id, payload_length = struct.unpack_from("<HH", stream, offset)
        payload_start = offset + 4
        payload_end = payload_start + payload_length
        if payload_end > len(stream):
            raise ValueError("Truncated BIFF record in Workbook stream")
        yield BiffRecord(record_id, offset, stream[payload_start:payload_end])
        offset = payload_end


def workbook_stream(file_contents: bytes) -> bytes:
    try:
        compound = CompDoc(file_contents)
        stream = compound.get_named_stream("Workbook")
        if stream is None:
            stream = compound.get_named_stream("Book")
    except Exception as exc:
        raise ValueError("Invalid OLE/BIFF workbook") from exc
    if stream is None:
        raise ValueError("OLE workbook stream is missing")
    return stream


def probe_biff_features(file_contents: bytes) -> dict[str, dict[str, int | str]]:
    feature_records: dict[str, list[bytes]] = {
        feature: [] for feature in _FEATURE_RECORD_IDS
    }
    for record in iter_biff_records(file_contents):
        for feature, record_ids in _FEATURE_RECORD_IDS.items():
            if record.record_id not in record_ids:
                continue
            encoded = bytearray(record.encoded)
            if record.record_id in _FORMULA_IDS and len(encoded) >= 18:
                # Cached formula results may contain customer values; formula tokens remain stable.
                encoded[10:18] = b"\0" * 8
            feature_records[feature].append(bytes(encoded))
    return {
        feature: {
            "record_count": len(records),
            "sha256": hashlib.sha256(b"".join(records)).hexdigest(),
        }
        for feature, records in feature_records.items()
    }


def scan_ole_metadata(file_contents: bytes) -> OleMetadataScan:
    property_value_count = 0
    property_parse_error_count = 0
    unknown_stream_count = 0
    unsafe_stream_count = 0
    property_stream_residual_count = 0
    try:
        with olefile.OleFileIO(file_contents) as compound:
            stream_paths = compound.listdir(streams=True, storages=False)
            stream_names = ["/".join(path) for path in stream_paths]
            unknown_stream_count = sum(
                1 for stream_name in stream_names if stream_name not in _ALLOWED_OLE_STREAMS
            )
            workbook_stream_count = sum(
                stream_name in _WORKBOOK_STREAMS for stream_name in stream_names
            )
            unsafe_stream_count += int(workbook_stream_count != 1)
            for stream_path, stream_name in zip(stream_paths, stream_names):
                allowed_hashes = _AUXILIARY_OLE_STREAM_HASHES.get(stream_name)
                if allowed_hashes is None:
                    continue
                stream_sha256 = hashlib.sha256(
                    compound.openstream(stream_path).read()
                ).hexdigest()
                unsafe_stream_count += int(stream_sha256 not in allowed_hashes)
            for stream_name in _OLE_PROPERTY_STREAMS:
                if not compound.exists(stream_name):
                    continue
                source_stream = compound.openstream(stream_name).read()
                try:
                    canonical_stream = _canonical_property_stream(
                        source_stream,
                        stream_name=stream_name,
                    )
                    properties = compound.getproperties(
                        stream_name,
                        convert_time=False,
                    )
                except Exception:
                    property_parse_error_count += 1
                    continue
                property_stream_residual_count += int(
                    source_stream != canonical_stream
                )
                property_value_count += sum(
                    _count_nonblank_property_values(value)
                    for property_id, value in properties.items()
                    if property_id != 1  # Codepage is structural, not user metadata.
                )
                if stream_name == "\x05DocumentSummaryInformation":
                    try:
                        custom_properties = compound.get_userdefined_properties(
                            stream_name,
                            convert_time=False,
                        )
                    except Exception:
                        property_parse_error_count += 1
                    else:
                        property_value_count += _count_nonblank_property_values(
                            custom_properties
                        )
    except Exception as exc:
        raise ValueError("Invalid OLE workbook metadata") from exc

    file_sharing_username_count = 0
    write_access_username_count = 0
    for record in iter_biff_records(file_contents):
        if record.record_id == _FILESHARING:
            file_sharing_username_count += int(
                _file_sharing_username_is_nonblank(record.payload)
            )
        elif record.record_id == _WRITEACCESS:
            write_access_username_count += int(
                _write_access_username_is_nonblank(record.payload)
            )

    return OleMetadataScan(
        ole_property_value_count=property_value_count,
        ole_property_parse_error_count=property_parse_error_count,
        file_sharing_username_count=file_sharing_username_count,
        write_access_username_count=write_access_username_count,
        unknown_ole_stream_count=unknown_stream_count,
        unsafe_ole_stream_count=unsafe_stream_count,
        property_stream_residual_count=property_stream_residual_count,
    )


def scan_template_content(
    file_contents: bytes,
    *,
    header_row_index: int,
) -> TemplateContentScan:
    records = list(iter_biff_records(file_contents))
    workbook = xlrd.open_workbook(file_contents=file_contents, formatting_info=True)
    security = _scan_biff_security(
        records,
        workbook,
        header_row_index=header_row_index,
    )
    workbook_value_count = 0
    for sheet_index, sheet in enumerate(workbook.sheets()):
        first_row = header_row_index + 1 if sheet_index == 0 else 0
        for row_index in range(first_row, sheet.nrows):
            workbook_value_count += sum(
                1 for value in sheet.row_values(row_index) if not _is_blank(value)
            )

    referenced_sst_indexes: set[int] = set()
    literal_record_count = 0
    worksheet_index = -1
    substream_stack: list[int | None] = []
    active_sheet: int | None = None
    for record in records:
        if record.record_id == _BOF and len(record.payload) >= 4:
            substream_stack.append(active_sheet)
            substream_type = struct.unpack_from("<H", record.payload, 2)[0]
            if substream_type == 0x0010:
                worksheet_index += 1
                active_sheet = worksheet_index
            continue
        if record.record_id == _EOF:
            active_sheet = substream_stack.pop() if substream_stack else None
            continue
        if record.record_id == _LABELSST and len(record.payload) >= 10:
            referenced_sst_indexes.add(struct.unpack_from("<I", record.payload, 6)[0])
        if active_sheet != 0 or len(record.payload) < 6:
            continue
        row_index = struct.unpack_from("<H", record.payload, 0)[0]
        if row_index <= header_row_index:
            continue
        if record.record_id in _LITERAL_CELL_IDS:
            literal_record_count += 1
        elif record.record_id in _FORMULA_IDS and not _formula_cache_is_empty(
            record.payload
        ):
            literal_record_count += 1

    shared_strings = _shared_strings(records)
    unreferenced_nonblank = sum(
        1
        for index, value in enumerate(shared_strings)
        if index not in referenced_sst_indexes and not _is_blank(value)
    )
    metadata = scan_ole_metadata(file_contents)
    return TemplateContentScan(
        post_header_workbook_value_count=workbook_value_count,
        post_header_literal_record_count=literal_record_count,
        unreferenced_nonblank_sst_count=unreferenced_nonblank,
        ole_property_value_count=metadata.ole_property_value_count,
        ole_property_parse_error_count=metadata.ole_property_parse_error_count,
        file_sharing_username_count=metadata.file_sharing_username_count,
        write_access_username_count=metadata.write_access_username_count,
        unknown_ole_stream_count=metadata.unknown_ole_stream_count,
        unsafe_ole_stream_count=metadata.unsafe_ole_stream_count,
        property_stream_residual_count=metadata.property_stream_residual_count,
        pre_header_formula_count=security["pre_header_formula_count"],
        unsafe_formula_count=security["unsafe_formula_count"],
        external_link_count=security["external_link_count"],
        dde_link_count=security["dde_link_count"],
        macro_sheet_count=security["macro_sheet_count"],
        active_content_record_count=security["active_content_record_count"],
    )


def _scan_biff_security(
    records: list[BiffRecord],
    workbook: xlrd.book.Book,
    *,
    header_row_index: int,
) -> dict[str, int]:
    counts = {
        "pre_header_formula_count": 0,
        "unsafe_formula_count": 0,
        "external_link_count": 0,
        "dde_link_count": 0,
        "macro_sheet_count": 0,
        "active_content_record_count": 0,
    }
    worksheet_index = -1
    substream_stack: list[int | None] = []
    active_sheet: int | None = None
    for record in records:
        if record.record_id == _BOF and len(record.payload) >= 4:
            substream_stack.append(active_sheet)
            substream_type = struct.unpack_from("<H", record.payload, 2)[0]
            if substream_type == 0x0010:
                worksheet_index += 1
                active_sheet = worksheet_index
            elif substream_type in {0x0006, 0x0040}:
                counts["macro_sheet_count"] += 1
            continue
        if record.record_id == _EOF:
            active_sheet = substream_stack.pop() if substream_stack else None
            continue
        if record.record_id == _BOUNDSHEET:
            if len(record.payload) < 6:
                counts["active_content_record_count"] += 1
            elif record.payload[5] in {0x01, 0x06}:
                counts["macro_sheet_count"] += 1
            elif record.payload[5] not in {0x00, 0x02}:
                counts["active_content_record_count"] += 1
        elif record.record_id == _SUPBOOK:
            _count_supbook_link(record.payload, counts)
        elif record.record_id == _EXTERNNAME:
            counts["active_content_record_count"] += 1
        elif record.record_id == _NAME:
            if len(record.payload) < 2:
                counts["active_content_record_count"] += 1
            else:
                option_flags = struct.unpack_from("<H", record.payload, 0)[0]
                if option_flags & (0x0004 | 0x0008 | 0x1000):
                    counts["active_content_record_count"] += 1
        elif record.record_id in {_HLINK, _OBPROJ}:
            counts["active_content_record_count"] += 1

        if record.record_id in _FORMULA_FEATURE_IDS - _FORMULA_IDS:
            counts["unsafe_formula_count"] += 1
            continue
        if record.record_id not in _FORMULA_IDS:
            continue
        formula_is_unsafe = active_sheet != 0
        if len(record.payload) < 22 or record.record_id != 0x0006:
            counts["unsafe_formula_count"] += 1
            continue
        row_index, column_index = struct.unpack_from("<HH", record.payload, 0)
        if active_sheet == 0 and row_index <= header_row_index:
            counts["pre_header_formula_count"] += 1
        if _formula_is_unsafe(workbook, record.payload, row_index, column_index):
            formula_is_unsafe = True
        counts["unsafe_formula_count"] += int(formula_is_unsafe)

    for name in workbook.name_obj_list:
        if name.macro or name.vbasic or name.binary:
            counts["active_content_record_count"] += 1
            continue
        try:
            formula = decompile_formula(
                workbook,
                name.raw_formula,
                name.basic_formula_len,
                FMLA_TYPE_NAME,
            )
        except Exception:
            counts["unsafe_formula_count"] += 1
            continue
        if _contains_unsafe_formula_function(formula):
            counts["unsafe_formula_count"] += 1
    return counts


def _count_supbook_link(payload: bytes, counts: dict[str, int]) -> None:
    if len(payload) < 4:
        counts["external_link_count"] += 1
        return
    if payload[2:4] == b"\x01\x04":
        return
    if payload[:4] == b"\x01\x00\x01\x3a":
        counts["active_content_record_count"] += 1
        return
    number_of_sheets = struct.unpack_from("<H", payload, 0)[0]
    key = "dde_link_count" if number_of_sheets == 0 else "external_link_count"
    counts[key] += 1


def _formula_is_unsafe(
    workbook: xlrd.book.Book,
    payload: bytes,
    row_index: int,
    column_index: int,
) -> bool:
    formula_length = struct.unpack_from("<H", payload, 20)[0]
    formula_end = 22 + formula_length
    if formula_end > len(payload):
        return True
    try:
        formula = decompile_formula(
            workbook,
            payload[22:formula_end],
            formula_length,
            FMLA_TYPE_CELL,
            row_index,
            column_index,
        )
    except Exception:
        return True
    return _contains_unsafe_formula_function(formula)


def _contains_unsafe_formula_function(formula: object) -> bool:
    normalized = str(formula or "").upper()
    return any(function in normalized for function in _UNSAFE_FORMULA_FUNCTIONS)


def advanced_biff_feature_names(
    probe: dict[str, dict[str, int | str]],
) -> tuple[str, ...]:
    return tuple(
        feature
        for feature, details in probe.items()
        if int(details["record_count"]) > 0
    )


def scrub_template_copy(
    source_path: Path,
    output_path: Path,
    *,
    header_row_index: int,
) -> Path:
    source_contents = source_path.read_bytes()
    source_probe = probe_biff_features(source_contents)
    workbook = xlrd.open_workbook(
        file_contents=source_contents,
        formatting_info=True,
    )
    source_sheet = workbook.sheet_by_index(0)
    stream = workbook_stream(source_contents)
    scrubbed_stream = _scrub_workbook_stream(
        stream,
        source_sheet,
        header_row_index=header_row_index,
    )
    scrubbed_stream = _scrub_workbook_user_metadata(scrubbed_stream)
    _write_scrubbed_ole_copy(source_contents, output_path, scrubbed_stream)

    output_contents = output_path.read_bytes()
    if probe_biff_features(output_contents) != source_probe:
        raise ValueError("Scrubbing changed protected BIFF feature records")
    scan = scan_template_content(
        output_contents,
        header_row_index=header_row_index,
    )
    if not scan.clean:
        raise ValueError("Scrubbing left customer values or workbook metadata")
    return output_path


def scrub_ole_metadata_copy(source_path: Path, output_path: Path) -> Path:
    source_contents = source_path.read_bytes()
    source_probe = probe_biff_features(source_contents)
    scrubbed_stream = _scrub_workbook_user_metadata(workbook_stream(source_contents))
    _write_scrubbed_ole_copy(source_contents, output_path, scrubbed_stream)

    output_contents = output_path.read_bytes()
    if not scan_ole_metadata(output_contents).clean:
        raise ValueError("Scrubbing left OLE or workbook user metadata")
    if probe_biff_features(output_contents) != source_probe:
        raise ValueError("Metadata scrubbing changed protected BIFF feature records")
    return output_path


def _write_scrubbed_ole_copy(
    source_contents: bytes,
    output_path: Path,
    scrubbed_workbook_stream: bytes,
) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(source_contents)
    with olefile.OleFileIO(str(output_path), write_mode=True) as compound:
        stream_name = "Workbook" if compound.exists("Workbook") else "Book"
        compound.write_stream(stream_name, scrubbed_workbook_stream)
        for property_stream_name in _OLE_PROPERTY_STREAMS:
            if not compound.exists(property_stream_name):
                continue
            source_stream = compound.openstream(property_stream_name).read()
            compound.write_stream(
                property_stream_name,
                _canonical_property_stream(
                    source_stream,
                    stream_name=property_stream_name,
                ),
            )


def _canonical_property_stream(source_stream: bytes, *, stream_name: str) -> bytes:
    # Keep a valid, minimal property set and preserve stream length for OLE in-place writes.
    if len(source_stream) < 72 or source_stream[:2] != b"\xfe\xff":
        raise ValueError("OLE property stream cannot be scrubbed safely")
    try:
        format_id = _OLE_PROPERTY_FORMAT_IDS[stream_name]
    except KeyError as exc:
        raise ValueError("Unknown OLE property stream cannot be canonicalized") from exc
    header = struct.pack("<HHI", 0xFFFE, 0, 0x00020006)
    header += b"\0" * 16
    header += struct.pack("<I", 1)
    header += format_id
    header += struct.pack("<I", 48)
    section = struct.pack("<II", 24, 1)
    section += struct.pack("<II", 1, 16)
    section += struct.pack("<IhH", 2, 1252, 0)
    scrubbed = header + section
    return scrubbed + (b"\0" * (len(source_stream) - len(scrubbed)))


def _count_nonblank_property_values(value: object) -> int:
    if isinstance(value, str):
        return int(bool(value.strip(" \t\r\n\0")))
    if isinstance(value, bytes):
        return int(bool(value.strip(b" \t\r\n\0")))
    if isinstance(value, dict):
        return sum(_count_nonblank_property_values(item) for item in value.values())
    if isinstance(value, (list, tuple, set)):
        return sum(_count_nonblank_property_values(item) for item in value)
    return 0


def _record_text_is_nonblank(payload: bytes) -> bool:
    return bool(payload.replace(b"\0", b"").strip(b" \t\r\n"))


def _file_sharing_username_is_nonblank(payload: bytes) -> bool:
    if len(payload) < 6:
        return True
    character_count = payload[4]
    character_width = 2 if payload[5] & 0x01 else 1
    end = 6 + (character_count * character_width)
    if end > len(payload):
        return True
    return _record_text_is_nonblank(payload[6:end])


def _write_access_username_is_nonblank(payload: bytes) -> bool:
    if len(payload) < 3:
        return True
    character_count = struct.unpack_from("<H", payload, 0)[0]
    character_width = 2 if payload[2] & 0x01 else 1
    end = 3 + (character_count * character_width)
    if end > len(payload):
        return True
    return _record_text_is_nonblank(payload[3:end])


def _scrub_workbook_user_metadata(stream: bytes) -> bytes:
    patched = bytearray(stream)
    for record in _iter_stream_records(stream):
        payload_start = record.offset + 4
        if record.record_id == _WRITEACCESS:
            if len(record.payload) < 3:
                raise ValueError("Malformed BIFF WRITEACCESS record")
            replacement = b"\0\0\0" + (b" " * (len(record.payload) - 3))
            patched[payload_start : payload_start + len(record.payload)] = replacement
            continue
        if record.record_id != _FILESHARING:
            continue
        if len(record.payload) < 6:
            raise ValueError("Malformed BIFF FILESHARING record")
        character_count = record.payload[4]
        wide_characters = bool(record.payload[5] & 0x01)
        character_width = 2 if wide_characters else 1
        character_start = payload_start + 6
        character_length = character_count * character_width
        if 6 + character_length > len(record.payload):
            raise ValueError("Malformed BIFF FILESHARING username")
        replacement = (
            b"\x20\x00" * character_count
            if wide_characters
            else b" " * character_count
        )
        patched[character_start : character_start + character_length] = replacement
    return bytes(patched)


def _scrub_workbook_stream(
    stream: bytes,
    source_sheet: xlrd.sheet.Sheet,
    *,
    header_row_index: int,
) -> bytes:
    records = list(_iter_stream_records(stream))
    target_sst_indexes: set[int] = set()
    protected_sst_indexes: set[int] = set()
    patched = bytearray(stream)
    worksheet_index = -1
    substream_stack: list[int | None] = []
    active_sheet: int | None = None

    for record in records:
        if record.record_id == _BOF and len(record.payload) >= 4:
            substream_stack.append(active_sheet)
            substream_type = struct.unpack_from("<H", record.payload, 2)[0]
            if substream_type == 0x0010:
                worksheet_index += 1
                active_sheet = worksheet_index
            continue
        if record.record_id == _EOF:
            active_sheet = substream_stack.pop() if substream_stack else None
            continue
        if len(record.payload) < 6:
            continue
        row_index, column_index, xf_index = struct.unpack_from(
            "<HHH", record.payload, 0
        )
        if record.record_id == _LABELSST and len(record.payload) >= 10:
            sst_index = struct.unpack_from("<I", record.payload, 6)[0]
            if active_sheet == 0 and row_index > header_row_index:
                target_sst_indexes.add(sst_index)
            else:
                protected_sst_indexes.add(sst_index)
        if active_sheet != 0:
            continue
        if row_index <= header_row_index:
            continue
        if record.record_id in _FORMULA_IDS:
            if _formula_cache_is_string(record.payload):
                raise ValueError("String-valued formula cache cannot be scrubbed safely")
            result_start = record.offset + 10
            patched[result_start : result_start + 8] = b"\x03\0\0\0\0\0\xff\xff"
        elif record.record_id in _LITERAL_CELL_IDS:
            replacement = _blank_record_bytes(
                len(record.encoded),
                row_index=row_index,
                column_index=column_index,
                xf_index=xf_index,
                source_sheet=source_sheet,
            )
            patched[record.offset : record.offset + len(replacement)] = replacement

    target_sst_indexes.difference_update(protected_sst_indexes)
    for sst_index, spans in enumerate(_sst_character_spans(records)):
        if sst_index not in target_sst_indexes:
            continue
        for offset, byte_length, wide_characters in spans:
            replacement = (
                b"\x20\x00" * (byte_length // 2)
                if wide_characters
                else b"\x20" * byte_length
            )
            patched[offset : offset + byte_length] = replacement
    return bytes(patched)


def _blank_record_bytes(
    total_length: int,
    *,
    row_index: int,
    column_index: int,
    xf_index: int,
    source_sheet: xlrd.sheet.Sheet,
) -> bytes:
    if total_length < 10 or total_length % 2:
        raise ValueError(f"Cannot safely blank BIFF record of {total_length} bytes")
    if total_length == 10:
        return struct.pack("<HHHHH", 0x0201, 6, row_index, column_index, xf_index)
    blank_count = (total_length - 10) // 2
    if blank_count < 1 or blank_count > source_sheet.ncols:
        raise ValueError(f"Cannot safely blank BIFF record of {total_length} bytes")
    first_column = max(0, min(column_index, source_sheet.ncols - blank_count))
    xf_indexes = [
        source_sheet.cell_xf_index(row_index, current_column)
        for current_column in range(first_column, first_column + blank_count)
    ]
    payload = struct.pack("<HH", row_index, first_column)
    payload += struct.pack(f"<{blank_count}H", *xf_indexes)
    payload += struct.pack("<H", first_column + blank_count - 1)
    encoded = struct.pack("<HH", 0x00BE, len(payload)) + payload
    if len(encoded) != total_length:
        raise AssertionError("BIFF blank replacement length changed")
    return encoded


def _sst_character_spans(
    records: list[BiffRecord],
) -> list[list[tuple[int, int, bool]]]:
    for index, record in enumerate(records):
        if record.record_id != _SST or len(record.payload) < 8:
            continue
        unique_count = struct.unpack_from("<I", record.payload, 4)[0]
        chunks: list[tuple[bytes, int]] = [
            (record.payload, record.offset + 4)
        ]
        next_index = index + 1
        while next_index < len(records) and records[next_index].record_id == _CONTINUE:
            current = records[next_index]
            chunks.append((current.payload, current.offset + 4))
            next_index += 1
        return _parse_sst_character_spans(chunks, unique_count)
    return []


def _parse_sst_character_spans(
    chunks: list[tuple[bytes, int]],
    unique_count: int,
) -> list[list[tuple[int, int, bool]]]:
    chunk_index = 0
    position = 8

    def read_metadata(size: int) -> bytes:
        nonlocal chunk_index, position
        result = bytearray()
        while size:
            if chunk_index >= len(chunks):
                raise ValueError("Truncated SST metadata")
            data = chunks[chunk_index][0]
            if position == len(data):
                chunk_index += 1
                position = 0
                continue
            take = min(size, len(data) - position)
            result.extend(data[position : position + take])
            position += take
            size -= take
        return bytes(result)

    all_spans: list[list[tuple[int, int, bool]]] = []
    for _ in range(unique_count):
        character_count = struct.unpack("<H", read_metadata(2))[0]
        options = read_metadata(1)[0]
        rich_run_count = (
            struct.unpack("<H", read_metadata(2))[0] if options & 0x08 else 0
        )
        phonetic_size = (
            struct.unpack("<I", read_metadata(4))[0] if options & 0x04 else 0
        )
        spans: list[tuple[int, int, bool]] = []
        characters_remaining = character_count
        while characters_remaining:
            data, absolute_start = chunks[chunk_index]
            wide_characters = bool(options & 0x01)
            character_width = 2 if wide_characters else 1
            available = (len(data) - position) // character_width
            take = min(available, characters_remaining)
            if take:
                byte_length = take * character_width
                spans.append(
                    (absolute_start + position, byte_length, wide_characters)
                )
                position += byte_length
                characters_remaining -= take
            if characters_remaining:
                chunk_index += 1
                if chunk_index >= len(chunks):
                    raise ValueError("Truncated SST character data")
                data = chunks[chunk_index][0]
                if not data:
                    raise ValueError("Empty SST continuation record")
                options = data[0]
                position = 1
        if rich_run_count:
            read_metadata(rich_run_count * 4)
        if phonetic_size:
            read_metadata(phonetic_size)
        all_spans.append(spans)
    return all_spans


def _formula_cache_is_empty(payload: bytes) -> bool:
    if len(payload) < 14:
        return False
    result = payload[6:14]
    return result[6:8] == b"\xff\xff" and result[0] == 3


def _formula_cache_is_string(payload: bytes) -> bool:
    if len(payload) < 14:
        return False
    result = payload[6:14]
    return result[6:8] == b"\xff\xff" and result[0] == 0


def _shared_strings(records: list[BiffRecord]) -> list[str]:
    for index, record in enumerate(records):
        if record.record_id != _SST or len(record.payload) < 8:
            continue
        unique_count = struct.unpack_from("<I", record.payload, 4)[0]
        chunks = [record.payload]
        next_index = index + 1
        while next_index < len(records) and records[next_index].record_id == _CONTINUE:
            chunks.append(records[next_index].payload)
            next_index += 1
        strings, _rich_text_runs = unpack_SST_table(chunks, unique_count)
        return strings
    return []


def _is_blank(value: object) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())
