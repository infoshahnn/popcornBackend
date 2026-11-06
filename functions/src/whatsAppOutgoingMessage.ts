import { onDocumentCreated } from "firebase-functions/v2/firestore";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";

type OutgoingMessageDoc = {
  message?: string;
  templateVariables?: Record<string, string>;
  status?: string;
  templateName?: string;
  createdAtMil?: number;
  createdAtTimestamp?: admin.firestore.Timestamp;
};

type WatiResult = {
  ok: boolean;
  status: number;
  bodyText: string;
};

const WATI_API_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1bmlxdWVfbmFtZSI6Imtob2pvZmZpY2VAZ21haWwuY29tIiwibmFtZWlkIjoia2hvam9mZmljZUBnbWFpbC5jb20iLCJlbWFpbCI6Imtob2pvZmZpY2VAZ21haWwuY29tIiwiYXV0aF90aW1lIjoiMTAvMTcvMjAyNiAwODowODoyNCIsInRlbmFudF9pZCI6IjEwMTI0OTIiLCJkYl9uYW1lIjoibXQtcHJvZC1UZW5hbnRzIiwiaHR0cDovL3NjaGVtYXMubWljcm9zb2Z0LmNvbS93cy8yMDA4LzA2L2lkZW50aXR5L2NsYWltcy9yb2xlIjoiQURNSU5JU1RSQVRPUiIsImV4cCI6MjUzNDAyMzAwODAwLCJpc3MiOiJDbGFyZV9BSSIsImF1ZCI6IkNsYXJlX0FJIn0.dsV1UPM1jiR1euH5m29O-lFqBUi9gNF-QvAyU1nj8Rw";

const WATI_BASE_URL = "https://live-mt-server.wati.io/1012492/api/v1";
const DEFAULT_TEMPLATE_NAME = "order_details_message";

const normalizePhone = (mobileNo: string): string => mobileNo.replace(/^\+/, "").trim();

const isWatiSuccess = (bodyText: string): boolean => {
  try {
    const parsed = JSON.parse(bodyText);
    const result = String(parsed?.result ?? "").toLowerCase();
    const status = String(parsed?.status ?? "").toLowerCase();

    return (
      parsed?.result === true ||
      parsed?.ok === true ||
      result === "success" ||
      result === "queued" ||
      status === "success" ||
      status === "queued" ||
      parsed?.messageId !== undefined
    );
  } catch {
    const text = bodyText.toLowerCase();
    return text.includes("success") || text.includes("queued") || text.includes("accepted");
  }
};

// const sendWatiSessionMessage = async (phone: string, messageText: string): Promise<WatiResult> => {
//   const formattedMessage = `🛒 Order Confirmation\n\n

//     Dear Customer,\n

//     Thank you for your order. Please review your order details below:\n\n

//     ━━━━━━━━━━━━━━━━━━━━━━\n\n
//     📦 Order Details\n

//     ${messageText}\n\n

//     ━━━━━━━━━━━━━━━━━━━━━━\n\n
//     📜 Terms & Conditions\n

//     1. Rate is Ex Warehouse Nagpur (Inco Terms: Ex Works).
//     2. Broker: None / Own.
//     3. Risk and responsibility transfer to the buyer once the goods leave the Nagpur warehouse.
//     4. Payment Terms: Advance.
//     5. Delay in payment may attract a penalty at the seller's discretion.
//     6. Dispatch Date: {dispatchDate}
//     7. Quality is judged based on expansion, not appearance.
//     8. Seller reserves the right to modify or cancel the order without penalty.
//     9. Buyer accepts up to 20% tolerance for torn pouches.
//     10. GST is included for 1 Kg packing. No GST is applicable on 30 Kg loose packing.
//     11. This is a No Claim deal.
//     12. Any damaged, missing, torn, or wet bags must be reported before transporter payment. Compensation will be adjusted from transport charges.
//     13. Some bags may contain 200g or 500g packets.
//     14. Mandi Cess/APMC Tax, if applicable, shall be borne by the buyer.
//     15. ₹1/Kg discount is applicable on returning empty bags (Terms Apply).
//     16. Cargo must be stored below 15°C.\n\n

//     ━━━━━━━━━━━━━━━━━━━━━━\n\n

//     Thank you for your business.`;
//   const url = `${WATI_BASE_URL}/sendSessionMessage/${phone}?messageText=${encodeURIComponent(formattedMessage)}`;

//   const resp = await fetch(url, {
//     method: "POST",
//     headers: {
//       Authorization: `Bearer ${WATI_API_TOKEN}`,
//       "Content-Type": "application/json",
//     },
//     body: "{}",
//   });

//   const bodyText = await resp.text();
//   return {
//     ok: resp.ok && isWatiSuccess(bodyText),
//     status: resp.status,
//     bodyText,
//   };
// };

const sendWatiTemplateMessage = async (
  phone: string,
  templateName: string,
  templateVariables: Record<string, string>,
): Promise<WatiResult> => {
  const url = `${WATI_BASE_URL}/sendTemplateMessage?whatsappNumber=${phone}`;
  console.log(`template Url: ${url}, templateName: ${templateName}, templateVariables: ${JSON.stringify(templateVariables)}`);

  //  parameters: [ { name: "order_number", value: "123456" }, ... ]
  const parameters =
    templateVariables &&
    typeof templateVariables === "object" &&
    !Array.isArray(templateVariables)
      ? Object.entries(templateVariables).map(([key, value]) => ({
          name: key,
          value: String(value ?? ""),
        }))
      : [];
  console.log(`Template parameters: ${JSON.stringify(parameters)}`);

  const payload = {
    template_name: templateName,
    broadcast_name: templateName,
    parameters,
    channel_number: "",
  };
  console.log("Sending WATI template message with payload:", JSON.stringify(payload));

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WATI_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  console.log("WATI template message response status:", JSON.stringify(resp.status));

  const bodyText = await resp.text();
  return {
    ok: resp.ok && isWatiSuccess(bodyText),
    status: resp.status,
    bodyText,
  };
};

export const frs_whatsAppMessages_outgoing_sendMessage_export = onDocumentCreated(
  {
    document: "whatsAppMessages/{mobileNo}/outgoing/{docId}",
    region: "asia-south1",
    memory: "512MiB",
  },
  async (event) => {
    const docRef = event.data?.ref;
    const mobileNo = String(event.params.mobileNo ?? "");
    const phone = normalizePhone(mobileNo);
    const docId = String(event.params.docId ?? "");

    try {
      if (!docRef || !event.data?.exists) {
        logger.warn("Outgoing trigger fired without snapshot", {
          mobileNo,
          docId,
          eventId: event.id,
        });
        return;
      }

      let allowedNumbers = ["917758967817", "918799951360", "918080528883", "919012345678", "917887478874", "919970179564", "917507158855", "919699893062"];
      const normalizedAllowedNumbers = allowedNumbers.map((n) => n.replace(/\D/g, ""));
      const normalizedPhone = phone.replace(/\D/g, "");
      if (!normalizedAllowedNumbers.includes(normalizedPhone)) {
        logger.info("Phone number is not allowed. Skipping message sending.", {
          mobileNo,
          phone,
          docId,
        });
        return;
      }
      console.log("Allowed phone number. Proceeding with message sending.", {
        mobileNo,
        phone,
        docId,
      });

      if (!WATI_API_TOKEN) {
        logger.error("WATI_API_TOKEN is missing", { mobileNo, docId });
        await docRef.update({
          status: "error",
          error: "Missing WATI_API_TOKEN",
          failedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        return;
      }

      const data = event.data.data() as OutgoingMessageDoc;
      console.log("Outgoing message data:", JSON.stringify(data), { mobileNo, docId });
      // const message = String(data.message ?? "").trim();
      const templateVariables = data?.templateVariables;
      const templateName = String(data.templateName ?? DEFAULT_TEMPLATE_NAME).trim() || DEFAULT_TEMPLATE_NAME;
      console.log("Using template name:", templateName);

      if (!phone || !/^[0-9]{10,15}$/.test(phone)) {
        logger.error("Invalid mobile number in outgoing trigger", { mobileNo, phone, docId });
        await docRef.update({
          status: "error",
          error: "Invalid mobile number",
          failedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        return;
      }

      if (!templateVariables) {
        logger.error("Template variables are empty", { phone, docId });
        await docRef.update({
          status: "error",
          error: "Template variables are empty",
          failedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        return;
      }

      logger.info("Processing outgoing WhatsApp message", {
        phone,
        docId,
        templateName,
      });

      await docRef.update({
        status: "sending",
        sendingStartedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // const sessionResult = await sendWatiSessionMessage(phone, message);
      // if (sessionResult.ok) {
      //   logger.info("Session message sent successfully", {
      //     phone,
      //     docId,
      //     status: sessionResult.status,
      //   });

      //   await docRef.update({
      //     status: "sent",
      //     sentVia: "session",
      //     sentAt: admin.firestore.FieldValue.serverTimestamp(),
      //     providerStatusCode: sessionResult.status,
      //   });
      //   return;
      // }

      // logger.warn("Session send failed, trying template fallback", {
      //   phone,
      //   docId,
      //   status: sessionResult.status,
      //   response: sessionResult.bodyText,
      // });

      const templateResult = await sendWatiTemplateMessage(phone, templateName, templateVariables);
      console.log("Template message response:", JSON.stringify(templateResult), { mobileNo, docId });
      if (templateResult.ok) {
        logger.info("Template fallback sent successfully", {
          phone,
          docId,
          templateName,
          status: templateResult.status,
        });

        await docRef.update({
          status: "sent",
          sentVia: "template",
          sentAt: admin.firestore.FieldValue.serverTimestamp(),
          templateName,
          providerStatusCode: templateResult.status,
        });
        return;
      }

      logger.warn("Both session and template sends failed", {
        phone,
        docId,
        // sessionStatus: sessionResult.status,
        // sessionResponse: sessionResult.bodyText,
        templateStatus: templateResult.status,
        templateResponse: templateResult.bodyText,
      });

      await docRef.update({
        status: "error",
        error: "Session and template send both failed",
        // sessionSendResponse: sessionResult.bodyText,
        templateSendResponse: templateResult.bodyText,
        failedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return;
    } catch (error) {
      logger.error("Unhandled error in outgoing WhatsApp trigger", {
        mobileNo,
        docId,
        error: error instanceof Error ? error.message : String(error),
      });

      if (docRef) {
        await docRef.update({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
          failedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      throw error;
    }
  },
);
