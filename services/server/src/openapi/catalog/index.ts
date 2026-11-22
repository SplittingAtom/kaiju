import {
  catalogErrorResponses,
  catalogPaths,
  catalogSchemas,
  catalogTags,
  type CatalogArea,
} from "./build.js";
import { conversationsAreas } from "./conversations.js";
import { meAreas } from "./me.js";
import { memoryAreas } from "./memory.js";
import { projectsAgentsAreas } from "./projects-agents.js";
import { sitePeopleAreas } from "./site-people.js";
import { sitePlatformAreas } from "./site-platform.js";
import { siteSkillsAreas } from "./site-skills.js";
import { skillsAreas } from "./skills.js";
import { teamAreas } from "./team.js";
import { teamSkillsAreas } from "./team-skills.js";

/** Every catalog area (KOBE-727), in the order the document lists their tags. */
export const CATALOG_AREAS: readonly CatalogArea[] = [
  ...meAreas,
  ...conversationsAreas,
  ...projectsAgentsAreas,
  ...memoryAreas,
  ...skillsAreas,
  ...teamAreas,
  ...teamSkillsAreas,
  ...sitePeopleAreas,
  ...sitePlatformAreas,
  ...siteSkillsAreas,
];

export const catalogOpenApiPaths = () => catalogPaths(CATALOG_AREAS);
export const catalogOpenApiTags = () => catalogTags(CATALOG_AREAS);
export const catalogOpenApiSchemas = () => catalogSchemas(CATALOG_AREAS);
export const catalogOpenApiResponses = () => catalogErrorResponses();
