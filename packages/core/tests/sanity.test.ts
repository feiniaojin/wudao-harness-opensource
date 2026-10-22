import { describe, it, expect } from "vitest";
import { PACKAGE_NAME } from "../src/index.js";

describe("sanity", () => {
  it("exposes the package name", () => {
    expect(PACKAGE_NAME).toBe("@wudao/core");
  });
});
