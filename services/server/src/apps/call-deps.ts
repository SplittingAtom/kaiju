import type { ServerDeps } from "../deps.js";
import { DENIED_AUDIT_RATE } from "../mcp/service.js";
import { createDbRuleSource } from "../policy/rule-store.js";
import { sharedRateLimit } from "../rate-limit.js";
import { createRateLimiter } from "../sandbox/rate-limit.js";
import type { AppCallDeps } from "./call.js";
import { createValidatorPool, type SchemaValidator } from "./validate-pool.js";

/**
 * Per member: a burst of 30 app calls, then 5 per second (spec T10), counted in Postgres so the
 * bucket holds across server replicas (KOBE-810).
 */
export const APP_CALL_RATE = { burst: 30, perSecond: 5 } as const;

const shared = new WeakMap<ServerDeps, AppCallDeps>();

/**
 * One set of app-call dependencies per server (KOBE-436, KOBE-440): the apps' own calls and the
 * rail's launches share the validator pool and the audit throttles (launches have their own rate,
 * `APP_LAUNCH_RATE`).
 */
export function appCallDepsFor(deps: ServerDeps): AppCallDeps {
  const known = shared.get(deps);
  if (known) return known;
  const db = deps.database.db;
  // Workers start on the first call, not for every app instance (tests build many).
  let pool: SchemaValidator | undefined;
  const validator: SchemaValidator = {
    validate: (schema, instance, owner) =>
      (pool ??= createValidatorPool()).validate(schema, instance, owner),
    close: async () => pool?.close(),
  };
  // The MCP service and the proxy caller are read at call time: building the routes touches no
  // dependency but the database (history reads never wake sandboxes,
  // threads.list.db.test.ts).
  const callDeps: AppCallDeps = {
    db,
    get mcp() {
      return deps.mcp;
    },
    rules: createDbRuleSource(db),
    get caller() {
      return deps.appCaller;
    },
    validator,
    limiter: sharedRateLimit(db, "app-call", APP_CALL_RATE),
    limitedAudits: createRateLimiter({ capacity: 1, refillPerSecond: 1 / 60 }),
    deniedAudits: createRateLimiter(DENIED_AUDIT_RATE),
  };
  shared.set(deps, callDeps);
  return callDeps;
}
