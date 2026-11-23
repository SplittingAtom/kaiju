import { describe, expect, it } from "vitest";
import { checkBaseUrl, checkHostList, checkHostPattern, hostAllowed } from "./address";

describe("checkBaseUrl (the server's parseGitBaseUrl rules, KOBE-761)", () => {
  it("canonicalizes an https address with a port and a path", () => {
    expect(checkBaseUrl(" https://Git.Example.com:8443/forgejo/ ")).toEqual({
      ok: true,
      value: { baseUrl: "https://git.example.com:8443/forgejo", host: "git.example.com" },
    });
  });

  it.each([
    ["", "Enter the host's https address."],
    ["git.example.com", "Enter the host's https address, e.g. https://git.example.com."],
    ["http://git.example.com", "The address must use https."],
    ["https://bot:pw@git.example.com", "The address must not contain a user name or password."],
    ["https://git.example.com/?x=1", "The address must not contain a query or fragment."],
    ["https://git.example.com/#top", "The address must not contain a query or fragment."],
    ["https://10.0.0.5", "The address must name a host, not an IP address."],
    ["https://[::1]/", "The address must name a host, not an IP address."],
    ["https://localhost", "The address must name a host, not an IP address."],
  ])("refuses %j", (raw, reason) => {
    expect(checkBaseUrl(raw)).toEqual({ ok: false, reason });
  });
});

describe("hostAllowed (the Site's host list, G3)", () => {
  it("allows any host while the list is empty or absent", () => {
    expect(hostAllowed(undefined, "git.example.com")).toBe(true);
    expect(hostAllowed([], "git.example.com")).toBe(true);
  });

  it("matches exact names and wildcard subdomains, never the wildcard's own name", () => {
    const list = ["github.com", "*.corp.example"];
    expect(hostAllowed(list, "github.com")).toBe(true);
    expect(hostAllowed(list, "git.corp.example")).toBe(true);
    expect(hostAllowed(list, "corp.example")).toBe(false);
    expect(hostAllowed(list, "gitlab.com")).toBe(false);
  });
});

describe("checkHostPattern / checkHostList (the server's parseDomainPattern rules)", () => {
  it("canonicalizes host names and wildcards", () => {
    expect(checkHostPattern(" GitHub.com ")).toEqual({ ok: true, value: "github.com" });
    expect(checkHostPattern("*.Example.org")).toEqual({ ok: true, value: "*.example.org" });
  });

  it.each([
    ["git.*.example.com", "a wildcard is allowed only as the first label (*.example.com)"],
    ["https://github.com", "enter a host name only, without scheme, port or path"],
    ["github.com:443", "enter a host name only, without scheme, port or path"],
    ["10.1.2.3", "must be a host name such as github.com (no IP addresses)"],
    ["*.com", "must be a host name such as github.com (no IP addresses)"],
    ["*.co.uk", "a wildcard on the public suffix co.uk would match every site under it"],
  ])("refuses %j", (raw, reason) => {
    expect(checkHostPattern(raw)).toEqual({ ok: false, reason });
  });

  it("names each bad line, dedupes and sorts the good ones", () => {
    expect(checkHostList("github.com\n\nhttps://x.org\n*.example.com\nGITHUB.com")).toEqual({
      hosts: ["*.example.com", "github.com"],
      problems: ["Line 3 (https://x.org): enter a host name only, without scheme, port or path."],
    });
  });

  it("refuses more than 50 hosts", () => {
    const text = Array.from({ length: 51 }, (_, i) => `h${i}.example.com`).join("\n");
    expect(checkHostList(text).problems).toEqual(["List at most 50 hosts (there are 51)."]);
  });
});
