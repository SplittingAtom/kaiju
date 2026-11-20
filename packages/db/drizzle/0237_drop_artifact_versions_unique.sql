-- kobe:hand-written
-- (db:rebase keeps this SQL and its snapshot and only renumbers it: never regenerate it.)
-- KOBE-735 (review STO-15): artifact_versions had two unique indexes on the version, the primary
-- key (team_id, artifact_id, version) and this constraint on (artifact_id, version); queries
-- always name the team, so the second only cost writes. A constraint, so not DROP INDEX
-- CONCURRENTLY: a brief ACCESS EXCLUSIVE lock (catalog only, no scan; the runner's 10 s
-- lock_timeout applies). IF EXISTS: hand-written so db:rebase keeps it.
ALTER TABLE "artifact_versions" DROP CONSTRAINT IF EXISTS "artifact_versions_artifact_version";
