import { onObjectFinalized } from "firebase-functions/v2/storage";
import * as logger from "firebase-functions/logger";
import { defineSecret } from "firebase-functions/params";
import * as admin from "firebase-admin";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { jsonrepair } from 'jsonrepair';

const db = admin.firestore();
const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fetch the transcription prompt from Firestore.
 * Looks for a document with field `transcribeSummary` across the known prompt collection.
 * Collection name: "prompt"  (adjust if yours differs)
 */
async function fetchTranscribePrompt(): Promise<string> {
  const snapshot = await db
    .collection("random").doc("prompt").get();
    const promptData = snapshot.data() ?? {};
    const transcribeSummary = promptData.transcribeSummary ?? "";

  const prompt = typeof transcribeSummary === "string" ? transcribeSummary : "";
  if (!prompt) {
    logger.warn("transcribeSummary field is empty, using default");
    return "Transcribe this audio call recording and provide: 1) Full transcription 2) Summary 3) Key information extracted such as names, dates, amounts, topics discussed.";
  }

  logger.info("Prompt fetched from Firestore", { promptLength: prompt.length });
  return prompt;
}

async function shouldRunTranscriptionSummary(): Promise<boolean> {
  try {
    const snapshot = await db.collection("random").doc("runTranscriptionSummary").get();
    const data = snapshot.data() ?? {};
    const runTranscriptionSummary = data.runTranscriptionSummary;

    if (typeof runTranscriptionSummary !== "boolean") {
      logger.warn("runTranscriptionSummary flag is missing or invalid, skipping execution");
      return false;
    }

    return runTranscriptionSummary;
  } catch (error) {
    logger.error("Failed to read runTranscriptionSummary flag", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Fetch matching companies where phoneContacts contains userName.
 * Returns arrays of matched company names and IDs.
 */
async function fetchMatchedCompanies(userName: string): Promise<{ companyNames: string[]; companyIds: string[] }> {
  try {
    const snapshot = await db
      .collection("companies")
      .where(
        admin.firestore.Filter.or(
          admin.firestore.Filter.where("phoneContacts", "array-contains", userName),
          admin.firestore.Filter.where("phones", "array-contains", userName),
        ),
      )
      .get();

    const companyNames: string[] = [];
    const companyIds: string[] = [];

    snapshot.forEach((doc) => {
      const companyData = doc.data();
      const companyName = typeof companyData.companyName === "string" ? companyData.companyName : "";
      const phoneContacts = Array.isArray(companyData.phoneContacts) ? companyData.phoneContacts : [];
      const phones = Array.isArray(companyData.phones) ? companyData.phones : [];
      const matchedInPhoneContacts = phoneContacts.includes(userName);
      const matchedInPhones = !matchedInPhoneContacts && phones.includes(userName);

      if (companyName && (matchedInPhoneContacts || matchedInPhones)) {
        companyNames.push(companyName);
        companyIds.push(doc.id);
      }
    });

    logger.info("Matched companies fetched", {
      userName,
      matchedCount: companyNames.length,
    });

    return { companyNames, companyIds };
  } catch (error) {
    logger.error("Failed to fetch matched companies", {
      userName,
      error: error instanceof Error ? error.message : String(error),
    });
    return { companyNames: [], companyIds: [] };
  }
}

/**
 * Download the audio file from Firebase Storage and return it as a base64 string.
 */
async function downloadAudioAsBase64(bucketName: string, filePath: string): Promise<{ base64: string; mimeType: string }> {
  const bucket = admin.storage().bucket(bucketName);
  const file = bucket.file(filePath);

  const [fileBuffer] = await file.download();
  const base64 = fileBuffer.toString("base64");

  // Determine MIME type from extension
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const mimeMap: Record<string, string> = {
    mp3: "audio/mpeg",
    mp4: "audio/mp4",
    wav: "audio/wav",
    ogg: "audio/ogg",
    m4a: "audio/mp4",
    flac: "audio/flac",
    aac: "audio/aac",
    webm: "audio/webm",
    "3gp": "audio/3gpp",
    amr: "audio/amr",
  };
  const mimeType = mimeMap[ext] ?? "audio/mpeg";

  logger.info("Audio downloaded and encoded", {
    filePath,
    bufferSizeBytes: fileBuffer.length,
    mimeType,
  });

  return { base64, mimeType };
}

/**
 * Fetch buyerNumber by matching buyerName in device contacts.
 * Checks 3 predefined phone numbers in the users collection.
 * Returns the matching phone number (ownNumber) or empty string if not found.
 */
async function fetchBuyerNumber(buyerName: string): Promise<string> {
  const targetPhoneNumbers = ["+918799951360", "+918080528883", "+917887478874"];
  
  try {
    for (const phoneNumber of targetPhoneNumbers) {
      // Query users collection where ownNumber matches
      const userSnapshot = await db
        .collection("users")
        .where("ownNumber", "==", phoneNumber)
        .limit(1)
        .get();

      if (userSnapshot.empty) {
        logger.info("No user found with ownNumber", { phoneNumber });
        continue;
      }

      // Get the user document
      const userDoc = userSnapshot.docs[0];
      
      // Check if device_contacts document exists in contacts subcollection
      const deviceContactsSnapshot = await db
        .collection("users")
        .doc(userDoc.id)
        .collection("contacts")
        .doc("device_contacts")
        .get();

      if (!deviceContactsSnapshot.exists) {
        logger.info("device_contacts document not found", { ownNumber: phoneNumber });
        continue;
      }

      // Get the contacts map
      const deviceContactsData = deviceContactsSnapshot.data() ?? {};
      const contactsMap = deviceContactsData.contacts ?? {};

      // Check if any value in contacts map matches buyerName
      for (const [key, value] of Object.entries(contactsMap)) {
        if (value === buyerName) {
          logger.info(`Buyer number found, 
            buyerName: ${buyerName},
            buyerNumber: ${phoneNumber},
            contactMapKey: ${key}
          `);
          return key;
        }
      }

      logger.info("buyerName not found in device_contacts", { 
        ownNumber: phoneNumber, 
        buyerName 
      });
    }

    logger.warn("buyerNumber not found for buyerName in any user", { buyerName });
    return ""; // Return empty string if no match found
  } catch (error) {
    logger.error("Failed to fetch buyerNumber", {
      buyerName,
      error: error instanceof Error ? error.message : String(error),
    });
    return "";
  }
}

/**
 * Send the audio + prompt to Gemini and return the text response.
 */
async function callGemini(
  apiKey: string,
  prompt: string,
  audioBase64: string,
  mimeType: string,
  aiModel: string,
): Promise<{ text: string; usage: any }> {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: aiModel });

  logger.info("Sending audio to Gemini");

  const result = await model.generateContent([
    {
      inlineData: {
        data: audioBase64,
        mimeType,
      },
    },
    { text: prompt },
  ]);

  const text = result.response.text();
  const usage = result.response.usageMetadata;
  logger.info("Gemini response received", { responseLength: text.length });
  return { text, usage };
}

// ---------------------------------------------------------------------------
// Cloud Function
// ---------------------------------------------------------------------------

export const stg_callRecording_transcribe_export = onObjectFinalized(
  {
    region: "asia-south1",
    memory: "4GiB",
    timeoutSeconds: 540,
    maxInstances: 2,
    secrets: [GEMINI_API_KEY],
  },
  async (event) => {
    const filePath = event.data.name;           // e.g. calls/John Doe/call_001.mp3
    const bucketName = event.data.bucket;
    const contentType = event.data.contentType ?? "";
    const dateAddedMsRaw = event.data.metadata?.dateAddedMs;

    const parsedDateAddedMs =
      typeof dateAddedMsRaw === "number"
        ? dateAddedMsRaw
        : typeof dateAddedMsRaw === "string"
          ? Number(dateAddedMsRaw)
          : NaN;

    const callRecordedAt = Number.isFinite(parsedDateAddedMs) ? Math.trunc(parsedDateAddedMs) : Date.now();
    const callRecordedAtTimestamp = admin.firestore.Timestamp.fromMillis(callRecordedAt);

    if (!Number.isFinite(parsedDateAddedMs)) {
      logger.warn("Storage metadata dateAddedMs missing/invalid, using current time for callRecordedAt", {
        filePath,
        dateAddedMsRaw,
      });
    }

    logger.info("Storage trigger fired", { filePath, bucketName, contentType });

    const tokenLimitSnapshot = await db.collection("random").doc("totalTokenLimit").get();
    const tokenToken = tokenLimitSnapshot.data() ?? {};
    const totalTokenLimitData = tokenToken.totalTokenLimit;

    console.log(`Total token limit: ${totalTokenLimitData}`);
    // if(totalTokenLimitData >= 3000000) {
    //   logger.info(`Token limit exceeded, ${totalTokenLimitData}`);
    //   return;
    // }

    const runTranscriptionSummary = await shouldRunTranscriptionSummary();
    if (!runTranscriptionSummary) {
      logger.info(`runTranscriptionSummary is false, skipping execution ${filePath}`);
      return;
    }

    // Only process files under calls/{userName}/...
    if (!filePath.startsWith("calls/")) {
      logger.info("File is not under calls/, skipping", { filePath });
      return;
    }

    // Only process audio files
    if (!contentType.startsWith("audio/") && !["mp3","mp4","wav","ogg","m4a","flac","aac","webm","3gp","amr"].some(ext => filePath.endsWith(`.${ext}`))) {
      logger.info("File is not an audio file, skipping", { filePath, contentType });
      return;
    }

    // Extract mobileNumber from path: calls/{mobileNumber}/...
    const pathParts = filePath.split("/");
    if (pathParts.length < 3) {
      logger.warn("Unexpected path structure, expected calls/{mobileNumber}/filename", { filePath });
      return;
    }
    const salesUserName = pathParts[1];
    const fileName = pathParts.slice(2).join("/");
    logger.info(`Extracted salesUserName: ${salesUserName}, fileName: ${fileName}`);

    const rawFileName = fileName.split('_');
    const breakName = rawFileName[0].split(' ');
    const buyerName = breakName.slice(2).join(' ');
    const contactUpperCase = buyerName.toUpperCase();

    try {
      // 1. Fetch Gemini API key from Firebase Secret Manager
      const apiKey = GEMINI_API_KEY.value();
      if (!apiKey) {
        logger.error("GEMINI_API_KEY secret is not set");
        return;
      }

      // 2. Fetch prompt from Firestore
      logger.info("Fetching transcription prompt from Firestore");
      const prompt = await fetchTranscribePrompt();

      // 3. Download audio from Storage
      logger.info("Downloading audio file from Storage", { bucketName, filePath });
      const { base64: audioBase64, mimeType } = await downloadAudioAsBase64(bucketName, filePath);

      // 4. Fetch buyerNumber by matching buyerName in device contacts
      logger.info(`Fetching buyerNumber for buyerName: ${buyerName}`);
      const buyerNumber = await fetchBuyerNumber(buyerName);

      // 5. Fetch matched companies by userName in phoneContacts
      logger.info(`Fetching matched companies with buyerName: ${buyerName}`);
      const { companyNames, companyIds } = await fetchMatchedCompanies(contactUpperCase);

      // 6. Call Gemini
      const model = "gemini-3-flash-preview";
      logger.info(`Calling Gemini API model: ${model}`);
      const geminiResponse = await callGemini(apiKey, prompt, audioBase64, mimeType, model);
      console.log("Gemini response:", JSON.stringify(geminiResponse));
      const usage = geminiResponse.usage;
      console.log(`token usage: ${JSON.stringify(usage)}`);
      const inputTokens = usage?.promptTokenCount || 0;
      const outputTokens = usage?.candidatesTokenCount || 0;
      const thoughtsTokenCount = usage?.thoughtsTokenCount || 0;
      const totalTokens = usage?.totalTokenCount || 0;
      const promptTokensDetails = Array.isArray(usage?.promptTokensDetails) ? usage.promptTokensDetails : [];
      const textPromptTokens = promptTokensDetails.find((item: any) => item?.modality === "TEXT")?.tokenCount || 0;
      const audioPromptTokens = promptTokensDetails.find((item: any) => item?.modality === "AUDIO")?.tokenCount || 0;

      const today = new Date().toISOString().split('T')[0];

      await db.collection('random').doc('tokenUsage').set(
        {
          tokenUsage: {
            [today]: {
              totalInputTokens: admin.firestore.FieldValue.increment(inputTokens),
              totalTextPromptTokens: admin.firestore.FieldValue.increment(textPromptTokens),
              totalAudioPromptTokens: admin.firestore.FieldValue.increment(audioPromptTokens),
              totalThoughtsTokens: admin.firestore.FieldValue.increment(thoughtsTokenCount),
              totalOutputTokens: admin.firestore.FieldValue.increment(outputTokens),
              totalTokens: admin.firestore.FieldValue.increment(totalTokens),
              totalRequests: admin.firestore.FieldValue.increment(1),
            },
          },
        },
        {
          merge: true,
        },
      );
      
      const rawGeminiText = typeof geminiResponse.text === "string" ? geminiResponse.text : "";
      let extractedData: any = {
        transcript: rawGeminiText,
        analysis: {
          callSummary: "",
          salesTeamWork: "",
          customerWork: "",
          customerQueryResolution: "",
        },
      };

      try {
        let aiText = rawGeminiText.replace(/```json|```/g, "").trim();
        const firstBrace = aiText.indexOf("{");
        if (firstBrace !== -1) {
          aiText = aiText.substring(firstBrace);
        }

        // Try JSON.parse first, fallback to jsonrepair if needed.
        try {
          extractedData = JSON.parse(aiText);
        } catch (e1) {
          try {
            const repaired = jsonrepair(aiText);
            extractedData = JSON.parse(repaired);
            console.log("Used jsonrepair to fix Gemini output.");
          } catch (e2) {
            console.warn("Failed to repair JSON, storing raw transcript text.", e2);
          }
        }
      } catch (e) {
        console.warn("Failed to parse/repair extractedData as JSON, storing raw transcript text.", e);
      }

      // Prevent Firestore 'undefined' errors if Gemini JSON misses fields.
      const transcript = typeof extractedData?.transcript === "string" ? extractedData.transcript : rawGeminiText;
      const analysis = {
        callSummary:
          typeof extractedData?.analysis?.callSummary === "string"
            ? extractedData.analysis.callSummary : "",
        salesTeamWork:
          typeof extractedData?.analysis?.salesTeamWork === "string"
            ? extractedData.analysis.salesTeamWork : "",

        customerWork:
          typeof extractedData?.analysis?.customerWork === "string"
            ? extractedData.analysis.customerWork : "",

        customerQueryResolution:
          typeof extractedData?.analysis?.customerQueryResolution === "string"
            ? extractedData.analysis.customerQueryResolution : "",
      };


      // 7. Prepare Firestore document
      const now = Date.now();
      const createdAtTimestamp = admin.firestore.Timestamp.now();

      const callRecordingDoc = {
        transcript,
        analysis,
        salesTeam: salesUserName,
        contactNumber: buyerNumber,
        contactName: buyerName,
        companyNames,
        companyIds,
        callRecordedAt,
        callRecordedAtTimestamp,
        createdAtMil: now,
        createdAtTimestamp,
        filePath,
        fileName,
        totalTokens,
        inputTokens,
        textPromptTokens,
        audioPromptTokens,
        totalThoughtsTokens: thoughtsTokenCount,
        outputTokens,
        aiModel: model,
      };

      // 8. Save to Firestore under callRecording collection
      logger.info("Saving result to Firestore", { salesUserName, matchedCompanies: companyNames.length });
      const docRef = await db.collection("callRecording").add(callRecordingDoc);

      logger.info("Call recording transcription saved successfully", {
        salesUserName,
        companyNames,
        companyIds,
        firestoreDocId: docRef.id,
        filePath,
      });
    } catch (error) {
      logger.error("Failed to process call recording", {
        filePath,
        salesUserName,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  },
);
