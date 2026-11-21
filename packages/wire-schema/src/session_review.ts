import type { SessionCreated } from "../generated/typescript/index.js";
export type ReviewState = NonNullable<NonNullable<SessionCreated["session"]>["review_state"]>;
