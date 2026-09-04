import { z } from "zod";

import type {
  ExistingModel,
  SyncProvider,
  SyncedFullModel,
  SyncedModel,
} from "../index.js";
import {
  factorBaseModel,
  modelMetadata,
  resolveModelMetadataBaseModel,
} from "./openrouter.js";

const API_ENDPOINT =
  "https://phaseo.app/api/_web/gateway/models?available_only=true";
const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "default",
] as const;

const CapabilityParameter = z.union([
  z.string(),
  z
    .object({
      param_id: z.string().min(1),
      values: z.array(z.string()).optional(),
    })
    .passthrough(),
]);

export const PhaseoModel = z
  .object({
    modelId: z.string().min(1),
    modelName: z.string().min(1),
    capabilities: z.array(z.string()).default([]),
    capabilityParamsById: z.record(z.string(), z.unknown()).default({}),
    inputModalities: z.array(z.string()).default([]),
    outputModalities: z.array(z.string()).default([]),
    releaseDate: z.string().nullish(),
    inputPricePerMillion: z.number().nonnegative().nullish(),
    outputPricePerMillion: z.number().nonnegative().nullish(),
    isAvailable: z.boolean(),
  })
  .passthrough();

export const PhaseoResponse = z
  .object({
    models: z.array(PhaseoModel),
  })
  .passthrough();

export type PhaseoModel = z.infer<typeof PhaseoModel>;

type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
type Modality = SyncedFullModel["modalities"]["input"][number];

function parameters(model: PhaseoModel) {
  const raw = model.capabilityParamsById["text.generate"];
  if (!Array.isArray(raw)) return [];
  return raw
    .flatMap((value) => {
      const parsed = CapabilityParameter.safeParse(value);
      return parsed.success ? [parsed.data] : [];
    })
    .map((parameter) =>
      typeof parameter === "string"
        ? { id: parameter, values: undefined }
        : { id: parameter.param_id, values: parameter.values },
    );
}

function modalities(values: string[]): Modality[] {
  const supported = new Set<Modality>([
    "text",
    "audio",
    "image",
    "video",
    "pdf",
  ]);
  return [
    ...new Set(
      values
        .map((value) =>
          value
            .toLowerCase()
            .replace(/^image\/.*$/, "image")
            .replace(/^application\/pdf$/, "pdf"),
        )
        .filter((value): value is Modality => supported.has(value as Modality)),
    ),
  ];
}

function reasoningOptions(
  model: PhaseoModel,
  existing: ExistingModel | undefined,
) {
  const reasoning = parameters(model);
  const effort = reasoning.find(
    (parameter) =>
      (parameter.id === "reasoning_effort" || parameter.id === "reasoning") &&
      parameter.values?.length,
  );
  const values = effort?.values?.filter((value): value is ReasoningEffort =>
    REASONING_EFFORTS.includes(value as ReasoningEffort),
  );
  if (values?.length) return [{ type: "effort" as const, values }];
  return existing?.reasoning_options;
}

function routePrice(model: PhaseoModel) {
  return (
    (model.inputPricePerMillion ?? Number.POSITIVE_INFINITY) +
    (model.outputPricePerMillion ?? Number.POSITIVE_INFINITY)
  );
}

export function preferredPhaseoRoutes(models: PhaseoModel[]) {
  const routes = new Map<string, PhaseoModel>();
  for (const model of models) {
    const current = routes.get(model.modelId);
    if (current === undefined || routePrice(model) < routePrice(current)) {
      routes.set(model.modelId, model);
    }
  }
  return [...routes.values()];
}

export function buildPhaseoModel(
  model: PhaseoModel,
  existing: ExistingModel | undefined,
  baseModel = resolveModelMetadataBaseModel(model.modelId),
): SyncedModel | undefined {
  if (baseModel === undefined) return undefined;
  const baseLimit = modelMetadata(baseModel).limit;
  if (typeof baseLimit !== "object" || baseLimit === null || !("output" in baseLimit)) return undefined;

  const params = new Set(parameters(model).map((parameter) => parameter.id));
  const input = modalities(model.inputModalities);
  const output = modalities(model.outputModalities);
  const reasoning =
    params.has("reasoning") ||
    params.has("reasoning_effort") ||
    params.has("include_reasoning");
  const cost =
    model.inputPricePerMillion != null && model.outputPricePerMillion != null
      ? {
          input: model.inputPricePerMillion,
          output: model.outputPricePerMillion,
        }
      : existing?.cost;
  const values = {
    name: model.modelName,
    attachment: input.some((value) => value !== "text"),
    reasoning,
    reasoning_options: reasoning
      ? reasoningOptions(model, existing)
      : undefined,
    temperature: params.has("temperature"),
    tool_call: params.has("tools") || params.has("tool_choice"),
    structured_output:
      params.has("response_format") ||
      params.has("json_schema") ||
      params.has("structured_outputs"),
    release_date: model.releaseDate?.slice(0, 10),
    cost,
    modalities: { input, output },
  };

  return factorBaseModel(
    baseModel,
    values,
    undefined,
    existing?.base_model_omit,
  );
}

export const phaseo = {
  id: "phaseo",
  name: "Phaseo",
  modelsDir: "providers/phaseo/models",
  preserveBaseModels: false,
  async fetchModels() {
    const response = await fetch(API_ENDPOINT);
    if (!response.ok) {
      throw new Error(
        `Phaseo models request failed: ${response.status} ${response.statusText}`,
      );
    }
    return response.json();
  },
  parseModels(raw) {
    return preferredPhaseoRoutes(
      PhaseoResponse.parse(raw).models.filter(
        (model) =>
          model.isAvailable &&
          model.capabilities.includes("text.generate") &&
          model.inputModalities.includes("text") &&
          model.outputModalities.includes("text"),
      ),
    );
  },
  sourceID(model) {
    return model.modelId.startsWith("phaseo/") ? undefined : model.modelId;
  },
  translateModel(model, context) {
    const existing = context.existing(model.modelId);
    const translated = buildPhaseoModel(model, existing);
    return translated === undefined
      ? undefined
      : { id: model.modelId, model: translated };
  },
} satisfies SyncProvider<PhaseoModel>;
