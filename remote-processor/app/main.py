"""Reference remote transcription processor.

This is a standalone service, independent of the Meetily desktop app, meant to
run on another machine (or a container on AWS/anywhere else) and expose a
small job-based HTTP API: upload audio, poll for a transcript. It is a
*reference* implementation of the "processor" side of a future remote
transcription provider for the desktop app -- the desktop app does not call
this yet (see README.md's "Connecting the desktop app" section for the exact
gap), and no audio ever leaves the user's machine unless that integration is
built and explicitly configured.

Run locally:
    PROCESSOR_API_KEY=dev-secret uvicorn app.main:app --port 8899

See README.md for the Docker workflow and the AWS deployment sketch.
"""
import logging
import shutil
import uuid
from pathlib import Path
from typing import Optional

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Request, UploadFile, status
from pydantic import BaseModel

from . import jobs, worker
from .auth import require_api_key
from .config import DATA_DIR, MAX_UPLOAD_BYTES, WHISPER_DEVICE, WHISPER_MODEL

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("remote-processor")

app = FastAPI(title="Meetily Remote Processor (reference)", version="0.1.0")


@app.on_event("startup")
async def on_startup() -> None:
    jobs.init_db()
    worker.load_model()
    import asyncio
    asyncio.create_task(worker.worker_loop())
    await worker.requeue_incomplete_jobs_on_startup()


class JobResponse(BaseModel):
    job_id: str
    status: str
    language: Optional[str] = None
    model: Optional[str] = None
    transcript: Optional[list] = None
    error: Optional[str] = None
    created_at: str
    updated_at: str


@app.get("/healthz")
async def healthz():
    return {"status": "ok", "model": WHISPER_MODEL, "device": WHISPER_DEVICE}


@app.post("/v1/jobs", response_model=JobResponse, status_code=status.HTTP_202_ACCEPTED, dependencies=[Depends(require_api_key)])
async def create_job(
    request: Request,
    file: UploadFile = File(...),
    language: Optional[str] = Form(None),
    model: Optional[str] = Form(None),
    idempotency_key: Optional[str] = Header(None, alias="Idempotency-Key"),
):
    """Submit an audio file for transcription.

    Pass `Idempotency-Key` (e.g. the meeting id) so retries from the client
    never create a second job for the same recording: if a job already exists
    for that key and hasn't failed, it is returned as-is instead of requeuing
    the audio.
    """
    # Fast-path reject obviously-oversized uploads using the client-supplied
    # Content-Length, before touching disk at all. This is a cheap
    # best-effort guard (a client can omit/lie about the header) -- the
    # authoritative cap is still enforced below as bytes are streamed in.
    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            if int(content_length) > MAX_UPLOAD_BYTES:
                raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Audio file exceeds the configured upload limit")
        except ValueError:
            pass

    if idempotency_key:
        existing = jobs.find_by_idempotency_key(idempotency_key)
        if existing and existing.status != jobs.STATUS_FAILED:
            logger.info("Idempotent replay for key=%s -> job %s (status=%s)", idempotency_key, existing.id, existing.status)
            return existing.to_public_dict()

    job_id = str(uuid.uuid4())
    job_dir = DATA_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    suffix = Path(file.filename or "audio").suffix or ".wav"
    audio_path = job_dir / f"audio{suffix}"

    size = 0
    with audio_path.open("wb") as out:
        while chunk := await file.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_UPLOAD_BYTES:
                out.close()
                shutil.rmtree(job_dir, ignore_errors=True)
                raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Audio file exceeds the configured upload limit")
            out.write(chunk)

    # If a *failed* job previously used this idempotency key, replace it in place
    # (unique constraint on idempotency_key) instead of leaving a dangling duplicate.
    if idempotency_key:
        existing = jobs.find_by_idempotency_key(idempotency_key)
        if existing:
            if existing.audio_path:
                shutil.rmtree(Path(existing.audio_path).parent, ignore_errors=True)
            jobs.delete(existing.id)

    job = jobs.create(idempotency_key=idempotency_key, language=language, model=model, audio_path=str(audio_path))
    await worker.enqueue(job.id)
    logger.info("Created job %s (idempotency_key=%s, %d bytes)", job.id, idempotency_key, size)
    return job.to_public_dict()


@app.get("/v1/jobs/{job_id}", response_model=JobResponse, dependencies=[Depends(require_api_key)])
async def get_job(job_id: str):
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Unknown job_id")
    return job.to_public_dict()


@app.delete("/v1/jobs/{job_id}", status_code=status.HTTP_204_NO_CONTENT, dependencies=[Depends(require_api_key)])
async def delete_job(job_id: str):
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Unknown job_id")
    if job.audio_path:
        shutil.rmtree(Path(job.audio_path).parent, ignore_errors=True)
    jobs.delete(job_id)
