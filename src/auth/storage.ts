import {
  findEnvKeys,
  getEnvApiKey,
  type OAuthCredentials,
  type OAuthLoginCallbacks,
  type OAuthProviderId
} from "@earendil-works/pi-ai";
import { getOAuthApiKey, getOAuthProvider, getOAuthProviders } from "@earendil-works/pi-ai/oauth";
import { execSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { getArgonHome } from "../session/manager.js";

export type ApiKeyCredential = {
  type: "api_key";
  key: string;
};

export type OAuthCredential = {
  type: "oauth";
} & OAuthCredentials;

export type AuthCredential = ApiKeyCredential | OAuthCredential;
export type AuthStorageData = Record<string, AuthCredential>;

export type AuthStatus = {
  configured: boolean;
  source?: "stored" | "runtime" | "environment" | "models_json_key" | "models_json_command";
  label?: string;
};

type LockResult<T> = {
  result: T;
  next?: string;
};

export interface AuthStorageBackend {
  withLock<T>(fn: (current: string | undefined) => LockResult<T>): T;
  withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T>;
}

export class FileAuthStorageBackend implements AuthStorageBackend {
  constructor(private readonly authPath = getDefaultAuthPath()) {}

  readUnlocked(): string | undefined {
    return existsSync(this.authPath) ? readFileSync(this.authPath, "utf8") : undefined;
  }

  withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
    if (!existsSync(this.authPath)) {
      const { result, next } = fn(undefined);
      if (next !== undefined) this.write(next);
      return result;
    }
    const release = this.acquireLockSync();
    try {
      const { result, next } = fn(readFileSync(this.authPath, "utf8"));
      if (next !== undefined) this.write(next);
      return result;
    } finally {
      release();
    }
  }

  async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
    if (!existsSync(this.authPath)) {
      const { result, next } = await fn(undefined);
      if (next !== undefined) this.write(next);
      return result;
    }
    const release = await lockfile.lock(this.authPath, {
      realpath: false,
      retries: { retries: 10, factor: 2, minTimeout: 100, maxTimeout: 5000, randomize: true },
      stale: 30000
    });
    try {
      const { result, next } = await fn(readFileSync(this.authPath, "utf8"));
      if (next !== undefined) this.write(next);
      return result;
    } finally {
      await release();
    }
  }

  private acquireLockSync(): () => void {
    let lastError: unknown;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        return lockfile.lockSync(this.authPath, { realpath: false });
      } catch (error) {
        lastError = error;
        const code =
          typeof error === "object" && error !== null && "code" in error
            ? String((error as { code?: unknown }).code)
            : undefined;
        if (code !== "ELOCKED") break;
        const start = Date.now();
        while (Date.now() - start < 20) {
          // Synchronous startup path; keep the retry bounded and short.
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Failed to acquire auth storage lock");
  }

  private write(content: string): void {
    writeFileSync(this.authPath, content, "utf8");
    chmodSync(this.authPath, 0o600);
  }
}

export class InMemoryAuthStorageBackend implements AuthStorageBackend {
  private value: string | undefined;

  withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
    const { result, next } = fn(this.value);
    if (next !== undefined) this.value = next;
    return result;
  }

  async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
    const { result, next } = await fn(this.value);
    if (next !== undefined) this.value = next;
    return result;
  }
}

export class AuthStorage {
  private data: AuthStorageData = {};
  private runtimeOverrides = new Map<string, string>();
  private modelApiKeyStatus = new Map<string, "key" | "command">();

  private constructor(private readonly storage: AuthStorageBackend) {
    this.reload();
  }

  static create(authPath = getDefaultAuthPath()): AuthStorage {
    return new AuthStorage(new FileAuthStorageBackend(authPath));
  }

  static fromStorage(storage: AuthStorageBackend): AuthStorage {
    return new AuthStorage(storage);
  }

  static inMemory(data: AuthStorageData = {}): AuthStorage {
    const storage = new InMemoryAuthStorageBackend();
    storage.withLock(() => ({ result: undefined, next: JSON.stringify(data, null, 2) }));
    return AuthStorage.fromStorage(storage);
  }

  setRuntimeApiKey(provider: string, apiKey: string): void {
    this.runtimeOverrides.set(provider, apiKey);
  }

  setModelApiKeyStatus(provider: string, value: string | undefined): void {
    if (!value) {
      this.modelApiKeyStatus.delete(provider);
    } else {
      this.modelApiKeyStatus.set(provider, value.startsWith("!") ? "command" : "key");
    }
  }

  reload(): void {
    if (this.storage instanceof FileAuthStorageBackend) {
      this.data = parseAuthStorageData(this.storage.readUnlocked());
      return;
    }
    this.storage.withLock((current) => {
      this.data = parseAuthStorageData(current);
      return { result: undefined };
    });
  }

  get(provider: string): AuthCredential | undefined {
    return this.data[provider];
  }

  getAll(): AuthStorageData {
    return { ...this.data };
  }

  list(): string[] {
    return Object.keys(this.data);
  }

  set(provider: string, credential: AuthCredential): void {
    this.data[provider] = credential;
    this.persist(provider, credential);
  }

  remove(provider: string): void {
    delete this.data[provider];
    this.persist(provider, undefined);
  }

  logout(provider: string): void {
    this.remove(provider);
  }

  hasAuth(provider: string): boolean {
    return (
      this.runtimeOverrides.has(provider) ||
      this.data[provider] !== undefined ||
      getEnvApiKey(provider) !== undefined ||
      this.modelApiKeyStatus.has(provider)
    );
  }

  getAuthStatus(provider: string): AuthStatus {
    if (this.data[provider]) return { configured: true, source: "stored" };
    if (this.runtimeOverrides.has(provider)) return { configured: true, source: "runtime", label: "--api-key" };

    const envKeys = findEnvKeys(provider);
    if (envKeys?.[0]) return { configured: true, source: "environment", label: envKeys[0] };

    const modelKeyStatus = this.modelApiKeyStatus.get(provider);
    if (modelKeyStatus === "command") return { configured: true, source: "models_json_command" };
    if (modelKeyStatus === "key") return { configured: true, source: "models_json_key" };

    return { configured: false };
  }

  async login(providerId: OAuthProviderId, callbacks: OAuthLoginCallbacks): Promise<void> {
    const provider = getOAuthProvider(providerId);
    if (!provider) throw new Error(`Unknown OAuth provider: ${providerId}`);
    const credentials = await provider.login(callbacks);
    this.set(providerId, { type: "oauth", ...credentials });
  }

  async getApiKey(providerId: string): Promise<string | undefined> {
    const runtimeKey = this.runtimeOverrides.get(providerId);
    if (runtimeKey) return runtimeKey;

    const credential = this.data[providerId];
    if (credential?.type === "api_key") return resolveConfigValue(credential.key);
    if (credential?.type === "oauth") {
      const provider = getOAuthProvider(providerId);
      if (!provider) return undefined;
      if (Date.now() < credential.expires) return provider.getApiKey(credential);
      const refreshed = await this.refreshOAuthToken(providerId);
      return refreshed?.apiKey;
    }

    return getEnvApiKey(providerId);
  }

  getOAuthProviders() {
    return getOAuthProviders();
  }

  private persist(provider: string, credential: AuthCredential | undefined): void {
    this.storage.withLock((current) => {
      const next = parseAuthStorageData(current);
      if (credential) next[provider] = credential;
      else delete next[provider];
      this.data = next;
      return { result: undefined, next: JSON.stringify(next, null, 2) };
    });
  }

  private async refreshOAuthToken(providerId: OAuthProviderId): Promise<{ apiKey: string; newCredentials: OAuthCredentials } | null> {
    return this.storage.withLockAsync(async (current) => {
      const data = parseAuthStorageData(current);
      const credential = data[providerId];
      if (credential?.type !== "oauth") return { result: null };

      const provider = getOAuthProvider(providerId);
      if (provider && Date.now() < credential.expires) {
        return { result: { apiKey: provider.getApiKey(credential), newCredentials: credential } };
      }

      const oauthCredentials: Record<string, OAuthCredentials> = {};
      for (const [key, value] of Object.entries(data)) {
        if (value.type === "oauth") oauthCredentials[key] = value;
      }

      const refreshed = await getOAuthApiKey(providerId, oauthCredentials);
      if (!refreshed) return { result: null };

      data[providerId] = { type: "oauth", ...refreshed.newCredentials };
      this.data = data;
      return { result: refreshed, next: JSON.stringify(data, null, 2) };
    });
  }
}

export function getDefaultAuthPath(): string {
  return join(getArgonHome(), "auth.json");
}

export function resolveConfigValue(value: string): string | undefined {
  if (value.startsWith("!")) {
    try {
      const output = execSync(value.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], shell: process.env.SHELL || "/bin/sh" });
      const trimmed = output.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    } catch {
      return undefined;
    }
  }
  return process.env[value] || value;
}

export function resolveConfigValueOrThrow(value: string, label: string): string {
  const resolved = resolveConfigValue(value);
  if (!resolved) throw new Error(`Failed to resolve ${label}`);
  return resolved;
}

export function resolveHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const next = resolveConfigValue(value);
    if (next !== undefined) resolved[key] = next;
  }
  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

function parseAuthStorageData(content: string | undefined): AuthStorageData {
  if (!content?.trim()) return {};
  const parsed = JSON.parse(content) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  return parsed as AuthStorageData;
}
