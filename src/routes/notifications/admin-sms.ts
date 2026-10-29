// Staff: the SMS channel of the dashboard composer (tag admin-notifications →
// excluded from the mobile client). The dashboard writes the in-app notification
// itself, then asks here to text its recipients: SMS Gate credentials stay on the
// server. Same roles as the dashboard's send (ops_admin; super_admin always).
import { SmsError, smsNotification, smsStatus } from "../../lib/notification-sms";
import { requireStaffRole } from "../../middleware/staff-roles";
import { bearer, createRoute, errorResponses, IdParam, json, router } from "../../openapi";
import {
  NotificationSmsBody,
  NotificationSmsResponse,
  NotificationSmsStatusResponse,
} from "../../validators/notifications";

const app = router();

const staff = requireStaffRole("ops_admin");

app.openapi(
  createRoute({
    method: "get",
    path: "/admin/sms/status",
    operationId: "getNotificationSmsStatusAdmin",
    tags: ["admin-notifications"],
    security: bearer,
    middleware: [staff] as const,
    responses: { 200: json(NotificationSmsStatusResponse), 401: errorResponses[401], 403: errorResponses[403] },
  }),
  async (c) => c.json(await smsStatus(), 200)
);

app.openapi(
  createRoute({
    method: "post",
    path: "/admin/{id}/sms",
    operationId: "sendNotificationSmsAdmin",
    tags: ["admin-notifications"],
    security: bearer,
    middleware: [staff] as const,
    request: { params: IdParam, body: { ...json(NotificationSmsBody), required: false } },
    responses: {
      200: json(NotificationSmsResponse),
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
      // sms_not_configured / sms_over_limit: refused before anything was sent.
      409: errorResponses[409],
    },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const { lang } = NotificationSmsBody.parse(c.req.valid("json") ?? {});
    try {
      return c.json(await smsNotification(id, lang), 200);
    } catch (e) {
      if (!(e instanceof SmsError)) throw e;
      if (e.code === "not_found") return c.json({ error: e.message, code: e.code }, 404);
      return c.json({ error: e.message, code: e.code }, 409);
    }
  }
);

export default app;
