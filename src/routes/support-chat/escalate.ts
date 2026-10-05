import { bearer, createRoute, errorResponses, IdParam, json, router } from "../../openapi";
import { escalateSchema, SupportOkResponse } from "../../validators/support-chat";
import { escalateConversation } from "../../lib/support-chat";
import { getConversation } from "./shared";

const app = router();

// POST /conversations/:id/escalate — user asks for a human.
const route = createRoute({
  method: "post",
  path: "/conversations/{id}/escalate",
  operationId: "escalateSupportConversation",
  tags: ["support-chat"],
  security: bearer,
  request: { params: IdParam, body: { ...json(escalateSchema), required: false } },
  responses: {
    200: json(SupportOkResponse),
    400: errorResponses[400],
    403: errorResponses[403],
    404: errorResponses[404],
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const { id } = c.req.valid("param");
  const { reason } = c.req.valid("json");

  const conversation = await getConversation(id);
  if (!conversation) return c.json({ error: "Conversation not found" }, 404);
  if ((conversation as any).user_id !== user.id) return c.json({ error: "Access denied" }, 403);

  if (conversation.status === "bot" || conversation.status === "resolved") {
    await escalateConversation(conversation, reason ?? "user requested a human");
  }
  return c.json({ ok: true }, 200);
});

export default app;
