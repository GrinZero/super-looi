import type { UserActionRef } from "@super-looi/contracts";

export interface Vault {
  get(key: string): string;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export type UiActionGuard = (action: UserActionRef) => void;
