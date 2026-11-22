import { z } from "zod";
import { agentFrontmatterSchema } from "@kobe/agent-file";
import { agentScope, agentStatus, ORBIT_EVAL_STATUSES } from "@kobe/db";
import { AGENT_MEMORY_SETTINGS, agentTransferSchema } from "@kobe/protocol";
import { toolManifestSchema } from "../../../agents/manifest.js";
import { skillManifestSchema } from "../../../skills/frozen.js";
import { jsonSchemaOf, untyped } from "../build.js";
import { arr, bool, dateTime, int, nullable, num, obj, oneOfStrings, str, uuid } from "../json.js";

/**
 * Agent answer shapes shared by the Agents and Site: gallery catalog areas (KOBE-771), read from
 * `agents/http.ts` (`agentSummary`, `agentDetail`, `versionSummary`, `versionDetail`),
 * `agents/eval/routes.ts` (`evalView`) and `agents/eval/gallery-scores.ts`. The routes build them
 * without a zod schema, so the components are `untyped`; the frontmatter, tool manifest and skill
 * manifest parts come from their zod schemas.
 */

type JsonSchema = Record<string, unknown>;

export const agentFrontmatter = jsonSchemaOf(agentFrontmatterSchema, "output");

/** `agentSummary`: what anyone who can see the agent gets. */
export const agentSummaryProps: Readonly<Record<string, JsonSchema>> = {
  id: uuid,
  scope: oneOfStrings(...agentScope.enumValues),
  slug: str,
  name: str,
  "description?": str,
  "icon?": str,
  starters: arr(str),
  dangerous: bool,
  status: oneOfStrings(...agentStatus.enumValues),
  ownerUserId: nullable(uuid),
  currentVersion: nullable(int),
  archivedAt: nullable(dateTime),
  revision: int,
  createdAt: dateTime,
  updatedAt: dateTime,
  canEdit: bool,
  canPublish: bool,
  canExport: bool,
  forkedFrom: nullable(obj({ agentId: uuid, version: nullable(int) })),
};

/** `agentDetail`: the summary plus the draft (callers who may read the definition). */
export const agentDetailProps: Readonly<Record<string, JsonSchema>> = {
  ...agentSummaryProps,
  frontmatter: agentFrontmatter,
  prompt: str,
};

export const agentSummary = obj(agentSummaryProps);
export const agentDetail = obj(agentDetailProps);

/** `AgentFileIssue`: a warning or validation problem at a path like `frontmatter.tools.allow.0`. */
export const agentIssue = obj({ path: str, message: str });
export const agentWarnings = arr(agentIssue);

export const agentTransfer = jsonSchemaOf(agentTransferSchema, "output");

const versionSummaryProps: Readonly<Record<string, JsonSchema>> = {
  version: int,
  publishedBy: nullable(uuid),
  publishedAt: dateTime,
  draftRevision: nullable(int),
  republishedFrom: nullable(int),
  memory: oneOfStrings(...AGENT_MEMORY_SETTINGS),
};

/** `versionDetail`: the frozen definition, tool manifest and (team versions) skill manifest. */
const versionDetail = obj({
  ...versionSummaryProps,
  frontmatter: agentFrontmatter,
  prompt: str,
  toolManifest: jsonSchemaOf(toolManifestSchema, "output"),
  "skillManifest?": jsonSchemaOf(skillManifestSchema, "output"),
});

/** `agentResponse`: the agent with its draft and the save-time warnings (ETag header set). */
export const AgentWithWarnings = untyped(
  "AgentWithWarnings",
  obj({ agent: agentDetail, warnings: agentWarnings }),
);

/** `publishedResponse` (publish, rollback, memory change): 201. */
export const AgentPublished = untyped(
  "AgentPublished",
  obj({
    agent: agentDetail,
    version: versionDetail,
    warnings: agentWarnings,
    skillsLeftOut: arr(
      obj({ name: str, reason: oneOfStrings("blocklisted", "suspended", "not_approved") }),
    ),
  }),
);

export const AgentVersionList = untyped(
  "AgentVersionList",
  obj({
    currentVersion: nullable(int),
    versions: arr(
      obj({
        ...versionSummaryProps,
        score: nullable(obj({ attackSuccessRate: num, threshold: num, evalId: uuid })),
      }),
    ),
    nextBefore: nullable(int),
  }),
);

export const AgentVersionDetail = untyped("AgentVersionDetail", obj({ version: versionDetail }));

const frozenRef = nullable(obj({ version: int, semver: str }));
export const AgentSkillUpdates = untyped(
  "AgentSkillUpdates",
  obj({
    version: nullable(int),
    skills: arr(
      obj({
        name: str,
        frozen: frozenRef,
        status: oneOfStrings("ok", "blocklisted", "suspended", "not_approved"),
        update: frozenRef,
      }),
    ),
  }),
);

const evalProps: Readonly<Record<string, JsonSchema>> = {
  id: uuid,
  agentId: uuid,
  status: oneOfStrings(...ORBIT_EVAL_STATUSES),
  draftRevision: int,
  threshold: num,
  attackSuccessRate: nullable(num),
  attempts: nullable(int),
  attackSuccesses: nullable(int),
  cases: obj({
    total: int,
    scored: nullable(int),
    failed: nullable(int),
    failureRate: nullable(num),
    skipped: { type: "object", additionalProperties: int },
  }),
  error: nullable(str),
  version: nullable(int),
  createdAt: dateTime,
  startedAt: nullable(dateTime),
  finishedAt: nullable(dateTime),
};

/** `evalView` without the report (lists, the eval a Publish started). */
export const agentEval = obj(evalProps);
/** `evalView(e, true)`: with the Orbit report as stored (null until it finished). */
export const agentEvalWithReport = obj({ ...evalProps, report: nullable({ type: "object" }) });

/** An eval was started (publish gate, gallery eval): 202. */
export const AgentEvalStarted = untyped("AgentEvalStarted", obj({ eval: agentEval, message: str }));

export const GalleryScoreList = untyped(
  "GalleryScoreList",
  obj({
    scores: arr(
      obj({
        agentId: uuid,
        version: int,
        status: oneOfStrings("passed", "blocked"),
        attackSuccessRate: num,
        attempts: int,
        threshold: num,
        evaluatedAt: dateTime,
      }),
    ),
  }),
);

/** Request body of a draft save (JSON form; an agent markdown file is also accepted). */
export const agentDefinitionShape = {
  frontmatter: agentFrontmatterSchema,
  prompt: z.string(),
};
