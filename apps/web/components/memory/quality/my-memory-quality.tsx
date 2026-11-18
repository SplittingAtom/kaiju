"use client";

import { useMemo } from "react";
import { createQualityApi, type QualityApi } from "../../../lib/memory/quality-api";
import { ItemFlags } from "./item-flags";

/**
 * My memory › How your memories are used (KOBE-411): the person's own memories in this
 * workspace with their run counts and the Check this / Not used lately flags.
 */
export function MyMemoryQuality({
  teamId,
  api: givenApi,
}: {
  readonly teamId: string;
  readonly api?: Pick<QualityApi, "items">;
}) {
  const api = useMemo(() => givenApi ?? createQualityApi("workspace", teamId), [givenApi, teamId]);
  return <ItemFlags api={api} scope="user" title="How your memories are used" />;
}
