/** The active team (D9) for the chat (KOBE-716: out of `components/chat/chat-app.tsx`). */
import { useEffect, useState } from "react";
import { ACTIVE_TEAM_EVENT, fetchMyTeams } from "../teams";

export type TeamState =
  | { readonly status: "loading" }
  | { readonly status: "signedOut" }
  | { readonly status: "noTeam" }
  /** Teams but none active yet: `TeamActivation` is choosing one (KOBE-419 review S3). */
  | { readonly status: "choosing" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly teamId: string; readonly teamName: string };

/** The active team (D9), asked again when the switcher activates one on first load. */
export function useActiveTeam(fetchFn?: typeof fetch): TeamState {
  const [state, setState] = useState<TeamState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const retry = () => setAttempt((n) => n + 1);
    window.addEventListener(ACTIVE_TEAM_EVENT, retry);
    return () => window.removeEventListener(ACTIVE_TEAM_EVENT, retry);
  }, []);
  useEffect(() => {
    let current = true;
    fetchMyTeams(fetchFn).then(
      (my) => {
        if (!current) return;
        if (my === null) setState({ status: "signedOut" });
        else if (my.activeTeamId === null) {
          setState({ status: my.teams.length > 0 ? "choosing" : "noTeam" });
        } else {
          const active = my.teams.find((t) => t.id === my.activeTeamId);
          setState({ status: "ready", teamId: my.activeTeamId, teamName: active?.name ?? "" });
        }
      },
      (e: unknown) => {
        if (current) {
          setState({
            status: "error",
            message: e instanceof Error ? e.message : "Could not load your teams.",
          });
        }
      },
    );
    return () => {
      current = false;
    };
  }, [attempt, fetchFn]);
  return state;
}
