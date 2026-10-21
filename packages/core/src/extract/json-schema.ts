import { z } from "zod";
import { PageExtraction } from "../schema.ts";

export type JsonSchema = { [key: string]: unknown };

/** Keywords structured-output modes reject or ignore; Zod re-validates them on our side. */
const STRIPPED_KEYWORDS = new Set([
  "$schema",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
]);

function isSchemaObject(v: unknown): v is JsonSchema {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Make a generated schema acceptable to strict structured-output modes:
 * every object gets `additionalProperties: false` and lists all properties as
 * required; numeric and length constraints are removed; fixed-length tuples
 * become plain arrays of their (single) item type.
 */
export function toProviderJsonSchema(schema: JsonSchema): JsonSchema {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!isSchemaObject(node)) return node;
    const out: JsonSchema = {};
    for (const [key, value] of Object.entries(node)) {
      if (STRIPPED_KEYWORDS.has(key)) continue;
      out[key] = walk(value);
    }
    if (Array.isArray(out.prefixItems)) {
      const items = out.prefixItems as unknown[];
      const first = items[0];
      if (!items.every((i) => JSON.stringify(i) === JSON.stringify(first))) {
        throw new Error("cannot express a heterogeneous tuple for structured output");
      }
      delete out.prefixItems;
      out.items = first;
    }
    if (out.type === "object" || isSchemaObject(out.properties)) {
      const props = isSchemaObject(out.properties) ? out.properties : {};
      out.properties = props;
      out.required = Object.keys(props);
      out.additionalProperties = false;
    }
    return out;
  };
  return walk(schema) as JsonSchema;
}

/**
 * JSON Schema handed to providers, generated from the Zod schema so the two
 * cannot drift. Zod remains the authority: provider output is always
 * re-validated with parsePageExtraction(), including the constraints stripped here.
 */
export const PAGE_EXTRACTION_JSON_SCHEMA: JsonSchema = toProviderJsonSchema(
  z.toJSONSchema(PageExtraction, { io: "input" }) as JsonSchema,
);
