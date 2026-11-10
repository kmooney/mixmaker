#!/usr/bin/env bash
# Runs a local //SCHEMA (catalog-api + media-worker) from ../schema's build,
# against the docker-compose Postgres + MinIO. Nothing in ../schema is modified.
set -euo pipefail
SCHEMA_DIR="${SCHEMA_DIR:-$(cd "$(dirname "$0")/../../schema" && pwd)}"
cd "$SCHEMA_DIR"
docker compose up -d db minio >/dev/null

export SCHEMA_BLOB_BUCKET=schema-media SCHEMA_BLOB_ENDPOINT=http://localhost:9100 \
  SCHEMA_BLOB_PUBLIC_ENDPOINT=http://localhost:9100 SCHEMA_BLOB_REGION=us-east-1 \
  SCHEMA_BLOB_ACCESS_KEY_ID=schema SCHEMA_BLOB_SECRET_ACCESS_KEY=schema-dev-secret

[ -x target/debug/catalog-api ] || cargo build -p catalog-api
[ -x target/debug/schema-media-worker ] || cargo build -p media-worker --features bin --bin schema-media-worker

SCHEMA_DATABASE_URL=postgres://postgres:example@localhost/schema SCHEMA_API_BIND=127.0.0.1:8081 \
  SCHEMA_METRICS_BIND=127.0.0.1:9199 SCHEMA_API_PLAYGROUND=1 RUST_LOG=catalog_api=info \
  ./target/debug/catalog-api &
# The worker makes the AAC encodings mix-maker plays. Several share the queue safely.
for i in 1 2 3; do
  SCHEMA_DATABASE_URL=postgres://schema_worker:worker-dev-secret@localhost/schema \
    SCHEMA_METRICS_BIND=127.0.0.1:919$i RUST_LOG=warn ./target/debug/schema-media-worker &
done
wait
