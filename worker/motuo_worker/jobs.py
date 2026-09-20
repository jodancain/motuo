"""PostgreSQL job leases and deletion-safe, per-page publication."""
from __future__ import annotations

import json
import logging
import os
import signal
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any

import psycopg
from psycopg.rows import dict_row

from .extraction import ExtractionConfig, ExtractionError, ExtractionStats, extract_document, sha256_file

LOG = logging.getLogger(__name__)


class JobDeleted(ExtractionError):
    pass


def canonical_id(value: Any) -> str:
    return str(uuid.UUID(str(value)))


def manual_directory(data_dir: Path, manual_id: Any) -> Path:
    root = data_dir.resolve()
    directory = root / "manuals" / canonical_id(manual_id)
    if directory.is_symlink() or (root / "manuals").is_symlink() or not directory.resolve().is_relative_to(root):
        raise ExtractionError("UNSAFE_MANUAL_PATH")
    return directory


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    """Caller holds the manual row lock, so deletion cannot race file creation."""
    fd, temporary = tempfile.mkstemp(prefix=".page-", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump(value, output, ensure_ascii=False)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


class Worker:
    def __init__(self, dsn: str, data_dir: Path, config: ExtractionConfig | None = None, stale_seconds: int = 300):
        self.dsn = dsn
        self.data_dir = data_dir
        self.config = config or ExtractionConfig()
        self.stale_seconds = stale_seconds
        self.stop_requested = False

    def connect(self) -> psycopg.Connection:
        return psycopg.connect(self.dsn, autocommit=True, row_factory=dict_row, connect_timeout=10)

    def claim(self, connection: psycopg.Connection) -> dict[str, Any] | None:
        """SKIP LOCKED selects queued/stale work; session advisory lock owns its lifetime."""
        with connection.transaction():
            jobs = connection.execute("""
                SELECT * FROM manuals
                WHERE status = 'queued' OR
                    (status = 'processing' AND updated_at < now() - (%s * interval '1 second'))
                ORDER BY CASE WHEN status = 'queued' THEN 0 ELSE 1 END, created_at
                LIMIT 10 FOR UPDATE SKIP LOCKED
            """, (self.stale_seconds,)).fetchall()
            for job in jobs:
                manual_id = canonical_id(job["id"])
                locked = connection.execute("SELECT pg_try_advisory_lock(hashtextextended(%s, 0)) AS locked", (manual_id,)).fetchone()["locked"]
                if not locked:
                    continue
                recovered = job["status"] == "processing"
                connection.execute("""
                    UPDATE manuals SET status='processing', updated_at=now(), error=%s
                    WHERE id=%s
                """, ("INTERRUPTED_IMPORT_RESUMING" if recovered else None, manual_id))
                job["recovered"] = recovered
                return job
        return None

    def check_alive(self, connection: psycopg.Connection, manual_id: str) -> None:
        if self.stop_requested:
            raise ExtractionError("WORKER_STOPPED_RETRYABLE")
        # The row existence/status is checked again under a lock before every page write.
        result = connection.execute("UPDATE manuals SET updated_at=now() WHERE id=%s AND status='processing' RETURNING id", (manual_id,)).fetchone()
        if result is None:
            raise JobDeleted("MANUAL_DELETED_OR_CANCELED")

    def save_page(self, connection: psycopg.Connection, manual_id: str, record: dict[str, Any], total: int) -> None:
        with connection.transaction():
            row = connection.execute("SELECT id FROM manuals WHERE id=%s AND status='processing' FOR UPDATE", (manual_id,)).fetchone()
            if row is None:
                raise JobDeleted("MANUAL_DELETED_OR_CANCELED")
            directory = manual_directory(self.data_dir, manual_id)
            if not (directory / "original.pdf").is_file():
                raise ExtractionError("ORIGINAL_PDF_MISSING")
            page_dir = directory / "pages"
            page_dir.mkdir(exist_ok=True)
            if page_dir.is_symlink():
                raise ExtractionError("UNSAFE_PAGE_DIRECTORY")
            record["source"]["manualId"] = manual_id
            atomic_json(page_dir / f"{record['page']:04d}.json", record)
            connection.execute("""
                INSERT INTO manual_pages(manual_id,page,printed_page,section,text,tokens,quality)
                VALUES (%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT (manual_id,page) DO UPDATE SET
                  printed_page=EXCLUDED.printed_page, section=EXCLUDED.section,
                  text=EXCLUDED.text, tokens=EXCLUDED.tokens, quality=EXCLUDED.quality
            """, (manual_id, record["page"], record["printedPage"], record["section"], record["text"], record["tokens"], record["quality"]))
            connection.execute("UPDATE manuals SET page_count=%s,progress=%s,updated_at=now() WHERE id=%s", (total, min(99, int(record["page"] * 100 / total)), manual_id))

    def existing_prefix(self, connection: psycopg.Connection, manual_id: str) -> tuple[list[dict[str, Any]], str | None]:
        """Only complete DB+sidecar prefixes may resume. An uncommitted file is ignored."""
        rows = connection.execute("SELECT page FROM manual_pages WHERE manual_id=%s ORDER BY page", (manual_id,)).fetchall()
        directory = manual_directory(self.data_dir, manual_id) / "pages"
        records: list[dict[str, Any]] = []
        for expected, row in enumerate(rows, 1):
            if row["page"] != expected:
                break
            path = directory / f"{expected:04d}.json"
            try:
                value = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                break
            if value.get("page") != expected or value.get("schemaVersion") != 1 or value.get("source", {}).get("manualId") != manual_id:
                break
            records.append(value)
        return records, records[-1].get("section") if records else None

    def process(self, connection: psycopg.Connection, job: dict[str, Any]) -> ExtractionStats:
        manual_id = canonical_id(job["id"])
        directory = manual_directory(self.data_dir, manual_id)
        original = directory / "original.pdf"
        self.check_alive(connection, manual_id)
        if not original.is_file() or original.is_symlink():
            raise ExtractionError("ORIGINAL_PDF_MISSING")
        if original.stat().st_size != int(job["total_bytes"]):
            raise ExtractionError("ORIGINAL_SIZE_MISMATCH")
        # Verify immutable source before trusting a resume prefix or citations.
        if sha256_file(original).lower() != job["sha256"].lower():
            raise ExtractionError("ORIGINAL_CHECKSUM_MISMATCH")
        prefix, section = self.existing_prefix(connection, manual_id)
        stats = ExtractionStats()
        for record in prefix:
            stats.accept(record)
        for record in extract_document(original, self.config, stats, lambda: self.check_alive(connection, manual_id), len(prefix) + 1, section):
            record["source"]["fileName"] = job["file_name"]
            self.save_page(connection, manual_id, record, stats.page_count)
            if record["page"] % 25 == 0 or record["page"] == stats.page_count:
                LOG.info("manual=%s page=%s/%s", manual_id, record["page"], stats.page_count)
        if not stats.output_chars:
            raise ExtractionError("NO_READABLE_TEXT_IN_DOCUMENT")
        with connection.transaction():
            row = connection.execute("SELECT id FROM manuals WHERE id=%s AND status='processing' FOR UPDATE", (manual_id,)).fetchone()
            if row is None:
                raise JobDeleted("MANUAL_DELETED_OR_CANCELED")
            count = connection.execute("SELECT count(*) AS n FROM manual_pages WHERE manual_id=%s", (manual_id,)).fetchone()["n"]
            if count != stats.page_count or stats.processed_pages != stats.page_count:
                raise ExtractionError("INCOMPLETE_PAGE_PUBLICATION")
            atomic_json(directory / "extraction-stats.json", stats.as_dict())
            connection.execute("UPDATE manuals SET status='ready',progress=100,page_count=%s,error=NULL,updated_at=now() WHERE id=%s", (stats.page_count, manual_id))
        return stats

    def run_once(self) -> bool:
        with self.connect() as connection:
            job = self.claim(connection)
            if job is None:
                return False
            manual_id = canonical_id(job["id"])
            try:
                self.process(connection, job)
                LOG.info("manual=%s status=ready", manual_id)
            except JobDeleted:
                LOG.info("manual=%s canceled/deleted; nothing republished", manual_id)
            except Exception as exc:
                code = str(exc) if isinstance(exc, ExtractionError) else f"WORKER_FAILED:{type(exc).__name__}"
                retry = code == "WORKER_STOPPED_RETRYABLE"
                # Never INSERT/UPSERT manuals: deleted jobs cannot be resurrected.
                connection.execute("UPDATE manuals SET status=%s,error=%s,updated_at=now() WHERE id=%s AND status='processing'", ("queued" if retry else "failed", code[:200], manual_id))
                LOG.error("manual=%s error=%s", manual_id, code)
            finally:
                connection.execute("SELECT pg_advisory_unlock(hashtextextended(%s, 0))", (manual_id,))
        return True

    def run_forever(self, poll_seconds: float = 2) -> None:
        def stop(signum: int, frame: Any) -> None:
            self.stop_requested = True
        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        while not self.stop_requested:
            try:
                worked = self.run_once()
            except psycopg.Error as exc:
                LOG.error("database connection error=%s", type(exc).__name__)
                worked = False
            if not worked:
                time.sleep(poll_seconds)
