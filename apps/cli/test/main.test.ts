import { describe, expect, it } from "vitest";
import { run } from "../src/main.ts";

describe("cli", () => {
  it("prints the schema version", () => {
    expect(run(["version"])).toBe(0);
  });

  it("rejects unknown commands", () => {
    expect(run(["bogus"])).toBe(2);
  });
});
