import { BlockList } from "node:net";
import { AddressPolicy, type AddressChecker } from "./index.js";

/**
 * Tests only, never a service: `policy` plus the IPv4 loopback range, where tests run their fake
 * upstreams. Loopback is always refused in production (KOBE-694), even when an operator lists it,
 * so a test that connects to a local server injects this checker instead of listing 127.0.0.0/8.
 */
export function withTestLoopback(policy: AddressChecker = new AddressPolicy()): AddressChecker {
  const loopback = new BlockList();
  loopback.addSubnet("127.0.0.0", 8, "ipv4");
  const check: AddressChecker["check"] = (address, options) =>
    loopback.check(address, "ipv4") ? "allowed" : policy.check(address, options);
  return {
    check,
    checkAll: (addresses, options) =>
      addresses.length > 0 && addresses.every((a) => check(a, options) === "allowed")
        ? "allowed"
        : "forbidden",
  };
}
