import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  resolveModelConfigForRole,
  resolveModelNameForRequest,
} from "../../src/config/model-provider.js";
import type { ModelConfigRole } from "../../src/config/model-provider.js";

const MODEL_ENV_NAMES = [
  "MODEL_CONFIG_ID",
  "MODEL_PROVIDER",
  "MODEL_PROVIDER_NAME",
  "MODEL_ID",
  "MODEL_BASE_URL",
  "MODEL_API_KEY",
  "MODEL_CLI_ID",
  "MODEL_MAX_OUTPUT_TOKENS",
  "MODEL_CONTEXT_WINDOW",
  "MODEL_REASONING_EFFORT",
  "MODEL_RUNTIME",
  "MODEL_RUNTIME_TRACE",
  "MODEL_RUNTIME_TRACE_SAMPLE_CHARS",
  "MODEL_THINKING",
  "MODEL_WIRE_API",
];

const ROLE_PREFIXES = ["MODULE_AGENT", "TEXT", "VISION"];

const withCleanModelEnv = <T>(run: () => T) => {
  const names = [
    "MODEL_PROVIDER_CONFIG",
    ...MODEL_ENV_NAMES,
    ...ROLE_PREFIXES.flatMap((prefix) =>
      MODEL_ENV_NAMES.map((name) => `${prefix}_${name}`),
    ),
  ];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  try {
    return run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
};

describe("model provider config", () => {
  const writeConfig = (
    configPath: string,
    payload: Record<string, unknown>,
  ) => {
    writeFileSync(configPath, JSON.stringify(payload));
  };

  const writeStandardConfig = (configPath: string) => {
    writeConfig(configPath, {
      models: {
        first: {
          runtime: "opencode",
          wireApi: "chat-completions",
          provider: "unit-provider-first",
          baseURL: "https://api-first.example.test/v1",
          apiKey: "unit-key",
          model: "unit-model-first",
        },
        second: {
          runtime: "opencode",
          wireApi: "chat-completions",
          provider: "unit-provider-second",
          baseURL: "https://api-second.example.test/v1",
          apiKey: "unit-key",
          model: "unit-model-second",
        },
      },
    });
  };

  it("uses the explicitly requested model for all model roles", () =>
    withCleanModelEnv(() => {
      const dir = mkdtempSync(path.join(tmpdir(), "svg-transform-model-"));
      const configPath = path.join(dir, "model-provider.json");
      try {
        writeStandardConfig(configPath);
        process.env.MODEL_PROVIDER_CONFIG = configPath;

        const roles: ModelConfigRole[] = ["text", "vision", "moduleAgent"];
        for (const role of roles) {
          const config = resolveModelConfigForRole(role, "second");
          assert.equal(config.id, "second");
          assert.equal(config.provider, "unit-provider-second");
          assert.equal(config.model, "unit-model-second");
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }));

  it("uses the first models entry when the request omits model", () =>
    withCleanModelEnv(() => {
      const dir = mkdtempSync(path.join(tmpdir(), "svg-transform-model-"));
      const configPath = path.join(dir, "model-provider.json");
      try {
        writeStandardConfig(configPath);
        process.env.MODEL_PROVIDER_CONFIG = configPath;

        assert.equal(resolveModelNameForRequest(), "first");
        const config = resolveModelConfigForRole("text");
        assert.equal(config.id, "first");
        assert.equal(config.provider, "unit-provider-first");
        assert.equal(config.model, "unit-model-first");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }));

  it("rejects unknown requested model names", () =>
    withCleanModelEnv(() => {
      const dir = mkdtempSync(path.join(tmpdir(), "svg-transform-model-"));
      const configPath = path.join(dir, "model-provider.json");
      try {
        writeStandardConfig(configPath);
        process.env.MODEL_PROVIDER_CONFIG = configPath;

        assert.throws(
          () => resolveModelNameForRequest("missing"),
          /Unknown model config "missing"/,
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }));

  it("rejects top-level model in provider config", () =>
    withCleanModelEnv(() => {
      const dir = mkdtempSync(path.join(tmpdir(), "svg-transform-model-"));
      const configPath = path.join(dir, "model-provider.json");
      try {
        writeConfig(configPath, {
          model: "first",
          models: {},
        });
        process.env.MODEL_PROVIDER_CONFIG = configPath;

        assert.throws(
          () => resolveModelNameForRequest(),
          /must not define top-level model/,
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }));

  it("does not let model selection env override the requested model", () =>
    withCleanModelEnv(() => {
      const dir = mkdtempSync(path.join(tmpdir(), "svg-transform-model-"));
      const configPath = path.join(dir, "model-provider.json");
      try {
        writeStandardConfig(configPath);
        process.env.MODEL_PROVIDER_CONFIG = configPath;
        process.env.MODEL_CONFIG_ID = "first";
        process.env.TEXT_MODEL_CONFIG_ID = "first";

        const config = resolveModelConfigForRole("text", "second");
        assert.equal(config.id, "second");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }));
});
