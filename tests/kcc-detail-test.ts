const url =
  "https://cissearch.kcc.gov.tw/System/Proposal/Detail.aspx?s=877CB6CEB53C8056&ct=EB02F15B1CDF9E89";

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

  console.log("status:", resp.status);
  console.log("url:", resp.url);

  const html = await resp.text();

  console.log("html length:", html.length);
  console.log(html.slice(0, 1000));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
