"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { projectPermissions } from "@kaiju/protocol";
import { saveBytes } from "../../lib/files/save";
import { worded, type Project, type ProjectInput } from "../../lib/projects/api";
import { useTeamAccess } from "../admin/console-context";
import { MutationStatus } from "../admin/error-notice";
import { ResourceView } from "../admin/parts";
import { useResource } from "../admin/use-resource";
import { useProjectMutation } from "./use-project-mutation";
import {
  Badge,
  Button,
  Notice,
  PageHeader,
  Section,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  eventTrigger,
  useConfirm,
} from "../ui/console";
import { inputOf, ProjectForm } from "./project-form";
import { ProjectFiles } from "./project-files";
import { ProjectHistory } from "./project-history";
import { ProjectMembers } from "./project-members";
import { ProjectStorage } from "./project-storage";
import { ProjectThreads } from "./project-threads";
import { ProjectWorkingCopies } from "./project-working-copies";
import { useCommitsApi, useProjectAgents, useProjectsApi } from "./use-projects";
import { useNavigate } from "../shell/use-navigate";
import { SuggestionsReview } from "../memory/suggestions/suggestions-review";
import { isUuid } from "../../lib/memory/ids";

/**
 * One project (`/v1/projects/:id`, KOBE-161/162/163; Workspaces KOBE-581): Overview (settings,
 * visibility and people, files, storage, conversations) and History (commits, diffs, downloads
 * at a commit, Revert; working copies for owners and admins). "Open to mount" while the project
 * is not in the member's files (no conversation of theirs in it, no checkout; MT1, FP2). Memory:
 * readers' suggestions for the project's notes (KOBE-652); the bell's `?suggestion=<id>` opens it.
 */
export function ProjectDetailPage({ projectId }: { readonly projectId: string }) {
  const api = useProjectsApi();
  const { state, reload } = useResource(() => api.get(projectId));
  const back = <Link href="/me/projects">All projects</Link>;
  return (
    <ResourceView state={state} label="the project">
      {(project) => <ProjectView project={project} back={back} onChanged={reload} />}
    </ResourceView>
  );
}

function ProjectView({
  project,
  back,
  onChanged,
}: {
  readonly project: Project;
  readonly back: ReactNode;
  readonly onChanged: () => void;
}) {
  const access = useTeamAccess();
  const api = useProjectsApi();
  const agents = useProjectAgents(api);
  const mutation = useProjectMutation();
  const navigate = useNavigate();
  const [confirm, confirmDialog] = useConfirm();
  const can = projectPermissions(access.role, project.myRole ?? undefined);
  // `#history` (the proposal card's "Open History" link) opens the History tab.
  const [tab, setTab] = useState("overview");
  const [suggestion, setSuggestion] = useState<string | null>(null);
  useEffect(() => {
    if (window.location.hash === "#history") setTab("history");
    const asked = new URLSearchParams(window.location.search).get("suggestion");
    if (asked !== null && isUuid(asked)) {
      setSuggestion(asked.toLowerCase());
      setTab("memory");
    }
  }, []);
  const commits = useCommitsApi();
  const threads = useResource(() => api.threads(project.id));
  const checkout = useResource(() => commits.checkoutState(project.id));
  const me = access.user.id;
  const mounted =
    (threads.state.status === "ready" &&
      threads.state.data.threads.some((t) => t.ownerUserId === me)) ||
    (checkout.state.status === "ready" && checkout.state.data !== null);
  const archived = project.archivedAt !== null;
  const canEdit = can.manage && !archived;

  async function save(input: ProjectInput) {
    if (
      await mutation.run(
        async () => worded(await api.update(project.id, input)),
        () => "Saved.",
      )
    ) {
      onChanged();
    }
  }

  async function archive(value: boolean, trigger: HTMLElement | null) {
    if (
      value &&
      !(await confirm(
        {
          title: `Archive ${project.name}?`,
          description: "It becomes read-only; shared conversations stay readable.",
          confirmLabel: "Archive project",
        },
        trigger,
      ))
    ) {
      return;
    }
    const done = await mutation.run(
      async () => worded(await api.update(project.id, { archived: value })),
      () => (value ? "Archived." : "Restored."),
    );
    if (done) onChanged();
  }

  async function downloadZip() {
    await mutation.run(
      () => api.downloadHead(project.id),
      (bytes) => {
        saveBytes(`${project.slug}.zip`, bytes);
        return `Downloaded ${project.slug}.zip.`;
      },
    );
  }

  /** KOBE-780 (P2-42): members whose working copy holds changes the delete would discard. */
  async function uncommittedCount(): Promise<number> {
    const copies = await commits.workingCopies(project.id);
    return copies.ok ? copies.data.filter((c) => c.changedFiles > 0).length : 0;
  }

  const uncommittedNote = (n: number): string =>
    n === 0
      ? ""
      : n === 1
        ? " 1 member has uncommitted changes in a working copy; deleting the project discards them."
        : ` ${n} members have uncommitted changes in their working copies; deleting the project discards them.`;

  /**
   * The delete carries the count the member confirmed; when the server finds more uncommitted
   * working copies by then (409 `uncommitted_work`), it asks again with the new count.
   */
  async function remove(trigger: HTMLElement | null) {
    let confirmed = await uncommittedCount();
    for (let attempt = 0; attempt < 3; attempt++) {
      const yes = await confirm(
        {
          title: `Delete ${project.name} for good?`,
          description: `Archive it instead to keep its history.${uncommittedNote(confirmed)}`,
          confirmLabel: "Delete project",
        },
        trigger,
      );
      if (!yes) return;
      let more: number | undefined;
      const done = await mutation.run(
        async () => {
          const res = await api.remove(project.id, confirmed);
          const now = res.ok ? undefined : res.error.details?.uncommittedWorkingCopies;
          if (!res.ok && res.error.code === "uncommitted_work" && typeof now === "number") {
            more = now;
          }
          return worded(res);
        },
        () => "Deleted.",
      );
      if (done) {
        navigate("/me/projects");
        return;
      }
      if (more === undefined) return;
      confirmed = more;
    }
  }

  return (
    <>
      <PageHeader
        back={back}
        title={
          <>
            {project.name}
            {archived && " (archived)"}
          </>
        }
        actions={
          <>
            {can.converse && !archived && (
              <Button asChild variant="primary">
                <Link href={`/?project=${project.id}`} aria-describedby="project-mount-hint">
                  {mounted ? "Open in a conversation" : "Open to mount"}
                </Link>
              </Button>
            )}
            <Button disabled={mutation.pending} onClick={() => void downloadZip()}>
              Download as zip
            </Button>
            {can.view && (
              <Button asChild>
                <Link href={`/me/memory?project=${project.id}`}>Project memory</Link>
              </Button>
            )}
          </>
        }
      />
      {archived && (
        <Notice tone="warn" role="note">
          <p>
            This project is archived and read-only. Its files and shared conversations stay
            readable.
          </p>
        </Notice>
      )}
      {can.converse && !archived && (
        <p id="project-mount-hint" className="m-0 mb-2 text-sm text-console-muted">
          {mounted
            ? `In your files under projects/${project.slug}.`
            : `Not in your files yet: open it in a conversation and it appears under projects/${project.slug}.`}
        </p>
      )}
      {!can.edit && (
        <p className="m-0 mb-2 text-sm">
          <Badge>reader</Badge> You can read this project and start conversations in it, not change
          its files.
        </p>
      )}
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <Tabs value={tab} onValueChange={setTab} className="mt-2">
        <TabsList label="Project">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
          <TabsTrigger value="memory">Memory</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <Section title="Settings">
            {!can.manage && (
              <p className="m-0 text-sm text-console-muted">
                Only the project&apos;s owners and team admins can change these.
              </p>
            )}
            <ProjectForm
              key={project.updatedAt}
              initial={inputOf(project)}
              agents={agents}
              submitLabel="Save changes"
              disabled={!canEdit}
              pending={mutation.pending}
              onSubmit={(input) => void save(input)}
            />
            {can.manage && (
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={mutation.pending}
                  onClick={(e) => void archive(!archived, eventTrigger(e))}
                >
                  {archived ? "Restore project" : "Archive project"}
                </Button>
                <Button
                  variant="danger"
                  disabled={mutation.pending}
                  onClick={(e) => void remove(eventTrigger(e))}
                >
                  Delete project
                </Button>
              </div>
            )}
          </Section>
          <ProjectMembers project={project} canManage={can.manage_members} />
          <ProjectFiles project={project} canManage={can.edit} />
          <ProjectStorage project={project} />
          <ProjectThreads project={project} state={threads.state} />
        </TabsContent>
        <TabsContent value="history">
          <ProjectHistory project={project} canRevert={can.edit} />
          {can.manage && <ProjectWorkingCopies project={project} />}
        </TabsContent>
        <TabsContent value="memory">
          <SuggestionsReview teamId={access.team.id} projectId={project.id} focusId={suggestion} />
        </TabsContent>
      </Tabs>
      {confirmDialog}
    </>
  );
}
