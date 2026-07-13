/**
 * RESERVED task operations (Task 2.0): `CreateTask` and `UpdateTaskState`.
 *
 * These ship as fully-validating schemas so a future task workflow slots in
 * without a schema break, but they are RESERVED forward-compatible surface: no
 * V1 workflow, CLI command, or acceptance criterion exercises them, and the
 * validation layer (Phase 4's operation gate) REJECTS any ChangePlan carrying a
 * task op with the stable code `reserved-operation`. Their presence in the
 * discriminated union and the byte-identity fixture matrix is deliberate — the
 * reserved surface must round-trip like every other op.
 */
import { z } from "zod";
import { OpVersion1, TaskState, type OpResult } from "./op-result.js";

export const CreateTaskOpSchema = z
  .object({
    op: z.literal("CreateTask"),
    opVersion: OpVersion1,
    title: z.string().min(1),
    /** Initial task state (defaults to `open` when omitted). */
    state: TaskState.optional(),
    /** Optional due date (RFC-3339 date or date-time string). */
    due: z.string().optional(),
  })
  .strict();

export type CreateTaskOp = z.infer<typeof CreateTaskOpSchema>;

export const CREATE_TASK_ERROR_CODES = ["reserved-operation"] as const;
export type CreateTaskErrorCode = (typeof CREATE_TASK_ERROR_CODES)[number];
export type CreateTaskResult = OpResult<"CreateTask", CreateTaskErrorCode>;

export const UpdateTaskStateOpSchema = z
  .object({
    op: z.literal("UpdateTaskState"),
    opVersion: OpVersion1,
    /** The task note's natural id. */
    taskId: z.string().min(1),
    /** The state to transition to (transition guards deferred with the reserved workflow). */
    toState: TaskState,
  })
  .strict();

export type UpdateTaskStateOp = z.infer<typeof UpdateTaskStateOpSchema>;

export const UPDATE_TASK_STATE_ERROR_CODES = ["reserved-operation"] as const;
export type UpdateTaskStateErrorCode = (typeof UPDATE_TASK_STATE_ERROR_CODES)[number];
export type UpdateTaskStateResult = OpResult<"UpdateTaskState", UpdateTaskStateErrorCode>;
