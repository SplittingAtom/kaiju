import { publishSchema, startSchema } from "../../../routes/site-skill-catalog-edit/shared.js";
import { named, untyped, type CatalogDetail } from "../build.js";
import { arr, bool, int, nullable, obj, oneOfStrings, str, uuid } from "../json.js";
import {
  packageDiffFields,
  publisher,
  rawFile,
  scanFields,
  siteDraftFile,
  siteDraftRecord,
  siteVersionRow,
  storedObject,
} from "./site-skills-json.js";

/**
 * The Site catalog editor's operations of "Site: skills" (KOBE-771,
 * `routes/site-skill-catalog-edit/*.ts`, KOBE-495): answers read from
 * `skills/site-edit/catalog-view.ts`, `site-drafts.ts`, `site-preview.ts`, `site-publish.ts` and
 * `kaiju-detach.ts`.
 */

const siteSkillView = obj({
  id: uuid,
  name: str,
  summary: str,
  publisher: oneOfStrings("kaiju", "maintainer"),
  status: str,
  retired: { type: "boolean", description: "Deprecated or archived: restore it before editing." },
  blocklisted: bool,
  kaiju: nullable(
    obj({
      detached: bool,
      detachedAt: nullable(str),
      detachedBy: nullable(str),
      detachedFromVersion: nullable(str),
      shippedVersion: nullable(str),
      updateAvailable: bool,
    }),
  ),
  draft: nullable(
    obj({ baseVersionId: uuid, baseSemver: str, rev: int, updatedAt: str, updatedBy: str }),
  ),
  versions: arr(siteVersionRow),
});

const siteVersionView = obj({
  version: siteVersionRow,
  files: arr(obj({ path: str, size: int, kind: oneOfStrings("text", "binary") })),
  frontmatter: nullable(storedObject),
  frontmatterProblem: nullable(str),
  manifest: storedObject,
  provenance: storedObject,
  scan: storedObject,
  hashes: obj({ runtime: str, package: str }),
});

const SiteDraft = untyped(
  "SiteSkillDraft",
  obj({ draft: siteDraftRecord, files: arr(siteDraftFile) }),
);
const DraftFileChanged = untyped(
  "SiteSkillDraftFileChanged",
  obj({ rev: int, draft: siteDraftRecord }),
);
const VersionRawFile = untyped("SiteCatalogVersionFile", rawFile);

const kaijuSeedResult = obj({
  name: str,
  semver: str,
  action: oneOfStrings(
    "created",
    "published",
    "unchanged",
    "refused",
    "failed",
    "skipped_detached",
    "skipped_name_taken",
  ),
  "reason?": oneOfStrings("scan_block", "version_reused", "version_not_newer"),
});

/** Draft writes need `If-Match: <rev>` (428 without it; a stale revision is a 409). */
const draftWriteErrors = ["404", "409", "413", "422", "428", "429"] as const;

export const siteSkillsEditDetails: Readonly<Record<string, CatalogDetail>> = {
  "get /v1/site/skills/catalog-skills/{skillId}": {
    response: untyped("SiteCatalogSkillView", siteSkillView),
    errors: ["404"],
  },
  "delete /v1/site/skills/catalog-skills/{skillId}/draft": {
    status: 204,
    errors: ["404", "409", "422"],
  },
  "get /v1/site/skills/catalog-skills/{skillId}/draft": {
    response: SiteDraft,
    responseDescription: "The draft and its files; `ETag` is its revision.",
    errors: ["404"],
  },
  "post /v1/site/skills/catalog-skills/{skillId}/draft": {
    body: named("StartSiteSkillDraftBody", startSchema),
    status: 201,
    response: SiteDraft,
    responseDescription: "The new draft; `replace: true` replaces an existing one.",
    errors: ["404", "409", "422", "503"],
  },
  "get /v1/site/skills/catalog-skills/{skillId}/draft/bump": {
    response: untyped(
      "SiteSkillDraftBump",
      obj({
        rev: int,
        latest: nullable(obj({ skillId: uuid, semver: str })),
        kind: nullable(oneOfStrings("major", "minor", "patch")),
        suggested: nullable(str),
        reasons: arr(str),
      }),
    ),
    errors: ["404", "429", "503"],
  },
  "delete /v1/site/skills/catalog-skills/{skillId}/draft/files/{path}": {
    response: DraftFileChanged,
    errors: draftWriteErrors,
  },
  "get /v1/site/skills/catalog-skills/{skillId}/draft/files/{path}": {
    produces: "application/octet-stream",
    responseDescription:
      "The file's bytes (`text/plain; charset=utf-8` for a text file); `ETag` is the draft revision.",
    errors: ["404"],
  },
  "put /v1/site/skills/catalog-skills/{skillId}/draft/files/{path}": {
    body: null,
    rawBody: ["application/octet-stream", "text/plain"],
    response: DraftFileChanged,
    responseDescription: "The file's raw bytes (any media type) written; the new revision.",
    errors: draftWriteErrors,
  },
  "post /v1/site/skills/catalog-skills/{skillId}/draft/publish": {
    body: named("PublishSiteSkillDraftBody", publishSchema),
    status: 201,
    response: untyped(
      "SiteSkillDraftPublished",
      obj({
        version: obj({
          versionId: uuid,
          skillId: uuid,
          name: str,
          semver: str,
          verdict: oneOfStrings("pass", "caution"),
          previous: nullable(obj({ publisher: str, semver: str })),
        }),
        notified: { type: "integer", description: "Maintainers told of the new version." },
      }),
    ),
    errors: ["404", "409", "413", "422", "428", "429", "503"],
  },
  "get /v1/site/skills/catalog-skills/{skillId}/draft/scan": {
    response: untyped("SiteSkillDraftScan", obj({ rev: int, ...scanFields, ruleSetVersion: str })),
    errors: ["404", "422", "429", "503"],
  },
  "get /v1/site/skills/catalog-skills/{skillId}/kaiju/compare": {
    response: untyped(
      "KaijuSkillCompare",
      obj({
        current: obj({ id: uuid, semver: str, publisher }),
        shipped: obj({ semver: str }),
        diff: obj(packageDiffFields),
      }),
    ),
    errors: ["404", "409", "503"],
  },
  "post /v1/site/skills/catalog-skills/{skillId}/kaiju/reset": {
    body: null,
    response: untyped(
      "KaijuSkillReset",
      obj({ shippedSemver: str, seed: nullable(kaijuSeedResult) }),
    ),
    errors: ["404", "409", "503"],
  },
  "get /v1/site/skills/catalog-skills/{skillId}/versions/{versionId}": {
    response: untyped("SiteCatalogVersionView", siteVersionView),
    errors: ["404", "503"],
  },
  "get /v1/site/skills/catalog-skills/{skillId}/versions/{versionId}/files/{path}": {
    response: VersionRawFile,
    errors: ["404", "503"],
  },
};
