import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/auth/storage.js";
import { loadUserSettings, saveDefaultModel, saveDefaultReasoning } from "../src/config/settings.js";
import { ModelRegistry } from "../src/model/registry.js";

describe("AuthStorage", () => {
  it("resolves stored API keys and environment-backed values", async () => {
    const auth = AuthStorage.inMemory({
      literal: { type: "api_key", key: "sk-literal" },
      env: { type: "api_key", key: "ARGON_TEST_API_KEY" }
    });
    process.env.ARGON_TEST_API_KEY = "sk-env";

    try {
      expect(await auth.getApiKey("literal")).toBe("sk-literal");
      expect(await auth.getApiKey("env")).toBe("sk-env");
      expect(auth.getAuthStatus("literal")).toMatchObject({ configured: true, source: "stored" });
    } finally {
      delete process.env.ARGON_TEST_API_KEY;
    }
  });

  it("returns non-expired OAuth access tokens", async () => {
    const auth = AuthStorage.inMemory({
      "openai-codex": {
        type: "oauth",
        access: "access-token",
        refresh: "refresh-token",
        expires: Date.now() + 60_000
      }
    });

    expect(await auth.getApiKey("openai-codex")).toBe("access-token");
  });
});

describe("ModelRegistry", () => {
  it("loads custom models and filters availability by configured auth", async () => {
    const dir = await mkdtemp(join(tmpdir(), "argon-models-"));
    const modelsPath = join(dir, "models.json");
    await writeFile(
      modelsPath,
      `{
        // comments and trailing commas are accepted
        "providers": {
          "ollama": {
            "baseUrl": "http://localhost:11434/v1",
            "api": "openai-completions",
            "apiKey": "ollama",
            "models": [
              { "id": "llama3.1:8b", "contextWindow": 8192, },
            ],
          }
        }
      }`,
      "utf8"
    );

    const auth = AuthStorage.inMemory();
    const registry = ModelRegistry.create(auth, modelsPath);
    const model = registry.find("ollama", "llama3.1:8b");

    expect(model).toMatchObject({
      provider: "ollama",
      id: "llama3.1:8b",
      api: "openai-completions",
      baseUrl: "http://localhost:11434/v1",
      contextWindow: 8192
    });
    expect(registry.getAvailable().some((candidate) => candidate.provider === "ollama")).toBe(true);
    expect(await registry.getApiKeyAndHeaders(model!)).toMatchObject({ ok: true, apiKey: "ollama" });
  });

  it("applies built-in model overrides", async () => {
    const dir = await mkdtemp(join(tmpdir(), "argon-overrides-"));
    const modelsPath = join(dir, "models.json");
    await writeFile(
      modelsPath,
      JSON.stringify({
        providers: {
          openai: {
            modelOverrides: {
              "gpt-5.2-codex": {
                contextWindow: 12345
              }
            }
          }
        }
      }),
      "utf8"
    );

    const registry = ModelRegistry.create(AuthStorage.inMemory({ openai: { type: "api_key", key: "sk-test" } }), modelsPath);
    expect(registry.find("openai", "gpt-5.2-codex")?.contextWindow).toBe(12345);
  });
});

describe("user settings", () => {
  it("persists the default model selection", async () => {
    const dir = await mkdtemp(join(tmpdir(), "argon-settings-"));
    const settingsPath = join(dir, "settings.json");

    saveDefaultModel("openai-codex", "gpt-5.3-codex", settingsPath);

    expect(loadUserSettings(settingsPath)).toMatchObject({
      provider: "openai-codex",
      model: "gpt-5.3-codex",
      modelId: "gpt-5.3-codex"
    });
    expect(await readFile(settingsPath, "utf8")).toContain("openai-codex");
  });

  it("persists the default thinking level without losing model settings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "argon-settings-"));
    const settingsPath = join(dir, "settings.json");

    saveDefaultModel("openai-codex", "gpt-5.3-codex", settingsPath);
    saveDefaultReasoning("off", settingsPath);

    expect(loadUserSettings(settingsPath)).toMatchObject({
      provider: "openai-codex",
      model: "gpt-5.3-codex",
      modelId: "gpt-5.3-codex",
      reasoning: "off"
    });
  });
});
