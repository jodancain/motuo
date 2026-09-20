import json
from pathlib import Path
import shutil

import pdfplumber
from pdfplumber.utils.exceptions import PdfminerException
import pytest
from reportlab.pdfgen import canvas

from motuo_worker.extraction import ExtractionConfig, ExtractionError, ExtractionStats, extract_document, extract_page, normalize_text, tokenize
from motuo_worker.jobs import canonical_id, manual_directory
from motuo_worker import extraction


def make_pdf(path, draw):
    c = canvas.Canvas(str(path), pagesize=(600, 800))
    draw(c)
    c.save()
    return path


def test_coordinate_dedupe_preserves_repeated_numbers(tmp_path):
    def draw(c):
        c.setFont("Helvetica", 12)
        for delta in [0, .25]:
            c.drawString(50 + delta, 700, "10000 km 11 V 2.550 09900-25009")
        c.drawString(50, 675, "10000 km remains a distinct second line")
        c.showPage()
    path = make_pdf(tmp_path / "overlap.pdf", draw)
    record = next(extract_document(path, ExtractionConfig(ocr_enabled=False)))
    assert record["duplicateCharsRemoved"] > 20
    assert "10000 km 11 V 2.550 09900-25009" in record["text"]
    assert record["text"].count("10000") == 2


def test_two_columns_are_read_in_column_order(tmp_path):
    def draw(c):
        c.setFont("Helvetica", 10)
        for i in range(8):
            c.drawString(40, 700 - i * 18, f"LEFT {i} Service procedure number 10000")
            c.drawString(340, 700 - i * 18, f"RIGHT {i} Installation value 11 V")
        c.showPage()
    path = make_pdf(tmp_path / "columns.pdf", draw)
    record = next(extract_document(path, ExtractionConfig(ocr_enabled=False)))
    assert record["twoColumnRegions"] == 1
    assert record["text"].index("LEFT 7") < record["text"].index("RIGHT 0")


def test_blank_page_is_not_an_ocr_failure(tmp_path):
    path = make_pdf(tmp_path / "blank.pdf", lambda c: c.showPage())
    record = next(extract_document(path))
    assert record["method"] == "blank"
    assert record["quality"] == "blank"
    assert not record["ocrAttempted"]
    assert record["text"] == ""


def test_printed_page_and_section_are_separate_from_physical_page(tmp_path):
    def draw(c):
        c.setFont("Helvetica", 10)
        c.drawString(360, 765, "Engine information: 1A-29")
        c.drawString(50, 700, "A long enough body for a reliable native extraction.")
        c.showPage()
    path = make_pdf(tmp_path / "labels.pdf", draw)
    record = next(extract_document(path))
    assert record["printedPage"] == "1A-29"
    assert record["page"] == record["source"]["physicalPage"] == 1
    assert record["section"] == "Engine information"
    assert record["blocks"][0]["bbox"][1] < 48


def test_grid_table_preserves_repeated_values_and_cell_geometry(tmp_path):
    def draw(c):
        c.setFont("Helvetica", 10)
        for y in [620, 650, 680]:
            c.line(40, y, 560, y)
        for x in [40, 300, 560]:
            c.line(x, 620, x, 680)
        c.drawString(50, 660, "Voltage")
        c.drawString(310, 660, "10000")
        c.drawString(50, 630, "Minimum")
        c.drawString(310, 630, "11 V")
        c.showPage()
    path = make_pdf(tmp_path / "table.pdf", draw)
    record = next(extract_document(path))
    assert record["tables"][0]["rows"] == [["Voltage", "10000"], ["Minimum", "11 V"]]
    assert record["tables"][0]["cellBoxes"][0][0] == [40.0, 120.0, 300.0, 150.0]
    assert "Voltage | 10000" in record["text"]


def test_whitespace_normalization_does_not_collapse_digits():
    assert normalize_text("10000  11\n  2.550 – 2.575") == "10000 11\n2.550 – 2.575"


def test_tokens_support_chinese_and_numbers():
    terms = tokenize("发动机机油 10000 km 蓄电池 11V").split()
    assert "10000" in terms
    assert "发动机" in terms
    assert "机油" in terms
    assert "蓄电池" in terms


def test_invalid_pdf_and_size_limit(tmp_path):
    path = tmp_path / "not.pdf"
    path.write_text("not a pdf")
    with pytest.raises(ExtractionError, match="INVALID_PDF_HEADER"):
        list(extract_document(path))
    with pytest.raises(ExtractionError, match="PDF_TOO_LARGE"):
        list(extract_document(path, ExtractionConfig(max_bytes=3)))


def test_original_pdf_is_never_modified(tmp_path):
    path = make_pdf(tmp_path / "source.pdf", lambda c: (c.drawString(30, 700, "Original unchanged, value 10000 km"), c.showPage()))
    before = path.read_bytes()
    stats = ExtractionStats()
    list(extract_document(path, stats=stats))
    assert path.read_bytes() == before
    assert stats.processed_pages == stats.page_count == 1


def test_missing_ocr_is_explicit_not_success(tmp_path, monkeypatch):
    def draw(c):
        c.rect(20, 20, 200, 100)
        c.showPage()
    path = make_pdf(tmp_path / "drawing.pdf", draw)
    monkeypatch.setattr(shutil, "which", lambda executable: None)
    record = next(extract_document(path))
    assert record["quality"] == "needs_review"
    assert "OCR_EXECUTABLE_MISSING" in record["warnings"]


@pytest.mark.skipif(not shutil.which("tesseract") or not shutil.which("pdftoppm"), reason="requires actual local Tesseract and Poppler")
def test_raster_pdf_runs_real_ocr_and_retains_source_page(tmp_path):
    from PIL import Image, ImageDraw, ImageFont
    image = Image.new("RGB", (1800, 800), "white")
    draw = ImageDraw.Draw(image)
    candidates = ["/System/Library/Fonts/Supplemental/Arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"]
    font = ImageFont.truetype(next(p for p in candidates if Path(p).exists()), 80)
    draw.text((80, 80), "Battery voltage 11 V", fill="black", font=font)
    draw.text((80, 230), "Service interval 10000 km", fill="black", font=font)
    image_path = tmp_path / "raster.png"
    image.save(image_path)
    def render(c):
        c.drawImage(str(image_path), 0, 300, width=600, height=266)
        c.showPage()
    pdf = make_pdf(tmp_path / "scan.pdf", render)
    record = next(extract_document(pdf))
    assert record["method"] == "ocr"
    assert record["nativeCharCount"] == 0
    assert "10000" in record["text"]
    assert "11" in record["text"]
    assert record["source"]["physicalPage"] == 1
    assert record["blocks"][0]["method"] == "ocr"


def test_manual_paths_validate_uuid_and_escape(tmp_path):
    with pytest.raises(ValueError):
        canonical_id("../../other")
    identifier = "f79c6576-84a4-498b-982a-26d5302013ad"
    (tmp_path / "manuals").mkdir()
    (tmp_path / "manuals" / identifier).symlink_to("/tmp")
    with pytest.raises(ExtractionError, match="UNSAFE_MANUAL_PATH"):
        manual_directory(tmp_path, identifier)


def test_wrapped_page_timeout_is_not_silently_converted_to_ocr(tmp_path, monkeypatch):
    path = make_pdf(tmp_path / "deadline.pdf", lambda c: c.showPage())
    def timed_out(*args, **kwargs):
        raise PdfminerException(ExtractionError("PAGE_TIMEOUT"))
    monkeypatch.setattr(extraction, "extract_page", timed_out)
    def forbidden_ocr(*args, **kwargs):
        raise AssertionError("A deadline must not be retried as a malformed page")
    monkeypatch.setattr(extraction, "ocr_page", forbidden_ocr)
    with pytest.raises(ExtractionError, match="^PAGE_TIMEOUT:page=1$"):
        list(extract_document(path))


def test_deadline_during_low_quality_ocr_remains_recoverable_failure(tmp_path, monkeypatch):
    path = make_pdf(tmp_path / "ocr-deadline.pdf", lambda c: (c.rect(20, 20, 200, 100), c.showPage()))
    def timed_out(*args, **kwargs):
        raise ExtractionError("PAGE_TIMEOUT")
    monkeypatch.setattr(extraction, "ocr_page", timed_out)
    with pytest.raises(ExtractionError, match="^PAGE_TIMEOUT:page=1$"):
        list(extract_document(path))


def test_parser_failure_has_explicit_unavailable_quality_when_ocr_disabled(tmp_path, monkeypatch):
    path = make_pdf(tmp_path / "parse-error.pdf", lambda c: c.showPage())
    def malformed(*args, **kwargs):
        raise PdfminerException(ValueError("sensitive source content must not be copied"))
    monkeypatch.setattr(extraction, "extract_page", malformed)
    record = next(extract_document(path, ExtractionConfig(ocr_enabled=False)))
    assert record["page"] == record["source"]["physicalPage"] == 1
    assert record["quality"] == "needs_review"
    assert record["method"] == "unavailable"
    assert record["text"] == ""
    assert record["tables"] == []
    assert record["warnings"][0] == "NATIVE_PARSER_FAILED:ValueError"
    assert "sensitive source content" not in json.dumps(record)


@pytest.mark.skipif(not shutil.which("tesseract") or not shutil.which("pdftoppm"), reason="requires actual local Tesseract and Poppler")
def test_parser_failure_runs_real_ocr_but_requires_source_review(tmp_path, monkeypatch):
    def draw(c):
        c.setFont("Helvetica", 24)
        c.drawString(40, 750, "Electrical: 1C-2")
        c.drawString(40, 650, "Battery voltage 11 V")
        c.drawString(40, 580, "Service interval 10000 km")
        c.showPage()
    path = make_pdf(tmp_path / "renderable.pdf", draw)
    def malformed(*args, **kwargs):
        raise PdfminerException(ValueError("malformed native instruction"))
    monkeypatch.setattr(extraction, "extract_page", malformed)
    record = next(extract_document(path))
    assert record["method"] == "ocr"
    assert record["ocrAttempted"]
    assert record["quality"] == "needs_review"
    assert "10000" in record["text"] and "11" in record["text"]
    assert record["printedPage"] == "1C-2"
    assert record["source"]["physicalPage"] == 1
    assert record["tables"] == []
    assert "OCR_VALUES_REQUIRE_SOURCE_PAGE_CHECK" in record["warnings"]
