import type { z } from "zod";
import type { StaffRole } from "../middleware/staff-roles";

export type { StaffRole };

/** Who is calling — resolved by the /mcp auth middleware. */
export interface McpContext {
  tokenId: string | null; // null when authenticated with a Supabase staff JWT
  user: { id: string; first_name: string | null; last_name: string | null; staff_role: StaffRole };
  staffRole: StaffRole;
}

export interface ToolResult {
  /** Serialised as JSON text + structuredContent. Must be a plain object. */
  data: Record<string, unknown>;
  /** For the audit log. */
  rowCount?: number;
}

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  input: S;
  /** Allowlist of staff roles. Omitted = every staff role. super_admin always passes. */
  roles?: StaffRole[];
  handler: (args: z.infer<z.ZodObject<S>>, ctx: McpContext) => Promise<ToolResult>;
}

export function defineTool<S extends z.ZodRawShape>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

export function toolAllowed(tool: Pick<ToolDef, "roles">, role: StaffRole): boolean {
  if (role === "super_admin") return true;
  if (!tool.roles) return true;
  return tool.roles.includes(role);
}

export function toolsForRole<T extends Pick<ToolDef, "roles">>(tools: readonly T[], role: StaffRole): T[] {
  return tools.filter((t) => toolAllowed(t, role));
}
