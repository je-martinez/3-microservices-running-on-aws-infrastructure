import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GenericIcon } from "../src/aws/schema";
import { AwsService } from "../src/schema";
import { GROUP_STYLE } from "../src/theme/aws-style";
import { awsIcon, genericIconSrc, groupIconSrc } from "../src/theme/aws-icons";

const publicDir = new URL("../public/", import.meta.url).pathname;
const onDisk = (src: string) => existsSync(publicDir + src.replace(/^.*?aws-icons\//, "aws-icons/"));

describe("awsIcon", () => {
  it.each(AwsService.options)("maps %s to a component", (s) => {
    expect(awsIcon(s)).toBeTruthy();
  });
});

describe("official group and generic icons", () => {
  const groupIcons = [...new Set(Object.values(GROUP_STYLE).flatMap((s) => (s.icon ? [s.icon] : [])))];
  it.each(groupIcons)("group icon %s resolves to a fetched file", (icon) => {
    expect(onDisk(groupIconSrc(icon))).toBe(true);
  });
  it.each(GenericIcon.options)("generic icon %s resolves to a fetched file", (icon) => {
    expect(onDisk(genericIconSrc(icon))).toBe(true);
  });
});
