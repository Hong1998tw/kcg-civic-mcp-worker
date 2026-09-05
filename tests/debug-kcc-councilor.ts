async function main() {
  const url =
    "https://cissearch.kcc.gov.tw/System/Proposal/Default.aspx";

  const resp = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
    },
  });

  console.log("HTTP:", resp.status);

  const html = await resp.text();

  console.log("HTML length:", html.length);

  const index = html.indexOf("ddlCouncilor");

  console.log("ddlCouncilor index:", index);

  if (index >= 0) {
    console.log("\n=== ddlCouncilor 附近 HTML ===\n");
    console.log(
      html.slice(
        Math.max(0, index - 1000),
        index + 5000,
      ),
    );
  } else {
    console.log("找不到 ddlCouncilor");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
