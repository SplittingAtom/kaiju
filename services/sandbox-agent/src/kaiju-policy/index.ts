import { fileURLToPath } from "node:url";
import {
  connectPolicy,
  registerKaijuPolicy,
  type ExtensionApiLike,
  type PolicyConnection,
} from "./extension.js";
import { hiddenToolsFrom, applyHiddenTools } from "./hidden-tools.js";

/**
 * kaiju-policy: the Pi 1.0.x extension that asks the Kaiju server about every tool call (spec D13,
 * D29; KOBE-36). kaiju-sandbox-agent loads it with `--extension <root-owned path>`, last, into every
 * `pi --mode rpc` it starts, with the policy channel on fd 3 (`KAIJU_POLICY_FD`).
 *
 * Self-contained by design: imports only node builtins and files in this directory, because the
 * image ships it on its own (root-owned, read-only, `/opt/kaiju/pi-extensions/kaiju-policy`).
 *
 * The channel is opened once per Pi process (module scope). If Pi re-evaluates the module (a
 * reload), the fd variable is already gone and the new instance blocks every call — fail closed.
 */
let connection: Promise<PolicyConnection> | undefined;

export default async function kaijuPolicy(pi: ExtensionApiLike): Promise<void> {
  connection ??= connectPolicy({
    env: process.env,
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    ownPath: fileURLToPath(import.meta.url),
    // stderr only: stdout is Pi's RPC stream.
    warn: (message) => process.stderr.write(`${message}\n`),
  });
  await registerKaijuPolicy(pi, connection);
  // KOBE-776: built-ins the run's agent may not use are not offered (the server refuses them).
  applyHiddenTools(pi, hiddenToolsFrom(process.env));
}
