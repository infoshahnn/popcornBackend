import { onDocumentCreated } from "firebase-functions/v2/firestore";
import * as admin from "firebase-admin";
import * as logger from "firebase-functions/logger";
import { fetchBagMarking, formatFieldValue, toFiniteNumber } from "./orderDataToGoogleSheet";

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
  outerPackType?: string;
  itemPackageType?: string;
  ratePerUnitIncludingGst?: number | string | undefined;
  itemRatePerKgIncludingGst?: number | string | undefined;
  itemPackingUnit?: string;
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
      // const totalQuantity = (order.totalBagQuantity ?? 0) + (order.totalBoxQuantity ?? 0);
      // const totalQty = `${totalQuantity}`;
      const totalWeight = `${toFiniteNumber(order.totalWeightKg)} Kg`;

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

      const sourceOrderItems = order.items ?? [];
      const quantityByOuterPackType: Record<string, number> = {};

      for (const item of sourceOrderItems) {
        if (!item) {
          continue;
        }

        const normalizedOuterPackType = String(item.outerPackType ?? "").trim().toLowerCase();
        if (!normalizedOuterPackType) {
          continue;
        }

        const outerPackTypeKey =
          normalizedOuterPackType === "small bag" ? "bag" : normalizedOuterPackType;

        const itemQuantity = toFiniteNumber(item.itemQuantity);
        quantityByOuterPackType[outerPackTypeKey] =
          (quantityByOuterPackType[outerPackTypeKey] ?? 0) + itemQuantity;
      }

      const bagQty = quantityByOuterPackType["bag"] ?? 0;
      const boxQty = quantityByOuterPackType["box"] ?? 0;

      const packSummaryParts: string[] = [];

      if (bagQty > 0) {
        packSummaryParts.push(`${bagQty <= 1 ? "Bag" : "Bags"}: ${bagQty}`);
      }

      if (boxQty > 0) {
        packSummaryParts.push(`${boxQty <= 1 ? "Box" : "Boxes"}: ${boxQty}`);
      }

      const outerPackSummary = packSummaryParts.join(", ");

      console.log(`outerPackSummary: ${outerPackSummary}`);

      const varietyMsgMap: Record<string, string> = {};
      let sessionMessage = "";

      for (let index = 0; index < 6; index++) {
        const item = sourceOrderItems[index];
        let varietyMsg = "";

        if (item) {
          const itemCategory = String(item.itemCategory ?? "").trim();
          const itemName = String(item.itemName ?? "").trim();
          const itemQuantity = String(item.itemQuantity ?? "").trim();
          const outerPackType = String(item.outerPackType ?? "").trim();
          const itemPerKg = toFiniteNumber(item?.ratePerUnitIncludingGst || item?.itemRatePerKgIncludingGst);
          const bagMarking = await fetchBagMarking(formatFieldValue(itemCategory), formatFieldValue(itemName));
          varietyMsg = `${itemQuantity} ${outerPackType} x ${bagMarking} @ ${itemPerKg}/Kg`;

          if (index === 5 && sourceOrderItems.length > 6) {
            varietyMsg = `${varietyMsg} and more...`;
          }
        }

        if (item) {
          varietyMsgMap[`varietyMsg${index + 1}`] = varietyMsg;
          sessionMessage += `* ${varietyMsg}\n`;
        } else {
          varietyMsgMap[`varietyMsg${index + 1}`] = " ";
        }
      }

      let message = `Order from ${userName} ${companyName ? `(${companyName})` : ""}, ${outerPackSummary}, Total Weight: ${totalWeight}\n\n`;
      message += `${sessionMessage}`;
      message += `\nPopcorn Team`;

      const nowMil = Date.now();
      const nowTimestamp = admin.firestore.Timestamp.now();
      // const message = `🛒 Order Confirmation\n\nOrder received successfully.\n\norder number: ${orderNumber}\ncustomer mobile: ${ownNumber}\n\nSales Team`;
      

      for (const adminNumber of adminNumbersWithoutPlus) {
        const parentRef = db.collection("whatsAppMessages").doc(adminNumber);
        const parentSnap = await parentRef.get();
        
         // Skip sending message to this number
        if (adminNumber === "919012345678" || adminNumber === "919699893062" || adminNumber === "918459714085") {
          console.log(`Skipping message for admin number: ${adminNumber}`);
          continue;
        };

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
          customer_name: `${userName}${companyName ? ` (${companyName})` : ""}` || ` Customer${companyName ? ` (${companyName})` : ""}`,
          order_quantity: outerPackSummary,
          total_weight: totalWeight,
          ...varietyMsgMap,
        };

        console.log(`templateVariables: ${JSON.stringify(templateVariables)}`);

        await parentRef.collection("outgoing").add({
          templateName: "order_details_popcorn",
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