# KOBE-699: Chart: CNPG Postgres admits only pods that need the database; ClamAV egress (SEC-10)

- **Status:** in review (group 50, branch `group-50-sec-platform`)
- **Branch / worktree:** `group-50-sec-platform` in `../Kobe-g50`
- **Depends on:** KOBE-691 (same branch; ClamAV digest)

## Plan

Replace the `podSelector: {}` ingress of the CloudNativePG policy with the DB-using components,
the migrate Job and the instances; add a ClamAV egress policy.

## Decisions

- Admitted on 5432: pods of this release (`name: kobe`, `instance: <release>`) whose component is
  server, scheduler, egress-proxy, model-gateway (the pods that include `kobe.databaseEnv`) or
  migrate. Instances (`cnpg.io/cluster: <release>-pg`) and the operator namespace keep all ports
  (replication, instance manager status on 8000).
- The migrate Job's pod template gains `app.kubernetes.io/instance` so the selector names this
  release only. Hook Jobs are recreated each upgrade, so the template change is safe.
- A chart test derives the DB users from the rendered env (`KOBE_DATABASE_URL`,
  `KOBE_DB_MIGRATE_URL`) and checks the selector admits exactly those pods, so a new DB-using
  component fails the test until it is added.
- ClamAV egress: DNS plus public addresses (private ranges excluded, as elsewhere) on 443 and 80;
  freshclam always runs (the chart has no switch to turn it off), so there is no "none" variant.
  `clamav.networkPolicy.extraEgress` for a private mirror (values, schema, test).
- External Postgres: unchanged (no policy is rendered for it).
- Operators reach Postgres through `kubectl port-forward`, which NetworkPolicy does not filter;
  stated in docs/install.md.
- Docs: docs/install.md (bundled Postgres paragraph, ClamAV paragraph, upgrade note). No
  member/agent-visible change, so no docs/guide page.

## Open questions (for Chris or the coordinator)

- none

## Evidence (acceptance criteria → test or command output)

- ac-1: `charts/kobe/tests/render.test.ts` "lets only the database users…" and "admits exactly the
  pods that hold database credentials…".
- ac-2: same file, "gives ClamAV egress to DNS and public addresses only".
- ac-3: k3d e2e (fresh install, upgrade, backup/restore shards) runs in CI after the push; the e2e
  installs use external Postgres, so the CNPG policy is covered by the chart tests only.
