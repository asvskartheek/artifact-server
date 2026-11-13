/**
 * Studio session ownership, stored as two artifact tags:
 *
 *   owner:<session>  the agent session that created the artifact (never moves)
 *   live:<session>   the session currently working on it (last publish/attach)
 *
 * New comments go to the live session; see the review UI's comment routing.
 * Tags hold at most 40 characters, so a session is stored as a short hash
 * (sessionKey); agents register with the same key in their connectionKey.
 * Sessions come from the agent host's environment: pi sets PI_SESSION_ID,
 * Copilot sets COPILOT_AGENT_SESSION_ID. Outside an agent there is no session
 * and nothing is stamped.
 */
import {createHash} from "node:crypto";

import {Option, type Command} from "commander";
import {Redacted} from "effect";
import {z} from "zod";

import {resolveCliServerConnection} from "./cli-server-connection.js";

export const ownerTagPrefix = "owner:";
export const liveTagPrefix = "live:";

/** A short, stable, tag-safe key for one agent session. */
export function sessionKey(session: string): string {
  return createHash("sha256").update(session, "utf8").digest("hex").slice(0, 12);
}

/** The agent session running this command, or null outside an agent. */
export function currentAgentSession(environment: NodeJS.ProcessEnv = process.env): string | null {
  const session = environment["PI_SESSION_ID"] ?? environment["COPILOT_AGENT_SESSION_ID"];
  const trimmed = session?.trim() ?? "";
  return trimmed === "" ? null : sessionKey(trimmed);
}

/** Tags after `session` touches the artifact: owner kept (or set), live moved. */
export function tagsAfterTouch(tags: readonly string[], session: string): readonly string[] {
  const hasOwner = tags.some((tag) => tag.startsWith(ownerTagPrefix));
  return [
    ...tags.filter((tag) => !tag.startsWith(liveTagPrefix)),
    ...(hasOwner ? [] : [`${ownerTagPrefix}${session}`]),
    `${liveTagPrefix}${session}`,
  ];
}

const artifactTagsResponseSchema = z.object({
  artifact: z.object({currentVersionId: z.string(), tags: z.array(z.string())}),
});

/** Mark `session` live on one artifact (and owner, if it has none yet). */
export async function touchArtifact(
  origin: string,
  token: string,
  projectId: string,
  artifactId: string,
  session: string,
): Promise<void> {
  const base = `${origin}/api/v1/artifacts/${encodeURIComponent(artifactId)}`;
  const query = `projectId=${encodeURIComponent(projectId)}`;
  const headers = {Authorization: `Bearer ${token}`, "Content-Type": "application/json"};
  const details = await fetch(`${base}?${query}`, {headers});
  if (!details.ok) throw new Error(`Reading the artifact answered ${details.status}.`);
  const {artifact} = artifactTagsResponseSchema.parse(await details.json());
  const tags = tagsAfterTouch(artifact.tags, session);
  if (tags.join("\n") === artifact.tags.join("\n")) return;
  const changed = await fetch(`${base}/tags?${query}`, {
    body: JSON.stringify({expectedCurrentVersionId: artifact.currentVersionId, tags}),
    headers: {...headers, "Idempotency-Key": `touch-${artifactId}-${session}-${Date.now()}`},
    method: "PATCH",
  });
  if (!changed.ok) throw new Error(`Marking the session live answered ${changed.status}.`);
}

/** `artifactserver attach <artifact-link-or-id>`: make this session live on it. */
export function configureAttachCommand(
  program: Command,
  defaultProfileDirectory: string,
): void {
  program
    .command("attach")
    .description("Make this agent session the live one on an artifact, so its new comments come here.")
    .argument("<artifact>", "review link or artifact ID")
    .addOption(new Option("--data <directory>", "local Artifact Server data directory").default(".artifact-server"))
    .addOption(new Option("--project <id>", "project ID").default("prj_default"))
    .addOption(new Option("--profile-data <directory>", "user-local CLI profile directory")
      .default(defaultProfileDirectory).env("ARTIFACT_SERVER_HOME"))
    .action(async (reference: string, options: {
      readonly data: string;
      readonly profileData: string;
      readonly project: string;
    }) => {
      const session = currentAgentSession();
      if (session === null) {
        throw new Error("attach runs inside an agent session (pi or GitHub Copilot); none was found.");
      }
      const fromLink = /[?&]artifact=([^&]+)/u.exec(reference)?.[1] ?? /art_[\w-]+/u.exec(reference)?.[0];
      const projectFromLink = /[?&]project=([^&]+)/u.exec(reference)?.[1];
      if (fromLink === undefined) throw new Error("Pass a review link or an artifact ID (art_…).");
      const connection = await resolveCliServerConnection(options, "publish");
      const projectId = decodeURIComponent(projectFromLink ?? options.project);
      const artifactId = decodeURIComponent(fromLink);
      await touchArtifact(connection.origin, Redacted.value(connection.apiToken), projectId, artifactId, session);
      console.log(JSON.stringify({artifactId, live: session, projectId}, null, 2));
    });
}
