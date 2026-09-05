async function main() {
  const url =
    "https://cissearch.kcc.gov.tw/System/Proposal/Default.aspx";

  const resp = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
    },
  });

  const html = await resp.text();

  const keywords = [
    "ddlCouncilor",
    "ddlPeriod",
    "ddlSession",
    "ddlMeeting",
    "LinkButton1",
    "AutoPostBack",
    "UpdatePanel",
  ];

  for (const keyword of keywords) {
    console.log(`\n========== ${keyword} ==========\n`);

    let start = 0;
    let count = 0;

    while (true) {
      const index = html.indexOf(keyword, start);

      if (index < 0 || count >= 10) break;

      console.log(
        html.slice(
          Math.max(0, index - 500),
          Math.min(html.length, index + 1500),
        ),
      );

      start = index + keyword.length;
      count++;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
