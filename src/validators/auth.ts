import { z } from "zod";

export const sendOtpSchema = z.object({
  phone_number: z
    .string()
    .regex(/^\+\d{9,15}$/, "Phone must be in international format (e.g. +213XXXXXXXXX)"),
});

export const verifyOtpSchema = z.object({
  phone_number: z
    .string()
    .regex(/^\+\d{9,15}$/),
  otp: z
    .string()
    .length(6, "OTP must be 6 digits"),
});

export const selectRoleSchema = z.object({
  role: z.enum(["customer", "rider", "merchant", "agent"]),
});

export const updateProfileSchema = z.object({
  first_name: z.string().min(1).optional(),
  last_name: z.string().min(1).optional(),
  middle_name: z.string().optional(),
  email: z.string().email().optional(),
  gender: z.enum(["male", "female"]).optional(),
  birthday: z.string().optional(),
  address: z.string().optional(),
});

export const setupPinSchema = z.object({
  pin: z.string().length(4, "PIN must be 4 digits").regex(/^\d{4}$/),
});

export const verifyPinSchema = z.object({
  pin: z.string().length(4).regex(/^\d{4}$/),
});
