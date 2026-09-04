/**
 * Operator health: TWO independent signals, never one dot.
 *
 * - Liveness   — did the operator answer /v1/ping?
 * - Correctness — are its resources in the state they declare?
 *
 * This mirrors the heartbeat-vs-verdict split the org's synthetic
 * monitoring runs on: a dead runner and a broken service are different
 * incidents, and one indicator cannot express both. The two signals
 * are therefore rendered as two separate lines, and no function in
 * this module (or anywhere else) folds them into a single value.
 *
 * `Unmonitored` is the third liveness state a boolean cannot hold: an
 * operator that has not answered is not healthy and not failing — it
 * is UNOBSERVED. Absence of a signal is not a verdict.
 */

/** Liveness — the answer to "did the operator answer?". */
export type LivenessSignal =
  | { signal: "reachable"; latencyMs: number; checkedAt: string }
  | {
      signal: "unmonitored";
      /** Last time the operator DID answer, if it ever has. */
      lastResponseAt?: string;
    };

/** One resource whose status is not Ready. */
export interface NotReadyResource {
  kind: string;
  name: string;
  /** The operator's own status word, verbatim. */
  state: string;
}

/** Correctness — the answer to "are the resources actually Ready?". */
export type CorrectnessSignal =
  | { signal: "all-ready"; total: number; checkedAt: string }
  | {
      signal: "not-ready";
      total: number;
      notReady: NotReadyResource[];
      checkedAt: string;
    }
  | {
      /**
       * "Partially observed" is a real state and is displayed as one,
       * naming the missing signal — never silently upgraded to
       * healthy, never downgraded to failing.
       */
      signal: "unavailable";
      reason: string;
    };

/** Both axes, side by side — deliberately NOT merged into a verdict. */
export interface OperatorHealth {
  liveness: LivenessSignal;
  correctness: CorrectnessSignal;
}

/** Fold a ping outcome into the liveness signal. */
export function livenessFrom(
  outcome:
    { ok: true; latencyMs: number; at: string } | { ok: false; at: string },
  previous?: LivenessSignal,
): LivenessSignal {
  if (outcome.ok) {
    return {
      signal: "reachable",
      latencyMs: outcome.latencyMs,
      checkedAt: outcome.at,
    };
  }
  // No answer is NOT "unhealthy" — it is unmonitored, with the last
  // successful response carried forward so the UI can say since when.
  return {
    signal: "unmonitored",
    lastResponseAt:
      previous?.signal === "reachable"
        ? previous.checkedAt
        : previous?.signal === "unmonitored"
          ? previous.lastResponseAt
          : undefined,
  };
}

/** A render-ready line for one axis: codicon name + text. */
export interface HealthLine {
  icon: string;
  text: string;
}

/** Render the liveness axis (one line, never merged with correctness). */
export function livenessLine(liveness: LivenessSignal): HealthLine {
  if (liveness.signal === "reachable") {
    return {
      icon: "pass-filled",
      text: `Reachable — ${liveness.latencyMs} ms (${liveness.checkedAt})`,
    };
  }
  return {
    icon: "circle-large-outline",
    text: liveness.lastResponseAt
      ? `Unmonitored — no response since ${liveness.lastResponseAt}`
      : "Unmonitored — no response yet",
  };
}

/** Render the correctness axis (one line, never merged with liveness). */
export function correctnessLine(correctness: CorrectnessSignal): HealthLine {
  switch (correctness.signal) {
    case "all-ready":
      return {
        icon: "check-all",
        text: `${correctness.total} of ${correctness.total} resources Ready`,
      };
    case "not-ready":
      return {
        icon: "warning",
        text: `${correctness.notReady.length} of ${correctness.total} resources not Ready`,
      };
    case "unavailable":
      return {
        icon: "question",
        text: `Partially observed — correctness unavailable (${correctness.reason})`,
      };
  }
}
