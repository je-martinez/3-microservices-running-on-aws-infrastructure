import { z } from "zod";

// The producer→pipeline contract. `type` and `source` are ALSO set as SQS
// message attributes (see the producers in Block D), so the queue can be
// inspected without deserializing the body — this schema validates the body.
export const EnvelopeSchema = z.object({
  event_id: z.string().min(1),
  type: z.string().min(1),
  source: z.string().min(1),
  user_id: z.string().min(1),
  order_id: z.string().min(1).nullable(),
  payload: z.record(z.string(), z.unknown()),
});

export type Envelope = z.infer<typeof EnvelopeSchema>;
