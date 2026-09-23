import assert from "node:assert/strict";
import test from "node:test";
import { verifyPackageSurface, verifyProductNames } from "../scripts/check-product-names.mjs";

test("Q-Core and workflow Registry surface has no qloops aliases", () => {
  assert.doesNotThrow(() => verifyProductNames());
});

test("old qloops package name is rejected by the negative naming guard", () => {
  assert.throws(
    () => verifyPackageSurface({ name: "qloops", version: "0.2.0-q-core.21", bin: {} }, []),
    /Q-Core name/,
  );
});
