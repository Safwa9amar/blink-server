import type { ErrorHandler } from "hono";

export const errorHandler: ErrorHandler = (err, c) => {
  // Zod v4 uses `issues`, v3 uses `errors`
  if (err.name === "ZodError" && "issues" in err) {
    const issues = (err as any).issues as Array<{ path: (string | number)[]; message: string }>;
    return c.json(
      {
        error: "Validation error",
        details: issues.map((e) => ({
          path: e.path.join("."),
          message: e.message,
        })),
      },
      400
    );
  }

  console.error("[Error]", err.message, err.stack);

  return c.json(
    { error: "Internal server error" },
    500
  );
};
