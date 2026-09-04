import * as vscode from "vscode";
import type { Profile } from "../profiles/model";
import { livenessFrom, type LivenessSignal } from "./state";

/**
 * Bounded liveness polling. The bounds ARE the design:
 *
 * - ONE poller for the whole extension, targeting the ACTIVE profile
 *   only — eight configured operators never mean eight connections.
 * - Runs only while the hosting view is visible; hiding the view stops
 *   all traffic.
 * - Interval is configurable; 0 disables polling entirely.
 * - Failures back off exponentially (capped) — one unreachable
 *   operator must not become a retry storm — and the failure state is
 *   `Unmonitored`, never "unhealthy".
 */

export interface PollerDeps {
  /** Resolve latency in ms; throws when the operator does not answer. */
  ping(profile: Profile): Promise<number>;
  /** Poll interval in ms; 0 disables. Read before every scheduling. */
  intervalMs(): number;
  /** Clock, injectable for tests. */
  now?(): Date;
}

/** Failed polls back off by doubling, capped at this many intervals. */
const BACKOFF_CAP_FACTOR = 8;

export class HealthPoller implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  /** Fires after every poll result (success or failure). */
  readonly onDidUpdate = this.emitter.event;

  private profile: Profile | undefined;
  private visible = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private consecutiveFailures = 0;
  private readonly liveness = new Map<string, LivenessSignal>();
  private disposed = false;

  constructor(private readonly deps: PollerDeps) {}

  /** The last-known liveness for a profile; undefined = never polled. */
  livenessFor(profileId: string): LivenessSignal | undefined {
    return this.liveness.get(profileId);
  }

  /** The delay the NEXT poll is scheduled with (visible for tests). */
  currentDelayMs(): number {
    const base = this.deps.intervalMs();
    if (base <= 0) {
      return 0;
    }
    const factor = Math.min(2 ** this.consecutiveFailures, BACKOFF_CAP_FACTOR);
    return base * factor;
  }

  setActiveProfile(profile: Profile | undefined): void {
    if (this.profile?.id === profile?.id) {
      this.profile = profile;
      return;
    }
    this.profile = profile;
    this.consecutiveFailures = 0;
    this.restart();
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) {
      return;
    }
    this.visible = visible;
    this.restart();
  }

  /** Re-read the interval setting and reschedule (or stop). */
  restart(): void {
    this.stopTimer();
    if (!this.visible || !this.profile || this.deps.intervalMs() <= 0) {
      return;
    }
    // First poll promptly on becoming visible/active; then interval.
    void this.pollOnce().then(() => this.schedule());
  }

  private schedule(): void {
    this.stopTimer();
    if (
      this.disposed ||
      !this.visible ||
      !this.profile ||
      this.deps.intervalMs() <= 0
    ) {
      return;
    }
    this.timer = setTimeout(() => {
      void this.pollOnce().then(() => this.schedule());
    }, this.currentDelayMs());
  }

  /** One poll of the active profile. Never throws. */
  async pollOnce(): Promise<void> {
    const profile = this.profile;
    if (!profile) {
      return;
    }
    const at = (this.deps.now?.() ?? new Date()).toISOString();
    const previous = this.liveness.get(profile.id);
    try {
      const latencyMs = await this.deps.ping(profile);
      this.consecutiveFailures = 0;
      this.liveness.set(
        profile.id,
        livenessFrom({ ok: true, latencyMs, at }, previous),
      );
    } catch {
      this.consecutiveFailures += 1;
      this.liveness.set(profile.id, livenessFrom({ ok: false, at }, previous));
    }
    this.emitter.fire();
  }

  private stopTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stopTimer();
    this.emitter.dispose();
  }
}
