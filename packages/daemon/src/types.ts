import type { JobRecord } from "@cue/store";
export type { JobId, JobSpecInput } from "@cue/core";

/** What the Gateway returns to clients: the record without internal lease fields. */
export type JobRecordView = JobRecord;
