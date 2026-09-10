const url =
  "https://cissearch.kcc.gov.tw/System/Proposal/Detail.aspx?s=877CB6CEB53C8056&ct=EB02F15B1CDF9E89";

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

  const lines = html.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    if (/attachment|附件|GetAttachmentList/i.test(lines[i])) {
      console.log(`\n===== LINE ${i + 1} =====`);
      console.log(lines.slice(Math.max(0, i - 8), i + 9).join("\n"));
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
