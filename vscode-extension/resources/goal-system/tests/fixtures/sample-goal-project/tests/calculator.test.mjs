import test from "node:test";
import assert from "node:assert/strict";
import { add, subtract } from "../src/calculator.mjs";

test("add", () => {
  assert.equal(add(2, 3), 5);
});

test("subtract", () => {
  assert.equal(subtract(7, 3), 4);
});
