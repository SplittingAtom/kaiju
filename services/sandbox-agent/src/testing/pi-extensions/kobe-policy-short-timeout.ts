import { fileURLToPath } from "node:url";
import {
  connectPolicy,
  registerKaijuPolicy,
  type ExtensionApiLike,
} from "../../kobe-policy/extension.js";

/**
 * Test-only: kobe-policy with a 500 ms first-answer timeout, injected through `clientOptions`
 * (production has no way to change it). Loaded by real Pi in place of kobe-policy's index.
 */
export default async function kaijuPolicyShortTimeout(pi: ExtensionApiLike): Promise<void> {
  await registerKaijuPolicy(
    pi,
    connectPolicy({
      env: process.env,
      argv: process.argv.slice(2),
      cwd: process.cwd(),
      ownPath: fileURLToPath(import.meta.url),
      clientOptions: { firstReplyTimeoutMs: 500 },
    }),
  );
}
