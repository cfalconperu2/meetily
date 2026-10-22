"""Single-worker background transcription queue built on faster-whisper.

Kept deliberately simple (one job at a time, in-process asyncio queue) since
this is a reference implementation meant to be read and adapted, not a
production job scheduler. Swapping this for a real queue (SQS, Redis) means
changing `enqueue`/the consumer loop only — `jobs.py`'s status machine and
`main.py`'s HTTP contract stay the same.
"""
import asyncio
import logging
from concurrent.futures import ThreadPoolExecutor

from faster_whisper import WhisperModel

from . import jobs
from .config import WHISPER_MODEL, WHISPER_DEVICE, WHISPER_COMPUTE_TYPE

logger = logging.getLogger("remote-processor.worker")

_queue: "asyncio.Queue[str]" = asyncio.Queue()
_executor = ThreadPoolExecutor(max_workers=1)
_model: WhisperModel | None = None


def load_model() -> None:
    global _model
    logger.info("Loading Whisper model '%s' (device=%s, compute_type=%s)...", WHISPER_MODEL, WHISPER_DEVICE, WHISPER_COMPUTE_TYPE)
    _model = WhisperModel(WHISPER_MODEL, device=WHISPER_DEVICE, compute_type=WHISPER_COMPUTE_TYPE)
    logger.info("Whisper model loaded.")


async def enqueue(job_id: str) -> None:
    await _queue.put(job_id)


def _transcribe_blocking(audio_path: str, language: str | None) -> list[dict]:
    assert _model is not None, "Whisper model not loaded"
    segments, _info = _model.transcribe(
        audio_path,
        language=None if not language or language == "auto" else language,
        vad_filter=True,
    )
    return [
        {"start": round(seg.start, 2), "end": round(seg.end, 2), "text": seg.text.strip()}
        for seg in segments
    ]


async def _process_one(job_id: str) -> None:
    job = jobs.get(job_id)
    if job is None:
        logger.warning("Job %s vanished before processing", job_id)
        return
    if not jobs.mark_processing(job_id):
        # Already picked up (e.g. a duplicate enqueue) — skip, no double work.
        return

    loop = asyncio.get_running_loop()
    try:
        transcript = await loop.run_in_executor(_executor, _transcribe_blocking, job.audio_path, job.language)
        jobs.mark_completed(job_id, transcript)
        logger.info("Job %s completed (%d segments)", job_id, len(transcript))
    except Exception as exc:  # noqa: BLE001 - surfaced to the client via job.error
        logger.exception("Job %s failed", job_id)
        jobs.mark_failed(job_id, str(exc))


async def worker_loop() -> None:
    logger.info("Worker loop started")
    while True:
        job_id = await _queue.get()
        try:
            await _process_one(job_id)
        finally:
            _queue.task_done()


async def requeue_incomplete_jobs_on_startup() -> None:
    """Crash recovery: resume anything left queued/orphaned from a previous run."""
    reset_count = jobs.requeue_orphaned_processing_jobs()
    if reset_count:
        logger.info("Reset %d orphaned 'processing' job(s) back to 'queued' after restart", reset_count)
    pending = jobs.list_by_status(jobs.STATUS_QUEUED)
    for job in pending:
        await enqueue(job.id)
    logger.info("Re-enqueued %d pending job(s) from a previous run", len(pending))
