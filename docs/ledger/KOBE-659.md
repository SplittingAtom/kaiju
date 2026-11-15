# KOBE-659: SMD5: Chart — optional in-cluster CPU embedding service, registered as a gateway provider

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (local commits on the branch; not pushed)
- **Branch / worktree:** `kobe-659-embed` in `../Kobe-wt659`
- **Depends on:** none. Consumed by KOBE-409 (gateway `/v1/embeddings`, Site setting, selector).

## Plan

1. Chart `embeddings.local` (on by default): Deployment + Service + PVC + NetworkPolicy
   (`templates/embeddings.yaml`, defaults in `_embeddings.tpl`), schema, NOTES.
2. Bifrost egress rule to the service; server env `KOBE_EMBEDDINGS_LOCAL_URL/MODEL`.
3. Server gateway sync adds the chart-managed provider `kobe-local` (no gateway code, no DB row).
4. Licence rows, install doc, guide (memory), licensing note.

## Decisions

- **Server: llama.cpp `llama-server` (MIT), not Ollama.** Same engine Ollama uses, but the CPU
  server image is ~295 MiB compressed (amd64) against Ollama's ~3.2 GiB (bundles CUDA/ROCm
  libraries we can't use; nodes are 16 GiB, no GPU, and node disks are already tight with pinned
  images). One GGUF file is the whole model, so preloading for air-gapped installs is a file copy;
  it runs non-root with a read-only root fs; it serves OpenAI-compatible `/v1/embeddings` and
  `/v1/models` (Bifrost's custom OpenAI provider lists and calls it) and `/health`. HF TEI
  (Apache-2.0) was rejected: no `/v1/models`, so Bifrost could not list the model.
- **Image pin:** `ghcr.io/ggml-org/llama.cpp:server-b12004@sha256:b3289030…` (build of
  2026-10-30, >2 weeks old), multi-arch index digest; schema refuses tag `latest`.
- **Model:** nomic-embed-text v1.5 **f16** GGUF (274 MB, 768 dims), same weights/precision as
  Ollama's `nomic-embed-text`, so a later switch to a LAN Ollama gives comparable vectors. URL
  pinned to HF commit `0188c9bf…`, sha256 checked on every start. Served under alias
  `nomic-embed-text`; `--embeddings --no-webui`, ctx/batch/ubatch 2048, `--threads 2`, `--parallel 1`.
- **Sizing (values):** requests 1 CPU / 1 GiB, limits 2 CPU / 1 GiB; 1 Gi PVC.
- **Model delivery:** init container (same image: has curl + sha256sum) downloads once onto the
  PVC (`model.download: true`), or only verifies a preloaded file (`download: false` +
  `persistence.existingClaim`) and fails with a clear log line otherwise. NetworkPolicy egress:
  DNS + public 443 only while download is on (a pod-level policy can't scope it to the init
  container; HF's CDN has no stable IPs), none at all with download off; `networkPolicy.extraEgress`
  for a private mirror.
- **Ingress:** only Bifrost pods, port 8080 (not the shim, not the server, not sandboxes).
  Bifrost's restricted egress gains a matching rule when the service is on.
- **Registration without gateway code:** Bifrost's config is owned by the server's sync (anything
  else is removed), so the chart can't put a provider in `config.json`. The server reads
  `KOBE_EMBEDDINGS_LOCAL_URL/MODEL` (`models/config.ts`), and the sync appends a keyless
  `openai_compatible` provider id `local` (Bifrost name `kobe-local`, private network allowed)
  to the providers it pushes (`models/local-embedding.ts`). Gateway model:
  `kobe-local/nomic-embed-text` (`localEmbeddingGatewayModel()`). Not a native `ollama`
  provider, which would collide with a Site's own Ollama provider (Bifrost has one per kind).
- **Reserved id:** new Site providers can't take id `local`; an existing row with it wins and the
  sync logs the conflict once.
- **External instead:** `embeddings.local.enabled=false` renders nothing (no Deployment, PVC,
  Service, policy, Bifrost rule or server env) and the sync removes `kobe-local`; external models
  are ordinary Site console providers as today (+ `bifrost.networkPolicy.extraEgress` for LAN).
- **Docs:** `docs/install.md` (Models › Embeddings), `docs/guide/memory.md` (Site memory
  settings; /llms.txt is generated from the guide), `docs/licensing.md`, NOTES.txt.

## Open questions (for Chris or the coordinator)

- **For KOBE-409:** `kobe-local` is not a `model_providers` row, so a catalog alias can't point
  at it (FK) and the existing `embedding_model_alias` Site setting can't name it as-is. 409 should
  either let the setting name a gateway model (with `kobe-local/<model>` offered from
  `config.models.localEmbedding`) or add it to the server-call virtual key directly. No member
  virtual key allows it today, so nothing but 409's path will be able to call it.
- nomic-embed-text expects task prefixes (`search_query: ` / `search_document: `); 409's caller
  should add them (the server does not).
- The llama.cpp image's Ubuntu base carries ffmpeg/curl packages (own licences, not linked);
  noted in the inventory row and licensing.md.

## Evidence (acceptance criteria → test or command output)

- **ac-1** `charts/kobe/tests/embeddings.test.ts`: image pin/no latest, args, non-root + read-only
  root fs, resources from values, init download + sha256, PVC / existingClaim, NetworkPolicy
  (Bifrost-only ingress, download-only egress, none when off, extraEgress), Bifrost egress rule,
  server env accepted by `loadModelsConfig`, disabled leaves nothing behind.
- **ac-2** (after deploy, Chris): from the Bifrost pod
  `wget -qO- --header 'Content-Type: application/json' --post-data '{"model":"nomic-embed-text","input":"hello"}' http://kobe-embeddings:8080/v1/embeddings`
  returns a 768-float vector (same from another pod: times out); server pod:
  `GET $KOBE_BIFROST_URL/api/models?provider=kobe-local` (admin bearer) lists `nomic-embed-text`
  (if empty: `POST /api/providers/kobe-local/refresh-models`). Full `/v1/embeddings` through the
  shim lands with KOBE-409. Steps in docs/install.md › Embeddings.
- **ac-3** `services/server/src/models/local-embedding.test.ts` (external stub provider reaches
  Bifrost and a team's virtual key with the local service off; reserved id), `config.test.ts`,
  `models.db.test.ts` ("registers … kobe-local; removes it when off"); chart test "keeps
  external models configured through the gateway"; documented in docs/install.md.
- **ac-4** inventory rows `llama-cpp`, `nomic-embed-text`, `chartValues.embeddings`;
  `pnpm licenses:update`; guide + install docs updated.
- Commands: see the final section of the commit/report (verify, license:check, test:db).
