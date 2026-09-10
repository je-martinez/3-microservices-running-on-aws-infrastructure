import { z } from "zod";

/**
 * The customer-facing order number, as Orders puts it on the wire.
 *
 * CONTRACT: Keep this OPTIONAL wherever it is used — the rule `request_id` follows.
 * A schema failure is a PermanentError and its email is LOST.
 * See [[events-pipeline-design]]
 *
 * CONTRACT: Render `formatted` VERBATIM. The server owns the separator rule, as it
 * owns `Money.formatted`; copies drift. `.min(1)` rejects a blank, which would
 * print an empty gap instead of falling back to the id.
 * See [[friendly-order-number]]
 */
export const OrderNumberSchema = z.object({
  raw: z.string().min(1),
  formatted: z.string().min(1),
});

export type OrderNumber = z.infer<typeof OrderNumberSchema>;
