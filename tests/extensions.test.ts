import { describe, expect, it } from "vitest";
import { ExtensionValidator } from "../src/extensions/validator.js";

describe("extension schemas", () => {
  it("rejects invalid schemas during model registration", () => {
    expect(() => new ExtensionValidator("broken", { engine: { schema: { type: "not-a-json-schema-type" } } })).toThrow(/Invalid extension schema 'engine'/);
    expect(() => new ExtensionValidator("async", { engine: { schema: { $async: true, type: "object" } } })).toThrow(/asynchronous schemas are not supported/);
  });

  it("does not materialize defaults unless the namespace is requested", () => {
    const validator = new ExtensionValidator("speech", { engine: { schema: { type: "object", properties: { temperature: { type: "number", default: 0.7 } } } } });
    expect(validator.validate(undefined)).toBeUndefined();
    expect(validator.validate({ engine: {} })).toEqual({ engine: { temperature: 0.7 } });
  });
});
