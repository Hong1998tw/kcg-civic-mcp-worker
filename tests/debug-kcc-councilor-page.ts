async function main() {
  const url =
    "https://cissearch.kcc.gov.tw/System/Councilor/Default.aspx";

  const resp = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/154.0.0.0 Safari/537.36",
    },
  });

  const html = await resp.text();

  console.log("status:", resp.status);
  console.log("length:", html.length);

  for (const keyword of ["陳慧文", "提案", "議員"]) {
    console.log(`\n===== ${keyword} =====`);

    let index = html.indexOf(keyword);
    let count = 0;

    while (index !== -1 && count < 5) {
      console.log(
        html.slice(
          Math.max(0, index - 500),
          Math.min(html.length, index + 1500),
        ),
      );

      index = html.indexOf(keyword, index + keyword.length);
      count++;
    }

    if (count === 0) {
      console.log("NOT FOUND");
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
