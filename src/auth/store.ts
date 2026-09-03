import * as vscode from "vscode";

/**
 * SecretStorage wrapper — the ONLY module that touches secrets.
 *
 * Keys:
 *   airdress.profile.<id>.refresh  — ZITADEL refresh token
 *   airdress.profile.<id>.bearer   — opaque operator bearer
 *
 * Access tokens live in memory for the extension-host lifetime only and
 * are never persisted. Nothing here is synced (design §4.5).
 */
export class SecretStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async getRefreshToken(profileId: string): Promise<string | undefined> {
    return this.secrets.get(`airdress.profile.${profileId}.refresh`);
  }

  async setRefreshToken(profileId: string, token: string): Promise<void> {
    await this.secrets.store(`airdress.profile.${profileId}.refresh`, token);
  }

  async getBearer(profileId: string): Promise<string | undefined> {
    return this.secrets.get(`airdress.profile.${profileId}.bearer`);
  }

  async setBearer(profileId: string, token: string): Promise<void> {
    await this.secrets.store(`airdress.profile.${profileId}.bearer`, token);
  }

  /** Remove every secret belonging to a profile (sign-out / delete). */
  async clearProfile(profileId: string): Promise<void> {
    await this.secrets.delete(`airdress.profile.${profileId}.refresh`);
    await this.secrets.delete(`airdress.profile.${profileId}.bearer`);
  }
}
