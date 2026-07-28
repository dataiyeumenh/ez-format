from __future__ import annotations

import argparse
from pathlib import Path
from struct import unpack_from

from xlrd.compdoc import CompDoc


_BIFF_COLINFO = 0x007D
_BIFF_ROW = 0x0208

def rebuild_blank_template(source: Path, target: Path, *, header_row_index: int = 7) -> None:
    try:
        import win32com.client
    except ImportError as exc:  # pragma: no cover - Windows maintenance dependency
        raise RuntimeError("Microsoft Excel automation is required to preserve BIFF styles") from exc

    target.parent.mkdir(parents=True, exist_ok=True)
    excel = win32com.client.DispatchEx("Excel.Application")
    excel.Visible = False
    excel.DisplayAlerts = False
    source_book = None
    blank_book = None
    try:
        source_book = excel.Workbooks.Open(str(source), ReadOnly=True, UpdateLinks=0)
        source_book.Worksheets(1).Copy()
        blank_book = excel.ActiveWorkbook
        sheet = blank_book.Worksheets(1)
        data_start_row = header_row_index + 2  # Excel rows are one-based.
        last_row = max(int(sheet.UsedRange.Row + sheet.UsedRange.Rows.Count - 1), data_start_row)
        sheet.Range(sheet.Cells(data_start_row, 1), sheet.Cells(last_row, 59)).ClearContents()
        blank_book.SaveAs(str(target), FileFormat=56)
    finally:
        if blank_book is not None:
            blank_book.Close(SaveChanges=False)
        if source_book is not None:
            source_book.Close(SaveChanges=False)
        excel.Quit()
    _restore_layout_records(source, target)


def _restore_layout_records(source: Path, target: Path) -> None:
    source_records = _layout_records(source)
    target_bytes = bytearray(target.read_bytes())
    target_raw = bytes(target_bytes)
    target_memory, target_offset, target_length = CompDoc(target_raw).locate_named_stream(
        "Workbook"
    )
    if target_memory is not target_raw or target_offset <= 0:
        raise RuntimeError("Unsupported compact OLE workbook stream")
    target_stream = target_raw[target_offset : target_offset + target_length]
    target_records = [
        (offset, record_id, raw)
        for offset, record_id, raw in _iter_biff_records(target_stream)
        if record_id in {_BIFF_COLINFO, _BIFF_ROW}
    ]
    if len(source_records) != len(target_records):
        raise RuntimeError("Excel changed the MISA row/column layout record count")
    for (source_id, source_raw), (record_offset, target_id, target_record) in zip(
        source_records, target_records
    ):
        if source_id != target_id:
            raise RuntimeError("Excel reordered MISA row/column layout records")
        if len(source_raw) != len(target_record):
            raise RuntimeError("Excel changed a MISA row/column layout record size")
        absolute = target_offset + record_offset
        field = slice(8, 10) if source_id == _BIFF_COLINFO else slice(10, 12)
        target_bytes[absolute + field.start : absolute + field.stop] = source_raw[field]
    target.write_bytes(target_bytes)


def _layout_records(path: Path) -> list[bytes]:
    raw = path.read_bytes()
    memory, offset, length = CompDoc(raw).locate_named_stream("Workbook")
    if memory is not raw:
        raise RuntimeError("Unsupported compact OLE workbook stream")
    stream = raw[offset : offset + length]
    return [
        (record_id, record)
        for _, record_id, record in _iter_biff_records(stream)
        if record_id in {_BIFF_COLINFO, _BIFF_ROW}
    ]


def _iter_biff_records(stream: bytes):
    offset = 0
    while offset + 4 <= len(stream):
        record_id, data_length = unpack_from("<HH", stream, offset)
        end = offset + 4 + data_length
        if end > len(stream):
            raise RuntimeError("Truncated BIFF workbook stream")
        yield offset, record_id, stream[offset:end]
        offset = end


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Rebuild the blank BSN sales template from a verified MISA workbook."
    )
    parser.add_argument("source", type=Path)
    parser.add_argument("target", type=Path)
    args = parser.parse_args()
    rebuild_blank_template(args.source.resolve(), args.target.resolve())


if __name__ == "__main__":
    main()
