// ---- U43: curators -------------------------------------------------------------------------------------

async function u43() {
  const started = new Date().toISOString();
  const owner = await asOwner();
  const ad = await as("ad");
  const st = await as("st");
  const m2 = await as("m2");
  out(
    "steward_grant",
    (await ad.call("PUT", `/v1/team/memory/stewards/${USERS.st.userId}`)).status,
  );
  const text = `Gate7 ${N} invoices go to finance`;
  const made = await create(st, {
    scope: "team",
    kind: "convention",
    statement: text,
    tags: ["Gate7"],
  });
  out("steward_create", code(made));
  const id = made.json.id ?? made.json.item?.id;
  const ver = made.json.version ?? 1;
  const edit = await st.call("PATCH", `/v1/memory/semantic/items/team/${id}`, {
    expected_version: ver,
    statement: `${text} by Friday`,
    tags: ["gate7", "finance"],
  });
  out("steward_edit", `${edit.status}:${(edit.json.tags ?? []).join("|")}`);
  out(
    "steward_pin",
    code(await st.call("POST", `/v1/memory/semantic/items/team/${id}/pin`, { pinned: true })),
  );
  out(
    "steward_archive",
    code(await st.call("POST", `/v1/memory/semantic/items/team/${id}/archive`, {})),
  );
  out(
    "member_create",
    code(await create(m2, { scope: "team", kind: "fact", statement: `Gate7 ${N} member fact` })),
  );
  const exp = await st.call("POST", "/v1/memory/semantic/export", {
    scope: "team",
    format: "json",
  });
  out("export", `${exp.status}:${Array.isArray(exp.json.items)}`);
  const doc = {
    ...exp.json,
    items: [
      {
        ref: "00000000-0000-4000-8000-0000000000aa",
        kind: "fact",
        statement: `Gate7 ${N} imported fact`,
        tags: [],
        pinned: false,
        policy: false,
        as_of: null,
        status: "active",
        superseded_by: null,
      },
    ],
  };
  const prev = await st.call("POST", "/v1/memory/semantic/import/preview", {
    scope: "team",
    format: "json",
    content: JSON.stringify(doc),
  });
  out(
    "import_preview",
    `${prev.status}:${oneLine(JSON.stringify(prev.json.rows?.map((r) => r.outcome ?? r.status) ?? prev.json.code ?? "-")).slice(0, 120)}`,
  );
  // Pins: at most 10 per scope.
  const pinIds = [];
  let pinRefused = "-";
  for (let i = 0; i < 11; i += 1) {
    const m = await create(st, {
      scope: "team",
      kind: "fact",
      statement: `Gate7 ${N} pinned fact number ${i}`,
      overrides: { lint: true }, // near-duplicates of each other: saved anyway
    });
    const pid = m.json.id;
    if (!pid) {
      pinRefused = `create ${i + 1}:${code(m)}`;
      break;
    }
    pinIds.push(pid);
    const pin = await st.call("POST", `/v1/memory/semantic/items/team/${pid}/pin`, {
      pinned: true,
    });
    if (pin.status !== 200) {
      pinRefused = `${i + 1}:${code(pin)}`;
      break;
    }
  }
  out("pin_limit", pinRefused);
  for (const pid of pinIds)
    await st.call("POST", `/v1/memory/semantic/items/team/${pid}/archive`, {});
  // Limits: the team cap set just above today's count: 80% notifies the curators, 100% blocks.
  const before = await siteSettings(owner);
  const count = (await items(st, "team")).usage?.count ?? 0;
  const cap = count + 5;
  const limits = { ...(before.scope_limits ?? {}), team: cap };
  out(
    "cap_set",
    (
      await owner.call("PUT", "/v1/memory/settings?level=site", {
        settings: { scope_limits: limits },
      })
    ).status,
  );
  const capIds = [];
  let blockedAt = "-";
  for (let i = 0; i < 7; i += 1) {
    const m = await create(st, {
      scope: "team",
      kind: "fact",
      statement: `Gate7 ${N} capacity fact ${i}`,
      overrides: { lint: true },
    });
    if (m.status !== 201) {
      blockedAt = `${count + i}/${cap}:${code(m)}`;
      break;
    }
    capIds.push(m.json.id);
  }
  out("cap_blocked", blockedAt);
  out("near_full_notified", (await notices(ad)).includes("memory.scope.near_full"));
  out(
    "cap_restored",
    (
      await owner.call("PUT", "/v1/memory/settings?level=site", {
        settings: { scope_limits: before.scope_limits },
      })
    ).status,
  );
  for (const cid of capIds)
    await st.call("POST", `/v1/memory/semantic/items/team/${cid}/archive`, {});
  const audit = await auditActions(TEAM_A, started);
  const byStewards = audit.filter((r) => r.actor_id === USERS.st.userId).map((r) => r.action);
  out("audited", [...new Set(byStewards.filter((a) => a.startsWith("memory.")))].sort().join(","));
}
