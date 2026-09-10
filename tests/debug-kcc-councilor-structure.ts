async function main() {
  const url =
    "https://cissearch.kcc.gov.tw/System/Councilor/Default_RWD.aspx";

  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/154.0.0.0 Safari/537.36",
  };

  const getResp = await fetch(url, { headers });
  const html = await getResp.text();

  console.log("GET status:", getResp.status);
  console.log("HTML length:", html.length);

  const printAround = (keyword: string, radius = 2500) => {
    const i = html.indexOf(keyword);

    console.log(`\n===== ${keyword} =====`);

    if (i === -1) {
      console.log("NOT FOUND");
      return;
    }

    console.log(
      html.slice(
        Math.max(0, i - radius),
        Math.min(html.length, i + radius),
      ),
    );
  };

  printAround('id="linkBtnSearch"', 4000);
  printAround('name="ddlCouncilor"', 1500);
  printAround("07040700", 4000);
  printAround("第7次定期大會", 4000);

  console.log("\n===== ALL SELECT ELEMENTS =====");

  const selects = html.match(/<select[\s\S]*?<\/select>/gi) ?? [];

  for (const select of selects) {
    const name = select.match(/\bname="([^"]+)"/i)?.[1] ?? "";
    const id = select.match(/\bid="([^"]+)"/i)?.[1] ?? "";

    console.log(
      `SELECT name="${name}" id="${id}" length=${select.length}`,
    );

    if (
      name.includes("Meeting") ||
      id.includes("Meeting") ||
      select.includes("07040700") ||
      select.includes("第7次定期大會")
    ) {
      console.log(select.slice(0, 12000));
    }
  }

  console.log("\n===== ALL INPUTS AROUND SEARCH =====");

  const linkIndex = html.indexOf('id="linkBtnSearch"');

  if (linkIndex !== -1) {
    const chunk = html.slice(
      Math.max(0, linkIndex - 10000),
      Math.min(html.length, linkIndex + 5000),
    );

    const inputs = chunk.match(/<input[^>]*>/gi) ?? [];

    for (const input of inputs) {
      const name = input.match(/\bname="([^"]*)"/i)?.[1] ?? "";
      const id = input.match(/\bid="([^"]*)"/i)?.[1] ?? "";
      const value = input.match(/\bvalue="([^"]*)"/i)?.[1] ?? "";

      console.log(
        `name="${name}" id="${id}" value="${value}"`,
      );
    }
  }

  console.log("\n===== FORMS =====");

  const forms = html.match(/<form[\s\S]*?<\/form>/gi) ?? [];

  for (const form of forms) {
    console.log(
      form.slice(0, 1000),
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
