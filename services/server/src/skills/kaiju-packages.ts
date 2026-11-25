import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KAIJU_SKILL_NAMES, canonicalZip, type KaijuSkillManifest } from "@kaiju/protocol";
import { validateZipBundle, type ValidBundle } from "./bundle.js";

/**
 * The package set of Kaiju's own catalog skills (KOBE-317, SK4): the former built-ins, one
 * directory per skill under `services/server/builtin-skills/<name>/`, shipped with the server
 * image (so a Kaiju release updates them without a sandbox image rebuild). Each holds the skill's
 * files and a manifest (`kaiju.skill.yaml` since KOBE-833) whose `version` is the catalog semver:
 * changing a skill's files means raising it (`kaiju-packages.test.ts` holds each version's hash).
 *
 * Every package goes through the upload's own checks (`validateZipBundle`: limits, paths,
 * SKILL.md, manifest), so a Kaiju skill is held to the rules a member's upload is.
 */
export const KAIJU_PACKAGES_DIR = fileURLToPath(new URL("../../builtin-skills", import.meta.url));

export interface KaijuPackage {
  readonly name: string;
  readonly semver: string;
  readonly manifest: KaijuSkillManifest;
  readonly bundle: ValidBundle;
}

export class KaijuPackageError extends Error {
  constructor(message: string) {
    super(`skills: Kaiju package set: ${message}`);
    this.name = "KaijuPackageError";
  }
}

/** The files of one package directory, by relative `/` path; symlinks and specials refused. */
async function readTree(root: string): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  const walk = async (dir: string, rel: string): Promise<void> => {
    for (const entry of (await readdir(dir)).sort()) {
      const full = path.join(dir, entry);
      const at = rel === "" ? entry : `${rel}/${entry}`;
      const info = await lstat(full);
      if (info.isDirectory()) await walk(full, at);
      else if (info.isFile()) files.set(at, new Uint8Array(await readFile(full)));
      else throw new KaijuPackageError(`${at} is not a regular file`);
    }
  };
  await walk(root, "");
  return files;
}

/** One package: its directory's files as a checked bundle with a manifest naming it. */
export async function readKaijuPackage(dir: string, name: string): Promise<KaijuPackage> {
  const files = await readTree(path.join(dir, name));
  const checked = validateZipBundle(canonicalZip(files));
  if (!checked.ok) throw new KaijuPackageError(`${name}: ${checked.error.message}`);
  const bundle = checked.value;
  if (bundle.name !== name)
    throw new KaijuPackageError(`${name}: SKILL.md names ${bundle.name}, not its directory`);
  if (!bundle.manifest) throw new KaijuPackageError(`${name}: the manifest is missing`);
  return { name, semver: bundle.manifest.version, manifest: bundle.manifest, bundle };
}

/** The whole set, in `KAIJU_SKILL_NAMES` order: exactly those directories, nothing else. */
export async function loadKaijuPackages(dir: string = KAIJU_PACKAGES_DIR): Promise<KaijuPackage[]> {
  const present = (await readdir(dir)).filter((n) => !n.startsWith(".")).sort();
  const expected = [...KAIJU_SKILL_NAMES].sort();
  if (present.join(",") !== expected.join(","))
    throw new KaijuPackageError(`expected ${expected.join(", ")}, found ${present.join(", ")}`);
  const out: KaijuPackage[] = [];
  for (const name of KAIJU_SKILL_NAMES) out.push(await readKaijuPackage(dir, name));
  return out;
}
