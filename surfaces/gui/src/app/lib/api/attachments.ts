// Attachment helpers. The PDF probe backs the composer's attach-time threshold check
// (Settings → pdf_max_pages / pdf_max_mb); route verified against
// coworker/server/app.py:1636 (POST /v1/attachments/inspect-pdf).

import { api } from "./client";

export interface PdfInspection {
  ok: boolean;
  pages?: number;
  bytes?: number;
  error?: string;
}

/** Local page/size probe for a PDF data URL — runs on the sidecar, never leaves the Mac. */
export const inspectPdf = (dataUrl: string): Promise<PdfInspection> =>
  api.post<PdfInspection>("/v1/attachments/inspect-pdf", { data_url: dataUrl });
