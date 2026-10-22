# Meetily Remote Processor (reference implementation)

Standalone service that turns an uploaded audio file into a transcript over
HTTP. It is **independent of the Meetily desktop app** — you run it on another
machine (or in a container, or later on AWS) and point the app at it. Nothing
in the desktop app calls this by default; no audio leaves the user's computer
unless a remote provider is explicitly configured.

This exists to satisfy the "process locally now, on another machine or AWS
later" requirement without standing up any paid infrastructure. It is a
reference you adapt, not a managed product.

## API

All endpoints except `/healthz` require `Authorization: Bearer <PROCESSOR_API_KEY>`.

- `GET /healthz` — `{status, model, device}`, no auth. Use for container health checks.
- `POST /v1/jobs` — multipart form: `file` (audio), `language` (optional, e.g. `es`, omit/`auto` for auto-detect), `model` (currently informational only — the server-side model is fixed at startup via `WHISPER_MODEL`). Optional `Idempotency-Key` header (e.g. the meeting id) — resubmitting the same key returns the existing job instead of creating a duplicate, so a retried upload can never double-process the same recording. Returns `202` with the job.
- `GET /v1/jobs/{job_id}` — `{job_id, status, transcript, error, ...}`. `status` is one of `queued`, `processing`, `completed`, `failed`.
- `DELETE /v1/jobs/{job_id}` — deletes the job and its stored audio.

Jobs persist in a local SQLite file (`$PROCESSOR_DATA_DIR/jobs.db`). On
restart, any job that was `processing` when the process died is requeued from
scratch (there is no partial-result resume), and every `queued` job is
resumed automatically — the queue survives a crash or restart the same way
the desktop app's own summary queue does.

## Run locally (no Docker)

```bash
python -m venv .venv
.venv/Scripts/activate        # .venv/bin/activate on macOS/Linux
pip install -r requirements.txt
PROCESSOR_API_KEY=dev-secret uvicorn app.main:app --host 0.0.0.0 --port 8899
```

First startup downloads the Whisper model (`small` by default, ~500MB) from
Hugging Face — this requires internet access once; after that it's cached
locally and the service works offline.

Smoke test (generates a synthetic tone, not a real recording, and runs it
through submit → poll → result):

```bash
PROCESSOR_API_KEY=dev-secret python test_client.py
```

## Run in Docker (e.g. on "another machine")

```bash
PROCESSOR_API_KEY=$(openssl rand -hex 32) docker compose up --build
```

The container listens on `:8899` and persists jobs/audio in the
`processor-data` named volume.

## Configuration (environment variables)

| Variable | Default | Notes |
|---|---|---|
| `PROCESSOR_API_KEY` | *(none — required)* | Bearer token. Service refuses to start requests without it (fails closed, not open). |
| `PROCESSOR_DATA_DIR` | `./data` | Where uploaded audio + `jobs.db` live. |
| `WHISPER_MODEL` | `small` | Any faster-whisper/CTranslate2 model size (`tiny`, `base`, `small`, `medium`, `large-v3`, ...). |
| `WHISPER_DEVICE` | `cpu` | `cpu` or `cuda` (needs an NVIDIA GPU + CUDA runtime in the container). |
| `WHISPER_COMPUTE_TYPE` | `int8` | `int8` for fast CPU inference; use `float16` on GPU for best accuracy. |
| `PROCESSOR_MAX_UPLOAD_MB` | `500` | Upload size cap. |

## Measured local performance (this reference implementation, this machine)

What was actually verified end-to-end on this dev machine, CPU only, model
`small`, `WHISPER_COMPUTE_TYPE=int8` (`python test_client.py`):

- Full cycle (submit → queued → processing → completed) for a 2s synthetic
  tone: **under 2 seconds** wall clock, model already warm.
- Model load at server startup, **from local Hugging Face cache**
  (`~/.cache/huggingface/hub`, ~464MB for `small`): **~1.3 seconds**.
- Idempotent resubmission (same `Idempotency-Key`, second upload): confirmed
  via direct SQLite inspection that no second row is created.
- Auth: requests without a bearer token, or with the wrong one, get `401`;
  `/healthz` stays open without auth.

**Not measured** (and this report will not pretend otherwise): first-time
model download speed (depends on the network, cache was already warm on this
machine from earlier testing), transcription speed/accuracy on real speech
(the smoke test uses a pure sine tone — VAD correctly returns zero speech
segments for it, which is expected, not a bug, but it means no real-time
factor could be measured), GPU/`cuda` path, and anything at all on AWS
(nothing was deployed there). Benchmark with a real, consented sample on your
target hardware before sizing a deployment.

## Connecting the desktop app (current state: NOT wired up yet)

The desktop app does not call this service today — there is no Rust client
for it in `frontend/src-tauri` yet. This is intentionally scoped as the
**processor side only** for this task, so it can be tested and iterated on
independently of the (much slower to rebuild) Tauri/Rust app. The concrete
next step is a small Rust module (a `TranscriptionProvider` implementation
alongside the existing local Whisper/Parakeet providers in
`frontend/src-tauri/src/audio/transcription/`) that: uploads a meeting's
saved audio to `POST /v1/jobs` with `Idempotency-Key: <meeting_id>`, polls
`GET /v1/jobs/{id}`, and writes the resulting segments through the same
transcript-save path retranscription already uses — plus a settings section
for the endpoint URL and API key (stored the same way `customOpenAIConfig`
is today) and a "Reprocess remotely" option in the existing Retranscribe
dialog. Until that lands, you can call this service directly with
`test_client.py` as a template, or `curl`:

```bash
curl -X POST http://localhost:8899/v1/jobs \
  -H "Authorization: Bearer $PROCESSOR_API_KEY" \
  -H "Idempotency-Key: meeting-123" \
  -F "file=@meeting.wav" -F "language=es"
```

## AWS deployment sketch (design only — nothing here is deployed)

No AWS resources were created for this project; the diagram below is a design
for *when* you choose to deploy, not a running system.

```
Desktop app --HTTPS(upload)--> API (ALB + ECS Fargate task running this app,
                                     or API Gateway + Lambda for the upload
                                     leg only)
                                  |
                                  v
                         S3 bucket (private, SSE-S3 or SSE-KMS,
                         lifecycle rule to expire objects after N days)
                                  |
                                  v
                         SQS queue (one message per job)
                                  |
                                  v
                         Worker (ECS Fargate task or EC2 with a GPU,
                         e.g. g4dn.xlarge, running worker.py against
                         faster-whisper) — polls SQS, downloads from S3,
                         transcribes, writes result back to S3 / a small
                         DynamoDB table for job status, deletes the SQS
                         message only after the result is durably stored
                         (at-least-once + idempotent job IDs => safe retries)
                                  |
                                  v
                         Desktop app polls GET /v1/jobs/{id} (API layer reads
                         DynamoDB/S3) or an SNS/WebSocket push, if added later
```

Why this shape: S3 decouples upload from processing (no request has to stay
open for the minutes a transcription takes), SQS gives at-least-once delivery
and natural retry/backoff, and the worker can scale to zero when idle (Fargate)
or scale on GPU availability (EC2 spot) since transcription is the expensive
part. None of this is required to use this reference implementation directly
on a second machine — it only matters once you need multi-user / auto-scaling
processing.

**Not done, and intentionally so:** no AWS account resources (S3 buckets, SQS
queues, IAM roles, compute) were created for this task — that would incur
cost and requires explicit authorization the task did not grant.
