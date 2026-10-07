import { describe, expect, it } from "vitest";
import { AwsService } from "../src/schema";
import { awsIcon } from "../src/theme/aws-icons";

describe("awsIcon", () => {
  it.each(AwsService.options)("maps %s to a component", (s) => {
    expect(awsIcon(s)).toBeTruthy();
  });
});
