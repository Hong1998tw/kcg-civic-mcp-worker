const url =
  "https://cissearch.kcc.gov.tw/System/Proposal/Detail.aspx?s=877CB6CEB53C8056&ct=EB02F15B1CDF9E89";

function cleanText(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x9;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function main() {
  const resp = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
    },
    signal: AbortSignal.timeout(8000),
  });

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`);
  }

  const html = await resp.text();

  console.log("HTML length:", html.length);
  console.log("\n===== TABLES =====\n");

  const tableRegex = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
  let tableIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tableRegex.exec(html)) !== null) {
    tableIndex++;

    const table = match[1];

    const rows: string[] = [];
    const rowRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;

    let rowMatch: RegExpExecArray | null;

    while ((rowMatch = rowRegex.exec(table)) !== null) {
      const rowText = cleanText(rowMatch[1]);

      if (rowText) {
        rows.push(rowText);
      }
    }

    console.log(`TABLE ${tableIndex}`);
    console.log("------------------------------");

    for (const row of rows) {
      console.log(row);
    }

    console.log();
  }

  console.log("\n===== IMPORTANT TEXT =====\n");

  const text = cleanText(html);

  const keywords = [
    "案由",
    "說明",
    "提案人",
    "連署人",
    "主旨",
    "辦法",
    "決議",
    "審議",
    "附件",
    "案號",
  ];

  for (const keyword of keywords) {
    const index = text.indexOf(keyword);

    if (index >= 0) {
      console.log(`【${keyword}】`);
      console.log(text.slice(Math.max(0, index - 100), index + 500));
      console.log();
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
