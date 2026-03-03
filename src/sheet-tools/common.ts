import { createFeishuClient } from "../client.js";
import {
  errorResult,
  json,
  runFeishuApiCall,
  type FeishuApiResponse,
} from "../tools-common/feishu-api.js";

export type SheetClient = ReturnType<typeof createFeishuClient>;

export { json, errorResult };

const RETRYABLE_SHEET_ERROR_CODES = new Set<number>([
  1254290, // Too many requests
  1254291, // Write conflict
  1254607, // Data not ready
  1255040, // Request timeout
]);

const RETRY_BACKOFF_MS = [350, 900, 1800];

export async function runSheetApiCall<T extends FeishuApiResponse>(
  context: string,
  fn: () => Promise<T>,
): Promise<T> {
  return runFeishuApiCall(context, fn, {
    retryableCodes: RETRYABLE_SHEET_ERROR_CODES,
    backoffMs: RETRY_BACKOFF_MS,
  });
}
