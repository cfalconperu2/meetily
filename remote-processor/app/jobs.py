"""SQLite-backed job store.

Jobs persist to disk so the service can recover its queue across restarts,
mirroring the same "the queue must survive a restart" requirement as the
desktop app's own summary pipeline. Status transitions are guarded with
compare-and-set UPDATEs (`WHERE status = ...`) so a crashed/duplicate worker
can never double-apply a terminal transition.
"""
import json
import sqlite3
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from .config import DB_PATH

STATUS_QUEUED = "queued"
STATUS_PROCESSING = "processing"
STATUS_COMPLETED = "completed"
STATUS_FAILED = "failed"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@contextmanager
def _connect():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    with _connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY,
                idempotency_key TEXT UNIQUE,
                status TEXT NOT NULL,
                language TEXT,
                model TEXT,
                audio_path TEXT,
                transcript_json TEXT,
                error TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )


@dataclass
class Job:
    id: str
    idempotency_key: Optional[str]
    status: str
    language: Optional[str]
    model: Optional[str]
    audio_path: Optional[str]
    transcript: Optional[list] = None
    error: Optional[str] = None
    created_at: str = field(default_factory=_now)
    updated_at: str = field(default_factory=_now)

    def to_public_dict(self) -> dict:
        return {
            "job_id": self.id,
            "status": self.status,
            "language": self.language,
            "model": self.model,
            "transcript": self.transcript,
            "error": self.error,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


def _row_to_job(row: sqlite3.Row) -> Job:
    return Job(
        id=row["id"],
        idempotency_key=row["idempotency_key"],
        status=row["status"],
        language=row["language"],
        model=row["model"],
        audio_path=row["audio_path"],
        transcript=json.loads(row["transcript_json"]) if row["transcript_json"] else None,
        error=row["error"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def find_by_idempotency_key(key: str) -> Optional[Job]:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM jobs WHERE idempotency_key = ?", (key,)).fetchone()
        return _row_to_job(row) if row else None


def get(job_id: str) -> Optional[Job]:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        return _row_to_job(row) if row else None


def list_by_status(status: str) -> list[Job]:
    with _connect() as conn:
        rows = conn.execute("SELECT * FROM jobs WHERE status = ? ORDER BY created_at ASC", (status,)).fetchall()
        return [_row_to_job(r) for r in rows]


def create(idempotency_key: Optional[str], language: Optional[str], model: Optional[str], audio_path: str) -> Job:
    job = Job(
        id=str(uuid.uuid4()),
        idempotency_key=idempotency_key,
        status=STATUS_QUEUED,
        language=language,
        model=model,
        audio_path=audio_path,
    )
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO jobs (id, idempotency_key, status, language, model, audio_path, transcript_json, error, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
            """,
            (job.id, job.idempotency_key, job.status, job.language, job.model, job.audio_path, job.created_at, job.updated_at),
        )
    return job


def mark_processing(job_id: str) -> bool:
    with _connect() as conn:
        cur = conn.execute(
            "UPDATE jobs SET status = ?, updated_at = ? WHERE id = ? AND status = ?",
            (STATUS_PROCESSING, _now(), job_id, STATUS_QUEUED),
        )
        return cur.rowcount == 1


def requeue_orphaned_processing_jobs() -> int:
    """Called on startup: a job stuck in 'processing' means the worker that owned
    it died (process restart/crash). There is no partial result to preserve, so
    it goes back to 'queued' to run from scratch — never silently dropped."""
    with _connect() as conn:
        cur = conn.execute(
            "UPDATE jobs SET status = ?, updated_at = ? WHERE status = ?",
            (STATUS_QUEUED, _now(), STATUS_PROCESSING),
        )
        return cur.rowcount


def mark_completed(job_id: str, transcript: list) -> bool:
    with _connect() as conn:
        cur = conn.execute(
            "UPDATE jobs SET status = ?, transcript_json = ?, error = NULL, updated_at = ? WHERE id = ? AND status = ?",
            (STATUS_COMPLETED, json.dumps(transcript), _now(), job_id, STATUS_PROCESSING),
        )
        return cur.rowcount == 1


def mark_failed(job_id: str, error: str) -> bool:
    with _connect() as conn:
        cur = conn.execute(
            "UPDATE jobs SET status = ?, error = ?, updated_at = ? WHERE id = ? AND status IN (?, ?)",
            (STATUS_FAILED, error, _now(), job_id, STATUS_PROCESSING, STATUS_QUEUED),
        )
        return cur.rowcount == 1


def delete(job_id: str) -> bool:
    with _connect() as conn:
        cur = conn.execute("DELETE FROM jobs WHERE id = ?", (job_id,))
        return cur.rowcount == 1
