"use client";

import type { ReactNode } from "react";
import type { ApiResult } from "../../../lib/api/client";
import {
  buildMemoryVectors,
  type MemoryVectorJob,
  type MemoryVectors,
} from "../../../lib/admin/api/site/memory";
import { Button, Notice } from "../../ui/console";
import { MutationStatus } from "../error-notice";
import { useMutation, type ResourceState } from "../use-resource";

/**
 * Site console › Settings › Memory: search by meaning (KOBE-409). Says why memory search is
 * keyword-only when it is (no pgvector, pgvector not enabled, no embedding model, its provider
 * gone, no model gateway) and what to do; shows how many memories have a vector of the current
 * model and offers Build vectors / Re-embed for every workspace (paid by the admin in their active
 * workspace, or without one by each workspace, KOBE-669).
 */

const STOP_REASONS: Readonly<Record<string, string>> = {
  budget: "a paying workspace reached 100% of a budget line (the other workspaces were built)",
  model_changed: "the embedding model changed",
  no_client: "the model gateway is not configured",
};

const stopText = (job: MemoryVectorJob) =>
  STOP_REASONS[job.stopReason ?? ""] ??
  `the gateway refused (${(job.stopReason ?? "error").replaceAll("_", " ")})`;

/** Why search is keyword-only, as a notice; null when vectors can be used. */
export function vectorNotice(v: MemoryVectors): ReactNode {
  if (v.pgvector === "missing") {
    return (
      <Notice tone="warn" title="Search by meaning is off: this Postgres server has no pgvector">
        <p>
          Install pgvector for the Postgres server Kaiju uses (a package or an image with it), then
          as a superuser run <code>CREATE EXTENSION vector;</code> in Kaiju&apos;s database and
          upgrade Kaiju: the next migration adds the vector columns. Until then memory search uses
          word matching.
        </p>
      </Notice>
    );
  }
  if (v.pgvector === "available" || !v.columns) {
    return (
      <Notice tone="warn" title="Search by meaning is off: pgvector is not enabled">
        <p>
          pgvector is installed on the Postgres server but Kaiju may not enable it. As a superuser
          run <code>CREATE EXTENSION vector;</code> in Kaiju&apos;s database, then upgrade Kaiju (or
          run its migrations again). Until then memory search uses word matching.
        </p>
      </Notice>
    );
  }
  if (!v.serverCalls) {
    return (
      <Notice tone="warn" title="Search by meaning is off: the model gateway is not configured">
        <p>Embeddings go through the model gateway. Memory search uses word matching.</p>
      </Notice>
    );
  }
  if (v.modelState === "no_model") {
    return (
      <Notice tone="info" title="No embedding model is set">
        <p>
          Memory search uses word matching. Choose an embedding model above to add search by
          meaning.
        </p>
      </Notice>
    );
  }
  if (v.modelState === "provider_missing") {
    return (
      <Notice tone="warn" title="The embedding model's provider is gone">
        <p>
          The gateway no longer has that model&apos;s provider. Choose another embedding model
          above; memory search uses word matching meanwhile.
        </p>
      </Notice>
    );
  }
  return null;
}

export function MemoryVectorsSection({
  resource,
}: {
  readonly resource: { readonly state: ResourceState<MemoryVectors>; readonly reload: () => void };
}) {
  const mutation = useMutation();
  const { state, reload } = resource;
  if (state.status !== "ready") return null;
  const v = state.data;
  const notice = vectorNotice(v);
  const usable = notice === null;
  const coverage = v.coverage;
  const job = v.job;
  const elsewhere = job?.state !== "running" && v.runningElsewhere === true;
  const running = job?.state === "running" || elsewhere;

  async function build() {
    const done = await mutation.run(
      (): Promise<ApiResult<unknown>> => buildMemoryVectors(),
      () => "Building vectors in the background.",
    );
    if (done) reload();
  }

  return (
    <section aria-label="Search by meaning" className="my-6">
      <h3 className="text-base font-semibold">Search by meaning</h3>
      {notice}
      {usable && coverage && (
        <p>
          {coverage.embedded} of {coverage.total} memories have vectors from <code>{v.model}</code>.
          {coverage.embedded < coverage.total &&
            " The rest are found by word matching until they are embedded."}
        </p>
      )}
      {job && running && !elsewhere && (
        <p role="status">Building vectors: {job.embedded} embedded so far.</p>
      )}
      {elsewhere && <p role="status">Building vectors on another server replica.</p>}
      {job && !elsewhere && job.state === "stopped" && (
        <Notice tone="warn" title="Building vectors stopped">
          <p>
            {job.embedded} embedded before it stopped: {stopText(job)}. Start it again when that is
            fixed.
          </p>
        </Notice>
      )}
      {usable && (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            variant="secondary"
            disabled={mutation.pending || running || coverage?.embedded === coverage?.total}
            onClick={() => void build()}
          >
            {coverage && coverage.embedded > 0 ? "Re-embed" : "Build vectors"}
          </Button>
          <Button variant="ghost" onClick={reload}>
            Refresh
          </Button>
        </div>
      )}
      <p className="text-sm text-console-muted">
        Embedding calls are paid by whoever causes them: the person saving a memory (in the
        workspace they act in), the member whose message is searched, and you for Build vectors (in
        your active workspace). Build vectors covers every workspace: with no active workspace, each
        workspace pays for its own memories (you when you are a member, else its first team admin)
        and the site&apos;s and portable memories are paid in the workspace you joined first. A
        workspace at 100% of a budget line gets no vectors; its memories stay on word matching.
      </p>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
    </section>
  );
}
