import { z } from "@hono/zod-openapi";
import { orders } from "../db/schema";
import { PaginationSchema, rowSchema } from "../openapi";

const orderStatus = z.enum([
  "searching",
  "heading_to_store",
  "preparation",
  "pickup",
  "on_the_way",
  "delivered",
  "canceled",
  "merchant_rejected",
  "processing",
]);

const orderItemSchema = z
  .object({
    name: z.string().min(1),
    quantity: z.number().int().positive(),
    unit_price: z.number().nonnegative(),
  })
  .openapi("OrderItem");

export const createOrderSchema = z
  .object({
    store_name: z.string().min(1),
    store_logo: z.string().url().optional(),
    type: z.enum(["merchant", "shopper"]),
    items: z.array(orderItemSchema).min(1),
    subtotal: z.number().nonnegative(),
    delivery_fee: z.number().nonnegative(),
    service_fee: z.number().nonnegative(),
    discount: z.number().nonnegative().default(0),
    pickup_address: z.string().optional(),
    destination_address: z.string().optional(),
  })
  .openapi("CreateOrderBody");

export const updateOrderStatusSchema = z
  .object({
    status: orderStatus,
    estimated_time: z.string().optional(),
    rider_id: z.string().uuid().optional(),
  })
  .openapi("UpdateOrderStatusBody");

export const listOrdersSchema = z.object({
  status: orderStatus.optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(50).default(20),
});

// ─── Response schemas ────────────────────────────────────────────────

export const OrderSchema = rowSchema(orders, "OrderRow")
  .extend({ items: z.array(orderItemSchema) })
  .openapi("Order");

export const OrderResponse = z.object({ order: OrderSchema }).openapi("OrderResponse");
export const OrderListResponse = z
  .object({ orders: z.array(OrderSchema), pagination: PaginationSchema })
  .openapi("OrderListResponse");
