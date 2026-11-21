# Embeddings model download: fail and retry on a stalled connection

- **Found:** 2026-11-21, merge-queue and PR e2e runs (#653, #661): shards `gate-sso`, `gate5-a`,
  `gate5-b` failed with `helm install` "context deadline exceeded" while the `kobe-embeddings`
  pod sat in `Init:0/1` for ten minutes. The `model` init container had started its download and
  never finished.
- **Cause:** `curl --retry` only retries a transfer that fails; a connection that stalls without
  closing never fails, so the init container waited for ever.
- **Change:** `charts/kobe/templates/embeddings.yaml`: connect timeout 20 s; under 1 KiB/s for
  30 s counts as stalled; 8 retries on any error, each resuming the partial file; a partial file
  whose checksum is wrong is removed so the next start does not resume it.
- **Docs:** none needed (no value or behaviour an admin sets changes; the download still verifies
  the pinned sha256).
