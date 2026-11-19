export * from "./job.js";
export * from "./config.js";

/** Thrown by scaffold stubs that later milestones fill in. */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`not implemented yet: ${what}`);
    this.name = "NotImplementedError";
  }
}
