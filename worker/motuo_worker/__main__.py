from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from pathlib import Path

from .extraction import ExtractionConfig, ExtractionError, ExtractionStats, extract_document


def main() -> int:
    parser = argparse.ArgumentParser(description="Motuo local PDF extractor / PostgreSQL import worker")
    parser.add_argument("--input", type=Path, help="Local PDF. Offline mode never connects to PostgreSQL or any network service.")
    parser.add_argument("--output", type=Path, help="UTF-8 JSONL output; stats are saved beside it as .stats.json")
    parser.add_argument("--no-ocr", action="store_true", help="Mark low-quality pages for review instead of OCR; never silently claim completeness")
    parser.add_argument("--max-seconds", type=float, default=float(os.environ.get("MANUAL_MAX_SECONDS", "7200")))
    parser.add_argument("--page-timeout", type=float, default=float(os.environ.get("MANUAL_PAGE_TIMEOUT", "120")))
    parser.add_argument("--ocr-timeout", type=float, default=float(os.environ.get("MANUAL_OCR_TIMEOUT", "60")))
    parser.add_argument("--max-ocr-pages", type=int, default=int(os.environ.get("MANUAL_MAX_OCR_PAGES", "1000")))
    parser.add_argument("--once", action="store_true", help="Process at most one PostgreSQL job")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", stream=sys.stderr)
    config = ExtractionConfig(max_seconds=args.max_seconds, page_timeout=args.page_timeout, ocr_timeout=args.ocr_timeout, max_ocr_pages=args.max_ocr_pages, ocr_enabled=not args.no_ocr, ocr_languages=os.environ.get("OCR_LANGUAGES", "chi_sim+eng"))
    if args.input:
        if args.output is None:
            parser.error("--input requires --output")
        if args.input.resolve() == args.output.resolve():
            parser.error("output must not overwrite the original PDF")
        if args.output.exists() or args.output.with_suffix(".stats.json").exists():
            parser.error("output or its stats file already exists; choose a new output path")
        stats = ExtractionStats()
        try:
            # Exclusive creation protects earlier extraction evidence from accidental overwrite.
            with args.output.open("x", encoding="utf-8") as output:
                for record in extract_document(args.input.resolve(), config, stats):
                    output.write(json.dumps(record, ensure_ascii=False) + "\n")
                    output.flush()
                    if record["page"] % 25 == 0 or record["page"] == stats.page_count:
                        logging.info("page=%s/%s", record["page"], stats.page_count)
        except (ExtractionError, OSError) as exc:
            logging.error("extraction failed: %s", exc)
            stats.warnings.append({"fatal": str(exc)})
            args.output.with_suffix(".stats.json").write_text(json.dumps(stats.as_dict(), ensure_ascii=False, indent=2), encoding="utf-8")
            return 1
        args.output.with_suffix(".stats.json").write_text(json.dumps(stats.as_dict(), ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(stats.as_dict(), ensure_ascii=False, indent=2))
        return 0
    if args.output:
        parser.error("--output requires --input")
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        parser.error("DATABASE_URL is required for worker mode")
    from .jobs import Worker
    worker = Worker(dsn, Path(os.environ.get("DATA_DIR", "./data")), config, int(os.environ.get("MANUAL_STALE_SECONDS", "300")))
    if args.once:
        worker.run_once()
    else:
        worker.run_forever(float(os.environ.get("MANUAL_POLL_SECONDS", "2")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
