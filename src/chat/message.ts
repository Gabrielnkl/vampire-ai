export type Role = "system" | "user" | "assistant";

export interface Message {
  readonly role: Role;
  readonly content: string;
}
