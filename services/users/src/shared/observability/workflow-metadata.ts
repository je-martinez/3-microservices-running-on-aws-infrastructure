export const WORKFLOW_FLOW = Symbol.for("users:workflowFlow");

/**
 * Names the business flow a handler implements, so the interceptor can derive
 * `<flow>_started` / `_succeeded` / `_failed` without each handler repeating them.
 */
export function Workflow(flow: string): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata(WORKFLOW_FLOW, flow, target);
  };
}

/**
 * A failure that is a normal outcome of the flow, not an error.
 *
 * CONTRACT: Returning this logs `<flow>_failed` + `reason` and leaves span status
 * OK — a "not found" the controller turns into a 404 is not a fault. Throwing is
 * what sets ERROR. Flattening the two is an observability regression that passes
 * review unnoticed. See [[logging-context]]
 */
export class RoutineFailure<T = null> {
  constructor(
    public readonly reason: string,
    public readonly value: T = null as T,
  ) {}
}
