import { Hono } from "hono";
import { supabaseAdmin } from "../../lib/supabase";
import type { AuthEnv } from "../../middleware/auth";
import { z } from "zod";

const upsertVehicleSchema = z.object({
  brand: z.string().min(1),
  model: z.string().min(1),
  license_plate: z.string().min(1),
  year: z.string().min(1),
  color: z.string().min(1),
  category: z.enum(["standard", "electric", "hybrid"]),
});

const app = new Hono<AuthEnv>();

// ─── Create or update vehicle ────────────────────────────────────────
app.put("/vehicle", async (c) => {
  const user = c.get("user");
  const body = upsertVehicleSchema.parse(await c.req.json());

  // Check if vehicle exists
  const { data: existing } = await supabaseAdmin
    .from("vehicles")
    .select("id")
    .eq("user_id", user.id)
    .single();

  let result;
  if (existing) {
    result = await supabaseAdmin
      .from("vehicles")
      .update(body)
      .eq("user_id", user.id)
      .select()
      .single();
  } else {
    result = await supabaseAdmin
      .from("vehicles")
      .insert({
        ...body,
        user_id: user.id,
        gray_card_status: "not_uploaded",
        insurance_status: "not_uploaded",
        driving_license_status: "not_uploaded",
      })
      .select()
      .single();
  }

  if (result.error) {
    return c.json({ error: result.error.message }, 400);
  }

  return c.json({ vehicle: result.data });
});

export default app;
