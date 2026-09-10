import { Row, Column, Text } from "@react-email/components";
import type { ReactNode } from "react";

// The label/value line repeated across the `.pen` frames: a muted label left, a
// primary-coloured value right. The `.pen` splits them with flexbox; email
// clients do not support it, so this is a two-column table row with `align`.
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
