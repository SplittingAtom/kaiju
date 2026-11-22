// ---- U44 / U45: Site proposals, Site curation and Policy ----------------------------------------------

/** m2 states `facts` in a conversation, learns, and proposes each to the Site; ad confirms each. */
async function siteProposals(facts, title) {
  const m2 = await as("m2");
  const t = await say(
    m2,
    ["No tools. Reply with the single word OK.", ...facts.map((f) => `For the record: ${f}.`)].join(
      " ",
    ),
    { title },
  );
  out("turn", t.terminal);
  const p = await learn(m2, t.threadId);
  out("pass", passLine(p));
  const ids = [];
  for (const f of facts) {
    const want = `${f.charAt(0).toUpperCase()}${f.slice(1)}.`;
    const cand = p.candidates.find((x) => x.statement === want);
    const r = await m2.call("POST", `/v1/memory/site-proposals/candidates/${cand?.id}`, {
      justification: `Every workspace needs this (${N}).`,
    });
    ids.push(r.json.id ?? r.json.proposal?.id ?? r.json.proposal_id);
    out("site_propose", code(r));
  }
  return { m2, thread: t, pass: p, ids };
}

async function u44() {
  const fact = `gate7 ${N} visitor parking is on level two`;
  const { m2, thread, pass, ids } = await siteProposals([fact], "gate7 u44");
  const [id] = ids;
  const owner = await asOwner(null);
  const queue1 = await owner.call("GET", "/v1/site/memory/proposals");
  const queued = (q) => JSON.stringify(q.json).toLowerCase().includes(fact.toLowerCase());
  out("site_queue_before_confirm", queued(queue1));
  const st = await as("st");
  out(
    "steward_confirm",
    code(await st.call("POST", `/v1/memory/site-proposals/${id}/confirm`, {})),
  );
  const ad = await as("ad");
  out("admin_confirm", code(await ad.call("POST", `/v1/memory/site-proposals/${id}/confirm`, {})));
  const queue2 = await owner.call("GET", "/v1/site/memory/proposals");
  out("site_queue_after_confirm", queued(queue2));
  const detail = await owner.call("GET", `/v1/site/memory/proposals/${id}`);
  const text = JSON.stringify(detail.json);
  const p = detail.json.proposal ?? detail.json;
  out("site_detail", detail.status);
  out("site_detail_keys", Object.keys(p).sort().join(","));
  const forbidden = [
    "evidence",
    "quote",
    "rationale",
    "source_thread_id",
    "thread_id",
    "entry_id",
    "pass_id",
    "candidate_id",
  ];
  const ids2 = [thread.threadId, pass.passId, ...pass.candidates.map((x) => x.id)];
  const leaks = [
    ...forbidden.filter((k) => text.includes(`"${k}"`)),
    ...ids2.filter((v) => v && text.includes(v)).map(() => "id"),
    ...["No tools", "Reply with the single word", "For the record"].filter((w) => text.includes(w)),
  ];
  out("site_detail_leaks", leaks.join(",") || "none");
  out(
    "site_detail_shows",
    ["statement", "kind", "justification", "from_workspace", "created_at"]
      .filter((k) => k in p)
      .join(","),
  );
  // Request changes: at most 3 rounds, then the Site decides.
  const rounds = [];
  for (let i = 1; i <= 4; i += 1) {
    const rc = await owner.call("POST", `/v1/site/memory/proposals/${id}/request-changes`, {
      note: `Round ${i}: name the building (${N}).`,
    });
    rounds.push(code(rc));
    if (rc.status !== 200) break;
    const again = await ad.call("POST", `/v1/memory/site-proposals/${id}/confirm`, {});
    rounds.push(`c${again.status}`);
  }
  out("rounds", rounds.join(","));
  const appr = await owner.call("POST", `/v1/site/memory/proposals/${id}/approve`, {
    overrides: { lint: true },
  });
  out("approve", code(appr));
  const siteItem = (await items(m2, "site", fact.slice(0, 40))).items.find((i) =>
    i.statement.includes(N),
  );
  out("site_item_for_member", Boolean(siteItem));
  if (siteItem)
    await owner.call("POST", `/v1/memory/semantic/items/site/${siteItem.id}/archive`, {});
}

async function u45() {
  const f1 = `gate7 ${N} the cafeteria opens at eight`;
  const f2 = `gate7 ${N} the cafeteria opens at eight thirty`;
  const f3 = `gate7 ${N} the roof garden is open to visitors`;
  const { m2, ids } = await siteProposals([f1, f2, f3], "gate7 u45");
  const ad = await as("ad");
  for (const id of ids)
    out("confirm", code(await ad.call("POST", `/v1/memory/site-proposals/${id}/confirm`, {})));
  const owner = await asOwner(null);
  const a = await owner.call("POST", `/v1/site/memory/proposals/${ids[0]}/approve`, {
    overrides: { lint: true },
  });
  out("approve", code(a));
  const siteId = a.json.item?.id ?? a.json.item_id ?? (await items(m2, "site", f1)).items[0]?.id;
  const m = await owner.call("POST", `/v1/site/memory/proposals/${ids[1]}/merge`, {
    item_id: siteId,
    overrides: { lint: true },
  });
  out("merge", code(m));
  const detail = await owner.call("GET", `/v1/memory/semantic/items/site/${siteId}`);
  out("merged_version", `${detail.status}:${detail.json.version ?? "-"}`);
  out(
    "reject_no_reason",
    code(await owner.call("POST", `/v1/site/memory/proposals/${ids[2]}/reject`, {})),
  );
  out(
    "reject",
    code(
      await owner.call("POST", `/v1/site/memory/proposals/${ids[2]}/reject`, {
        reason: `Not for every workspace (${N}).`,
      }),
    ),
  );
  const mine = await m2.call("GET", "/v1/memory/site-proposals");
  out(
    "proposer_sees_reason",
    JSON.stringify(mine.json).includes(`Not for every workspace (${N}).`),
  );
  // Policy: a Site admin sets it, ≤2 KiB in all; it reaches a workspace that opted out of Site
  // memories, first; a contradicting save is blocked until saved anyway, audited.
  const started = new Date().toISOString();
  const policyText = `Gate7 ${N} customer invoices are archived for seven years`;
  const pol = await create(owner, {
    scope: "site",
    kind: "convention",
    statement: policyText,
    policy: true,
  });
  out("policy", code(pol));
  const fillers = [];
  let budget = "-";
  for (let i = 0; i < 6; i += 1) {
    const filler =
      `Gate7 ${N} policy filler ${i}: ${"governance wording kept deliberately long so the Policy byte budget fills ".repeat(5)}`.slice(
        0,
        480,
      );
    const f = await create(owner, {
      scope: "site",
      kind: "convention",
      statement: filler,
      policy: true,
      overrides: { lint: true },
    });
    if (f.status !== 201) {
      budget = `${i + 1}:${code(f)}`;
      break;
    }
    fillers.push(f.json.id);
  }
  out("policy_budget", budget);
  for (const fid of fillers)
    await owner.call("POST", `/v1/memory/semantic/items/site/${fid}/archive`, {});
  const bd = await as("bd");
  const optOut = await bd.call("PUT", "/v1/memory/settings?level=team", {
    site_memories_enabled: false,
  });
  out("opt_out", optOut.status);
  const tb = await say(bd, "No tools. Reply with the single word OK.", { title: "gate7 u45 b" });
  out("turn_b", tb.terminal);
  const ctx = await contextOf(bd, tb.threadId);
  out(
    "policy_first_b",
    `${ctx.items[0]?.lane ?? "-"}:${ctx.items[0]?.statement === policyText || ctx.items.some((i) => i.lane === "policy" && i.statement === policyText)}`,
  );
  out("site_lane_b", ctx.items.filter((i) => i.lane === "site").length);
  await bd.call("PUT", "/v1/memory/settings?level=team", { site_memories_enabled: true });
  const contra = `Gate7 ${N} customer invoices are never archived`;
  const blocked = await create(ad, { scope: "team", kind: "fact", statement: contra });
  out("contradiction", code(blocked));
  const anyway = await create(ad, {
    scope: "team",
    kind: "fact",
    statement: contra,
    overrides: { policy_conflict: true },
  });
  out("contradiction_anyway", code(anyway));
  const audit = await auditActions(TEAM_A, started);
  out(
    "override_audited",
    audit.some((r) => r.action === "memory.policy.override"),
  );
  if (anyway.json.id)
    await ad.call("POST", `/v1/memory/semantic/items/team/${anyway.json.id}/archive`, {});
  if (pol.json.id)
    await owner.call("POST", `/v1/memory/semantic/items/site/${pol.json.id}/archive`, {});
  if (siteId) await owner.call("POST", `/v1/memory/semantic/items/site/${siteId}/archive`, {});
}
