const url =
  "https://cissearch.kcc.gov.tw/System/Proposal/Default.aspx";

async function main() {
  const resp = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    signal: AbortSignal.timeout(8000),
  });

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`);
  }

  const html = await resp.text();

  const selectMatch = html.match(
    /<select[^>]*name="ctl00\$ContentPlaceHolder1\$ddlCouncilor"[\s\S]*?<\/select>/i,
  );

  if (!selectMatch) {
    throw new Error("找不到 ddlCouncilor");
  }

  const selectHtml = selectMatch[0];

  const optionRegex =
    /<option\b[^>]*value=["']([^"']*)["'][^>]*>([\s\S]*?)<\/option>/gi;

  const options: Array<{ value: string; text: string }> = [];

  let match: RegExpExecArray | null;

  while ((match = optionRegex.exec(selectHtml)) !== null) {
    const text = match[2]
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .trim();

    options.push({
      value: match[1],
      text,
    });
  }

  console.log(`議員選項數量: ${options.length}`);
  console.log(JSON.stringify(options, null, 2));

  const target = options.filter((x) =>
    x.text.includes("陳慧文"),
  );

  console.log("\n===== 陳慧文 =====");
  console.log(JSON.stringify(target, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
