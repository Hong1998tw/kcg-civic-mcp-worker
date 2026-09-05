async function main() {
  const url = "https://cissearch.kcc.gov.tw/System/Proposal/Default.aspx";

  const resp = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/154.0.0.0 Safari/537.36",
    },
  });

  const html = await resp.text();

  const re =
    /<select[^>]*name="ctl00\$ContentPlaceHolder1\$uscPeriodSessionMeeting\$ddlPeriod"[\s\S]*?<\/select>/i;

  const match = html.match(re);

  console.log(match ? match[0] : "NOT FOUND");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
