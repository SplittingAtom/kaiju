"use client";

import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { getSiteHealth, type SiteHealthCheck } from "../../../lib/admin/api/site/health";
import { Notice } from "../../ui/console";

/** The guide's section on it (the install guide itself is for operators, outside the app). */
const GUIDE_HREF = "/docs/admin/site-admin#ingress-rate-limit";

type InfoCheck = Extract<SiteHealthCheck, { level: "info" }>;

/**
 * Install checks on the Site console overview (KOBE-811), for site admins. Informational only:
 * nothing here stops Kaiju working. Today: whether requests are limited per client at the ingress
 * (off by default in the chart).
 */
export function SiteHealthNotices() {
  const [checks, setChecks] = useState<readonly InfoCheck[]>([]);

  useEffect(() => {
    let current = true;
    getSiteHealth().then(
      (res) => {
        if (current && res.ok) {
          setChecks(res.data.checks.filter((c): c is InfoCheck => c.level === "info"));
        }
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, []);

  return (
    <>
      {checks.map((c) => (
        <IngressRateLimitNotice key={c.id} state={c.state} />
      ))}
    </>
  );
}

function IngressRateLimitNotice({ state }: { readonly state: InfoCheck["state"] }) {
  const titleId = useId();
  const title = state === "none" ? "No rate limit at the ingress" : "Ingress rate limit unknown";
  return (
    <Notice
      tone="info"
      role="status"
      aria-labelledby={titleId}
      title={<span id={titleId}>{title}</span>}
    >
      {state === "none" ? (
        <p>
          Kaiju limits sign-in, uploads and other costly requests itself, but nothing limits how
          many requests one address sends through the ingress. Your operator can turn on the
          chart&apos;s limit (install guide, &ldquo;Rate limit at the ingress&rdquo;).
        </p>
      ) : (
        <p>
          Kaiju&apos;s ingress is not managed by its Helm chart, so Kaiju can&apos;t tell whether
          requests are limited per address in front of it. If your edge limits them, your operator
          can set <code>ingress.rateLimit.external</code> to hide this notice (install guide,
          &ldquo;Rate limit at the ingress&rdquo;).
        </p>
      )}
      <p>
        <Link href={GUIDE_HREF}>Site admin overview: Ingress rate limit</Link>
      </p>
    </Notice>
  );
}
