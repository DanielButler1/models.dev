import { expect, test } from "bun:test";
import { buildPhaseoModel, cheapestPhaseoCost, PhaseoModel, PhaseoResponse, phaseo } from "../src/sync/providers/phaseo.js";

const fixture = PhaseoModel.parse({
  id: "openai/gpt-5.6-terra", name: "GPT-5.6 Terra",
  lifecycle: { status: "active", released_at: "2026-07-09T00:00:00+00:00" },
  modalities: { input: ["text", "image"], output: ["text"] },
  limits: { input_tokens: 400000, output_tokens: 128000 },
  capabilities: { endpoints: ["text.generate"], parameters: ["include_reasoning", "tool_choice", "response_format", "temperature", "tools"] },
  availability: { status: "active" },
  offers: [{ status: "active", routable: true, endpoints: ["text.generate"], pricing: { meters: {
    input_text_tokens: { unit_size: 1_000_000, price_per_unit: "1.25" },
    output_text_tokens: { unit_size: 1_000_000, price_per_unit: "10" },
  } } }],
});

test("builds a Phaseo override from the public model contract", () => {
  expect(JSON.parse(JSON.stringify(buildPhaseoModel(fixture, undefined, fixture.id)))).toEqual({
    base_model: fixture.id, temperature: true, cost: { input: 1.25, output: 10 },
    limit: { context: 400000 }, modalities: { input: ["text", "image"] },
  });
});

test("preserves authored reasoning controls", () => {
  const existing = { base_model: fixture.id, reasoning_options: [{ type: "budget_tokens" as const }] };
  expect(buildPhaseoModel(fixture, existing, fixture.id)).toMatchObject({ reasoning_options: [{ type: "budget_tokens" }] });
});

test("filters to active, routable text-generation models", () => {
  const raw = PhaseoResponse.parse({ models: [fixture,
    { ...fixture, id: "image/model", modalities: { input: ["text"], output: ["image"] } },
    { ...fixture, id: "retired/model", lifecycle: { status: "retired" } },
    { ...fixture, id: "unroutable/model", offers: [{ ...fixture.offers[0], routable: false }] },
  ] });
  expect(phaseo.parseModels(raw).map((model) => model.id)).toEqual([fixture.id]);
});

test("uses the lowest complete routable offer price", () => {
  const model = PhaseoModel.parse({ ...fixture, offers: [fixture.offers[0],
    { ...fixture.offers[0], pricing: { meters: {
      input_text_tokens: { unit_size: 1_000, price_per_unit: "0.0005" },
      output_text_tokens: { unit_size: 1_000, price_per_unit: "0.002" },
    } } },
  ] });
  expect(cheapestPhaseoCost(model)).toEqual({ input: 0.5, output: 2 });
});
