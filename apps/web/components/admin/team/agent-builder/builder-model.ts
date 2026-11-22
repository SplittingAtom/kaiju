"use client";

import { agentSlugSchema } from "@kobe/agent-file";
import { useMemo } from "react";
import type { AgentDetail } from "../../../../lib/admin/api/team/agent-builder";
import {
  EMPTY_FORM,
  fromFrontmatter,
  validateForm,
  type FieldErrors,
  type FormState,
} from "../../../../lib/admin/agent-builder/form-model";
import { isSkillSlug } from "../../../../lib/admin/skills/reach";
import { MEMORY_SETTING_LABELS } from "./memory-setting";
import type { MemoryChange } from "./version-history";
import { TEAM_TAB_HREF } from "../../../../lib/agents/redirects";

export type BuilderScope = "team" | "personal";

/** Where each scope's builder lives: the admin console for team agents, Agents otherwise. */
export const HOME: Readonly<
  Record<BuilderScope, { base: string; list: string; back: string; title: string }>
> = {
  // The list of team agents is the Agents page's Team tab (KOBE-570); the builder stays here.
  team: {
    base: "/admin/team/agents",
    list: TEAM_TAB_HREF,
    back: "All team agents",
    title: "New team agent",
  },
  personal: { base: "/agents", list: "/agents", back: "Agents", title: "New personal agent" },
};

/** The form with `slug` appended to its skills (unless listed already or not a skill name). */
export function withSkill(form: FormState, slug: string | undefined): FormState {
  if (slug === undefined || !isSkillSlug(slug)) return form;
  const listed = form.skills.split("\n").map((l) => l.trim());
  if (listed.includes(slug)) return form;
  return { ...form, skills: [...listed.filter((l) => l !== ""), slug].join("\n") };
}

export interface Baseline {
  readonly form: FormState;
  readonly prompt: string;
}

export const baselineOf = (agent: AgentDetail | null): Baseline =>
  agent
    ? { form: fromFrontmatter(agent.frontmatter), prompt: agent.prompt }
    : { form: EMPTY_FORM, prompt: "" };

/** What confirming a restore tells the member: a memory change and unsaved edits being replaced. */
export function restoreNotes(memory: MemoryChange | undefined, dirty: boolean): string[] {
  // KOBE-646 (review L2): a restore brings back that version's memory setting; say so.
  return [
    ...(memory
      ? [
          `Memory: ${MEMORY_SETTING_LABELS[memory.from].label} → ${MEMORY_SETTING_LABELS[memory.to].label}.`,
        ]
      : []),
    ...(dirty ? ["Your unsaved changes in the form are replaced."] : []),
  ];
}

/** The form's validation, the slug's, and the errors shown once a save was attempted. */
export function useBuilderErrors(
  form: FormState,
  prompt: string,
  agent: AgentDetail | null,
  slug: string,
  attempted: boolean,
) {
  const validation = useMemo(() => validateForm(form, prompt), [form, prompt]);
  const slugErrors = useMemo(() => {
    if (agent || slug === "" || agentSlugSchema.safeParse(slug).success) return [];
    return [
      "The slug needs 1-64 lowercase letters, digits or hyphens, starting and ending alphanumeric.",
    ];
  }, [agent, slug]);
  const errors: FieldErrors = attempted
    ? {
        ...(validation.ok ? {} : validation.errors),
        ...(slugErrors.length ? { slug: slugErrors } : {}),
      }
    : {};
  const problemCount = Object.values(errors).reduce((n, list) => n + (list?.length ?? 0), 0);
  return { validation, slugErrors, errors, problemCount };
}
