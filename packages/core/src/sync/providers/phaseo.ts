import { z } from "zod";

import type { ExistingModel, SyncProvider, SyncedFullModel, SyncedModel } from "../index.js";
import { factorBaseModel, modelMetadata, resolveModelMetadataBaseModel } from "./openrouter.js";

const API_ENDPOINT = process.env.PHASEO_MODELS_URL ?? "https://api.phaseo.app/v1/models";

const Meter = z.object({ unit_size: z.number().positive(), price_per_unit: z.coerce.number().nonnegative() }).passthrough();
const Offer = z.object({
  status: z.string(), routable: z.boolean(), endpoints: z.array(z.string()).default([]),
  pricing: z.object({ meters: z.object({ input_text_tokens: Meter.nullish(), output_text_tokens: Meter.nullish() }).passthrough() }).passthrough(),
}).passthrough();

export const PhaseoModel = z.object({
  id: z.string().min(1), name: z.string().min(1),
  lifecycle: z.object({ status: z.string(), released_at: z.string().nullish() }).passthrough(),
  modalities: z.object({ input: z.array(z.string()), output: z.array(z.string()) }),
  limits: z.object({ input_tokens: z.number().positive().nullish(), output_tokens: z.number().positive().nullish() }),
  capabilities: z.object({ endpoints: z.array(z.string()).default([]), parameters: z.array(z.string()).default([]) }).passthrough(),
  availability: z.object({ status: z.string() }).passthrough(),
  offers: z.array(Offer).default([]),
}).passthrough();
export const PhaseoResponse = z.object({ models: z.array(PhaseoModel) }).passthrough();
export type PhaseoModel = z.infer<typeof PhaseoModel>;
type Modality = SyncedFullModel["modalities"]["input"][number];

function modalities(values: string[]): Modality[] {
  const supported = new Set<Modality>(["text", "audio", "image", "video", "pdf"]);
  return [...new Set(values.map((value) => value.toLowerCase().replace(/^image\/.*$/, "image").replace(/^application\/pdf$/, "pdf")).filter((value): value is Modality => supported.has(value as Modality)))];
}

function perMillion(meter: z.infer<typeof Meter>) {
  return meter.price_per_unit * (1_000_000 / meter.unit_size);
}

export function cheapestPhaseoCost(model: PhaseoModel) {
  const costs = model.offers.flatMap((offer) => {
    const input = offer.pricing.meters.input_text_tokens;
    const output = offer.pricing.meters.output_text_tokens;
    return offer.routable && offer.status === "active" && input && output ? [{ input: perMillion(input), output: perMillion(output) }] : [];
  });
  return costs.sort((a, b) => a.input + a.output - b.input - b.output)[0];
}

export function buildPhaseoModel(model: PhaseoModel, existing: ExistingModel | undefined, baseModel = resolveModelMetadataBaseModel(model.id)): SyncedModel | undefined {
  if (baseModel === undefined) return undefined;
  const baseLimit = modelMetadata(baseModel).limit;
  const baseOutput = typeof baseLimit === "object" && baseLimit !== null && "output" in baseLimit ? baseLimit.output : undefined;
  const outputLimit = model.limits.output_tokens ?? existing?.limit?.output ?? baseOutput;
  if (outputLimit == null) return undefined;
  const params = new Set(model.capabilities.parameters);
  const input = modalities(model.modalities.input);
  const output = modalities(model.modalities.output);
  const reasoning = params.has("reasoning") || params.has("reasoning_effort") || params.has("include_reasoning");
  return factorBaseModel(baseModel, {
    name: model.name,
    attachment: input.some((value) => value !== "text"),
    reasoning,
    reasoning_options: reasoning ? existing?.reasoning_options : undefined,
    temperature: params.has("temperature"),
    tool_call: params.has("tools") || params.has("tool_choice"),
    structured_output: params.has("response_format") || params.has("json_schema") || params.has("structured_outputs"),
    release_date: model.lifecycle.released_at?.slice(0, 10),
    cost: cheapestPhaseoCost(model) ?? existing?.cost,
    limit: { context: model.limits.input_tokens ?? existing?.limit?.context ?? 0, output: outputLimit },
    modalities: { input, output },
  }, undefined, existing?.base_model_omit);
}

export const phaseo = {
  id: "phaseo", name: "Phaseo", modelsDir: "providers/phaseo/models", preserveBaseModels: false,
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) throw new Error(`Phaseo models request failed: ${response.status} ${response.statusText}`);
    return response.json();
  },
  parseModels(raw) {
    return PhaseoResponse.parse(raw).models.filter((model) => model.lifecycle.status === "active" && model.availability.status === "active" && model.capabilities.endpoints.includes("text.generate") && model.modalities.input.includes("text") && model.modalities.output.includes("text") && model.offers.some((offer) => offer.routable && offer.status === "active" && offer.endpoints.includes("text.generate")));
  },
  sourceID(model) { return model.id.startsWith("phaseo/") ? undefined : model.id; },
  translateModel(model, context) {
    const translated = buildPhaseoModel(model, context.existing(model.id));
    return translated === undefined ? undefined : { id: model.id, model: translated };
  },
} satisfies SyncProvider<PhaseoModel>;
