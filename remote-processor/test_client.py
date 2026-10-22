"""End-to-end smoke test for the reference remote processor.

Generates a short SYNTHETIC audio file (a sine-wave tone, not a real
recording -- per the project's rule against recording real conversations for
tests) and pushes it through the full submit -> poll -> result cycle.

Usage:
    PROCESSOR_API_KEY=dev-secret python test_client.py [base_url]
"""
import math
import os
import struct
import sys
import time
import urllib.error
import urllib.request
import uuid
import wave
from pathlib import Path

BASE_URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8899"
API_KEY = os.environ.get("PROCESSOR_API_KEY", "dev-secret")


def make_synthetic_wav(path: Path, seconds: float = 2.0, freq_hz: float = 440.0, rate: int = 16000) -> None:
    n_samples = int(seconds * rate)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        frames = bytearray()
        for i in range(n_samples):
            value = int(3000 * math.sin(2 * math.pi * freq_hz * (i / rate)))
            frames += struct.pack("<h", value)
        wf.writeframes(bytes(frames))


def request(method: str, path: str, data: bytes | None = None, headers: dict | None = None) -> tuple[int, bytes]:
    req = urllib.request.Request(f"{BASE_URL}{path}", data=data, method=method)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def main() -> int:
    tmp_dir = Path(os.environ.get("TEMP", "/tmp"))
    wav_path = tmp_dir / f"meetily_test_tone_{uuid.uuid4().hex}.wav"
    print(f"Generating synthetic test tone at {wav_path} ...")
    make_synthetic_wav(wav_path)

    boundary = uuid.uuid4().hex
    body = bytearray()
    body += f"--{boundary}\r\n".encode()
    body += b'Content-Disposition: form-data; name="file"; filename="tone.wav"\r\n'
    body += b"Content-Type: audio/wav\r\n\r\n"
    body += wav_path.read_bytes()
    body += f"\r\n--{boundary}\r\n".encode()
    body += b'Content-Disposition: form-data; name="language"\r\n\r\nen\r\n'
    body += f"--{boundary}--\r\n".encode()

    idem_key = f"smoke-test-{uuid.uuid4().hex[:8]}"
    print(f"Submitting job (Idempotency-Key={idem_key}) ...")
    status, resp = request(
        "POST",
        "/v1/jobs",
        data=bytes(body),
        headers={
            "Authorization": f"Bearer {API_KEY}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Idempotency-Key": idem_key,
        },
    )
    print(status, resp[:300])
    if status not in (200, 202):
        print("FAILED to submit job")
        return 1

    import json
    job = json.loads(resp)
    job_id = job["job_id"]

    print(f"Polling job {job_id} ...")
    for _ in range(60):
        status, resp = request("GET", f"/v1/jobs/{job_id}", headers={"Authorization": f"Bearer {API_KEY}"})
        job = json.loads(resp)
        print(f"  status={job['status']}")
        if job["status"] in ("completed", "failed"):
            break
        time.sleep(2)

    wav_path.unlink(missing_ok=True)

    if job["status"] != "completed":
        print(f"FAILED: job ended in status={job['status']} error={job.get('error')}")
        return 1

    print("OK - job completed. Transcript segments:", job.get("transcript"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
