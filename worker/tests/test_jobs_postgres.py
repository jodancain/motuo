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
