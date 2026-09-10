export function recordIdFromPdfUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { return ""; }
  if (url.protocol !== "https:" || url.hostname !== "cissearch.kcc.gov.tw") return "";
  return url.pathname.match(/\/MeetingRecord\/(\d+)\//i)?.[1] || "";
}
