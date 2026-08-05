import { Html, Head, Body, Container, Text } from "@react-email/components";
import type { ReactNode } from "react";

// Shared chrome for every transactional email. Lives in `emails/` (the
// react-email CLI's default dir) rather than under `src/` so `email dev` picks
// it up for preview without a second copy of the templates.
//
// Inline styles, not a stylesheet: email clients strip <style> blocks
// inconsistently, so react-email's style props are the portable option.
export function EmailLayout({ children }: { children: ReactNode }) {
  return (
    <Html>
      <Head />
      <Body style={{ fontFamily: "sans-serif", backgroundColor: "#f6f6f6" }}>
        <Container style={{ backgroundColor: "#ffffff", padding: "24px" }}>
          {children}
          <Text style={{ fontSize: "12px", color: "#888" }}>3MRAI</Text>
        </Container>
      </Body>
    </Html>
  );
}
