import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveModelConfigForRole } from "../../src/config/model-provider.js";
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
  it("uses one configured model for all model roles", () =>
    withCleanModelEnv(() => {
      const dir = mkdtempSync(path.join(tmpdir(), "svg-transform-model-"));
      const configPath = path.join(dir, "model-provider.json");
      try {
        writeFileSync(
          configPath,
          JSON.stringify({
            model: "main",
            models: {
              main: {
                runtime: "opencode",
                wireApi: "chat-completions",
                provider: "unit-provider",
                baseURL: "https://api.example.test/v1",
                apiKey: "unit-key",
                model: "unit-model-id",
              },
            },
          }),
        );
        process.env.MODEL_PROVIDER_CONFIG = configPath;

        const roles: ModelConfigRole[] = ["text", "vision", "moduleAgent"];
        for (const role of roles) {
          const config = resolveModelConfigForRole(role);
          assert.equal(config.id, "main");
          assert.equal(config.provider, "unit-provider");
          assert.equal(config.model, "unit-model-id");
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }));
});
