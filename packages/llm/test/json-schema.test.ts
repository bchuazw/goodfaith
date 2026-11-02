import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fitToSchema, toAnthropicSchema, toGeminiSchema, toOpenAIStrictSchema, zodToJsonSchema } from "../src/index.js";
import { stripNullOptionals } from "../src/json-schema.js";

const Money = z.object({ currency: z.string().describe("ISO 4217"), value: z.string().regex(/^\d+\.\d{2}$/) });
const Schema = z.object({
  maxPerOrder: Money.describe("Hard cap per order"),
  period: z.enum(["week", "month", "total"]),
  categories: z.array(z.string()).optional(),
  note: z.string().nullable(),
  score: z.number().min(0).max(1),
  verified: z.boolean().default(true),
});

describe("zodToJsonSchema", () => {
  it("uses zod's built-in converter on the input side", () => {
    const js = zodToJsonSchema(Schema);
    expect(js.$schema).toBeUndefined();
    expect(js.type).toBe("object");
    expect(js.required).toEqual(["maxPerOrder", "period", "note", "score"]); // optional + defaulted are not required
    expect((js.properties as Record<string, unknown>).period).toEqual({ type: "string", enum: ["week", "month", "total"] });
    expect((js.properties as Record<string, { description?: string }>).maxPerOrder?.description).toBe("Hard cap per order");
  });
});

describe("provider schema transforms", () => {
  const js = zodToJsonSchema(Schema);

  it("anthropic: additionalProperties:false everywhere, keeps enum, moves unsupported constraints to the description", () => {
    const a = toAnthropicSchema(js) as { additionalProperties: boolean; properties: Record<string, Record<string, unknown>> };
    expect(a.additionalProperties).toBe(false);
    expect(a.properties.maxPerOrder?.additionalProperties).toBe(false);
    expect(a.properties.period).toEqual({ type: "string", enum: ["week", "month", "total"] });
    expect(a.properties.score).toEqual({ type: "number", description: "{minimum: 0, maximum: 1}" });
    const moneyProps = a.properties.maxPerOrder?.properties as Record<string, Record<string, unknown>> | undefined;
    expect(moneyProps?.value).toEqual({ type: "string", description: '{pattern: "^\\\\d+\\\\.\\\\d{2}$"}' });
    expect(a.properties.verified).toEqual({ type: "boolean", description: "{default: true}" });
  });

  it("openai strict: every property required, optional ones nullable", () => {
    const o = toOpenAIStrictSchema(js) as { required: string[]; additionalProperties: boolean; properties: Record<string, unknown> };
    expect(o.required).toEqual(["maxPerOrder", "period", "categories", "note", "score", "verified"]);
    expect(o.additionalProperties).toBe(false);
    expect(o.properties.categories).toEqual({ anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }] });
    expect(o.properties.verified).toEqual({ type: ["boolean", "null"] });
    expect(o.properties.note).toEqual({ type: ["string", "null"] });
  });

  it("gemini: OpenAPI-style Schema with upper-case types, nullable and property ordering", () => {
    const g = toGeminiSchema(js) as Record<string, unknown> & { properties: Record<string, Record<string, unknown>> };
    expect(g.type).toBe("OBJECT");
    expect(g.propertyOrdering).toEqual(["maxPerOrder", "period", "categories", "note", "score", "verified"]);
    expect(g.required).toEqual(["maxPerOrder", "period", "note", "score"]);
    expect(g.properties.period).toEqual({ type: "STRING", enum: ["week", "month", "total"] });
    expect(g.properties.note).toEqual({ type: "STRING", nullable: true });
    expect(g.properties.score).toEqual({ type: "NUMBER", minimum: 0, maximum: 1 });
    expect(g.properties.categories).toEqual({ type: "ARRAY", items: { type: "STRING" } });
    expect(g.properties.maxPerOrder?.type).toBe("OBJECT");
  });
});

describe("output helpers", () => {
  it("stripNullOptionals removes nulls only for optional non-nullable fields", () => {
    const js = zodToJsonSchema(Schema);
    const out = stripNullOptionals({ categories: null, note: null, period: "month", maxPerOrder: { currency: "USD", value: "1.00" } }, js);
    expect(out).toEqual({ note: null, period: "month", maxPerOrder: { currency: "USD", value: "1.00" } });
  });

  it("fitToSchema maps values by name, synonyms and type", () => {
    const target = zodToJsonSchema(
      z.object({
        max_per_order_usd: z.number(),
        recommendation: z.enum(["ALLOW", "BLOCK"]),
        reasons: z.array(z.string()),
        nested: z.object({ query: z.string(), qty: z.number().int() }),
        missing: z.string(),
      }),
    );
    const fitted = fitToSchema(target, {
      maxPerOrder: { currency: "USD", value: "45.00" },
      recommendation: "block",
      reasons: "one reason",
      q: "cat food",
      quantity: 2,
    });
    expect(fitted).toEqual({
      max_per_order_usd: 45,
      recommendation: "BLOCK",
      reasons: ["one reason"],
      nested: { query: "cat food", qty: 2 },
      missing: "",
    });
  });
});

describe("toGeminiSchema item bounds", () => {
  it("moves minItems/maxItems into the description (gemini-3.5-flash rejects nested maxItems)", () => {
    const out = toGeminiSchema(zodToJsonSchema(z.object({ xs: z.array(z.string()).min(1).max(20).describe("Things"), ys: z.array(z.number()).max(5) }))) as any;
    expect(out.properties.xs).toEqual({ type: "ARRAY", description: "Things at least 1, at most 20 items.", items: { type: "STRING" } });
    expect(out.properties.ys).toEqual({ type: "ARRAY", description: "at most 5 items.", items: { type: "NUMBER" } });
  });
});

