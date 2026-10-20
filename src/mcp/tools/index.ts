import type { ToolDef } from "../registry";
import { findUsers, getUser } from "./users";
import { getOrder, listOrders } from "./orders";
import { getTrip, listTrips } from "./trips";
import { getTransaction, getWallet, listTransactions } from "./cash";
import { getStore, listStores } from "./stores";
import { getSupportConversation, listSupportConversations } from "./support";
import { opsSummary, serverInfo } from "./ops";
import { COMMERCE_TOOLS } from "./commerce";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const ALL_TOOLS: ToolDef<any>[] = [
  findUsers,
  getUser,
  listOrders,
  getOrder,
  listTrips,
  getTrip,
  listTransactions,
  getTransaction,
  getWallet,
  listStores,
  getStore,
  listSupportConversations,
  getSupportConversation,
  opsSummary,
  serverInfo,
  ...COMMERCE_TOOLS,
];
