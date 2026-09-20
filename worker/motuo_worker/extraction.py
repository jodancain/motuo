"""Coordinate-aware PDF extraction. Source text is data, never instructions."""
from __future__ import annotations

import csv
import hashlib
import io
import json
import logging
import re
import shutil
import signal
import subprocess
import tempfile
import time
from collections import Counter
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterator

import jieba
import pdfplumber
from pdfplumber.utils.exceptions import PdfminerException

LOG = logging.getLogger(__name__)
jieba.setLogLevel(logging.WARNING)
PRINTED_PAGE = re.compile(r"(?<![A-Za-z0-9])([0-9]{1,2}[A-Z]?\s*[-–]\s*(?:\d{1,3}|[ivx]{1,5}))(?![A-Za-z0-9])")
CJK_RUN = re.compile(r"[\u3400-\u9fff]+")
BAD_TEXT = re.compile(r"\ufffd|\(cid:\d+\)")


class ExtractionError(RuntimeError):
    pass


@dataclass
class ExtractionConfig:
    max_bytes: int = 256 * 1024 * 1024
    max_pages: int = 1000
    max_seconds: float = 7200
    page_timeout: float = 120
    ocr_timeout: float = 60
    max_ocr_pages: int = 1000
    ocr_languages: str = "chi_sim+eng"
    ocr_enabled: bool = True
    dedupe_tolerance: float = 0.7


@dataclass
class ExtractionStats:
    page_count: int = 0
    processed_pages: int = 0
    native_chars: int = 0
    deduped_chars: int = 0
    output_chars: int = 0
    duplicate_chars_removed: int = 0
    table_count: int = 0
    block_count: int = 0
    printed_page_count: int = 0
    two_column_regions: int = 0
    ocr_attempted: int = 0
    methods: Counter = field(default_factory=Counter)
    qualities: Counter = field(default_factory=Counter)
    warnings: list[dict[str, Any]] = field(default_factory=list)
    elapsed_seconds: float = 0
    sha256: str = ""
    total_bytes: int = 0

    def accept(self, record: dict[str, Any]) -> None:
        self.processed_pages += 1
        self.native_chars += record["nativeCharCount"]
        self.deduped_chars += record["dedupedCharCount"]
        self.duplicate_chars_removed += record["duplicateCharsRemoved"]
        self.output_chars += len(record["text"])
        self.table_count += len(record["tables"])
        self.block_count += len(record["blocks"])
        self.printed_page_count += bool(record["printedPage"])
        self.two_column_regions += record["twoColumnRegions"]
        self.methods[record["method"]] += 1
        self.qualities[record["quality"]] += 1
        self.ocr_attempted += record["ocrAttempted"]
        if record["warnings"]:
            self.warnings.append({"page": record["page"], "warnings": record["warnings"]})

    def as_dict(self) -> dict[str, Any]:
        return {**vars(self), "methods": dict(self.methods), "qualities": dict(self.qualities)}


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def normalize_text(text: str) -> str:
    """Normalize whitespace only. In particular, 10000 and 11 must stay intact."""
    return "\n".join(re.sub(r"[ \t]+", " ", line).strip() for line in text.replace("\x00", "").splitlines()).strip()


def tokenize(text: str) -> str:
    """Exact words plus CJK bigrams let Postgres simple queries match Chinese."""
    terms = [w.strip().lower() for w in jieba.cut(text, HMM=False) if w.strip() and re.search(r"\w", w)]
    for run in CJK_RUN.findall(text):
        terms.extend(run)
        terms.extend(run[i:i + 2] for i in range(len(run) - 1))
    # Deduplication applies to the search index ONLY, never evidence text/numbers.
    return " ".join(dict.fromkeys(terms))


@contextmanager
def time_limit(seconds: float) -> Iterator[None]:
    """Unix worker main thread deadline, including pathological PDF parsing."""
    if seconds <= 0:
        raise ExtractionError("DOCUMENT_TIMEOUT")
    previous = signal.getsignal(signal.SIGALRM)
    def expired(signum: int, frame: Any) -> None:
        raise ExtractionError("PAGE_TIMEOUT")
    signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


def box_tuple(box: Any) -> list[float]:
    return [round(float(v), 2) for v in box]


def extract_region(page: Any, bbox: tuple[float, float, float, float]) -> list[dict[str, Any]]:
    if bbox[2] - bbox[0] < 1 or bbox[3] - bbox[1] < 1:
        return []
    cropped = page.crop(bbox)
    lines = cropped.extract_text_lines(x_tolerance=1, y_tolerance=3, return_chars=False)
    blocks: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    for line in lines:
        text = normalize_text(line["text"])
        if not text:
            continue
        box = (line["x0"], line["top"], line["x1"], line["bottom"])
        # Paragraph grouping preserves line breaks, list items, gaps and geometry.
        new_item = bool(re.match(r"^(?:[•!]|\d+[)）]|规定扭矩|专用工具|注意|警\s*告|危\s*险)", text))
        if current is None or box[1] - current["bbox"][3] > 6 or new_item:
            current = {"kind": "paragraph", "bbox": box_tuple(box), "text": text}
            blocks.append(current)
        else:
            current["text"] += "\n" + text
            current["bbox"] = box_tuple((min(current["bbox"][0], box[0]), current["bbox"][1], max(current["bbox"][2], box[2]), box[3]))
    return blocks


def column_split(page: Any, bbox: tuple[float, float, float, float]) -> float | None:
    """Find a real empty vertical gutter; never split through a spanning table."""
    x0, top, x1, bottom = bbox
    chars = [c for c in page.chars if top <= c["top"] and c["bottom"] <= bottom and c["text"].strip()]
    if len(chars) < 70:
        return None
    xs = sorted(c["x0"] for c in chars)
    xe = sorted(c["x1"] for c in chars)
    left, right = xs[max(0, int(len(xs) * .01))], xe[min(len(xe) - 1, int(len(xe) * .99))]
    middle = (left + right) / 2
    # Headers/titles can span the gutter. Search the middle body, with <=2 crossings.
    rows: list[tuple[int, int]] = []
    for x in range(int(middle - 25), int(middle + 26)):
        count = sum(c["x0"] - 1 < x < c["x1"] + 1 for c in chars)
        rows.append((x, count))
    gaps: list[list[int]] = []
    for x, count in rows:
        if count <= 2:
            if not gaps or x != gaps[-1][-1] + 1:
                gaps.append([])
            gaps[-1].append(x)
    gaps = [g for g in gaps if len(g) >= 9]
    if not gaps:
        return None
    gap = min(gaps, key=lambda g: abs((g[0] + g[-1]) / 2 - middle))
    split = (gap[0] + gap[-1]) / 2
    # A genuine text column has substantial content on BOTH sides.
    if min(sum(c["x1"] <= split for c in chars), sum(c["x0"] >= split for c in chars)) < 25:
        return None
    return split


def native_layout(page: Any) -> tuple[list[dict[str, Any]], list[dict[str, Any]], int, list[str]]:
    tables: list[dict[str, Any]] = []
    warnings: list[str] = []
    if len(page.edges) < 6000:
        for table in page.find_tables():
            rows = table.extract(x_tolerance=1, y_tolerance=3)
            clean_rows = [[normalize_text(cell) if cell is not None else None for cell in row] for row in rows]
            if len(clean_rows) < 2 or max((len(r) for r in clean_rows), default=0) < 2:
                continue
            if sum(len(c or "") for row in clean_rows for c in row) < 10:
                continue
            tables.append({"bbox": box_tuple(table.bbox), "rows": clean_rows,
                           "text": "\n".join(" | ".join(cell or "" for cell in row) for row in clean_rows),
                           "cellBoxes": [[box_tuple(cell) if cell else None for cell in row.cells] for row in table.rows],
                           "method": "native_grid", "mergedCells": "null_cells_and_original_geometry_preserved"})
    else:
        warnings.append("TABLE_DETECTION_SKIPPED_COMPLEX_VECTOR_PAGE")
    # Full-width tables are horizontal bands, preserving left/right prose above/below.
    spanning = sorted([t for t in tables if t["bbox"][2] - t["bbox"][0] > page.width * .6], key=lambda t: t["bbox"][1])
    blocks: list[dict[str, Any]] = []
    y = 0.0
    regions = 0
    def append_band(top: float, bottom: float) -> None:
        nonlocal regions
        if bottom - top < 1:
            return
        # The running header is a separate line, so it cannot bridge two columns.
        if top == 0 and bottom > 45:
            blocks.extend(extract_region(page, (0, 0, page.width, 45)))
            top = 45
        box = (0, top, page.width, bottom)
        split = column_split(page, box)
        if split is not None:
            regions += 1
            # A short full-width note may cross an otherwise real gutter. Keep
            # that line as a full-width band rather than clipping a digit or
            # falling back to mixing both columns throughout the whole page.
            spanning_lines = []
            for line in page.crop(box).extract_text_lines(x_tolerance=1, y_tolerance=3):
                if any(c["x0"] < split < c["x1"] for c in line["chars"]):
                    spanning_lines.append((max(top, line["top"] - .5), min(bottom, line["bottom"] + .5)))
            current_top = top
            for span_top, span_bottom in sorted(spanning_lines):
                if span_top < current_top:
                    continue
                blocks.extend(extract_region(page, (0, current_top, split, span_top)))
                blocks.extend(extract_region(page, (split, current_top, page.width, span_top)))
                blocks.extend(extract_region(page, (0, span_top, page.width, span_bottom)))
                current_top = span_bottom
            blocks.extend(extract_region(page, (0, current_top, split, bottom)))
            blocks.extend(extract_region(page, (split, current_top, page.width, bottom)))
        else:
            blocks.extend(extract_region(page, box))
    for table in spanning:
        if table["bbox"][1] < y:
            continue
        append_band(y, table["bbox"][1])
        blocks.append({"kind": "table", "bbox": table["bbox"], "text": table["text"], "tableIndex": tables.index(table)})
        y = table["bbox"][3]
    append_band(y, page.height)
    return blocks, tables, regions, warnings


def header_metadata(page: Any, text: str, previous_section: str | None, allow_ocr: bool = False) -> tuple[str | None, str | None]:
    header = page.crop((0, 0, page.width, min(48, page.height))).extract_text(x_tolerance=1, y_tolerance=3) or ""
    match = PRINTED_PAGE.search(header)
    if match:
        printed = re.sub(r"\s", "", match.group(1)).replace("–", "-")
        section = PRINTED_PAGE.sub("", header).strip(" \n:：")
        return printed, section or previous_section
    # Never turn a TOC/body cross-reference into this page's printed page number.
    if not allow_ocr:
        return None, previous_section
    # OCR has no native header geometry; restrict guesses to first/last lines.
    candidate = "\n".join(text.splitlines()[:2] + text.splitlines()[-2:])
    match = PRINTED_PAGE.search(candidate)
    printed = re.sub(r"\s", "", match.group(1)).replace("–", "-") if match else None
    return printed, previous_section


def ocr_page(path: Path, page_number: int, width: float, height: float, config: ExtractionConfig) -> tuple[list[dict[str, Any]], float]:
    if not shutil.which("pdftoppm") or not shutil.which("tesseract"):
        raise ExtractionError("OCR_EXECUTABLE_MISSING")
    with tempfile.TemporaryDirectory(prefix="motuo-ocr-") as directory:
        stem = Path(directory) / "page"
        try:
            subprocess.run(["pdftoppm", "-f", str(page_number), "-l", str(page_number), "-singlefile", "-r", "180", "-scale-to", "2400", "-png", str(path), str(stem)], check=True, capture_output=True, timeout=config.ocr_timeout)
            result = subprocess.run(["tesseract", str(stem) + ".png", "stdout", "-l", config.ocr_languages, "--psm", "3", "tsv"], check=True, capture_output=True, text=True, timeout=config.ocr_timeout)
        except subprocess.TimeoutExpired as exc:
            raise ExtractionError("OCR_TIMEOUT") from exc
        except subprocess.CalledProcessError as exc:
            raise ExtractionError("OCR_FAILED_OR_LANGUAGE_MISSING") from exc
        from PIL import Image
        with Image.open(str(stem) + ".png") as img:
            image_width, image_height = img.size
        lines: dict[tuple[str, ...], list[dict[str, str]]] = {}
        confidences: list[float] = []
        for row in csv.DictReader(io.StringIO(result.stdout), delimiter="\t"):
            if row.get("text", "").strip() and float(row.get("conf", "-1")) >= 0:
                key = (row["block_num"], row["par_num"], row["line_num"])
                lines.setdefault(key, []).append(row)
                confidences.append(float(row["conf"]))
        blocks = []
        for words in lines.values():
            text = " ".join(w["text"] for w in words)
            text = re.sub(r"(?<=[\u3400-\u9fff]) +(?=[\u3400-\u9fff])", "", text)
            left = min(int(w["left"]) for w in words)
            top = min(int(w["top"]) for w in words)
            right = max(int(w["left"]) + int(w["width"]) for w in words)
            bottom = max(int(w["top"]) + int(w["height"]) for w in words)
            blocks.append({"kind": "paragraph", "bbox": box_tuple((left * width / image_width, top * height / image_height, right * width / image_width, bottom * height / image_height)), "text": text, "method": "ocr"})
        return blocks, sum(confidences) / len(confidences) if confidences else 0


def extract_page(pdf_page: Any, path: Path, number: int, config: ExtractionConfig, previous_section: str | None = None, ocr_budget: int = 1000) -> dict[str, Any]:
    raw_count = len(pdf_page.chars)
    # Match glyph content AND coordinates; font/paint differences often cause overlays.
    page = pdf_page.dedupe_chars(tolerance=config.dedupe_tolerance, extra_attrs=())
    blocks, tables, regions, warnings = native_layout(page)
    text = normalize_text("\n\n".join(block["text"] for block in blocks))
    method, quality = "native", "native"
    confidence: float | None = None
    graphical = bool(page.images or page.lines or page.rects or page.curves)
    # Some pages contain only a running header and an image identifier in their
    # text layer, while the actual illustration's labels live inside the image.
    body = page.crop((0, min(45, page.height), page.width, page.height)).extract_text(x_tolerance=1, y_tolerance=3) or ""
    body_without_figure_ids = re.sub(r"\b[A-Z][A-Z0-9]{8,}-\d{2}\b", "", body)
    figure_only = bool(page.images) and len(re.sub(r"\s", "", body_without_figure_ids)) < 15
    bad = len(BAD_TEXT.findall(text))
    low_quality = len(re.sub(r"\s", "", text)) < 25 or bad > max(2, len(text) * .02) or figure_only
    attempted = False
    if not raw_count and not graphical:
        method, quality = "blank", "blank"
    elif low_quality:
        if not config.ocr_enabled:
            quality = "needs_review"
            warnings.append("OCR_DISABLED_ON_LOW_QUALITY_PAGE")
        elif ocr_budget <= 0:
            quality = "needs_review"
            warnings.append("OCR_PAGE_BUDGET_EXHAUSTED")
        else:
            attempted = True
            try:
                ocr_blocks, confidence = ocr_page(path, number, page.width, page.height, config)
                ocr_text = normalize_text("\n".join(block["text"] for block in ocr_blocks))
                if len(ocr_text) > len(text) or bad:
                    text, blocks, tables = ocr_text, ocr_blocks, []
                    method = "ocr"
                    warnings.append("OCR_VALUES_REQUIRE_SOURCE_PAGE_CHECK")
                    warnings.append("OCR_TABLES_NOT_STRUCTURED")
                quality = "ocr" if method == "ocr" and confidence >= 55 else "needs_review"
                if quality == "needs_review":
                    warnings.append("LOW_TEXT_PAGE_REQUIRES_VISUAL_CHECK")
                if not text:
                    warnings.append("NO_READABLE_TEXT_ON_GRAPHIC_PAGE")
            except ExtractionError as exc:
                if str(exc) in {"PAGE_TIMEOUT", "DOCUMENT_TIMEOUT"}:
                    raise
                quality = "needs_review"
                warnings.append(str(exc))
    printed, section = header_metadata(page, text, previous_section, method == "ocr")
    if not section:
        section = next((line for line in text.splitlines()[:3] if re.search(r"[\u3400-\u9fff]", line)), None)
    for i, block in enumerate(blocks):
        block["id"] = f"p{number}-b{i + 1}"
    figures = [{"id": f"p{number}-figure{i + 1}", "bbox": box_tuple((img["x0"], img["top"], img["x1"], img["bottom"])), "sourcePage": number} for i, img in enumerate(page.images)]
    return {"schemaVersion": 1, "page": number, "printedPage": printed, "section": section, "chapter": printed.split("-")[0] if printed else None,
            "text": text, "tokens": tokenize(text), "quality": quality, "method": method,
            "source": {"fileName": path.name, "physicalPage": number, "originalRelativePath": "original.pdf", "coordinateSystem": "pdf_points_top_left", "width": page.width, "height": page.height},
            "blocks": blocks, "tables": tables, "figures": figures, "nativeCharCount": raw_count,
            "dedupedCharCount": len(page.chars), "duplicateCharsRemoved": raw_count - len(page.chars),
            "twoColumnRegions": regions, "ocrAttempted": attempted,
            "ocrMeanWordConfidence": round(confidence, 2) if confidence is not None else None,
            "warnings": warnings}


def parser_failure_page(page: Any, path: Path, number: int, config: ExtractionConfig, previous_section: str | None, ocr_budget: int, cause: Exception) -> dict[str, Any]:
    """A malformed native page may still render; OCR never restores native quality."""
    warnings = [f"NATIVE_PARSER_FAILED:{type(cause).__name__}", "SOURCE_PAGE_REVIEW_REQUIRED", "NATIVE_GLYPH_COUNTS_UNAVAILABLE"]
    blocks: list[dict[str, Any]] = []
    confidence: float | None = None
    attempted = False
    if not config.ocr_enabled:
        warnings.append("OCR_DISABLED_ON_LOW_QUALITY_PAGE")
    elif ocr_budget <= 0:
        warnings.append("OCR_PAGE_BUDGET_EXHAUSTED")
    else:
        attempted = True
        try:
            blocks, confidence = ocr_page(path, number, page.width, page.height, config)
            warnings.extend(["OCR_VALUES_REQUIRE_SOURCE_PAGE_CHECK", "OCR_TABLES_NOT_STRUCTURED"])
        except ExtractionError as exc:
            # Hard processing deadlines remain failures so the worker can resume
            # from the last complete page; they are not empty successful pages.
            if str(exc) in {"PAGE_TIMEOUT", "DOCUMENT_TIMEOUT"}:
                raise
            warnings.append(str(exc))
    text = normalize_text("\n".join(block["text"] for block in blocks))
    if not text:
        warnings.append("NO_READABLE_TEXT_ON_FAILED_NATIVE_PAGE")
    header = "\n".join(text.splitlines()[:2] + text.splitlines()[-2:])
    match = PRINTED_PAGE.search(header)
    printed = re.sub(r"\s", "", match.group(1)).replace("–", "-") if match else None
    for i, block in enumerate(blocks):
        block["id"] = f"p{number}-b{i + 1}"
    return {"schemaVersion": 1, "page": number, "printedPage": printed, "section": previous_section,
            "chapter": printed.split("-")[0] if printed else None,
            "text": text, "tokens": tokenize(text), "quality": "needs_review", "method": "ocr" if text else "unavailable",
            "source": {"fileName": path.name, "physicalPage": number, "originalRelativePath": "original.pdf", "coordinateSystem": "pdf_points_top_left", "width": page.width, "height": page.height},
            "blocks": blocks, "tables": [], "figures": [], "nativeCharCount": 0, "dedupedCharCount": 0,
            "duplicateCharsRemoved": 0, "twoColumnRegions": 0, "ocrAttempted": attempted,
            "ocrMeanWordConfidence": round(confidence, 2) if confidence is not None else None, "warnings": warnings}


def extract_document(path: Path, config: ExtractionConfig | None = None, stats: ExtractionStats | None = None, check_alive: Callable[[], None] | None = None, start_page: int = 1, previous_section: str | None = None) -> Iterator[dict[str, Any]]:
    config = config or ExtractionConfig()
    stats = stats or ExtractionStats()
    started = time.monotonic()
    if not path.is_file() or path.is_symlink():
        raise ExtractionError("PDF_NOT_FOUND_OR_SYMLINK")
    if path.stat().st_size > config.max_bytes:
        raise ExtractionError("PDF_TOO_LARGE")
    stats.total_bytes = path.stat().st_size
    stats.sha256 = sha256_file(path)
    with path.open("rb") as f:
        if b"%PDF-" not in f.read(1024):
            raise ExtractionError("INVALID_PDF_HEADER")
    try:
        with pdfplumber.open(path) as pdf:
            with time_limit(min(config.page_timeout, config.max_seconds)):
                stats.page_count = len(pdf.pages)
            if not 0 < stats.page_count <= config.max_pages:
                raise ExtractionError("INVALID_PAGE_COUNT")
            for number, page in enumerate(pdf.pages, 1):
                if number < start_page:
                    page.close()
                    continue
                if check_alive:
                    check_alive()
                remaining = config.max_seconds - (time.monotonic() - started)
                try:
                    with time_limit(min(config.page_timeout, remaining)):
                        try:
                            record = extract_page(page, path, number, config, previous_section, config.max_ocr_pages - stats.ocr_attempted)
                        except PdfminerException as exc:
                            # pdfplumber wraps all process_page errors, including
                            # our signal deadline. Keep typed operational errors.
                            cause = exc.args[0] if exc.args and isinstance(exc.args[0], Exception) else exc
                            if isinstance(cause, ExtractionError):
                                raise cause from exc
                            record = parser_failure_page(page, path, number, config, previous_section, config.max_ocr_pages - stats.ocr_attempted, cause)
                except ExtractionError as exc:
                    if str(exc) in {"PAGE_TIMEOUT", "DOCUMENT_TIMEOUT"}:
                        raise ExtractionError(f"{exc}:page={number}") from exc
                    raise
                previous_section = record["section"]
                stats.accept(record)
                stats.elapsed_seconds = round(time.monotonic() - started, 3)
                yield record
                page.close()  # Do not retain every decoded page of a 140 MB manual.
    except ExtractionError:
        raise
    except Exception as exc:
        # No document text, private file paths, or parser internals in user errors.
        raise ExtractionError(f"PDF_EXTRACTION_FAILED:{type(exc).__name__}") from exc
    finally:
        stats.elapsed_seconds = round(time.monotonic() - started, 3)
