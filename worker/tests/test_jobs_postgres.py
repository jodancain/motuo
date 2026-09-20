"""Real PG behavior; set TEST_DATABASE_URL to an isolated test database.

Each test creates a random schema and drops only that schema afterwards. Never
uses the production schema or imports the user's manual during lifecycle tests.
"""
import os
import uuid
from pathlib import Path

import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo
import pytest
from reportlab.pdfgen import canvas

from motuo_worker.extraction import ExtractionConfig, ExtractionStats, extract_document, sha256_file
from motuo_worker.jobs import JobDeleted, Worker


@pytest.fixture
def worker(tmp_path):
    dsn = os.environ.get("TEST_DATABASE_URL")
    if not dsn:
        pytest.skip("TEST_DATABASE_URL not configured; PostgreSQL behavior not claimed")
    schema = "motuo_worker_test_" + uuid.uuid4().hex
    with psycopg.connect(dsn, autocommit=True) as admin:
        admin.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
        test_dsn = make_conninfo(dsn, options=f"-c search_path={schema}")
        with psycopg.connect(test_dsn, autocommit=True) as conn:
            conn.execute("""CREATE TABLE manuals(id uuid PRIMARY KEY,owner_id uuid NOT NULL,vehicle_id uuid,
                file_name text,total_bytes bigint,sha256 text,status text,progress integer DEFAULT 0,
                page_count integer DEFAULT 0,error text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
                CREATE TABLE manual_pages(manual_id uuid REFERENCES manuals ON DELETE CASCADE,page integer,
                printed_page text,section text,text text,tokens text,quality text,PRIMARY KEY(manual_id,page));""")
        try:
            yield Worker(test_dsn, tmp_path, ExtractionConfig(ocr_enabled=False), stale_seconds=0)
        finally:
            admin.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(schema)))


def add_job(worker, pages=2):
    manual_id = str(uuid.uuid4())
    directory = worker.data_dir / "manuals" / manual_id
    directory.mkdir(parents=True)
    path = directory / "original.pdf"
    c = canvas.Canvas(str(path))
    for number in range(1, pages + 1):
        c.drawString(40, 700, f"Manual page {number}: Service interval is 10000 km. Battery voltage 11 V.")
        c.showPage()
    c.save()
    with worker.connect() as conn:
        conn.execute("INSERT INTO manuals(id,owner_id,file_name,total_bytes,sha256,status) VALUES(%s,%s,%s,%s,%s,'queued')", (manual_id, str(uuid.uuid4()), "test.pdf", path.stat().st_size, sha256_file(path)))
    return manual_id, path


def test_two_workers_never_claim_same_active_job(worker):
    identifier, _ = add_job(worker)
    with worker.connect() as first, worker.connect() as second:
        assert str(worker.claim(first)["id"]) == identifier
        # Stale threshold zero deliberately tries to reclaim an active job.
        assert worker.claim(second) is None


def test_skip_locked_moves_to_the_next_job(worker):
    first_id, _ = add_job(worker)
    second_id, _ = add_job(worker)
    with worker.connect() as first, worker.connect() as second:
        with first.transaction():
            first.execute("SELECT id FROM manuals WHERE id=%s FOR UPDATE", (first_id,))
            assert str(worker.claim(second)["id"]) == second_id


def test_deleted_job_cannot_reappear_or_recreate_directory(worker):
    import shutil
    identifier, original = add_job(worker)
    with worker.connect() as conn:
        worker.claim(conn)
        record = next(extract_document(original, worker.config))
        conn.execute("DELETE FROM manuals WHERE id=%s", (identifier,))
        shutil.rmtree(original.parent)
        with pytest.raises(JobDeleted):
            worker.save_page(conn, identifier, record, 2)
        assert not original.parent.exists()
        assert conn.execute("SELECT count(*) AS n FROM manual_pages").fetchone()["n"] == 0


def test_interrupted_job_resumes_from_committed_page(worker):
    identifier, original = add_job(worker, 3)
    with worker.connect() as first:
        worker.claim(first)
        record = next(extract_document(original, worker.config))
        worker.save_page(first, identifier, record, 3)
    # Simulated process death: closing its connection releases advisory lock.
    with worker.connect() as second:
        job = worker.claim(second)
        assert job["recovered"]
        records, _ = worker.existing_prefix(second, identifier)
        assert len(records) == 1
        stats = worker.process(second, job)
        assert stats.processed_pages == 3
        row = second.execute("SELECT status,progress,page_count FROM manuals WHERE id=%s", (identifier,)).fetchone()
        assert row == {"status": "ready", "progress": 100, "page_count": 3}
        assert second.execute("SELECT count(*) AS n FROM manual_pages").fetchone()["n"] == 3


def test_checksum_failure_publishes_failed_without_pages(worker):
    identifier, original = add_job(worker)
    with original.open("ab") as f:
        f.write(b"mutation")
    assert worker.run_once()
    with worker.connect() as conn:
        row = conn.execute("SELECT status,error FROM manuals WHERE id=%s", (identifier,)).fetchone()
        assert row == {"status": "failed", "error": "ORIGINAL_SIZE_MISMATCH"}
        assert conn.execute("SELECT count(*) AS n FROM manual_pages").fetchone()["n"] == 0


def failed_import(worker):
    """One truly committed page followed by the same failure state as a parser crash."""
    identifier, original = add_job(worker, 3)
    with worker.connect() as conn:
        job = worker.claim(conn)
        record = next(extract_document(original, worker.config))
        record["source"]["fileName"] = job["file_name"]
        worker.save_page(conn, identifier, record, 3)
        conn.execute("UPDATE manuals SET status='failed',error='PDF_EXTRACTION_FAILED:PdfminerException' WHERE id=%s", (identifier,))
    return identifier, original, str(job["owner_id"]), job["sha256"], job["total_bytes"]


def test_retry_dry_run_then_apply_preserves_pages_and_resumes(worker):
    from motuo_worker.retry import retry_failed
    identifier, original, owner, checksum, size = failed_import(worker)
    sidecar = original.parent / "pages" / "0001.json"
    original_bytes, page_bytes = original.read_bytes(), sidecar.read_bytes()
    with worker.connect() as conn:
        before = conn.execute("SELECT * FROM manuals WHERE id=%s", (identifier,)).fetchone()
    result = retry_failed(worker, identifier, owner, checksum, size)
    assert result["dryRun"] and not result["changed"] and result["status"] == "failed"
    assert result["prefixPages"] == 1 and result["action"] == "would_queue"
    with worker.connect() as conn:
        assert conn.execute("SELECT * FROM manuals WHERE id=%s", (identifier,)).fetchone() == before
    applied = retry_failed(worker, identifier, owner, checksum, size, apply=True)
    assert applied["changed"] and applied["status"] == "queued"
    repeated = retry_failed(worker, identifier, owner, checksum, size, apply=True)
    assert not repeated["changed"] and repeated["status"] == "queued"
    assert worker.run_once()
    final = retry_failed(worker, identifier, owner, checksum, size, apply=True)
    assert final["status"] == "ready" and not final["changed"]
    assert original.read_bytes() == original_bytes and sidecar.read_bytes() == page_bytes
    with worker.connect() as conn:
        assert conn.execute("SELECT count(*) AS n FROM manual_pages WHERE manual_id=%s", (identifier,)).fetchone()["n"] == 3


@pytest.mark.parametrize("case,code", [
    ("owner", "MANUAL_NOT_FOUND_FOR_OWNER"), ("checksum", "EXPECTED_SOURCE_MISMATCH"),
    ("size", "EXPECTED_SOURCE_MISMATCH"), ("uuid", "INVALID_ID"),
    ("source_bytes", "ORIGINAL_CHECKSUM_MISMATCH"), ("source_size", "ORIGINAL_SIZE_MISMATCH"),
    ("gap", "NONCONTIGUOUS_PAGE_PREFIX"), ("missing_sidecar", "PAGE_SIDECAR_MISSING_OR_UNSAFE"),
    ("symlink", "PAGE_SIDECAR_MISSING_OR_UNSAFE"), ("source_page", "PAGE_SOURCE_MISMATCH"),
    ("page_text", "PAGE_DATABASE_SIDECAR_MISMATCH"), ("stats", "INVALID_PAGE_SIDECAR"),
])
def test_retry_rejects_wrong_identity_or_corrupt_evidence_without_changing_data(worker, case, code):
    import json
    from motuo_worker.retry import RetryRejected, retry_failed
    identifier, original, owner, checksum, size = failed_import(worker)
    sidecar = original.parent / "pages" / "0001.json"
    if case == "owner":
        owner = str(uuid.uuid4())
    elif case == "checksum":
        checksum = "0" * 64
    elif case == "size":
        size += 1
    elif case == "uuid":
        identifier = "../../manuals"
    elif case == "source_bytes":
        data = original.read_bytes()
        original.write_bytes(data[:-1] + bytes([data[-1] ^ 1]))
    elif case == "source_size":
        original.write_bytes(original.read_bytes() + b"extra")
    elif case == "gap":
        with worker.connect() as conn:
            conn.execute("UPDATE manual_pages SET page=2 WHERE manual_id=%s", (identifier,))
    elif case == "missing_sidecar":
        sidecar.unlink()
    elif case == "symlink":
        target = sidecar.with_suffix(".backup")
        sidecar.rename(target)
        sidecar.symlink_to(target)
    else:
        record = json.loads(sidecar.read_text())
        if case == "source_page":
            record["source"]["physicalPage"] = 2
        elif case == "page_text":
            record["text"] = "Tampered torque 1000 Nm"
        else:
            record.pop("nativeCharCount")
        sidecar.write_text(json.dumps(record))
    with worker.connect() as conn:
        before = conn.execute("SELECT * FROM manuals").fetchone()
        pages_before = conn.execute("SELECT * FROM manual_pages").fetchall()
    with pytest.raises(RetryRejected, match=f"^{code}$"):
        retry_failed(worker, identifier, owner, checksum, size, apply=True)
    with worker.connect() as conn:
        assert conn.execute("SELECT * FROM manuals").fetchone() == before
        assert conn.execute("SELECT * FROM manual_pages").fetchall() == pages_before


def test_retry_respects_active_advisory_lock_and_processing_is_idempotent(worker):
    from motuo_worker.retry import RetryRejected, retry_failed
    identifier, _, owner, checksum, size = failed_import(worker)
    with worker.connect() as active:
        active.execute("SELECT pg_advisory_lock(hashtextextended(%s, 0))", (identifier,))
        with pytest.raises(RetryRejected, match="^MANUAL_BUSY$"):
            retry_failed(worker, identifier, owner, checksum, size, apply=True)
        active.execute("UPDATE manuals SET status='processing' WHERE id=%s", (identifier,))
        before = active.execute("SELECT * FROM manuals WHERE id=%s", (identifier,)).fetchone()
        readback = retry_failed(worker, identifier, owner, checksum, size, apply=True)
        assert readback["status"] == "processing" and not readback["changed"]
        assert readback["validation"] == "metadata_only"
        assert active.execute("SELECT * FROM manuals WHERE id=%s", (identifier,)).fetchone() == before


def test_retry_respects_delete_row_lock_and_cannot_resurrect_deleted_manual(worker):
    import shutil
    from motuo_worker.retry import RetryRejected, retry_failed
    identifier, original, owner, checksum, size = failed_import(worker)
    with worker.connect() as deleting:
        with deleting.transaction():
            deleting.execute("DELETE FROM manuals WHERE id=%s", (identifier,))
            with pytest.raises(RetryRejected, match="^MANUAL_BUSY$"):
                retry_failed(worker, identifier, owner, checksum, size, apply=True)
    shutil.rmtree(original.parent)
    with pytest.raises(RetryRejected, match="^MANUAL_NOT_FOUND_FOR_OWNER$"):
        retry_failed(worker, identifier, owner, checksum, size, apply=True)
    assert not worker.run_once() and not original.parent.exists()


def test_retry_holds_row_lock_during_checksum_and_releases_all_locks(worker, monkeypatch):
    import motuo_worker.retry as retry_module
    identifier, _, owner, checksum, size = failed_import(worker)
    actual_hash = retry_module.sha256_file
    def verify_locked(path):
        with worker.connect() as deleting:
            with pytest.raises(psycopg.errors.LockNotAvailable), deleting.transaction():
                deleting.execute("SELECT id FROM manuals WHERE id=%s FOR UPDATE NOWAIT", (identifier,))
        return actual_hash(path)
    monkeypatch.setattr(retry_module, "sha256_file", verify_locked)
    retry_module.retry_failed(worker, identifier, owner, checksum, size)
    with worker.connect() as independent:
        assert independent.execute("SELECT pg_try_advisory_lock(hashtextextended(%s, 0)) AS locked", (identifier,)).fetchone()["locked"]
        with independent.transaction():
            assert independent.execute("SELECT id FROM manuals WHERE id=%s FOR UPDATE NOWAIT", (identifier,)).fetchone()


def test_retry_cli_defaults_to_dry_run_and_never_prints_document(worker, monkeypatch, capsys):
    import json
    import sys
    from motuo_worker.retry import main
    identifier, _, owner, checksum, size = failed_import(worker)
    monkeypatch.setenv("DATABASE_URL", worker.dsn)
    monkeypatch.setenv("DATA_DIR", str(worker.data_dir))
    monkeypatch.setattr(sys, "argv", ["retry", "--manual-id", identifier, "--owner-id", owner,
                                     "--expected-sha256", checksum, "--expected-bytes", str(size)])
    assert main() == 0
    output = capsys.readouterr().out
    assert "Service interval" not in output and worker.dsn not in output
    assert json.loads(output)["action"] == "would_queue"
    with worker.connect() as conn:
        assert conn.execute("SELECT status FROM manuals WHERE id=%s", (identifier,)).fetchone()["status"] == "failed"
