import { describe, expect, it } from "vitest";
import { groupHeader, groupHeaderRect } from "../src/aws/header";
import { textWidth } from "../src/aws/measure";
import { GroupKind } from "../src/aws/schema";
import { GROUP_STYLE } from "../src/theme/aws-style";

describe("group header", () => {
  it.each(GroupKind.options)("%s: reserves the corner icon only when the kind has one", (kind) => {
    const h = groupHeader(kind, "Label");
    expect(h.iconSize).toBe(GROUP_STYLE[kind].icon ? 32 : 0);
    expect(h.textLeft).toBe(GROUP_STYLE[kind].icon ? 40 : 10);
    expect(h.width).toBeCloseTo(h.textLeft + textWidth("Label", 14) + 4);
  });
  it("places the header band at the frame's top-left corner, 32px tall", () => {
    expect(groupHeaderRect({ x: 10, y: 20, w: 500, h: 300 }, "generic", "Compose")).toEqual({ x: 10, y: 20, w: groupHeader("generic", "Compose").width, h: 32 });
  });
});
