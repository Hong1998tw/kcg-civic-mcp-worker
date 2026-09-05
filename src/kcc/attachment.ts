import { fetchWebFormsTokens } from "./client";

export interface AttachmentItem {
  no?: string;
  description?: string;
  name?: string;
  size?: string;
  download_url?: string;
}

const KCC_BASE_URL = "https://cissearch.kcc.gov.tw";

export async function getProposalAttachments(proposalSn: string) {
  if (!/^\d+$/.test(String(proposalSn || "").trim())) {
    throw new Error("proposal_sn 必須是數字流水號");
  }
  const tokens = await fetchWebFormsTokens();

  const url =
    `${KCC_BASE_URL}/Common/GetAttachmentList.ashx` +
    `?f=1&s=${encodeURIComponent(proposalSn)}&t=False`;

  const resp = await fetch(url, {
    headers: {
      Accept: "text/html, */*; q=0.01",
      Cookie: tokens.cookieHeader,
      "User-Agent": "Mozilla/5.0",
      "X-Requested-With": "XMLHttpRequest",
      Referer:
        `${KCC_BASE_URL}/System/Proposal/Detail.aspx?s=${encodeURIComponent(proposalSn)}`,
    },
    signal: AbortSignal.timeout(6000),
  });

  if (!resp.ok) {
    throw new Error(`取得附件清單失敗: HTTP ${resp.status}`);
  }

  const html = await resp.text();

  if (
    html.includes("尚無任何資料") ||
    html.includes("總大小 0 bytes")
  ) {
    return {
      proposal_sn: proposalSn,
      total_files: 0,
      attachments: [] as AttachmentItem[],
    };
  }

  const attachments: AttachmentItem[] = [];

  const rowRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;

  let rowMatch: RegExpExecArray | null;

  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const rowHtml = rowMatch[1];

    const cellRegex = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;

    const cells: string[] = [];
    const links: string[] = [];

    let cellMatch: RegExpExecArray | null;

    while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
      const rawCell = cellMatch[1];

      const linkMatch = rawCell.match(
        /<a\b[^>]*href=["']([^"']+)["'][^>]*>/i,
      );

      if (linkMatch) {
        links.push(linkMatch[1]);
      }

      const text = rawCell
        .replace(/<br\s*\/?>/gi, " ")
        .replace(/<[^>]*>/g, "")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/\s+/g, " ")
        .trim();

      cells.push(text);
    }

    // 標題列：序號／說明／名稱／大小
    if (cells.length >= 4 && cells[0] !== "序號") {
      const attachment: AttachmentItem = {
        no: cells[0],
        description: cells[1],
        name: cells[2],
        size: cells[3],
      };

      if (links.length > 0) {
        const href = links[0];

        attachment.download_url = href.startsWith("http")
          ? href
          : new URL(href, KCC_BASE_URL).toString();
      }

      attachments.push(attachment);
    }
  }

  return {
    proposal_sn: proposalSn,
    total_files: attachments.length,
    attachments,
  };
}
