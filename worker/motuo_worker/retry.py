"""Operator-only, checksum-bound retry of one failed import; dry-run by default."""
from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path
from typing import Any

import psycopg

from .extraction import ExtractionError, ExtractionStats, sha256_file
from .jobs import Worker, canonical_id, manual_directory


class RetryRejected(ExtractionError):
    """Stable error codes only: never include document text, paths or credentials."""


def checked_prefix(connection: psycopg.Connection, data_dir: Path, job: dict[str, Any]) -> int:
    manual_id = canonical_id(job["id"])
    rows = connection.execute("SELECT * FROM manual_pages WHERE manual_id=%s ORDER BY page", (manual_id,)).fetchall()
    count = job["page_count"]
    if not isinstance(count, int) or not 0 <= count <= 1000 or len(rows) > count:
        raise RetryRejected("INVALID_PAGE_COUNT")
    directory = manual_directory(data_dir, manual_id) / "pages"
    if directory.is_symlink():
        raise RetryRejected("UNSAFE_PAGE_DIRECTORY")
    stats = ExtractionStats()
    for number, row in enumerate(rows, 1):
        if row["page"] != number:
            raise RetryRejected("NONCONTIGUOUS_PAGE_PREFIX")
        path = directory / f"{number:04d}.json"
        if not path.is_file() or path.is_symlink():
            raise RetryRejected("PAGE_SIDECAR_MISSING_OR_UNSAFE")
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
            source = record["source"]
            if (record["schemaVersion"] != 1 or record["page"] != number
                    or source["manualId"] != manual_id or source["physicalPage"] != number
                    or source["fileName"] != job["file_name"] or source["originalRelativePath"] != "original.pdf"):
                raise RetryRejected("PAGE_SOURCE_MISMATCH")
            for database_key, record_key in (("printed_page", "printedPage"), ("section", "section"),
                                             ("text", "text"), ("tokens", "tokens"), ("quality", "quality")):
                if row[database_key] != record[record_key]:
                    raise RetryRejected("PAGE_DATABASE_SIDECAR_MISMATCH")
            for key in ("nativeCharCount", "dedupedCharCount", "duplicateCharsRemoved", "twoColumnRegions"):
                if type(record[key]) is not int or record[key] < 0:
                    raise RetryRejected("INVALID_PAGE_SIDECAR")
            if (not isinstance(record["text"], str) or not isinstance(record["tokens"], str)
                    or record["quality"] not in {"native", "ocr", "needs_review", "blank"}
                    or record["method"] not in {"native", "ocr", "unavailable", "blank"}
                    or type(record["ocrAttempted"]) is not bool
                    or any(not isinstance(record[key], list) for key in ("tables", "blocks", "warnings"))):
                raise RetryRejected("INVALID_PAGE_SIDECAR")
            # The resumed worker consumes these exact fields to reconstruct its stats.
            stats.accept(record)
        except RetryRejected:
            raise
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            raise RetryRejected("INVALID_PAGE_SIDECAR") from None
    return len(rows)


def retry_failed(worker: Worker, manual_id: str, owner_id: str, expected_sha256: str,
                 expected_bytes: int, *, apply: bool = False) -> dict[str, Any]:
    try:
        manual_id, owner_id = canonical_id(manual_id), canonical_id(owner_id)
    except (ValueError, TypeError, AttributeError):
        raise RetryRejected("INVALID_ID") from None
    if not re.fullmatch(r"[a-fA-F0-9]{64}", expected_sha256):
        raise RetryRejected("INVALID_EXPECTED_CHECKSUM")
    if type(expected_bytes) is not int or not 0 < expected_bytes <= 256 * 1024 * 1024:
        raise RetryRejected("INVALID_EXPECTED_SIZE")
    with worker.connect() as connection:
        locked = False
        try:
            with connection.transaction():
                # Same order as Worker.claim: row first, nonblocking advisory lock second.
                # A delete either wins first (not found), or waits until validation commits.
                job = connection.execute("SELECT * FROM manuals WHERE id=%s AND owner_id=%s FOR UPDATE NOWAIT",
                                         (manual_id, owner_id)).fetchone()
                if job is None:
                    raise RetryRejected("MANUAL_NOT_FOUND_FOR_OWNER")
                if job["sha256"].lower() != expected_sha256.lower() or job["total_bytes"] != expected_bytes:
                    raise RetryRejected("EXPECTED_SOURCE_MISMATCH")
                result = {"manualId": manual_id, "ownerId": owner_id, "status": job["status"],
                          "changed": False, "dryRun": not apply, "prefixPages": None,
                          "pageCount": job["page_count"], "validation": "metadata_only"}
                if job["status"] in {"queued", "processing", "ready"}:
                    return {**result, "action": "already_in_progress_or_complete"}
                if job["status"] != "failed":
                    raise RetryRejected("MANUAL_NOT_FAILED")
                locked = connection.execute("SELECT pg_try_advisory_lock(hashtextextended(%s, 0)) AS locked",
                                            (manual_id,)).fetchone()["locked"]
                if not locked:
                    raise RetryRejected("MANUAL_BUSY")
                original = manual_directory(worker.data_dir, manual_id) / "original.pdf"
                if not original.is_file() or original.is_symlink():
                    raise RetryRejected("ORIGINAL_PDF_MISSING_OR_UNSAFE")
                if original.stat().st_size != expected_bytes:
                    raise RetryRejected("ORIGINAL_SIZE_MISMATCH")
                if sha256_file(original).lower() != expected_sha256.lower():
                    raise RetryRejected("ORIGINAL_CHECKSUM_MISMATCH")
                prefix = checked_prefix(connection, worker.data_dir, job)
                result.update(prefixPages=prefix, validation="source_and_committed_prefix", action="would_queue")
                if apply:
                    updated = connection.execute("""UPDATE manuals SET status='queued',error=NULL,updated_at=now()
                        WHERE id=%s AND owner_id=%s AND status='failed' AND sha256=%s AND total_bytes=%s
                        RETURNING status""", (manual_id, owner_id, job["sha256"], expected_bytes)).fetchone()
                    if updated is None:
                        raise RetryRejected("MANUAL_STATE_CHANGED")
                    result.update(status=updated["status"], changed=True, action="queued")
                return result
        except psycopg.errors.LockNotAvailable:
            raise RetryRejected("MANUAL_BUSY") from None
        finally:
            if locked:
                connection.execute("SELECT pg_advisory_unlock(hashtextextended(%s, 0))", (manual_id,))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manual-id", required=True)
    parser.add_argument("--owner-id", required=True)
    parser.add_argument("--expected-sha256", required=True)
    parser.add_argument("--expected-bytes", required=True, type=int)
    parser.add_argument("--apply", action="store_true", help="Queue only after all checks pass; default is read-only")
    args = parser.parse_args()
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        parser.error("DATABASE_URL must be supplied by the private deployment environment")
    try:
        result = retry_failed(Worker(dsn, Path(os.environ.get("DATA_DIR", "./data"))),
                              args.manual_id, args.owner_id, args.expected_sha256, args.expected_bytes, apply=args.apply)
    except ExtractionError as exc:
        print(json.dumps({"error": str(exc)}))
        return 1
    except (OSError, psycopg.Error):
        print(json.dumps({"error": "STORAGE_OR_DATABASE_UNAVAILABLE"}))
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
