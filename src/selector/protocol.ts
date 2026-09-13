/**
 * The selector view's wire: one state object from the extension to the
 * webview, four actions back. Shared by both bundles; imports nothing
 * from `vscode` or Node. Nothing here ever carries a token — a test
 * greps the state for every secret shape the extension knows.
 */

export type Reach = "reachable" | "unreachable" | "unknown";
export type Credential = "signed-in" | "needs-sign-in" | "unknown";

export interface SelectorProfile {
  id: string;
  label: string;
  fqdn: string;
  authMode: "zitadel" | "bearer";
}

export interface SelectorActive extends SelectorProfile {
  reach: Reach;
  /** Milliseconds, when the last liveness probe answered. */
  latencyMs?: number;
  credential: Credential;
}

export interface SelectorState {
  active?: SelectorActive;
  profiles: SelectorProfile[];
  /** True while a probe or a sign-in is in flight. */
  busy: boolean;
}

export type SelectorAction =
  | { type: "load" }
  | { type: "switch"; id: string }
  | { type: "signInAgain" }
  | { type: "connect" }
  | { type: "refresh" };

export type SelectorHostMessage = { type: "state"; state: SelectorState };

/** Parse a webview message defensively; undefined means "drop it". */
export function parseSelectorAction(raw: unknown): SelectorAction | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const m = raw as Record<string, unknown>;
  switch (m.type) {
    case "load":
    case "signInAgain":
    case "connect":
    case "refresh":
      return { type: m.type };
    case "switch":
      return typeof m.id === "string" && m.id.length > 0
        ? { type: "switch", id: m.id }
        : undefined;
    default:
      return undefined;
  }
}
