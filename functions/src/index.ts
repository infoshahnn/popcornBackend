import * as admin from 'firebase-admin';
if (!admin.apps.length) {
	admin.initializeApp();
}

import { frs_orders_orderPlaceMessage_export } from './orderPlaceMessage';
import { frs_orders_orderReceivedMessage_export } from './orderReceivedMessage';
import { frs_orders_orderGoogleSheetSync_export } from './orderDataToGoogleSheet';
import { frs_whatsAppMessages_outgoing_sendMessage_export } from './whatsAppOutgoingMessage';
import { stg_callRecording_transcribe_export } from './callRecordingTranscribe';
import { frs_callRecording_dailyCallSummary_export } from './dailyCallSummary';

export const frs_orders_orderPlaceMessage = frs_orders_orderPlaceMessage_export;
export const frs_orders_orderReceivedMessage = frs_orders_orderReceivedMessage_export;
export const frs_orders_orderGoogleSheetSync = frs_orders_orderGoogleSheetSync_export;
export const frs_whatsAppMessages_outgoing_sendMessage = frs_whatsAppMessages_outgoing_sendMessage_export;
export const stg_callRecording_transcribe = stg_callRecording_transcribe_export;
export const frs_callRecording_dailyCallSummary = frs_callRecording_dailyCallSummary_export;