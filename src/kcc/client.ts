const DEFAULT_URL =
  "https://cissearch.kcc.gov.tw/System/Proposal/Default.aspx";

export interface WebFormsTokens {
  viewState: string;
  viewStateGenerator: string;
  eventValidation: string;
  cookieHeader: string;
}

export function extractTokensFromHtml(
  html: string,
  cookieHeader = "",
): WebFormsTokens {
  const extract = (name: string) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(
      `<input\\b[^>]*name=["']${escaped}["'][^>]*value=["']([^"']*)["']`,
      "i",
    );
    const reverse = new RegExp(
      `<input\\b[^>]*value=["']([^"']*)["'][^>]*name=["']${escaped}["']`,
      "i",
    );
    return re.exec(html)?.[1] ?? reverse.exec(html)?.[1] ?? "";
  };

  return {
    viewState: extract("__VIEWSTATE"),
    viewStateGenerator: extract("__VIEWSTATEGENERATOR"),
    eventValidation: extract("__EVENTVALIDATION"),
    cookieHeader,
  };
}

export async function fetchWebFormsTokens(
  url: string = DEFAULT_URL,
): Promise<WebFormsTokens> {
  const resp = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/154.0.0.0 Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    signal: AbortSignal.timeout(8000),
  });

  if (!resp.ok) {
    throw new Error(`無法取得 WebForms 權杖: HTTP ${resp.status}`);
  }

  const html = await resp.text();

  const cookies = resp.headers.getSetCookie?.() ??
    (resp.headers.get("set-cookie") ? [resp.headers.get("set-cookie") as string] : []);
  const cookieHeader = cookies.map((x) => x.split(";")[0]).join("; ");

  return extractTokensFromHtml(html, cookieHeader);
}
