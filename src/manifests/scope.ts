import * as YAML from "yaml";
import type { Profile } from "../profiles/model";
import { parseManifest } from "./validate";

/**
 * Scoped apply: a manifest FILE may declare several resources (YAML
 * multi-document form). Apply can then target a selected subset — with
 * apply-everything remaining the one-click default. These helpers are
 * pure so the selection and confirmation wording are unit-testable.
 */

/** One appliable document within a manifest file. */
export interface PlannedDoc {
  kind: string;
  name: string;
  /** The exact text to POST for this document. */
  text: string;
  /** Character offset of the document in the source file (diagnostics). */
  offset: number;
}

/**
 * Split manifest text into appliable documents.
 *
 * - JSON is always a single document.
 * - YAML uses the multi-document form; a single-document file keeps its
 *   ORIGINAL text byte-for-byte (the long-standing single-file path),
 *   while multi-document files are split on document boundaries.
 * - Every document must carry a well-formed envelope; the first
 *   malformed one fails the whole plan — applying "the valid half" of
 *   a file is a partial write nobody asked for.
 */
export function planApplyDocuments(
  text: string,
  languageId: string,
): { docs: PlannedDoc[] } | { error: string } {
  if (languageId === "json") {
    const parsed = parseManifest(text);
    if ("error" in parsed) {
      return { error: parsed.error };
    }
    return {
      docs: [
        {
          kind: parsed.envelope.kind,
          name: parsed.envelope.metadata.name,
          text,
          offset: 0,
        },
      ],
    };
  }

  let documents: YAML.Document.Parsed[];
  try {
    documents = YAML.parseAllDocuments(text);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  const nonEmpty = documents.filter((d) => d.contents !== null);
  if (nonEmpty.length === 0) {
    return { error: "The file contains no manifest documents." };
  }

  const docs: PlannedDoc[] = [];
  for (const document of nonEmpty) {
    for (const yamlError of document.errors) {
      return { error: yamlError.message };
    }
    const docText =
      nonEmpty.length === 1
        ? text
        : text.slice(document.range[0], document.range[2]);
    const parsed = parseManifest(docText);
    if ("error" in parsed) {
      return {
        error: `Document ${docs.length + 1} of ${nonEmpty.length}: ${parsed.error}`,
      };
    }
    docs.push({
      kind: parsed.envelope.kind,
      name: parsed.envelope.metadata.name,
      text: docText,
      offset: document.range[0],
    });
  }
  return { docs };
}

/**
 * The apply confirmation, naming every selected resource AND the
 * target profile + FQDN. The realistic accident is not "I did not mean
 * to apply" — it is "I did not mean to apply THERE", followed closely
 * by "not THOSE".
 */
export function applyConfirmation(
  selected: PlannedDoc[],
  profile: Profile,
): { message: string; detail?: string } {
  if (selected.length === 1) {
    return {
      message: `Apply ${selected[0].kind}/${selected[0].name} to profile "${profile.label}" (${profile.fqdn})?`,
    };
  }
  return {
    message: `Apply ${selected.length} resources to profile "${profile.label}" (${profile.fqdn})?`,
    detail: selected.map((d) => `${d.kind}/${d.name}`).join("\n"),
  };
}
