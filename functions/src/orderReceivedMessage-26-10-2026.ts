import { onDocumentCreated } from "firebase-functions/v2/firestore";
import * as admin from "firebase-admin";
import * as logger from "firebase-functions/logger";

type TriggerOrderDocument = {
  orderNumber?: string;
  ownNumber?: string;
  userName?: string;
  companyName?: string;
  items?: TriggerOrderItem[];
  totalBagQuantity?: number;
  totalBoxQuantity?: number;
  totalWeightKg?: number | string;
  totalAmountIncludingGstAfterRoundOff?: number | string;
};

type TriggerOrderItem = {
  itemCategory?: string;
  itemName?: string;
  itemQuantity?: string | number;
  itemPackageType?: string;
};

type AdDocument = {
  ad?: Record<string, string>;
};

export const frs_orders_orderReceivedMessage_export = onDocumentCreated(
  {
    document: "orders/{orderId}",
    region: "asia-south1",
    memory: "1GiB",
  },
  async (event) => {
    try {
      const snapshot = event.data;
      if (!snapshot?.exists) {
        logger.warn("Order received trigger fired without snapshot data", {
          eventId: event.id,
        });
        return;
      }

      const orderId = event.params.orderId;
      const order = snapshot.data() as TriggerOrderDocument;
      const orderNumber = String(order.orderNumber ?? "").trim();
      const ownNumber = String(order.ownNumber ?? "").trim();
      const userName = String(order.userName ?? "").trim();
      const companyName = String(order.companyName ?? "").trim() || null;
      const totalQuantity = (order.totalBagQuantity ?? 0) + (order.totalBoxQuantity ?? 0);
      const totalQtyWeight = `${totalQuantity}, ${order.totalWeightKg ?? 0}`;
      const totalAmount = Number(order.totalAmountIncludingGstAfterRoundOff ?? 0).toLocaleString('en-US');

      if (!orderNumber || !ownNumber) {
        logger.error("Order is missing required fields", {
          orderId,
          hasOrderNumber: Boolean(orderNumber),
          hasOwnNumber: Boolean(ownNumber),
        });
        return;
      }

      const db = admin.firestore();
      const adDocRef = db.collection("random").doc("ad");
      const adDocSnap = await adDocRef.get();

      if (!adDocSnap.exists) {
        logger.warn("Admin mapping document random/ad not found", { orderId });
        return;
      }

      const adDocData = adDocSnap.data() as AdDocument;
      const adMap = adDocData.ad ?? {};
      let adminNumbersWithoutPlus = Object.keys(adMap)
        .map((mobileNumber) => String(mobileNumber).replace(/^\+/, "").trim())
        .filter((mobileNumber) => mobileNumber.length > 0);
      
      if(ownNumber == "+919012345678" || ownNumber == "+917507158855" || ownNumber == "+918799951360") {
        adminNumbersWithoutPlus = ["917758967817"]
      }

      if (adminNumbersWithoutPlus.length === 0) {
        logger.warn("No admin numbers found in random/ad.ad map", { orderId });
        return;
      }

      console.log(`admin numbers: ${JSON.stringify(adminNumbersWithoutPlus)}`);

      logger.info("Preparing order received messages for admin numbers", {
        orderId,
        adminCount: adminNumbersWithoutPlus.length,
      });

      const nowMil = Date.now();
      const nowTimestamp = admin.firestore.Timestamp.now();
      const message = `🛒 Order Confirmation\n\nOrder received successfully.\n\norder number: ${orderNumber}\ncustomer mobile: ${ownNumber}\n\nSales Team`;

      for (const adminNumber of adminNumbersWithoutPlus) {
        const parentRef = db.collection("whatsAppMessages").doc(adminNumber);
        const parentSnap = await parentRef.get();

        if (!parentSnap.exists) {
          await parentRef.set({
            createdAtMil: nowMil,
            createdAtTimestamp: nowTimestamp,
            ownNumber: adminNumber,
            latestOutgoingMil: nowMil,
            latestOutgoingTimestamp: nowTimestamp,
            numberOfOutgoingMessages: 0,
          });

          logger.info("Created whatsAppMessages parent document", {
            adminNumber,
          });
        }

        const templateVariables = {
          customer_name: `${userName} ${companyName ? `(${companyName})` : ""}` || `Customer (${companyName})`,
          qty_weight: totalQtyWeight,
          total_amount: totalAmount,
        };

        console.log(`templateVariables: ${JSON.stringify(templateVariables)}`);

        await parentRef.collection("outgoing").add({
          templateName: "popcorn_order_received",
          templateVariables,
          createdAtMil: nowMil,
          createdAtTimestamp: nowTimestamp,
          status: "pending",
          message,
        });

        await parentRef.update({
          latestOutgoingMil: nowMil,
          latestOutgoingTimestamp: nowTimestamp,
          numberOfOutgoingMessages: admin.firestore.FieldValue.increment(1),
        });

        logger.info("Queued order received message for admin", {
          orderId,
          adminNumber,
        });
      }
    } catch (error) {
      logger.error("Failed to process order received trigger", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
);