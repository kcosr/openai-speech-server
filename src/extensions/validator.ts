import { createRequire } from "node:module";
import type { Ajv as AjvConstructor, AnySchema, ValidateFunction } from "ajv";
import type { FormatsPlugin } from "ajv-formats";
import { invalid } from "../api/errors.js";
import type { ModelExtensions } from "../config/schema.js";

const require = createRequire(import.meta.url);
const Ajv = require("ajv") as typeof AjvConstructor;
const addFormats = require("ajv-formats") as FormatsPlugin;

export class ExtensionValidator {
  private readonly validators = new Map<string, ValidateFunction>();

  constructor(modelId: string, readonly definitions: ModelExtensions) {
    for (const [namespace, definition] of Object.entries(definitions)) {
      try {
        const ajv = new Ajv({ allErrors: true, strict: true, useDefaults: true });
        addFormats(ajv);
        const validator = ajv.compile(definition.schema as AnySchema);
        if ("$async" in validator) throw new Error("asynchronous schemas are not supported");
        this.validators.set(namespace, validator);
      } catch (error) {
        throw new Error(`Invalid extension schema '${namespace}' for model '${modelId}': ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  validate(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    if (!value || Object.keys(value).length === 0) return undefined;
    const unsupported = Object.keys(value).find((namespace) => !this.validators.has(namespace));
    if (unsupported) throw invalid("unsupported_extension", `Unsupported extension '${unsupported}'.`, `extensions.${unsupported}`);

    const result = structuredClone(value);
    for (const [namespace, extensionValue] of Object.entries(result)) {
      const validator = this.validators.get(namespace)!;
      if (!validator(extensionValue)) {
        const detail = validator.errors?.[0];
        const location = detail?.instancePath || "/";
        throw invalid("invalid_extension", `Extension '${namespace}' at '${location}' ${detail?.message ?? "is invalid"}.`, `extensions.${namespace}`);
      }
    }
    return result;
  }
}
