import { describe, expect, it } from "vitest";
import { shouldUseStatelessGroupRollover } from "./groupsense-context-engine.js";

describe("shouldUseStatelessGroupRollover", () => {
  it("returns false when groupsense context engine is selected", () => {
    expect(
      shouldUseStatelessGroupRollover({
        plugins: {
          slots: {
            contextEngine: "groupsense",
          },
        },
        channels: {
          feishu: {
            milestoneContext: {
              enabled: true,
            },
          },
        },
      }),
    ).toBe(false);
  });

  it("returns true when milestone context is enabled and groupsense is not selected", () => {
    expect(
      shouldUseStatelessGroupRollover({
        channels: {
          feishu: {
            milestoneContext: {
              enabled: true,
            },
          },
        },
      }),
    ).toBe(true);
  });

  it("returns false when milestone context is disabled", () => {
    expect(
      shouldUseStatelessGroupRollover({
        channels: {
          feishu: {
            milestoneContext: {
              enabled: false,
            },
          },
        },
      }),
    ).toBe(false);
  });
});
