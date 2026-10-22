FROM python:3.12-slim

# ffmpeg is required by faster-whisper/ctranslate2 to decode arbitrary audio containers.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

ENV PROCESSOR_DATA_DIR=/data
VOLUME ["/data"]

EXPOSE 8899

# PROCESSOR_API_KEY must be provided at `docker run` time (no default secret is baked in).
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8899"]
