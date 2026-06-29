import { nanoid } from "nanoid";

export function newUserId(): string {
  return `usr_${nanoid()}`;
}
