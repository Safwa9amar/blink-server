import { z } from "zod";

const orderItemSchema = z.object({
  name: z.string().min(1),
  quantity: z.number().int().positive(),
  unit_price: z.number().nonnegative(),
});

export const createOrderSchema = z.object({
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
});

export const updateOrderStatusSchema = z.object({
  status: z.enum([
    "searching",
    "heading_to_store",
    "preparation",
    "pickup",
    "on_the_way",
    "delivered",
    "canceled",
    "merchant_rejected",
    "processing",
  ]),
  estimated_time: z.string().optional(),
  rider_id: z.string().uuid().optional(),
});

export const listOrdersSchema = z.object({
  status: z
    .enum([
      "searching", "heading_to_store", "preparation", "pickup",
      "on_the_way", "delivered", "canceled", "merchant_rejected", "processing",
    ])
    .optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(50).default(20),
});
