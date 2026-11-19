import { describe, expect, it } from "vitest";
import { NotImplementedError } from "@cue/core";
import { openSqliteStore, SQLITE_SCHEMA } from "@cue/store";

describe("store (scaffold)", () => {
  it("declares the jobs and events tables", () => {
    expect(SQLITE_SCHEMA).toMatch(/CREATE TABLE IF NOT EXISTS jobs/);
    expect(SQLITE_SCHEMA).toMatch(/fence INTEGER/);
  });

  it("is a stub until M1", () => {
    expect(() => openSqliteStore(":memory:")).toThrow(NotImplementedError);
  });
});
