import type { KaijuTx } from "../../client.js";

/** Inserts one row into a team table for `teamId` (inside a withTeam transaction). */
export type ProbeFixture = (tx: KaijuTx, teamId: string) => Promise<void>;
