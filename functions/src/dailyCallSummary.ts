import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";
import { defineSecret } from "firebase-functions/params";
import * as admin from "firebase-admin";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { jsonrepair } from "jsonrepair";

const db = admin.firestore();
const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

type CallSummaryMap = {
  customerComplaint: string;
  customerTodo: string;
  salesTeamTodo: string;
  salesTeam: string;
  callRecordedAtTimestamp: admin.firestore.Timestamp | null;
  contactName: string;
  contactNumber: string;
};

function getIstDayRangeMs(baseDate: Date): { startMs: number; endMs: number } {
  const istEpochMs = baseDate.getTime() + IST_OFFSET_MS;
  const istDate = new Date(istEpochMs);

  const year = istDate.getUTCFullYear();
  const month = istDate.getUTCMonth();
  const date = istDate.getUTCDate();

  const startMs = Date.UTC(year, month, date, 0, 0, 0, 0) - IST_OFFSET_MS;
  const endMs = startMs + ONE_DAY_MS - 1;

  return { startMs, endMs };
}

function formatIstDateForDocId(baseDate: Date): string {
  const istEpochMs = baseDate.getTime() + IST_OFFSET_MS;
  const istDate = new Date(istEpochMs);

  const day = String(istDate.getUTCDate()).padStart(2, "0");
  const month = String(istDate.getUTCMonth() + 1).padStart(2, "0");
  const year = String(istDate.getUTCFullYear());

  return `${day}_${month}_${year}`;
}

async function fetchDailySummaryPrompt(): Promise<string> {
  const snapshot = await db
      .collection("random").doc("prompt").get();
      const promptData = snapshot.data() ?? {};
      const daliySummary = promptData.daliySummary ?? "";
  
    const prompt = typeof daliySummary === "string" ? daliySummary : "";
    if (!prompt) {
      logger.warn("daliySummary field is empty, using default");
      return "Transcribe this audio call recording and provide: 1) Full transcription 2) Summary 3) Key information extracted such as names, dates, amounts, topics discussed.";
    }
  
    logger.info("Prompt fetched from Firestore", { promptLength: prompt.length });
    return prompt;
}

async function callGeminiForDailySummary(apiKey: string, prompt: string): Promise<string> {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });
  const result = await model.generateContent(prompt);
  return result.response.text();
}

function parseAiResponse(rawText: string): Record<string, unknown> {
  let normalized = rawText.replace(/```json|```/g, "").trim();
  const firstBrace = normalized.indexOf("{");

  if (firstBrace !== -1) {
    normalized = normalized.substring(firstBrace);
  }

  try {
    const parsed = JSON.parse(normalized);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { aiOutput: parsed };
  } catch (_parseError) {
    const repaired = jsonrepair(normalized);
    const parsed = JSON.parse(repaired);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { aiOutput: parsed };
  }
}

export const frs_callRecording_dailyCallSummary_export = onSchedule(
  {
    schedule: "40 23 * * *",
    timeZone: "Asia/Kolkata",
    region: "asia-south1",
    memory: "1GiB",
    timeoutSeconds: 540,
    secrets: [GEMINI_API_KEY],
  },
  async (event) => {
    try {
      // Step 1: Resolve trigger date and IST day range.
      const triggerDate = event.scheduleTime ? new Date(event.scheduleTime) : new Date();
      const { startMs, endMs } = getIstDayRangeMs(triggerDate);
      const summaryDocId = formatIstDateForDocId(triggerDate);

      logger.info("Daily call summary job started", {
        triggerScheduleTime: event.scheduleTime,
        dayStartMs: startMs,
        dayEndMs: endMs,
        summaryDocId,
      });

      // Step 2: Fetch callRecording docs for the trigger date using callRecordedAt milliseconds.
      const callRecordingSnapshot = await db
        .collection("callRecording")
        .where("callRecordedAt", ">=", startMs)
        .where("callRecordedAt", "<=", endMs)
        .get();

      logger.info("Fetched callRecording documents", {
        count: callRecordingSnapshot.size,
      });

      // Step 3: Build a compact map array from each fetched document.
      const salesTeamCallCount: Record<string, number> = {};
      const callSummaries: CallSummaryMap[] = callRecordingSnapshot.docs.map((doc) => {
        const data = doc.data() as Record<string, unknown>;
        const analysis = (data.analysis ?? {}) as Record<string, unknown>;
        const salesTeam = String(data.salesTeam ?? "").trim();

        if (salesTeam) {
          salesTeamCallCount[salesTeam] = (salesTeamCallCount[salesTeam] ?? 0) + 1;
        }

        return {
          customerComplaint: String(analysis.customerComplaint ?? ""),
          customerTodo: String(analysis.customerTodo || analysis.customerToDo || ""),
          salesTeamTodo: String(analysis.salesTeamTodo || analysis.salesTeamToDo || ""),
          salesTeam,
          callRecordedAtTimestamp:
            data.callRecordedAtTimestamp instanceof admin.firestore.Timestamp
              ? data.callRecordedAtTimestamp
              : null,
          contactName: String(data.contactName ?? ""),
          contactNumber: String(data.contactNumber ?? ""),
        };
      });

      const callSummaryJson = JSON.stringify(callSummaries);

      logger.info("Prepared call summary JSON", {
        mappedCount: callSummaries.length,
        jsonLength: callSummaryJson.length,
        salesTeamCount: salesTeamCallCount,
      });

      // Step 4: Fetch prompt template and inject call summaries.
      const promptTemplate = await fetchDailySummaryPrompt();
      const salesTeamCountJson = JSON.stringify(salesTeamCallCount);
      const prompt = promptTemplate
        .replace("{{callSummary}}", callSummaryJson)
        .replace("{{salesTeamCount}}", salesTeamCountJson);
      console.log("Final prompt sent to Gemini:", prompt);

      logger.info("Prompt prepared for AI", {
        promptLength: prompt.length,
      });

      // Step 5: Send prompt to Gemini and parse JSON output (with jsonrepair fallback).
      const apiKey = GEMINI_API_KEY.value();
      if (!apiKey) {
        throw new Error("GEMINI_API_KEY secret is not set");
      }

      const aiRawResponse = await callGeminiForDailySummary(apiKey, prompt);
      logger.info("AI response received", {
        responseLength: aiRawResponse.length,
      });

      const parsedAiData = parseAiResponse(aiRawResponse);

      // Step 6: Add createdAt fields and save final payload in dailyCallSummary/{DD_MM_YYYY}.
      const createdAtMil = Date.now();
      const createdAtTimestamp = admin.firestore.Timestamp.now();
      const preparedData = {
        analysis: parsedAiData,
        salesTeamCallCount,
        createdAtMil,
        createdAtTimestamp,
      };

      await db.collection("dailyCallSummary").doc(summaryDocId).set(preparedData);

      logger.info("Daily call summary saved successfully", {
        collection: "dailyCallSummary",
        documentId: summaryDocId,
        createdAtMil,
      });
    } catch (error) {
      logger.error("Daily call summary job failed", {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  },
);