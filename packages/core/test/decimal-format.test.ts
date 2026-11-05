import { describe, expect, it } from "vitest";
import { detectDecimalFormat, parseNumber, type DecimalFormat } from "../src/index.ts";

function parsed(raw: string, format: DecimalFormat | null, allowCurrency = true): string | null {
  const r = parseNumber(raw, format, allowCurrency);
  return r.ok ? r.parsed.value.toFixed() : null;
}

describe("detectDecimalFormat", () => {
  it("detects dot-decimal (US) documents", () => {
    expect(detectDecimalFormat(["1,234.56", "12.50", "1,000"]).format).toBe("dot");
  });

  it("detects comma-decimal (European) documents", () => {
    expect(detectDecimalFormat(["1.234,56", "12,50", "1.000"]).format).toBe("comma");
  });

  it("uses repeated separators as grouping evidence", () => {
    expect(detectDecimalFormat(["1,234,567"]).format).toBe("dot");
    expect(detectDecimalFormat(["1.234.567"]).format).toBe("comma");
  });

  it("treats 0,500 as a decimal, not a group", () => {
    expect(detectDecimalFormat(["0,500"]).format).toBe("comma");
  });

  it("refuses to guess when only ambiguous numbers exist", () => {
    const d = detectDecimalFormat(["1,234", "5,000"]);
    expect(d.format).toBeNull();
    expect(d.ambiguous).toBe(2);
  });

  it("flags documents that mix formats", () => {
    const d = detectDecimalFormat(["1,234.56", "12,50"]);
    expect(d.format).toBeNull();
    expect(d.reason).toMatch(/mixes/);
  });

  it("defaults to dot when every number is an integer", () => {
    expect(detectDecimalFormat(["10", "250"]).format).toBe("dot");
  });

  it("ignores currency decoration and space grouping when voting", () => {
    expect(detectDecimalFormat(["€ 1 234,56", "EUR 12,00"]).format).toBe("comma");
  });
});

describe("parseNumber", () => {
  it("parses dot-decimal values with grouping and currency", () => {
    expect(parsed("$1,234.56", "dot")).toBe("1234.56");
    expect(parsed("USD 12.50", "dot")).toBe("12.5");
    expect(parsed("1,000", "dot")).toBe("1000");
    expect(parsed("12.345 USD", "dot")).toBe("12.345");
  });

  it("parses comma-decimal values", () => {
    expect(parsed("1.234,56 €", "comma")).toBe("1234.56");
    expect(parsed("1 234,56", "comma")).toBe("1234.56");
    expect(parsed("1.000", "comma")).toBe("1000");
  });

  it("parses Swiss apostrophe grouping", () => {
    expect(parsed("1'234.50", "dot")).toBe("1234.5");
  });

  it("records the printed scale", () => {
    const r = parseNumber("25.00", "dot", true);
    expect(r.ok && r.parsed.scale).toBe(2);
    const q = parseNumber("10", "dot", false);
    expect(q.ok && q.parsed.scale).toBe(0);
  });

  it("parses negatives in parentheses, leading and trailing minus", () => {
    expect(parsed("(3.00)", "dot")).toBe("-3");
    expect(parsed("-3.00", "dot")).toBe("-3");
    expect(parsed("3.00-", "dot")).toBe("-3");
    expect(parsed("($3.00)", "dot")).toBe("-3");
  });

  it("rejects malformed grouping instead of guessing", () => {
    expect(parsed("1,23.45", "dot")).toBeNull();
    expect(parsed("12,3456.00", "dot")).toBeNull();
    expect(parsed("1.234.56", "dot")).toBeNull();
  });

  it("rejects non-numeric text", () => {
    expect(parsed("N/A", "dot")).toBeNull();
    expect(parsed("12 pcs", "dot", false)).toBeNull();
    expect(parsed("", "dot")).toBeNull();
    expect(parsed("--3", "dot")).toBeNull();
  });

  it("rejects currency on fields that don't allow it", () => {
    expect(parsed("$10", "dot", false)).toBeNull();
  });

  it("with unknown format, accepts only values both readings agree on", () => {
    expect(parsed("12", null)).toBe("12");
    expect(parsed("1,234", null)).toBeNull();
    expect(parsed("12.50", null)).toBeNull();
  });

  it("preserves precision beyond floating point", () => {
    expect(parsed("12,345,678,901,234.5678", "dot")).toBe("12345678901234.5678");
  });
});
