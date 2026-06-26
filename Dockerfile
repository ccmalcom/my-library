# MyLibrary API + arq worker image.
#
# One image backs TWO Railway services:
#   - web    -> runs start.sh (alembic upgrade head, then uvicorn on $PORT)
#   - worker -> overrides the start command to: python -m arq mylibrary.worker.WorkerSettings
#
# Python is pinned to 3.12 (not the 3.14 used for local dev) because all the binary
# deps -- psycopg[binary], pandas, numpy -- ship prebuilt wheels for 3.12, so the
# image builds with no compiler and stays slim. Nothing in the codebase needs 3.14.

FROM python:3.12-slim

# Faster, quieter, no .pyc clutter; unbuffered logs so Railway shows them live.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Install deps first so the layer caches unless requirements.txt changes.
COPY requirements.txt ./
RUN pip install -r requirements.txt

# App code (frontend, data, venv, etc. are excluded via .dockerignore).
COPY . .

RUN chmod +x start.sh

# Railway injects $PORT; default to 8000 for `docker run` locally.
ENV PORT=8000
EXPOSE 8000

# Default = web process. The worker service overrides this in Railway.
CMD ["./start.sh"]
