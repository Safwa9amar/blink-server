import { auth, requireRole } from "../../middleware/auth";
import { requireVerifiedPartner, MERCHANT_ONBOARDING } from "../../lib/verified-account";
import { router } from "../../openapi";
import storesList from "./stores-list";
import storesCreate from "./stores-create";
import storesDetail from "./stores-detail";
import storesUpdate from "./stores-update";
import productsList from "./products-list";
import productsCreate from "./products-create";
import productsUpdate from "./products-update";
import productsDelete from "./products-delete";
import library from "./library";
import packsList from "./packs-list";
import packsCreate from "./packs-create";
import packsUpdate from "./packs-update";
import packsDelete from "./packs-delete";
import ordersList from "./orders-list";
import ordersAction from "./orders-action";
import earnings from "./earnings";
import dues from "./dues";
import duesPay from "./dues-pay";
import dashboard from "./dashboard";
import dashboardGlobal from "./dashboard-global";
import uploads from "./uploads";
import adminReview from "./admin-review";
import ordersDetail from "./orders-detail";
import ordersRiders from "./orders-riders";
import ordersAssign from "./orders-assign";
import ordersOffer from "./orders-offer";
import ordersReply from "./orders-reply";
import drivers from "./drivers";
import categories from "./categories";
import strategy from "./strategy";

const app = router();

app.use("/*", auth);
// Staff review endpoints carry their own requireStaff guard; everything else
// is the merchant app.
app.use("/*", async (c, next) => {
  if (c.req.path.includes("/merchant/admin/")) return next();
  return requireRole("merchant")(c, next);
});
app.use("/*", requireVerifiedPartner({ prefix: "/merchant", allow: MERCHANT_ONBOARDING, skip: "/admin/" }));

// Each endpoint lives in its own file and is mounted at the router root.
app.route("/", storesList);
app.route("/", storesCreate);
app.route("/", storesDetail);
app.route("/", storesUpdate);
app.route("/", productsList);
app.route("/", productsCreate);
app.route("/", productsUpdate);
app.route("/", productsDelete);
app.route("/", library);
app.route("/", packsList);
app.route("/", packsCreate);
app.route("/", packsUpdate);
app.route("/", packsDelete);
app.route("/", ordersList);
app.route("/", ordersRiders);
app.route("/", ordersAssign);
app.route("/", ordersOffer);
app.route("/", ordersReply);
app.route("/", ordersDetail);
app.route("/", ordersAction);
app.route("/", drivers);
app.route("/", categories);
app.route("/", strategy);
app.route("/", earnings);
app.route("/", dues);
app.route("/", duesPay);
app.route("/", dashboardGlobal);
app.route("/", dashboard);
app.route("/", uploads);
app.route("/", adminReview);

export default app;
