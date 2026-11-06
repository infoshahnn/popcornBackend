import { onDocumentCreated } from "firebase-functions/v2/firestore";
import * as admin from "firebase-admin";
import * as logger from "firebase-functions/logger";

type OrderItem = {
  itemName?: string;
  itemCategory?: string;
  itemSize?: number;
  itemPackingUnit?: string;
  itemPackageType?: string;
  itemQuantity?: number;
  itemTotalWeightKg?: number;
  itemRatePerKg?: number;
  ratePerUnitIncludingGst?: number;
  amountIncludingGst?: number;
};

type OrderDocument = {
  orderNumber?: string;
  ownNumber?: string;
  createdAtMil?: number;
  createdAtTimestamp?: admin.firestore.Timestamp;
  totalBagQuantity?: number;
  totalBoxQuantity?: number;
  totalWeightKg?: number;
  totalAmountBasic?: number;
  totalAmountGst?: number;
  totalLocalTransportCharge?: number;
  totalAmountIncludingGst?: number;
  items?: OrderItem[];
};

const formatCurrency = (value?: number): string => {
  const amount = Number(value ?? 0);
  return amount.toFixed(2);
};

const buildOrderDetails = (order: OrderDocument): [string, string] => {
  const items = Array.isArray(order.items) ? order.items : [];
  const itemsSection = items
    .map((item, index) => {
      return [
        `${index + 1}. ${item.itemName ?? "N/A"}`,
        `   • Category: ${item.itemCategory ?? "N/A"}`,
        `   • Packing: ${item.itemSize ?? 0} ${item.itemPackingUnit ?? ""} ${item.itemPackageType ?? ""}`.trimEnd(),
        `   • Quantity: ${item.itemQuantity ?? 0}`,
        `   • Total Weight: ${item.itemTotalWeightKg ?? 0} Kg`,
        `   • Rate: ₹${formatCurrency(item.itemRatePerKg)}/Kg`,
        `   • Rate Including GST: ₹${formatCurrency(item.ratePerUnitIncludingGst)}/Kg`,
        `   • Amount: ₹${formatCurrency(item.amountIncludingGst)}`,
      ].join("\n");
    })
    .join("\n\n");
    console.log("itemsSection", itemsSection);

  const orderDetails = [
    `🆔 Order No: ${order.orderNumber ?? "N/A"}`,
    "",
    `📱 Mobile: ${order.ownNumber ?? "N/A"}`,
    "",
    "━━━━━━━━━━━━━━━━━━━━━━",
    "📋 Items Ordered",
    "",
    itemsSection || "No items found in order.",
    "",
    "━━━━━━━━━━━━━━━━━━━━━━",
    "📊 Order Summary",
    "",
    `🛍️ Total Bags: ${order.totalBagQuantity ?? 0}`,
    `📦 Total Boxes: ${order.totalBoxQuantity ?? 0}`,
    `⚖️ Total Weight: ${order.totalWeightKg ?? 0} Kg`,
    "",
    `💰 Basic Amount: ₹${formatCurrency(order.totalAmountBasic)}`,
    `🧾 GST: ₹${formatCurrency(order.totalAmountGst)}`,
    `🚚 Local Transport: ₹${formatCurrency(order.totalLocalTransportCharge)}`,
    "",
    `✅ Grand Total: ₹${formatCurrency(order.totalAmountIncludingGst)}`,
  ].join("\n");

  const orderNumber = order.orderNumber ?? "N/A";

  return [orderDetails, orderNumber];
};

export const frs_orders_orderPlaceMessage_export = onDocumentCreated(
  {
    document: "orders/{orderId}",
    region: "asia-south1",
    memory: "512MiB",
  },
  async (event) => {
    try {
      const snapshot = event.data;
      if (!snapshot?.exists) {
        logger.warn("Order create trigger fired without snapshot data", {
          eventId: event.id,
        });
        return;
      }

      const order = snapshot.data() as OrderDocument;
      const orderId = event.params.orderId;
      const ownNumber = String(order.ownNumber ?? "").trim();
      const ownNumberWithoutPlus = ownNumber.replace(/^\+/, "");

      if (!ownNumberWithoutPlus) {
        logger.error("Order does not contain ownNumber, skipping whatsapp queue", {
          orderId,
        });
        return;
      }

      const nowTimestamp = order.createdAtTimestamp ?? admin.firestore.Timestamp.now();
      const nowMil = Number(order.createdAtMil ?? Date.now());
      const orderDetails = buildOrderDetails(order);
      const [orderDetailsMessage, orderNumber] = orderDetails;

      logger.info("Prepared order details for whatsapp message", {
        orderId,
        ownNumber: ownNumberWithoutPlus,
        itemsCount: Array.isArray(order.items) ? order.items.length : 0,
      });

      const db = admin.firestore();
      const parentRef = db.collection("whatsAppMessages").doc(ownNumberWithoutPlus);
      const parentSnap = await parentRef.get();

      if (!parentSnap.exists) {
        await parentRef.set({
          createdAtMil: nowMil,
          createdAtTimestamp: nowTimestamp,
          ownNumber: ownNumberWithoutPlus,
          latestOutgoingMil: nowMil,
          latestOutgoingTimestamp: nowTimestamp,
          numberOfOutgoingMessages: 1,
        });

        logger.info("Created new whatsAppMessages parent document", {
          ownNumber: ownNumberWithoutPlus,
        });
      } else {
        await parentRef.update({
          latestOutgoingMil: nowMil,
          latestOutgoingTimestamp: nowTimestamp,
          numberOfOutgoingMessages: admin.firestore.FieldValue.increment(1),
        });

        logger.info("Updated existing whatsAppMessages parent document", {
          ownNumber: ownNumberWithoutPlus,
        });
      }

      const templateVariables = {
        order_number: orderNumber,
      };
      
      await parentRef.collection("outgoing").add({
        createdAtMil: nowMil,
        createdAtTimestamp: nowTimestamp,
        message: orderDetailsMessage,
        templateVariables,
        status: "pending",
        templateName: "order_details_message",
      });

      logger.info("Queued outgoing whatsapp message", {
        orderId,
        ownNumber: ownNumberWithoutPlus,
      });
    } catch (error) {
      logger.error("Failed to process order create trigger", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
);