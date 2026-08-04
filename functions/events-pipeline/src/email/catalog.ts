import type { ReactElement } from "react";
import UserCreatedEmail, { type UserCreatedEmailProps } from "../../emails/user-created.tsx";

// The single registry: template key → component + sample props. Three consumers
// read THIS object and nothing else — handlers (to render), the preview server
// (to list), and tests (to snapshot every entry). One source of truth; adding a
// template is one entry here and no change to the renderer or the dispatch
// code. See the milestone design spec's "src/email/catalog.ts — the key piece".
//
// Task 11 adds `order-created` and Task 12 the `tracking-status-changed`
// variants (one entry per status) the same way.
export interface EmailTemplateEntry<P> {
  component: (props: P) => ReactElement;
  // Rendered by the preview server and by the "every entry renders" test, so an
  // entry can never be registered without a working set of props.
  sampleProps: P;
}

// `defineTemplate` is what keeps the map heterogeneous WITHOUT reaching for
// `any`. Each call is checked against its own prop type — passing
// `UserCreatedEmail` with props that don't match `UserCreatedEmailProps` is a
// compile error — and the return type erases P to `unknown` so entries with
// different prop shapes can live in one `Record`.
//
// A plain `Record<string, EmailTemplateEntry<any>>` (the shape the plan
// sketched) would type-check the same registration but disable checking for
// every future entry too, which is exactly the mistake that would surface as a
// runtime "cannot read property of undefined" inside a template.
export function defineTemplate<P>(entry: EmailTemplateEntry<P>): EmailTemplateEntry<unknown> {
  return entry as EmailTemplateEntry<unknown>;
}

export type EmailCatalog = Record<string, EmailTemplateEntry<unknown>>;

export const catalog: EmailCatalog = {
  "user-created": defineTemplate<UserCreatedEmailProps>({
    component: UserCreatedEmail,
    sampleProps: { fullName: "Ada Lovelace", email: "ada@example.com" },
  }),
};
