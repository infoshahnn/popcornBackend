import { onDocumentCreated } from "firebase-functions/v2/firestore";
import * as logger from "firebase-functions/logger";
import { google, sheets_v4 } from "googleapis";
import * as admin from "firebase-admin";

const db = admin.firestore();

type OrderDocument = Record<string, unknown>;
type OrderItem = Record<string, unknown>;
type SheetCellValue = string | number;

function extractSpreadsheetId(sheetUrl: string): string | null {
  const trimmedUrl = String(sheetUrl ?? "").trim();
  const match = trimmedUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match?.[1] ?? null;
}

function parseDateValue(value: string): Date | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (/^\d{2}\/\d{2}\/\d{4}$/.test(trimmed)) {
    const [day, month, year] = trimmed.split("/").map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toGoogleSheetsDateSerial(value: string): number {
  const parsedDate = parseDateValue(value);
  if (!parsedDate) {
    return 0;
  }

  const googleSheetsEpoch = new Date(Date.UTC(1899, 11, 30));
  const utcDateOnly = new Date(
    Date.UTC(
      parsedDate.getUTCFullYear(),
      parsedDate.getUTCMonth(),
      parsedDate.getUTCDate(),
    ),
  );

  const diffMs = utcDateOnly.getTime() - googleSheetsEpoch.getTime();
  return diffMs / (1000 * 60 * 60 * 24);
}

export function formatFieldValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => formatFieldValue(item)).join(", ");
  }

  if (typeof value === "object") {
    const maybeTimestamp = value as {
      seconds?: unknown;
      nanoseconds?: unknown;
      _seconds?: unknown;
      _nanoseconds?: unknown;
      toDate?: () => Date;
    };

    if (typeof maybeTimestamp.toDate === "function") {
      return maybeTimestamp.toDate().toISOString();
    }

    const secondsCandidate =
      typeof maybeTimestamp.seconds === "number"
        ? maybeTimestamp.seconds
        : typeof maybeTimestamp._seconds === "number"
          ? maybeTimestamp._seconds
          : undefined;

    if (typeof secondsCandidate === "number") {
      return new Date(secondsCandidate * 1000).toISOString();
    }

    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }

  return "";
}

async function fetchCompanyName(companyId: string): Promise<{ companyName: string, city: string, state: string, salesPerson: string }> {
  try {
    const snapshot = await db
      .collection("companies")
      .doc(companyId)
      .get();

    const companyName = snapshot.data()?.companyName ?? "";
    const city = snapshot.data()?.city ?? "";
    const state = snapshot.data()?.state ?? "";
    const salesPerson = snapshot.data()?.salesPerson?.[0] ?? "";

    logger.info("Matched company name", companyName);

    return { companyName, city, state, salesPerson };
  } catch (error) {
    logger.error("Failed to fetch matched companies", {
      companyId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { companyName: "", city: "", state: "", salesPerson: "" };
  }
}

async function fetchBrokerName(brokerId: string): Promise<string> {
  try {
    const snapshot = await db
      .collection("brokers")
      .doc(brokerId)
      .get();

    const brokerData = snapshot.data();
    const brokerName = brokerData?.companyName ?? "";

    logger.info("Matched broker name", brokerName);

    return brokerName;
  } catch (error) {
    logger.error("Failed to fetch matched broker", {
      brokerId,
      error: error instanceof Error ? error.message : String(error),
    });
    return "";
  }
}

async function fetchTransporter(transporterId: string): Promise<string> {
  try {
    const snapshot = await db
      .collection("transporters")
      .doc(transporterId)
      .get();

    const transporterName = snapshot.data()?.companyName ?? "";

    logger.info("Matched transporter name", transporterName);

    return transporterName;
  } catch (error) {
    logger.error("Failed to fetch matched transporter", {
      transporterId,
      error: error instanceof Error ? error.message : String(error),
    });
    return "";
  }
}

async function fetchFromPlace(location: string): Promise<string> {
  try {
    const snapshot = await db
      .collection("random")
      .doc("settings")
      .get();

    const settingsData = snapshot.data() as
      | { locations?: Record<string, unknown> }
      | undefined;
    const locationsMap =
      (settingsData?.locations as Record<string, unknown> | undefined) ?? {};

    const directMatch = locationsMap[location];
    let matchedLocation = directMatch;

    if (!matchedLocation) {
      const normalizedLocation = location.trim().toLowerCase();
      const matchedEntry = Object.entries(locationsMap).find(([key]) => {
        return key.trim().toLowerCase() === normalizedLocation;
      });
      matchedLocation = matchedEntry?.[1];
    }

    const googleSheetName =
      typeof matchedLocation === "object" && matchedLocation !== null
        ? formatFieldValue((matchedLocation as Record<string, unknown>).googleSheetName)
        : "";

    logger.info("Matched location google sheet name", {
      location,
      googleSheetName,
    });

    return googleSheetName;
  } catch (error) {
    logger.error("Failed to fetch location mapping", {
      location,
      error: error instanceof Error ? error.message : String(error),
    });
    return "";
  }
}

export async function fetchBagMarking(itemCategory: string, itemName: string): Promise<string> {
  const bagMarkingDoc = await db.collection("random").doc("bagMarking").get();
  const bagMarkingMap = bagMarkingDoc.data()?.bagMarking ?? {};
  const bagMarkingEntries = Object.entries(bagMarkingMap as Record<string, unknown>);

  const orderBagMarkingRaw = `${formatFieldValue(itemCategory)} ${formatFieldValue(itemName)}`;
  let bagMarking = orderBagMarkingRaw;
  const normalizedOrderBagMarking = normalizeLookupKey(orderBagMarkingRaw);
  console.log(`order bagMarking (normalized) for outgoing message: ${normalizedOrderBagMarking}`);

  const directMatch = (bagMarkingMap as Record<string, string>)[bagMarking];
  if (directMatch) {
    bagMarking = directMatch;
    console.log(`direct match found for bagMarking: ${bagMarking}`);
  } else {
    const normalizedMatch = bagMarkingEntries.find(([key]) => {
      return normalizeLookupKey(key) === normalizedOrderBagMarking;
    });
    bagMarking = String(normalizedMatch?.[1] ?? "");
    console.log(`normalized match found for bagMarking: ${bagMarking}`);

    if (!bagMarking) {
      console.warn("bagMarking mapping miss", {
        orderBagMarkingRaw,
        orderBagMarkingNormalized: normalizedOrderBagMarking,
        bagMarkingMapKeyCount: bagMarkingEntries.length,
        bagMarkingMapKeysSample: bagMarkingEntries.slice(0, 10).map(([key]) => key),
      });
    }
  }
  return bagMarking;
}

function toOrderItems(orderData: OrderDocument): OrderItem[] {
  const rawItems = orderData.items;
  if (!Array.isArray(rawItems)) {
    return [];
  }

  return rawItems.filter(
    (item): item is OrderItem => typeof item === "object" && item !== null,
  );
}

function normalizeLookupKey(value: unknown): string {
  return formatFieldValue(value)
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
}

export function toFiniteNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : fallback;
  }

  if (typeof value === "string") {
    const normalized = value.replace(/,/g, "").trim();
    if (!normalized) {
      return fallback;
    }

    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  return fallback;
}

async function prepareSingleOrderRow(
  orderData: OrderDocument,
  brokerName: string,
  companyName: string,
  city: string,
  state: string,
  salesPerson: string,
  fromPlace: string,
  currentTimeIstIso: string,
  transporterName: string,
  whatsAppOutgoingMessage: string,
  item: OrderItem,
): Promise<SheetCellValue[]> {
  const noOfBags = toFiniteNumber(item.itemQuantity);
  const itemPerKg = toFiniteNumber(item.ratePerUnitIncludingGst || item.itemRatePerKgIncludingGst);
  const outerPackType = formatFieldValue(item.outerPackType);
  const localTransport =
    orderData.totalLocalTransportCharge != undefined &&
    orderData.totalLocalTransportCharge !== null
      ? outerPackType === "Bag"
        ? "Bags"
        : outerPackType
      : "No";
  const subTotal = toFiniteNumber(item.amountIncludingGst);
  const transportCharge = noOfBags * 15;
  const totalWithTransport = subTotal + transportCharge;
  const orderPaymentTerm = orderData.paymentTerm;
  const itemQuantityMT = (noOfBags * 30) / 1000;
  const gstPercentage = Number(item.gstPercentage);
  const remarkGst = gstPercentage > 0 ? `INCLUDING GST` : "NO GST";

  const remark = orderData.remark ? `${orderData.remark}, ${remarkGst}` : remarkGst;

  // tentativeDispatchDate name se variable create karna hai jo currentTimeIstIso date se 7 days aage ka date ho aur usko format karna hai dd/mm/yyyy format me
  const tentativeDispatchDate = new Date();
  tentativeDispatchDate.setDate(tentativeDispatchDate.getDate() + 7);
  const tentativeDispatchDateFormatted = `${tentativeDispatchDate.getDate().toString().padStart(2, "0")}/${(tentativeDispatchDate.getMonth() + 1)
    .toString()
    .padStart(2, "0")}/${tentativeDispatchDate.getFullYear()}`;

  const bagMarking = await fetchBagMarking(formatFieldValue(item.itemCategory), formatFieldValue(item.itemName));
  
  const paymentTermDoc = await db.collection("random").doc("paymentTerms").get();
  const paymentTermMap = paymentTermDoc.data()?.paymentTerms ?? {};
  const paymentTerm = paymentTermMap[formatFieldValue(orderPaymentTerm)];
  const paymentTermTitle =
    typeof paymentTerm === "object" && paymentTerm !== null
      ? formatFieldValue((paymentTerm as Record<string, unknown>).title) ||
        formatFieldValue(orderPaymentTerm)
      : formatFieldValue(paymentTerm) || formatFieldValue(orderPaymentTerm);
  console.log("prepared paymentTerm", {
    orderPaymentTerm: formatFieldValue(orderPaymentTerm),
    paymentTermTitle,
  });
  
  const rowData: SheetCellValue[] = [
    toGoogleSheetsDateSerial(currentTimeIstIso),
    toGoogleSheetsDateSerial(currentTimeIstIso),
    "Spot",
    formatFieldValue(companyName),
    formatFieldValue(brokerName),
    formatFieldValue(city),
    formatFieldValue(state),
    bagMarking,
    formatFieldValue(item.itemQuantity),
    formatFieldValue(itemPerKg.toFixed(3)),
    formatFieldValue(transporterName),
    localTransport,
    toGoogleSheetsDateSerial(tentativeDispatchDateFormatted),
    formatFieldValue(paymentTermTitle),
    formatFieldValue(remark),
    formatFieldValue(salesPerson),
    "App",
    formatFieldValue(fromPlace),
    "",
    "",
    "",
    formatFieldValue(whatsAppOutgoingMessage),
    formatFieldValue(itemPerKg.toFixed(3)),
    formatFieldValue(itemQuantityMT.toFixed(3)),
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    formatFieldValue(subTotal.toFixed(3)),
    formatFieldValue(itemQuantityMT.toFixed(3)),
    formatFieldValue(totalWithTransport.toFixed(3)),
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "Dry maize",
    "",
    "",
  ];
  console.log(`Prepared row data: ${JSON.stringify(rowData)}`);
  return rowData;
}

async function prepareOrderRows(orderId: string, orderData: OrderDocument): Promise<SheetCellValue[][]> {
  const currentTimeIst = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }),
  );
  const dd = String(currentTimeIst.getDate()).padStart(2, "0");
  const mm = String(currentTimeIst.getMonth() + 1).padStart(2, "0");
  const yyyy = currentTimeIst.getFullYear();
  const currentTimeIstIso = `${dd}/${mm}/${yyyy}`;

  const ownNumber = formatFieldValue(orderData.ownNumber);
  console.log(`user ownNumber: ${ownNumber}`);

  const usersQuerySnapshot = await db.collection("users")
    .where("ownNumber", "==", ownNumber)
    .limit(1)
    .get();

  const userData =
    usersQuerySnapshot.empty
      ? {}
      : ((usersQuerySnapshot.docs[0].data() as OrderDocument | undefined) ?? {});

  if (usersQuerySnapshot.empty) {
    console.warn("No user found for ownNumber", { ownNumber, orderId });
  }

  console.log(`user data: ${JSON.stringify(userData)}`);
  const userName = formatFieldValue(userData.name) || "";
  console.log(`user name: ${userName}`);

  const adminUpdated =
    typeof orderData.adminUpdated === "object" && orderData.adminUpdated !== null
      ? (orderData.adminUpdated as Record<string, unknown>)
      : undefined;
  const companyId =
    formatFieldValue(adminUpdated?.companyId) ||
    formatFieldValue(orderData.companyId);
  let { companyName, city, state, salesPerson } = await fetchCompanyName(companyId);

  const adminUpdatedTransporterId = formatFieldValue(adminUpdated?.transporterId);
  const orderTransporterId = formatFieldValue(orderData.transporterId);

  const brokerId = formatFieldValue(orderData.brokerId);
  let brokerName = "OWN";
  if (brokerId) {
    brokerName = await fetchBrokerName(brokerId);
  }

  let transporterName = "";
  if (adminUpdatedTransporterId || orderTransporterId) {
    const transporterId = adminUpdatedTransporterId || orderTransporterId;
    transporterName = await fetchTransporter(transporterId);
  }

  const location = formatFieldValue(orderData.location);
  let fromPlace = "";
  if (location) {
    fromPlace = await fetchFromPlace(location);
  }

  const items = toOrderItems(orderData);
  if (items.length === 0) {
    console.warn("No items array found or no valid item objects", { orderId });
    // return [
    //   prepareSingleOrderRow(orderId, orderData, companyName, currentTimeIstIso, {}),
    // ];
  }

  companyName = companyName || userName;


  let whatsAppOutgoingMessage = `Today's outgoing: ${companyName}\n`;
  for (const item of items) {
    
    const outerPackType =
      item.outerPackType === "Bag"
        ? "Bags"
        : item.outerPackType;

    const bagMarking = await fetchBagMarking(formatFieldValue(item.itemCategory), formatFieldValue(item.itemName));
    whatsAppOutgoingMessage += `${item.itemQuantity} ${outerPackType} / City: ${city}\n${bagMarking}\n`;
  }
  if(adminUpdatedTransporterId === "" && orderTransporterId === "") {
    whatsAppOutgoingMessage += `Transport: OWN\nParty will pick up from ${fromPlace} / Bilti required`;
  } else {
    whatsAppOutgoingMessage += `Transport: ???\n???`;
  }

  return Promise.all(
    items.map((item) =>
      prepareSingleOrderRow(orderData, brokerName, companyName, city, state, salesPerson, fromPlace, currentTimeIstIso, transporterName, whatsAppOutgoingMessage, item),
    ),
  );
}

function getMainSheet(
  spreadsheetMeta: sheets_v4.Schema$Spreadsheet,
): sheets_v4.Schema$Sheet | undefined {
  return (spreadsheetMeta.sheets ?? []).find(
    (sheet) => sheet.properties?.title === "main",
  );
}

async function getMainSheetHeaderRow(
  sheetsClient: sheets_v4.Sheets,
  spreadsheetId: string,
): Promise<string[]> {
  const response = await sheetsClient.spreadsheets.values.get({
    spreadsheetId,
    range: "main!1:1",
    valueRenderOption: "UNFORMATTED_VALUE",
  });

  const headerRow = response.data.values?.[0] ?? [];
  return headerRow.map((value) => formatFieldValue(value).trim());
}

function findColumnIndexByHeader(headers: string[], title: string): number {
  const normalizedTarget = title.trim().toLowerCase();
  return headers.findIndex((header) => header.trim().toLowerCase() === normalizedTarget);
}

function buildDateFormatRequest(
  sheetId: number,
  columnIndex: number,
): sheets_v4.Schema$Request {
  return {
    repeatCell: {
      range: {
        sheetId,
        startRowIndex: 1,
        startColumnIndex: columnIndex,
        endColumnIndex: columnIndex + 1,
      },
      cell: {
        userEnteredFormat: {
          numberFormat: {
            type: "DATE",
            pattern: "dd/mm/yyyy",
          },
        },
      },
      fields: "userEnteredFormat.numberFormat",
    },
  };
}

async function appendOrderRow(
  sheetsClient: sheets_v4.Sheets,
  spreadsheetId: string,
  sheetId: number,
  rows: SheetCellValue[][],
): Promise<void> {
  await sheetsClient.spreadsheets.values.append({
    spreadsheetId,
    range: "main!A:Z",
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: rows,
    },
  });

  const headers = await getMainSheetHeaderRow(sheetsClient, spreadsheetId);
  const dateColumnIndexes = [
    findColumnIndexByHeader(headers, "Entry date"),
    findColumnIndexByHeader(headers, "Order date"),
    findColumnIndexByHeader(headers, "Tentative dispatch date"),
  ].filter((index) => index >= 0);

  if (dateColumnIndexes.length === 0) {
    console.warn("Date column headers not found in main sheet", {
      expectedHeaders: ["Entry date", "Order date", "Tentative dispatch date"],
      headers,
    });
    return;
  }

  await sheetsClient.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: dateColumnIndexes.map((columnIndex) => buildDateFormatRequest(sheetId, columnIndex)),
    },
  });
}

export const frs_orders_orderGoogleSheetSync_export = onDocumentCreated(
  {
    document: "orders/{orderId}",
    region: "asia-south1",
    memory: "512MiB",
  },
  async (event) => {
    console.info("Function triggered");

    try {
      const snapshot = event.data;
      if (!snapshot?.exists) {
        console.warn("Order create trigger fired without snapshot data", {
          eventId: event.id,
        });
        return;
      }

      const orderId = event.params.orderId;
      console.info("Order document ID", { orderId });

      const orderData = snapshot.data() as OrderDocument;
      const ownNumber = orderData.ownNumber;

      if(ownNumber == "+917758967817" || ownNumber == "+917758967818" || ownNumber == "+917507158855" || ownNumber == "+917887478874" || ownNumber == "+918080528883" || ownNumber == "+918799951360" || ownNumber == "+919012345678" || ownNumber == "+919699893062" || ownNumber == "+919970179564") {
        console.info("Order from test number, skipping Google Sheet sync", { orderId, ownNumber });
        return;
      }

      const rows = await prepareOrderRows(orderId, orderData);
      console.info("Order row prepared", {
        orderId,
        rowCount: rows.length,
        firstRowLength: rows[0]?.length ?? 0,
      });

      const sheetUrl = "https://docs.google.com/spreadsheets/d/1i32pGf7aJVOUuTSpfCV3IPtnBgD_Rffh7fkzgLnKxIk/edit?gid=0#gid=0";
      if (!sheetUrl) {
        console.error("Unexpected error", {
          orderId,
          message: "ORDERS_GOOGLE_SHEET_URL is not configured",
        });
        return;
      }

      const spreadsheetId = extractSpreadsheetId(sheetUrl);
      if (!spreadsheetId) {
        console.error("Unexpected error", {
          orderId,
          message: "Failed to extract spreadsheet ID from ORDERS_GOOGLE_SHEET_URL",
        });
        return;
      }
      console.info("Spreadsheet ID extracted", { orderId, spreadsheetId });

      console.info("Connecting to Google Sheets", { orderId });
      const auth = new google.auth.GoogleAuth({
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
      });

      const sheets = google.sheets({
        version: "v4",
        auth,
      });

      let spreadsheetMeta: sheets_v4.Schema$Spreadsheet;
      try {
        const spreadsheetMetaResponse = await sheets.spreadsheets.get({
          spreadsheetId,
          fields: "sheets.properties.title",
        });
        spreadsheetMeta = spreadsheetMetaResponse.data;
        console.info("Spreadsheet metadata fetched", { orderId, spreadsheetId });
      } catch (error) {
        console.error("Failed to fetch spreadsheet metadata", {
          orderId,
          spreadsheetId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }

      const mainSheet = getMainSheet(spreadsheetMeta);
      if (!mainSheet) {
        console.warn("main sheet/tab not found", { orderId, spreadsheetId });
        return;
      }
      console.info("main tab found", { orderId, spreadsheetId });

      console.info("Appending row to Google Sheet", { orderId, spreadsheetId });
      try {
        await appendOrderRow(sheets, spreadsheetId, mainSheet.properties?.sheetId ?? 0, rows);
        console.info("Row successfully inserted", {
          orderId,
          spreadsheetId,
          insertedRows: rows.length,
        });
      } catch (error) {
        console.error("Failed to append row", {
          orderId,
          spreadsheetId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }

      console.info("Function completed", { orderId });
    } catch (error) {
      logger.error("Google Sheets API error", {
        error: error instanceof Error ? error.message : String(error),
      });
      logger.error("Unexpected error", {
        error: error instanceof Error ? error.stack ?? error.message : String(error),
      });
      throw error;
    }
  },
);
