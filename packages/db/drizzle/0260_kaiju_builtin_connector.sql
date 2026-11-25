-- kobe:hand-written
-- (db:rebase keeps this SQL and its snapshot and only renumbers it: never regenerate it.)
-- KOBE-826 (rename step RN-13, owner decision 2026-11-24, spec rename-kaiju §11 A3): the built-in
-- connectors take the new name, with every stored reference to them rewritten. Drizzle generated
-- the CHECK statements (`builtin` value `kaiju` and the new marker URLs); everything between
-- the drops and the adds is hand-written.
--
-- 0. A registered connector named `kaiju` or `kaiju-git` (reserved for the built-ins from now on)
--    is renamed `<name>-registered` and audited (`mcp.connector.updated`, system actor), so the
--    built-ins always own `mcp__kaiju__*` and `mcp__kaiju_git__*` (review L2); its references are
--    rewritten like the built-ins' below, first.
-- 1. The built-in rows (fixed ids, kept): `builtin` 'kobe' becomes 'kaiju'; the Kaiju row is
--    renamed to `kaiju` (else `kaiju-builtin`, else it keeps its name; after step 0 only a
--    concurrent oddity could take it) and the git row to `kaiju-git` (else `kaiju-git-builtin`,
--    else unchanged); both marker URLs move to `kaiju-server.internal`.
-- 2. Where a row's name changed, its Pi tool names change with it (`mcp__<old segment>__x` →
--    `mcp__<new segment>__x`; Pi treats `-` as `_`). Rewritten: site and team tool rules
--    (deny, ask, allow and remembered approvals: `tool_glob` only; the remembered input and
--    scope are unsigned and stay), team custom exposure lists, agent drafts' and published
--    versions' `tools.allow` / `tools.deny` and frozen `tools_allow` / `tools_deny`, and the
--    connector names in their `connectors` lists, for globs that start with the full old prefix.
--    Published versions are immutable (D19): their trigger is disabled for this one rewrite only,
--    inside this transaction, and nothing else in them changes.
-- 3. Deny and ask globs with a wildcard inside the old server segment (`mcp__kobe*`) are
--    rewritten where that is exact (see step 3 below), else kept: the policy engine matches deny
--    and ask rules against every tool's pre-rename names too (review H1), so none is widened.
-- 4. Settings keys: site `kobe_mcp.mode`, `.reads_per_minute`, `.writes_per_hour` and each
--    team's `kobe_mcp.admin` become `kaiju_mcp.*`.
-- 5. Pending approvals of an old tool name are signed over that name (D29) and never re-signed:
--    they fall due now (`expires_at`), so the server refuses them at once and its expiry ends
--    them visibly with the cause `ttl` and a message naming the rename (approvals/expiry.ts).
-- 6. `site_settings` `kaiju_mcp.renamed` records the segments renamed here (`segments`: built-ins,
--    `registered`: step 0), for the readers of history and rules that keep the old names (audit
--    view, shared-thread redaction, the engine's deny and ask matching and its refusal of an old
--    name).
-- Kept as they were: audit rows (append-only), run events and thread entries, decided approvals,
-- skipped actions, MCP App results and eval records: history names the tool as it was called.
-- Thread connector toggles and team enablement rows reference the fixed ids and need nothing.
--
-- Migrations run as the owner role (no superuser, no BYPASSRLS) and the team tables have FORCE
-- ROW LEVEL SECURITY with no `kobe.team_id` set, so FORCE is lifted for these updates only (one
-- transaction; ALTER TABLE holds its lock until commit), as 0235/0258; no team is set. No row is
-- deleted. The helper functions exist only inside this transaction.
-- (kaiju-builtin-rename-upgrade.db.test.ts migrates a populated database.)
ALTER TABLE "connectors" DROP CONSTRAINT "connectors_builtin";--> statement-breakpoint
ALTER TABLE "connectors" DROP CONSTRAINT "connectors_builtin_url";--> statement-breakpoint
CREATE FUNCTION "public"."kaiju_826_tool"(v text, old_prefix text, new_prefix text) RETURNS text
  LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT CASE WHEN starts_with(v, old_prefix) THEN new_prefix || substr(v, length(old_prefix) + 1)
              ELSE v END
$$;--> statement-breakpoint
CREATE FUNCTION "public"."kaiju_826_tools"(a jsonb, old_prefix text, new_prefix text) RETURNS jsonb
  LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT CASE WHEN jsonb_typeof(a) <> 'array' THEN a ELSE (
    SELECT coalesce(jsonb_agg(CASE WHEN jsonb_typeof(e) = 'string'
                                   THEN to_jsonb(public.kaiju_826_tool(e #>> '{}', old_prefix, new_prefix))
                                   ELSE e END ORDER BY i), '[]'::jsonb)
      FROM jsonb_array_elements(a) WITH ORDINALITY AS t(e, i)) END
$$;--> statement-breakpoint
CREATE FUNCTION "public"."kaiju_826_names"(a jsonb, old_name text, new_name text) RETURNS jsonb
  LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT CASE WHEN jsonb_typeof(a) <> 'array' THEN a ELSE (
    SELECT coalesce(jsonb_agg(CASE WHEN e = to_jsonb(old_name) THEN to_jsonb(new_name) ELSE e END
                              ORDER BY i), '[]'::jsonb)
      FROM jsonb_array_elements(a) WITH ORDINALITY AS t(e, i)) END
$$;--> statement-breakpoint
-- An agent definition (`frontmatter`) with its tool globs and connector names rewritten.
CREATE FUNCTION "public"."kaiju_826_frontmatter"(f jsonb, old_prefix text, new_prefix text,
                                                 old_name text, new_name text) RETURNS jsonb
  LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT CASE WHEN jsonb_typeof(f) <> 'object' THEN f ELSE
    f || CASE WHEN jsonb_typeof(f -> 'tools') = 'object' THEN jsonb_build_object('tools',
           (f -> 'tools')
           || CASE WHEN f -> 'tools' ? 'allow' THEN jsonb_build_object('allow',
                public.kaiju_826_tools(f -> 'tools' -> 'allow', old_prefix, new_prefix)) ELSE '{}' END
           || CASE WHEN f -> 'tools' ? 'deny' THEN jsonb_build_object('deny',
                public.kaiju_826_tools(f -> 'tools' -> 'deny', old_prefix, new_prefix)) ELSE '{}' END)
         ELSE '{}' END
      || CASE WHEN f ? 'connectors' THEN jsonb_build_object('connectors',
           public.kaiju_826_names(f -> 'connectors', old_name, new_name)) ELSE '{}' END
  END
$$;--> statement-breakpoint
-- A frozen tool manifest with its agent entries and connector names rewritten.
CREATE FUNCTION "public"."kaiju_826_manifest"(m jsonb, old_prefix text, new_prefix text,
                                              old_name text, new_name text) RETURNS jsonb
  LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT CASE WHEN jsonb_typeof(m) <> 'object' THEN m ELSE
    m || CASE WHEN m ? 'tools_allow' THEN jsonb_build_object('tools_allow',
           public.kaiju_826_tools(m -> 'tools_allow', old_prefix, new_prefix)) ELSE '{}' END
      || CASE WHEN m ? 'tools_deny' THEN jsonb_build_object('tools_deny',
           public.kaiju_826_tools(m -> 'tools_deny', old_prefix, new_prefix)) ELSE '{}' END
      || CASE WHEN m ? 'connectors' THEN jsonb_build_object('connectors',
           public.kaiju_826_names(m -> 'connectors', old_name, new_name)) ELSE '{}' END
  END
$$;--> statement-breakpoint
-- A deny or ask glob whose literal prefix is a shorter prefix of the old built-in names
-- (`mcp__kobe*`), with `mcp__kobe` replaced by `mcp__kaiju` (used only where exact: step 3).
CREATE FUNCTION "public"."kaiju_826_partial"(v text) RETURNS text
  LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT CASE WHEN p <> v AND starts_with(p, 'mcp__kobe')
                   AND (starts_with('mcp__kobe__', p) OR starts_with('mcp__kobe_git__', p))
                   AND NOT starts_with(p, 'mcp__kobe__') AND NOT starts_with(p, 'mcp__kobe_git__')
              THEN 'mcp__kaiju' || substr(v, length('mcp__kobe') + 1) ELSE v END
    FROM (SELECT substring(v from '^[^*?\\]*') AS p) AS s
$$;--> statement-breakpoint
-- A jsonb document with the string array at `path` passed through kaiju_826_partial.
CREATE FUNCTION "public"."kaiju_826_deny"(d jsonb, path text[]) RETURNS jsonb
  LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT CASE WHEN jsonb_typeof(d #> path) <> 'array' OR jsonb_typeof(d #> path) IS NULL THEN d
    ELSE jsonb_set(d, path, (
      SELECT coalesce(jsonb_agg(CASE WHEN jsonb_typeof(e) = 'string'
                                     THEN to_jsonb(public.kaiju_826_partial(e #>> '{}'))
                                     ELSE e END ORDER BY i), '[]'::jsonb)
        FROM jsonb_array_elements(d #> path) WITH ORDINALITY AS t(e, i))) END
$$;--> statement-breakpoint
ALTER TABLE "tool_rules" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_connectors" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_agents" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_agent_versions" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "approvals" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_agent_versions" DISABLE TRIGGER "team_agent_versions_immutable";--> statement-breakpoint
ALTER TABLE "site_agent_versions" DISABLE TRIGGER "site_agent_versions_immutable";--> statement-breakpoint
DO $$
DECLARE
  kaiju_id constant uuid := '6b6f6265-0000-4000-8000-000000000001';
  git_id constant uuid := '6b6f6265-0000-4000-8000-000000000002';
  old_name text;
  new_name text;
  segments jsonb := '{}'::jsonb;
  registered jsonb := '{}'::jsonb;
  pairs text[][] := ARRAY[]::text[][];
  moved int := 0;
  standard boolean := true;
  old_prefix text;
  new_prefix text;
  rec record;
  k int;
  i int;
BEGIN
  -- 0. A registered connector holding a built-in's new name moves out of its way (review L2), so
  -- the built-ins always own `mcp__kaiju__*` and `mcp__kaiju_git__*`: `kaiju` → `kaiju-registered`
  -- (`-2`, `-3`, ... when taken). Audited as a system rename; its references follow below.
  FOR rec IN SELECT id, name FROM connectors
              WHERE builtin IS NULL AND replace(name, '-', '_') IN ('kaiju', 'kaiju_git')
              ORDER BY name LOOP
    new_name := rec.name || '-registered';
    k := 1;
    WHILE EXISTS (SELECT 1 FROM connectors x
                   WHERE replace(x.name, '-', '_') = replace(new_name, '-', '_')) LOOP
      k := k + 1;
      new_name := rec.name || '-registered-' || k;
    END LOOP;
    UPDATE connectors SET name = new_name, updated_at = now() WHERE id = rec.id;
    INSERT INTO audit_log (actor_kind, action, target)
    VALUES ('system', 'mcp.connector.updated',
            jsonb_build_object('connectorId', rec.id, 'name', new_name,
                               'changed', jsonb_build_array('name'), 'previousName', rec.name));
    RAISE NOTICE 'KOBE-826: registered connector % renamed to % (the name is reserved for a built-in connector): its tools are now mcp__%__*',
      rec.name, new_name, replace(new_name, '-', '_');
    registered := registered || jsonb_build_object(replace(rec.name, '-', '_'), replace(new_name, '-', '_'));
    pairs := pairs || ARRAY[ARRAY[rec.name, new_name]];
    moved := moved + 1;
  END LOOP;

  -- 1. The Kaiju row: the first free of its new names (a free Pi server segment), else its own.
  SELECT name INTO old_name FROM connectors WHERE builtin = 'kobe';
  IF old_name IS NOT NULL THEN
    SELECT c INTO new_name FROM unnest(ARRAY['kaiju', 'kaiju-builtin']) WITH ORDINALITY AS t(c, n)
     WHERE NOT EXISTS (SELECT 1 FROM connectors x
                        WHERE x.id <> kaiju_id AND replace(x.name, '-', '_') = replace(t.c, '-', '_'))
     ORDER BY n LIMIT 1;
    new_name := coalesce(new_name, old_name);
    UPDATE connectors
       SET builtin = 'kaiju', name = new_name,
           url = 'http://kaiju-server.internal/internal/v1/mcp/kaiju', updated_at = now()
     WHERE id = kaiju_id;
    standard := standard AND old_name = 'kobe' AND new_name = 'kaiju';
    IF new_name <> old_name THEN
      pairs := pairs || ARRAY[ARRAY[old_name, new_name]];
    ELSE
      RAISE NOTICE 'KOBE-826: built-in connector % keeps its name (kaiju and kaiju-builtin are taken)', old_name;
    END IF;
  END IF;
  -- The git row, the same way.
  old_name := NULL;
  new_name := NULL;
  SELECT name INTO old_name FROM connectors WHERE builtin = 'git';
  IF old_name IS NOT NULL THEN
    SELECT c INTO new_name FROM unnest(ARRAY['kaiju-git', 'kaiju-git-builtin']) WITH ORDINALITY AS t(c, n)
     WHERE NOT EXISTS (SELECT 1 FROM connectors x
                        WHERE x.id <> git_id AND replace(x.name, '-', '_') = replace(t.c, '-', '_'))
     ORDER BY n LIMIT 1;
    new_name := coalesce(new_name, old_name);
    UPDATE connectors
       SET name = new_name, url = 'http://kaiju-server.internal/internal/v1/mcp/git',
           updated_at = now()
     WHERE id = git_id;
    standard := standard AND old_name = 'kobe-git' AND new_name = 'kaiju-git';
    IF new_name <> old_name THEN
      pairs := pairs || ARRAY[ARRAY[old_name, new_name]];
    ELSE
      RAISE NOTICE 'KOBE-826: built-in git connector % keeps its name (kaiju-git and kaiju-git-builtin are taken)', old_name;
    END IF;
  END IF;

  -- 2. Every rename's references, registered ones first (their old prefix is a built-in's new one).
  FOR i IN 1 .. coalesce(array_length(pairs, 1), 0) LOOP
    old_name := pairs[i][1];
    new_name := pairs[i][2];
    old_prefix := 'mcp__' || replace(old_name, '-', '_') || '__';
    new_prefix := 'mcp__' || replace(new_name, '-', '_') || '__';
    IF i > moved THEN
      segments := segments || jsonb_build_object(replace(old_name, '-', '_'), replace(new_name, '-', '_'));
      RAISE NOTICE 'KOBE-826: built-in connector % renamed to %: its tools are now %*', old_name,
        new_name, new_prefix;
    END IF;

    UPDATE site_tool_rules SET tool_glob = kaiju_826_tool(tool_glob, old_prefix, new_prefix)
     WHERE starts_with(tool_glob, old_prefix);
    UPDATE tool_rules SET tool_glob = kaiju_826_tool(tool_glob, old_prefix, new_prefix)
     WHERE starts_with(tool_glob, old_prefix);
    UPDATE team_connectors
       SET enabled_tools = ARRAY(SELECT kaiju_826_tool(e, old_prefix, new_prefix)
                                   FROM unnest(enabled_tools) WITH ORDINALITY AS t(e, n) ORDER BY n)
     WHERE EXISTS (SELECT 1 FROM unnest(enabled_tools) AS e WHERE starts_with(e, old_prefix));
    UPDATE team_agents
       SET frontmatter = kaiju_826_frontmatter(frontmatter, old_prefix, new_prefix, old_name, new_name)
     WHERE frontmatter IS DISTINCT FROM
           kaiju_826_frontmatter(frontmatter, old_prefix, new_prefix, old_name, new_name);
    UPDATE site_agents
       SET frontmatter = kaiju_826_frontmatter(frontmatter, old_prefix, new_prefix, old_name, new_name)
     WHERE frontmatter IS DISTINCT FROM
           kaiju_826_frontmatter(frontmatter, old_prefix, new_prefix, old_name, new_name);
    UPDATE team_agent_versions
       SET frontmatter = kaiju_826_frontmatter(frontmatter, old_prefix, new_prefix, old_name, new_name),
           tool_manifest = kaiju_826_manifest(tool_manifest, old_prefix, new_prefix, old_name, new_name)
     WHERE frontmatter IS DISTINCT FROM
           kaiju_826_frontmatter(frontmatter, old_prefix, new_prefix, old_name, new_name)
        OR tool_manifest IS DISTINCT FROM
           kaiju_826_manifest(tool_manifest, old_prefix, new_prefix, old_name, new_name);
    UPDATE site_agent_versions
       SET frontmatter = kaiju_826_frontmatter(frontmatter, old_prefix, new_prefix, old_name, new_name),
           tool_manifest = kaiju_826_manifest(tool_manifest, old_prefix, new_prefix, old_name, new_name)
     WHERE frontmatter IS DISTINCT FROM
           kaiju_826_frontmatter(frontmatter, old_prefix, new_prefix, old_name, new_name)
        OR tool_manifest IS DISTINCT FROM
           kaiju_826_manifest(tool_manifest, old_prefix, new_prefix, old_name, new_name);
    UPDATE approvals SET expires_at = LEAST(expires_at, now())
     WHERE status = 'pending' AND starts_with(tool, old_prefix);
  END LOOP;

  -- 3. Deny and ask globs whose literal prefix (up to the first `*`, `?` or `\`) is a shorter
  -- prefix of the old built-in names (`mcp__kobe*`, `mcp__kobe_g*`), review H1: rewritten only
  -- where that is exact, i.e. the built-ins were exactly `kobe` / `kobe-git` and became `kaiju` /
  -- `kaiju-git`, and no registered connector's segment starts with `kobe` or `kaiju` (else the
  -- glob would stop matching, or start matching, a registered connector's tools). Every other glob
  -- stays as written: the policy engine also matches deny and ask rules against a tool's
  -- pre-rename names (`kaiju_mcp.renamed`), permanently. Allow rules are never widened this way.
  standard := standard AND array_length(pairs, 1) > moved
    AND NOT EXISTS (SELECT 1 FROM connectors c
                     WHERE c.builtin IS NULL
                       AND (replace(c.name, '-', '_') LIKE 'kobe%' OR replace(c.name, '-', '_') LIKE 'kaiju%'));
  IF standard THEN
    UPDATE site_tool_rules SET tool_glob = kaiju_826_partial(tool_glob)
     WHERE effect IN ('deny', 'ask') AND tool_glob <> kaiju_826_partial(tool_glob);
    UPDATE tool_rules SET tool_glob = kaiju_826_partial(tool_glob)
     WHERE effect IN ('deny', 'ask') AND tool_glob <> kaiju_826_partial(tool_glob);
    UPDATE team_agents SET frontmatter = kaiju_826_deny(frontmatter, '{tools,deny}')
     WHERE frontmatter IS DISTINCT FROM kaiju_826_deny(frontmatter, '{tools,deny}');
    UPDATE site_agents SET frontmatter = kaiju_826_deny(frontmatter, '{tools,deny}')
     WHERE frontmatter IS DISTINCT FROM kaiju_826_deny(frontmatter, '{tools,deny}');
    UPDATE team_agent_versions
       SET frontmatter = kaiju_826_deny(frontmatter, '{tools,deny}'),
           tool_manifest = kaiju_826_deny(tool_manifest, '{tools_deny}')
     WHERE frontmatter IS DISTINCT FROM kaiju_826_deny(frontmatter, '{tools,deny}')
        OR tool_manifest IS DISTINCT FROM kaiju_826_deny(tool_manifest, '{tools_deny}');
    UPDATE site_agent_versions
       SET frontmatter = kaiju_826_deny(frontmatter, '{tools,deny}'),
           tool_manifest = kaiju_826_deny(tool_manifest, '{tools_deny}')
     WHERE frontmatter IS DISTINCT FROM kaiju_826_deny(frontmatter, '{tools,deny}')
        OR tool_manifest IS DISTINCT FROM kaiju_826_deny(tool_manifest, '{tools_deny}');
  END IF;

  -- 4. Settings keys.
  UPDATE site_settings SET key = 'kaiju_mcp.' || substr(key, length('kobe_mcp.') + 1), updated_at = now()
   WHERE key IN ('kobe_mcp.mode', 'kobe_mcp.reads_per_minute', 'kobe_mcp.writes_per_hour')
     AND NOT EXISTS (SELECT 1 FROM site_settings s
                      WHERE s.key = 'kaiju_mcp.' || substr(site_settings.key, length('kobe_mcp.') + 1));
  UPDATE teams
     SET settings = (settings - 'kobe_mcp.admin')
                    || jsonb_build_object('kaiju_mcp.admin', settings -> 'kobe_mcp.admin')
   WHERE settings ? 'kobe_mcp.admin';
  IF segments <> '{}'::jsonb OR registered <> '{}'::jsonb THEN
    INSERT INTO site_settings (key, value)
    VALUES ('kaiju_mcp.renamed',
            jsonb_build_object('segments', segments, 'registered', registered)::text)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
  END IF;
END
$$;--> statement-breakpoint
ALTER TABLE "site_agent_versions" ENABLE TRIGGER "site_agent_versions_immutable";--> statement-breakpoint
ALTER TABLE "team_agent_versions" ENABLE TRIGGER "team_agent_versions_immutable";--> statement-breakpoint
ALTER TABLE "approvals" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_agent_versions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_agents" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_connectors" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tool_rules" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP FUNCTION "public"."kaiju_826_deny"(jsonb, text[]);--> statement-breakpoint
DROP FUNCTION "public"."kaiju_826_partial"(text);--> statement-breakpoint
DROP FUNCTION "public"."kaiju_826_manifest"(jsonb, text, text, text, text);--> statement-breakpoint
DROP FUNCTION "public"."kaiju_826_frontmatter"(jsonb, text, text, text, text);--> statement-breakpoint
DROP FUNCTION "public"."kaiju_826_names"(jsonb, text, text);--> statement-breakpoint
DROP FUNCTION "public"."kaiju_826_tools"(jsonb, text, text);--> statement-breakpoint
DROP FUNCTION "public"."kaiju_826_tool"(text, text, text);--> statement-breakpoint
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_builtin" CHECK ("connectors"."builtin" IS NULL OR ((("connectors"."builtin" = 'kaiju' AND "connectors"."id" = '6b6f6265-0000-4000-8000-000000000001'::uuid) OR ("connectors"."builtin" = 'git' AND "connectors"."id" = '6b6f6265-0000-4000-8000-000000000002'::uuid)) AND "connectors"."auth_kind" = 'none' AND "connectors"."credential_source" = 'member' AND "connectors"."tools_hash" IS NULL AND "connectors"."tools_snapshot" = '[]'::jsonb));--> statement-breakpoint
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_builtin_url" CHECK (CASE WHEN "connectors"."builtin" IS NULL THEN "connectors"."url" NOT IN ('http://kaiju-server.internal/internal/v1/mcp/kaiju', 'http://kaiju-server.internal/internal/v1/mcp/git') WHEN "connectors"."builtin" = 'kaiju' THEN "connectors"."url" = 'http://kaiju-server.internal/internal/v1/mcp/kaiju' WHEN "connectors"."builtin" = 'git' THEN "connectors"."url" = 'http://kaiju-server.internal/internal/v1/mcp/git' ELSE false END);
