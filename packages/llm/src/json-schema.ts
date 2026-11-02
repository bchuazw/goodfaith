import { z } from "zod";
import type { JsonSchema } from "./types.js";

type S = Record<string, unknown>;

export const isPlainObject = (v: unknown): v is S => typeof v === "object" && v !== null && !Array.isArray(v);

function typesOf(s: S): string[] {
  const t = s.type;
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === "string");
  return typeof t === "string" ? [t] : [];
}

function mapValues(v: unknown, f: (s: S) => S): S {
  const out: S = {};
  if (!isPlainObject(v)) return out;
  for (const [k, child] of Object.entries(v)) out[k] = isPlainObject(child) ? f(child) : child;
  return out;
}

function isObjectSchema(s: S): boolean {
  return typesOf(s).includes("object") || isPlainObject(s.properties);
}

/**
 * Zod → JSON Schema using zod 4's built-in `z.toJSONSchema` (input side, so `.default()` fields are optional).
 * Unrepresentable types (dates, custom) become `{}` rather than throwing.
 */
export function zodToJsonSchema(schema: z.ZodType): JsonSchema {
  const js = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as unknown as S;
  const { $schema: _drop, ...rest } = js;
  return dropSafeIntegerBounds(rest);
}

/** `z.number().int()` adds ±MAX_SAFE_INTEGER bounds; they carry no information for a model. */
function dropSafeIntegerBounds(s: S): S {
  const out: S = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === "minimum" && v === Number.MIN_SAFE_INTEGER) continue;
    if (k === "maximum" && v === Number.MAX_SAFE_INTEGER) continue;
    if (Array.isArray(v)) out[k] = v.map((x) => (isPlainObject(x) ? dropSafeIntegerBounds(x) : x));
    else out[k] = isPlainObject(v) ? dropSafeIntegerBounds(v) : v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Anthropic structured outputs / tool input_schema
// Supported: type, enum, const, anyOf, allOf, $ref/$defs, supported string formats, minItems 0|1,
// additionalProperties:false (required on every object). Everything else is moved into the description
// (the same strategy as the SDK's transformJSONSchema, but keeping enum/const which the API supports).
// ---------------------------------------------------------------------------
const ANTHROPIC_FORMATS = new Set(["date-time", "time", "date", "duration", "email", "hostname", "uri", "ipv4", "ipv6", "uuid"]);

export function toAnthropicSchema(input: JsonSchema): JsonSchema {
  return anthropicNode(input);
}

function anthropicNode(s: S): S {
  const out: S = {};
  const extras: string[] = [];
  for (const [k, v] of Object.entries(s)) {
    switch (k) {
      case "$schema":
      case "additionalProperties":
        break;
      case "type":
      case "description":
      case "title":
      case "enum":
      case "const":
      case "required":
      case "$ref":
        out[k] = v;
        break;
      case "properties":
        out.properties = mapValues(v, anthropicNode);
        break;
      case "items":
        out.items = isPlainObject(v) ? anthropicNode(v) : v;
        break;
      case "anyOf":
      case "oneOf":
        out.anyOf = Array.isArray(v) ? v.map((x) => (isPlainObject(x) ? anthropicNode(x) : x)) : v;
        break;
      case "allOf":
        out.allOf = Array.isArray(v) ? v.map((x) => (isPlainObject(x) ? anthropicNode(x) : x)) : v;
        break;
      case "$defs":
      case "definitions":
        out.$defs = mapValues(v, anthropicNode);
        break;
      case "format":
        if (typeof v === "string" && ANTHROPIC_FORMATS.has(v)) out.format = v;
        else extras.push(`format: ${JSON.stringify(v)}`);
        break;
      case "minItems":
        if (v === 0 || v === 1) out.minItems = v;
        else extras.push(`minItems: ${JSON.stringify(v)}`);
        break;
      default:
        extras.push(`${k}: ${JSON.stringify(v)}`);
    }
  }
  if (isObjectSchema(out)) {
    if (!isPlainObject(out.properties)) out.properties = {};
    out.additionalProperties = false;
  }
  if (extras.length > 0) {
    out.description = [typeof out.description === "string" ? out.description : "", `{${extras.join(", ")}}`]
      .filter(Boolean)
      .join("\n\n");
  }
  return out;
}

// ---------------------------------------------------------------------------
// OpenAI strict JSON schema: every property required (optional ones become nullable),
// additionalProperties:false everywhere. Nulls for optional fields are stripped again before validation.
// ---------------------------------------------------------------------------
export function toOpenAIStrictSchema(input: JsonSchema): JsonSchema {
  return openaiNode(input);
}

function openaiNode(s: S): S {
  const out: S = {};
  for (const [k, v] of Object.entries(s)) {
    switch (k) {
      case "$schema":
      case "$id":
      case "default":
      case "examples":
      case "additionalProperties":
        break;
      case "properties":
        out.properties = mapValues(v, openaiNode);
        break;
      case "items":
        out.items = isPlainObject(v) ? openaiNode(v) : v;
        break;
      case "anyOf":
      case "oneOf":
        out.anyOf = Array.isArray(v) ? v.map((x) => (isPlainObject(x) ? openaiNode(x) : x)) : v;
        break;
      case "allOf":
        out.allOf = Array.isArray(v) ? v.map((x) => (isPlainObject(x) ? openaiNode(x) : x)) : v;
        break;
      case "$defs":
      case "definitions":
        out.$defs = mapValues(v, openaiNode);
        break;
      default:
        out[k] = v;
    }
  }
  if (isObjectSchema(out)) {
    const props = isPlainObject(out.properties) ? out.properties : {};
    const required = new Set(Array.isArray(out.required) ? (out.required as string[]) : []);
    for (const key of Object.keys(props)) {
      const p = props[key];
      if (!required.has(key) && isPlainObject(p)) props[key] = makeNullable(p);
    }
    out.properties = props;
    out.required = Object.keys(props);
    out.additionalProperties = false;
  }
  return out;
}

function makeNullable(s: S): S {
  if (allowsNull(s)) return s;
  const t = typesOf(s);
  const primitive = t.length === 1 && ["string", "number", "integer", "boolean"].includes(t[0] as string);
  if (primitive && s.enum === undefined && s.const === undefined) return { ...s, type: [t[0], "null"] };
  if (Array.isArray(s.anyOf)) return { ...s, anyOf: [...s.anyOf, { type: "null" }] };
  return { anyOf: [s, { type: "null" }] };
}

function allowsNull(s: S): boolean {
  if (typesOf(s).includes("null") || s.nullable === true || s.const === null) return true;
  if (Array.isArray(s.enum) && s.enum.includes(null)) return true;
  const variants = (Array.isArray(s.anyOf) ? s.anyOf : Array.isArray(s.oneOf) ? s.oneOf : []) as unknown[];
  return variants.some((v) => isPlainObject(v) && allowsNull(v));
}

// ---------------------------------------------------------------------------
// Gemini `Schema` (OpenAPI 3.0 subset, upper-case Type enum) for responseSchema and function parameters.
// ---------------------------------------------------------------------------
const GEMINI_TYPES: Record<string, string> = {
  string: "STRING",
  number: "NUMBER",
  integer: "INTEGER",
  boolean: "BOOLEAN",
  object: "OBJECT",
  array: "ARRAY",
  null: "NULL",
};

export function toGeminiSchema(input: JsonSchema): JsonSchema {
  return geminiNode(input);
}

function geminiNode(s: S): S {
  const variants = (Array.isArray(s.anyOf) ? s.anyOf : Array.isArray(s.oneOf) ? s.oneOf : undefined) as S[] | undefined;
  if (variants) {
    const nonNull = variants.filter((v) => !(isPlainObject(v) && typesOf(v).length === 1 && typesOf(v)[0] === "null"));
    const hasNull = nonNull.length !== variants.length;
    const description = typeof s.description === "string" ? s.description : undefined;
    if (nonNull.length === 1 && isPlainObject(nonNull[0])) {
      const inner = geminiNode(nonNull[0]);
      if (hasNull) inner.nullable = true;
      if (description && inner.description === undefined) inner.description = description;
      return inner;
    }
    const out: S = { anyOf: nonNull.filter(isPlainObject).map(geminiNode) };
    if (hasNull) out.nullable = true;
    if (description) out.description = description;
    return out;
  }

  const all = typesOf(s);
  const nullable = all.includes("null") || s.nullable === true;
  const types = all.filter((t) => t !== "null");
  if (types.length > 1) {
    const out: S = { anyOf: types.map((t) => geminiNode({ ...s, type: t })) };
    if (nullable) out.nullable = true;
    return out;
  }

  const out: S = {};
  const t = types[0] ?? (isPlainObject(s.properties) ? "object" : undefined);
  if (t && GEMINI_TYPES[t]) out.type = GEMINI_TYPES[t];
  if (nullable) out.nullable = true;
  if (typeof s.description === "string") out.description = s.description;
  if (typeof s.title === "string") out.title = s.title;

  const enumValues = s.const !== undefined ? [s.const] : Array.isArray(s.enum) ? s.enum : undefined;
  if (enumValues) {
    const strings = enumValues.filter((x): x is string => typeof x === "string");
    if (strings.length === enumValues.length && strings.length > 0) {
      out.enum = strings;
      if (!out.type) out.type = "STRING";
    } else {
      out.description = [out.description, `Allowed values: ${JSON.stringify(enumValues)}`].filter(Boolean).join(" ");
    }
  }
  if (t === "string" && s.format === "date-time") out.format = "date-time";
  if ((t === "number" || t === "integer") && typeof s.minimum === "number") out.minimum = s.minimum;
  if ((t === "number" || t === "integer") && typeof s.maximum === "number") out.maximum = s.maximum;
  if (t === "array") {
    if (isPlainObject(s.items)) out.items = geminiNode(s.items);
    // Item-count bounds go into the description, not the schema: gemini-3.5-flash answers 400
    // INVALID_ARGUMENT for the triage claims schema when its nested arrays carry maxItems (verified live
    // 2026-11-02), and the same schema without them is accepted. zod still enforces the bounds afterwards.
    const bounds = [
      typeof s.minItems === "number" && s.minItems > 0 ? `at least ${s.minItems}` : undefined,
      typeof s.maxItems === "number" ? `at most ${s.maxItems}` : undefined,
    ].filter(Boolean);
    if (bounds.length > 0) out.description = [out.description, `${bounds.join(", ")} items.`].filter(Boolean).join(" ");
  }
  if (t === "object") {
    const props = isPlainObject(s.properties) ? s.properties : {};
    out.properties = mapValues(props, geminiNode);
    const required = Array.isArray(s.required) ? s.required.filter((r): r is string => typeof r === "string") : [];
    if (required.length > 0) out.required = required;
    const keys = Object.keys(props);
    if (keys.length > 0) out.propertyOrdering = keys;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Output post-processing
// ---------------------------------------------------------------------------

/** Removes `null` values the model emitted for optional, non-nullable fields (OpenAI strict mode does this). */
export function stripNullOptionals(value: unknown, schema: JsonSchema | undefined): unknown {
  if (!schema || !isPlainObject(schema)) return value;
  if (Array.isArray(value)) {
    const items = schema.items;
    return isPlainObject(items) ? value.map((v) => stripNullOptionals(v, items)) : value;
  }
  if (!isPlainObject(value)) return value;
  let target: S | undefined = isPlainObject(schema.properties) ? schema : undefined;
  if (!target) {
    const variants = (Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : []) as unknown[];
    target = variants.find((v): v is S => isPlainObject(v) && isPlainObject(v.properties));
  }
  if (!target) return value;
  const props = target.properties as S;
  const required = new Set(Array.isArray(target.required) ? (target.required as string[]) : []);
  const out: S = {};
  for (const [k, v] of Object.entries(value)) {
    const ps = props[k];
    if (v === null && !required.has(k) && !(isPlainObject(ps) && allowsNull(ps))) continue;
    out[k] = isPlainObject(ps) ? stripNullOptionals(v, ps) : v;
  }
  return out;
}

/** JSON.parse that also accepts ```json fences or prose around a single JSON value. */
export function parseJsonLoose(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const t = text.trim();
  const attempts: string[] = [t];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence?.[1]) attempts.push(fence[1].trim());
  const start = t.search(/[{[]/);
  const end = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
  if (start >= 0 && end > start) attempts.push(t.slice(start, end + 1));
  for (const a of attempts) {
    try {
      return { ok: true, value: JSON.parse(a) };
    } catch {
      // try the next candidate
    }
  }
  return { ok: false, error: t.length === 0 ? "Output was empty." : "Output is not valid JSON." };
}

export function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.slice(0, 12).map((i) => `${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`);
}
