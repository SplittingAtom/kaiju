"use client";

/**
 * Workspace settings → Storage and history: rebuild a member's workspace whose storage was lost
 * with its server (KOBE-739; `/v1/team/workspaces/{userId}/rebuild`, team admins). The admin picks
 * the member; the dialog checks that the volume is really lost, shows the last sync time and what
 * will be lost, and asks to confirm. Audited with the admin as actor.
 */
import { useMemo, useState } from "react";
import { listTeamMembers } from "../../../lib/admin/api/team/members";
import { createRebuildApi } from "../../../lib/workspace/rebuild";
import { RebuildWorkspaceDialog } from "../../files/rebuild-workspace-dialog";
import { Button, Field, FormRow, Section, Select } from "../../ui/console";
import { useTeamAccess } from "../console-context";
import { ResourceView } from "../parts";
import { useResource } from "../use-resource";

export function WorkspaceRebuildSection() {
  const teamId = useTeamAccess().team.id;
  const roster = useResource(() => listTeamMembers(teamId));
  const [userId, setUserId] = useState("");
  const [open, setOpen] = useState(false);
  const api = useMemo(
    () => (userId === "" ? null : createRebuildApi(teamId, undefined, userId)),
    [teamId, userId],
  );
  return (
    <Section
      title="Rebuild a lost sandbox"
      description="When the server holding a member's sandbox storage is gone, their sandbox can't start. Rebuild it from the last sync of their My files: Kobe checks that the storage is really lost and shows what will be lost before you confirm."
    >
      <ResourceView state={roster.state} label="members">
        {(members) => {
          const name = members.find((m) => m.userId === userId)?.name;
          return (
            <FormRow className="mt-0">
              <Field label="Member">
                <Select value={userId} onChange={(e) => setUserId(e.target.value)}>
                  <option value="">Choose a member</option>
                  {members.map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button type="button" disabled={api === null} onClick={() => setOpen(true)}>
                Check and rebuild…
              </Button>
              {api && (
                <RebuildWorkspaceDialog
                  api={api}
                  open={open}
                  onOpenChange={setOpen}
                  memberName={name}
                />
              )}
            </FormRow>
          );
        }}
      </ResourceView>
    </Section>
  );
}
