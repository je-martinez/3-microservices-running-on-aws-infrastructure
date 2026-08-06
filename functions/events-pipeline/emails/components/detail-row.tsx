import { Row, Column, Text } from "@react-email/components";
import type { ReactNode } from "react";

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
    <Row className="mb-[10px]">
      <Column align="left">
        <Text className="m-0 font-body text-[13px] font-normal text-text-secondary">{label}</Text>
      </Column>
      <Column align="right">
        <Text className="m-0 font-body text-[13px] font-medium text-text-primary">{value}</Text>
      </Column>
    </Row>
  );
}
