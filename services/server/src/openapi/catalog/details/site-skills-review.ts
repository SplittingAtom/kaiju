import {
  acknowledgeSchema,
  commentSchema,
  decisionSchema,
} from "../../../routes/site-skill-registry-review.js";
import { QUEUE_FILTERS } from "../../../skills/registry/review-queue.js";
import { named, untyped, type CatalogDetail } from "../build.js";
import { arr, bool, int, nullable, num, obj, oneOfStrings, str, uuid } from "../json.js";
import {
  fileDiff,
  packageDiffFields,
  person,
  rawFile,
  storedObject,
  versionState,
} from "./site-skills-json.js";

/**
 * The Registry review console's operations of "Site: skills" (KOBE-771,
 * `routes/site-skill-registry-review.ts`): answers read from `skills/registry/review-queue.ts`,
 * `review-detail.ts`, `review-diff.ts` and `rerun.ts`. Scan, scorecard, manifest and provenance
 * documents are passed through as stored (typed as objects, not traced field by field).
 */

const bump = oneOfStrings("new", "major", "minor", "patch", "older");
const versionRef = nullable(obj({ id: uuid, semver: str }));

const queueItem = obj({
  id: uuid,
  skill: obj({ id: uuid, name: str }),
  semver: str,
  previous: versionRef,
  bump,
  changedFiles: nullable(int),
  state: versionState,
  verdict: str,
  submittedBy: nullable(person),
  submittedAt: str,
  claimedBy: nullable(person),
  authoritativeScorecard: { type: "boolean", description: "A Registry re-run scored it." },
  selfApproved: bool,
});

const reviewFinding = obj({
  key: str,
  rule: str,
  file: str,
  line: int,
  severity: str,
  category: nullable(str),
  acknowledged: nullable(obj({ by: person, at: str })),
  source: oneOfStrings("kobe", "external"),
  "title?": str,
  "externalSeverity?": str,
});

const rerunEntry = obj({
  evalRunId: uuid,
  startedBy: nullable(person),
  startedAt: str,
  status: str,
  cancelledBy: nullable(person),
  progress: nullable(obj({ done: int, total: int })),
  passRate: nullable(num),
  lift: nullable(num),
  current: bool,
  lowerThanCurrent: bool,
});

const maintainer = obj({ userId: uuid, name: str, email: str, deactivated: bool, addedAt: str });
const problem = obj({ code: str, message: str });

const reviewDetail = obj({
  id: uuid,
  skill: obj({ id: uuid, name: str, status: str, maintainers: arr(maintainer) }),
  semver: str,
  state: versionState,
  previous: versionRef,
  bump,
  verdict: str,
  scan: storedObject,
  findings: arr(reviewFinding),
  scorecard: nullable(storedObject),
  authoritativeScorecard: nullable(storedObject),
  reruns: arr(rerunEntry),
  manifest: storedObject,
  capabilities: obj({ egress: arr(obj({ host: str, inCeiling: bool })), packages: storedObject }),
  provenance: storedObject,
  source: { ...obj({ teamName: nullable(str) }), description: "Provenance source, with its team." },
  submittedBy: nullable(person),
  confirmedBy: nullable(person),
  submittedAt: str,
  claimedBy: nullable(person),
  selfApproved: bool,
  similarNames: arr(str),
  checklist: arr(obj({ id: str, label: str })),
  events: arr(
    obj({
      action: str,
      actor: nullable(person),
      note: nullable(str),
      checklist: nullable(storedObject),
      at: str,
    }),
  ),
  approveProblems: arr(problem),
});

const ReviewState = untyped("RegistryReviewState", obj({ id: uuid, state: versionState }));
const versionPath = {
  path: { type: "string", description: "A file path inside the submitted package." },
};
const rerunErrors = ["404", "409", "422", "503"] as const;

export const siteSkillsReviewDetails: Readonly<Record<string, CatalogDetail>> = {
  "get /v1/site/skills/registry": {
    query: { state: { type: "string", enum: [...QUEUE_FILTERS], default: "open" } },
    response: untyped("RegistryReviewQueue", obj({ items: arr(queueItem) })),
    errors: ["503"],
  },
  "get /v1/site/skills/registry/{id}": {
    response: untyped("RegistryReviewDetail", reviewDetail),
    errors: ["404"],
  },
  "post /v1/site/skills/registry/{id}/acknowledgements": {
    body: named("AcknowledgeFindingBody", acknowledgeSchema),
    response: untyped(
      "FindingAcknowledged",
      obj({ finding: str, acknowledged: { type: "boolean", enum: [true] }, changed: bool }),
    ),
    errors: ["404", "409"],
  },
  "delete /v1/site/skills/registry/{id}/claim": { response: ReviewState, errors: ["404", "409"] },
  "post /v1/site/skills/registry/{id}/claim": {
    body: null,
    query: {
      expectedState: {
        type: "string",
        enum: ["submitted", "in_review"],
        description: "Claim only while the version is still in this state.",
      },
    },
    response: ReviewState,
    errors: ["404", "409"],
  },
  "post /v1/site/skills/registry/{id}/comments": {
    body: named("RegistryReviewCommentBody", commentSchema),
    response: ReviewState,
    errors: ["404", "409"],
  },
  "post /v1/site/skills/registry/{id}/decision": {
    body: named("RegistryReviewDecisionBody", decisionSchema),
    response: untyped(
      "RegistryReviewDecision",
      obj({ id: uuid, state: versionState, "selfApproved?": bool }),
    ),
    responseDescription: "The new state; `selfApproved` on an approval.",
    errors: ["404", "409"],
  },
  "get /v1/site/skills/registry/{id}/diff": {
    query: {
      path: { type: "string", description: "Diff only this file (the screen's Load diff)." },
    },
    response: untyped("RegistryVersionDiff", {
      anyOf: [
        obj({ against: versionRef, ...packageDiffFields }),
        { ...fileDiff, description: "One file's diff, when `path` is given." },
      ],
    }),
    errors: ["404", "409", "503"],
  },
  "get /v1/site/skills/registry/{id}/file": {
    query: versionPath,
    requiredQuery: ["path"],
    response: untyped("RegistryRawFile", rawFile),
    errors: ["404", "409", "503"],
  },
  "post /v1/site/skills/registry/{id}/rerun-evals": {
    body: null,
    status: 202,
    response: untyped("RegistryEvalRerunStarted", obj({ evalRunId: uuid })),
    errors: rerunErrors,
  },
  "post /v1/site/skills/registry/{id}/reruns/{evalRunId}/cancel": {
    body: null,
    status: 202,
    response: untyped(
      "RegistryEvalRerunCancelled",
      obj({ evalRunId: uuid, status: oneOfStrings("cancelled") }),
    ),
    errors: rerunErrors,
  },
};
