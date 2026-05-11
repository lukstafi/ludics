// Type declarations for the browser-side role-switcher module.
// Mirrors templates/dashboard/role-switcher.js; PROVIDERS list is pinned
// in lockstep with src/orchestration-defaults.ts via a constant-sync test.

export const PROVIDERS: ReadonlyArray<"claude-code" | "codex">;

export type RoleSwitcherRole = "coder" | "reviewer" | "none";
export type RoleSwitcherState = Record<string, RoleSwitcherRole>;
export interface RoleSwitcherWireBody {
  coder: string | null;
  reviewer: string | null;
}

export function applyRoleChange(
  state: RoleSwitcherState,
  provider: string,
  role: RoleSwitcherRole,
): RoleSwitcherState;

export function createRoleSwitcherElement(
  initialState: RoleSwitcherState,
  onSubmit: (newState: RoleSwitcherWireBody) => Promise<unknown>,
): HTMLElement;

export function fromWireBody(body: RoleSwitcherWireBody): RoleSwitcherState;

export interface InFlightSequencer {
  begin(): number;
  isLatest(id: number): boolean;
}

export function createInFlightSequencer(): InFlightSequencer;
