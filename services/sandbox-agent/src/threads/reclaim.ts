import { stat } from "node:fs/promises";
import { removeRuntimeDir } from "../models/runtime-dir.js";
import { SHARED_SCRATCH_DIRS, type RuntimeOf, type ThreadEnv } from "./thread-env.js";

/**
 * After a Pi exited: under a Pi identity every process of its uid is killed and what it owns is
 * reclaimed, then its private directories go, and only then is the identity released for another
 * thread. Anything that fails keeps the identity out of use (warned through `warn`).
 */
export async function reclaimRuntime(
  env: ThreadEnv,
  runtime: RuntimeOf,
  warn: (message: string) => void,
): Promise<void> {
  const identities = env.identities;
  const identity = runtime.identity;
  if (identity !== undefined && identities !== undefined) {
    try {
      await identities.killAllPatiently(identity);
      // Pi's private HOME/TMPDIR go first: the reclaim below opens what the uid owns in the
      // shared trees to the workspace group, and these sit under one of them.
      if (runtime.piDir !== undefined) await removeRuntimeDir(runtime.piDir, identities);
      // What the uid still owns in the shared trees becomes the workspace group's (nothing
      // stays private to it for the next thread that gets the uid), its IPC objects go.
      const gid = (await stat(env.workspaceDir)).gid;
      await identities.reclaimFiles(
        identity,
        gid,
        [env.workspaceDir, env.home, ...SHARED_SCRATCH_DIRS],
        // The runtime root is a small sticky tmpfs shared by all Pis: what the uid left at its
        // top level (owner-only files, a filled disk) must not reach the next holder.
        { purgeDirs: [env.runtimeDir] },
      );
    } catch (error) {
      // Its processes or private files may remain: the identity is never handed out again.
      warn(`Pi identity ${identity.uid} not reclaimed: ${(error as Error).message}`);
      return;
    }
  }
  try {
    // (Under an identity it is already gone, removed before the reclaim.)
    if (identity === undefined && runtime.piDir !== undefined) {
      await removeRuntimeDir(runtime.piDir, identities);
    }
    await removeRuntimeDir(runtime.dir, identities);
    if (runtime.toolDir !== undefined) await removeRuntimeDir(runtime.toolDir, identities);
  } catch (error) {
    warn(`runtime directory not removed: ${(error as Error).message}`);
    // A directory the next holder of the identity could read: keep the identity out of use.
    if (identity !== undefined) return;
  }
  if (identity !== undefined) identities?.release(identity);
}
