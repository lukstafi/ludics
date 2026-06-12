// Type declarations for the browser-side role-switcher module.
// Mirrors templates/dashboard/role-switcher.js; PROVIDERS list is pinned
// in lockstep with src/orchestration-defaults.ts via a constant-sync test.

export const PROVIDERS: ReadonlyArray<"claude-code" | "codex">;
export const ROLES: ReadonlyArray<"coder" | "reviewer">;

export type RoleSwitcherRole = "coder" | "reviewer" | "none";
export type RoleSwitcherState = Record<string, RoleSwitcherRole>;
export type HighEndClass = "claude-opus" | "claude-fable";
export interface RoleSwitcherWireBody {
  coder: string | null;
  reviewer: string | null;
  // task-13dee93b: per-role high-end Claude class, carried alongside provider
  // state in the same POST body.
  coderClass?: HighEndClass;
  reviewerClass?: HighEndClass;
}
export interface RoleSwitcherClasses {
  coder?: HighEndClass;
  reviewer?: HighEndClass;
}

export const HIGH_END_CLASSES: ReadonlyArray<HighEndClass>;

// task-13dee93b: claude-code is surfaced in each role dropdown as its two
// model classes directly (no separate sub-select).
export const ROLE_OPTION_VALUES: ReadonlyArray<string>;

export function providerForOptionValue(value: string): string;

export function applyRoleChange(
  state: RoleSwitcherState,
  provider: string,
  role: RoleSwitcherRole,
): RoleSwitcherState;

export function toWireBody(
  state: RoleSwitcherState,
  classState?: RoleSwitcherClasses,
): RoleSwitcherWireBody;

export function createRoleSwitcherElement(
  initialState: RoleSwitcherState,
  onSubmit: (newState: RoleSwitcherWireBody) => Promise<unknown>,
  initialClasses?: RoleSwitcherClasses,
): HTMLElement;

export function fromWireBody(body: RoleSwitcherWireBody): RoleSwitcherState;

export interface InFlightSequencer {
  begin(): number;
  isLatest(id: number): boolean;
}

export function createInFlightSequencer(): InFlightSequencer;
