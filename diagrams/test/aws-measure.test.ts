import { describe, expect, it } from "vitest";
import { textWidth, wrap } from "../src/aws/measure";

describe("measure", () => {
  it("estimates Arimo width at 0.56em per character", () => {
    expect(textWidth("abcd", 10)).toBeCloseTo(22.4);
    expect(textWidth("", 13)).toBe(0);
  });
  it("wraps on word boundaries within the width", () => {
    expect(wrap("Orders service", 13, 70, 2)).toEqual(["Orders", "service"]);
    expect(wrap("API Gateway", 13, 200, 2)).toEqual(["API Gateway"]);
  });
  it("caps the line count and ellipsises the overflow", () => {
    const lines = wrap("one two three four five six", 13, 40, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1]!.endsWith("…")).toBe(true);
    for (const line of lines) expect(textWidth(line, 13)).toBeLessThanOrEqual(40);
  });
  it("breaks a single overlong word to fit", () => {
    const lines = wrap("Supercalifragilistic", 13, 60, 2);
    for (const line of lines) expect(textWidth(line, 13)).toBeLessThanOrEqual(60);
  });
});
