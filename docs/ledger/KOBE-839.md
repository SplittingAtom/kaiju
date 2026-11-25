# KOBE-839: CI e2e: chart installs time out while the embeddings init container downloads the model

- **Status:** in review
- **Branch / worktree:** `group-141-ci-embeddings-cache` in `../Kobe-g141`
- **Depends on:** none

## Plan

Fetch the GGUF once per run into the GitHub Actions cache (key: its sha256), serve it from each
shard's runner, and point the e2e installs' `embeddings.local.model.url` at it. The chart, its
defaults and its sha256 check are unchanged.

## Decisions

- **Serve from the runner, not preload onto the node.** One `python3 -m http.server` per shard,
  started before the cluster, bound to all addresses (the restore shard deletes and recreates the
  k3d network, so a socket bound to its gateway would die with it). The runner is thrown away
  after the job. Preloading would need a hostPath or a pre-filled PVC, which the chart does not
  offer cleanly; the URL override uses existing values keys only.
- **Address:** the IPv4 gateway of Docker network `k3d-<cluster>`, looked up at every install
  (`e2e/lib/embeddings-model.sh`), plus an `embeddings.local.networkPolicy.extraEgress` rule for
  that /32 and port (the chart's download rule allows public 443 only). The helper checks the
  server answers on that address before the install.
- **Cache job:** `model` in `e2e.yml` (parallel with the image builds) fills the cache; shards use
  `actions/cache/restore` only and download themselves (retries, sha256) only if the entry is gone.
  The pin is read from `charts/kaiju/values.yaml`, so a new model needs no workflow change.
- **Degrades, never blocks:** a runner that cannot serve (no python3, e.g. a minimal self-hosted
  image) leaves `KAIJU_E2E_MODEL_PORT` unset and the chart downloads from the public URL, as before.
- **Shards covered:** every shard installs through `e2e/run/10-deploy.sh` (suite, cold-start,
  executor, and the `gate1-prep` install of gate1-5, gate7, gate-apps, gate-sso) or
  `e2e/gate4-restore.sh` (restore, both clusters). Later upgrades keep the URL (`--reuse-values`, or
  the `helm get values` file the gate scripts restore). There is no upgrade-from-base shard in
  `e2e.yml` today.
- **Docs:** `docs/development.md` (Tests) and the workflow's comments. No user-facing guide change:
  CI only; installs and their values are unchanged.

## Open questions (for Chris or the coordinator)

- none

## Evidence (acceptance criteria → test or command output)

- **ac-1:** shards install with `embeddings.local.model.url=http://<k3d gateway>:18089/model.gguf`;
  `helm template` with those overrides renders `MODEL_URL` and the extra egress rule; the init
  container script (sha256 check) is untouched. `scripts/ci-embeddings-model.sh` tested locally:
  `pin` reads the values, `serve` answers, `verify` fails on a wrong file.
- **ac-2:** needs three CI runs of the PR (not runnable here).
- **ac-3:** `docs/development.md` and `e2e.yml` header/step comments.
- `actionlint` (with shellcheck) clean on `e2e.yml`; `shellcheck -x` clean on the new scripts and
  no new findings in `e2e/run.sh` / `e2e/gate4-restore.sh`.
