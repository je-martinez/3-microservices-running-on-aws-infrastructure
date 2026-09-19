// Package bus is this service's CQRS dispatch: one generic handler signature,
// one generic middleware signature, and the behaviors every use case shares
// (tracing, app_event, logging, validation).
//
// CONTRACT: There is NO runtime registry and no reflection here. A registry has
// to be `map[reflect.Type]any`-shaped, which erases Q and R exactly where the
// behaviors need them — and the behaviors are the reason the bus exists. Each
// wrapped handler is built once in the composition root and handed to the HTTP
// layer as a value the compiler checks. See [[cqrs]]
package bus

import "context"

// Handler is one use case: a message in, a result out. Commands and queries
// share the shape, so one pipeline serves both.
type Handler[Q any, R any] func(ctx context.Context, q Q) (R, error)

// Middleware wraps a handler in one cross-cutting concern.
type Middleware[Q any, R any] func(Handler[Q, R]) Handler[Q, R]

// Wrap composes mws around h.
//
// CONTRACT: The FIRST middleware listed is the OUTERMOST — it enters first and
// exits last. The loop therefore runs backwards: applying them front to back
// would invert the pipeline, and D4's order is load-bearing (tracing must be
// outside app_event so the span exists when the attributes are set, and
// validation must be innermost so it sees the message the handler will).
// See [[cqrs]]
func Wrap[Q any, R any](h Handler[Q, R], mws ...Middleware[Q, R]) Handler[Q, R] {
	for i := len(mws) - 1; i >= 0; i-- {
		h = mws[i](h)
	}
	return h
}
