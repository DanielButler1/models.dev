import { expect, test } from "bun:test";

import {
  buildPhaseoModel,
  PhaseoModel,
  PhaseoResponse,
  phaseo,
  preferredPhaseoRoutes,
} from "../src/sync/providers/phaseo.js";

const fixture = PhaseoModel.parse({
  modelId: "openai/gpt-5.6-terra",
  modelName: "GPT-5.6 Terra",
  capabilities: ["text.generate"],
  capabilityParamsById: {
    "text.generate": [
      "include_reasoning",
      "tool_choice",
      "response_format",
      {
        param_id: "reasoning",
        values: ["none", "low", "medium", "high", "xhigh"],
      },
      "reasoning_effort",
      { param_id: "temperature" },
      { param_id: "tools" },
    ],
  },
  inputModalities: ["text", "image"],
  outputModalities: ["text"],
  releaseDate: "2026-07-09T00:00:00+00:00",
  inputPricePerMillion: 1.25,
  outputPricePerMillion: 10,
  isAvailable: true,
});

test("builds an override-only Phaseo route", () => {
  expect(
    JSON.parse(
      JSON.stringify(
        buildPhaseoModel(fixture, undefined, "openai/gpt-5.6-terra"),
      ),
    ),
  ).toEqual({
    base_model: "openai/gpt-5.6-terra",
    temperature: true,
    reasoning_options: [
      { type: "effort", values: ["none", "low", "medium", "high", "xhigh"] },
    ],
    cost: { input: 1.25, output: 10 },
    modalities: { input: ["text", "image"] },
  });
});

test("preserves authored reasoning controls when the catalog omits effort values", () => {
  const withoutEfforts = PhaseoModel.parse({
    ...fixture,
    capabilityParamsById: { "text.generate": ["reasoning", "tools"] },
  });
  const existing = {
    base_model: "openai/gpt-5.6-terra",
    reasoning_options: [{ type: "budget_tokens" as const }],
  };
  expect(
    buildPhaseoModel(withoutEfforts, existing, "openai/gpt-5.6-terra"),
  ).toMatchObject({
    base_model: "openai/gpt-5.6-terra",
    reasoning_options: [{ type: "budget_tokens" }],
  });
});

test("filters the public catalog to available text-generation routes", () => {
  const raw = PhaseoResponse.parse({
    models: [
      fixture,
      {
        ...fixture,
        modelId: "image/model",
        capabilities: ["image.generate"],
        outputModalities: ["image"],
      },
      { ...fixture, modelId: "retired/model", isAvailable: false },
    ],
  });
  expect(phaseo.parseModels(raw).map((model) => model.modelId)).toEqual([
    "openai/gpt-5.6-terra",
  ]);
});

test("uses the lowest public route price for duplicate model IDs", () => {
  const expensive = PhaseoModel.parse({
    ...fixture,
    inputPricePerMillion: 2,
    outputPricePerMillion: 12,
  });
  expect(preferredPhaseoRoutes([expensive, fixture])).toEqual([fixture]);
});
