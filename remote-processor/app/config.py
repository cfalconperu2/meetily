import os
from pathlib import Path

# Single shared-secret bearer token. There is no default: the service refuses to
# start without one, so a forgotten env var can never fall back to an open API.
API_KEY = os.environ.get("PROCESSOR_API_KEY")

DATA_DIR = Path(os.environ.get("PROCESSOR_DATA_DIR", "./data")).resolve()
DB_PATH = DATA_DIR / "jobs.db"

WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "small")
WHISPER_DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")  # "cpu" or "cuda"
WHISPER_COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")

MAX_UPLOAD_BYTES = int(os.environ.get("PROCESSOR_MAX_UPLOAD_MB", "500")) * 1024 * 1024
