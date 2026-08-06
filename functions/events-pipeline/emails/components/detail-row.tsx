import { Row, Column, Text } from "@react-email/components";
import type { ReactNode } from "react";
import { theme } from "../theme.ts";

// The label/value line that repeats across the `.pen` frames ("Row Email", "Row
// Member Since", "Row Account ID", "Row Carrier", "Row Tracking Number", …):
// a muted 13px label on the left, a 13px/500 primary-coloured value on the
// right.
//
// The `.pen` achieves the split with `justifyContent: space_between`; email
// clients do not support flexbox, so this is a two-column table row with
// `align` doing the work.
export function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <Row style={{ marginBottom: "10px" }}>
      <Column align="left">
        <Text
          style={{
            margin: "0",
            fontFamily: theme.fontBody,
            fontSize: "13px",
            fontWeight: 400,
            color: theme.textSecondary,
          }}
        >
          {label}
        </Text>
      </Column>
      <Column align="right">
        <Text
          style={{
            margin: "0",
            fontFamily: theme.fontBody,
            fontSize: "13px",
            fontWeight: 500,
            color: theme.textPrimary,
          }}
        >
          {value}
        </Text>
      </Column>
    </Row>
  );
}
