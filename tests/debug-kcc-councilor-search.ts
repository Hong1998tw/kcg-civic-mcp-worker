const URL =
  "https://cissearch.kcc.gov.tw/System/Councilor/Default_RWD.aspx";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/154.0.0.0 Safari/537.36";

function getHidden(html: string, name: string): string {
  const re = new RegExp(
    `<input[^>]+name="${name}"[^>]+value="([^"]*)"` ,
    "i",
  );

  return re.exec(html)?.[1] ?? "";
}

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripHtml(value: string): string {
  return decodeHtml(
    value
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function parseTable(html: string, tableId: string) {
  const tableRe = new RegExp(
    `<table[^>]+id="${tableId}"[\\s\\S]*?<\\/table>`,
    "i",
  );

  const table = tableRe.exec(html)?.[0];

  if (!table) {
    console.log(`\n[${tableId}] NOT FOUND`);
    return [];
  }

  console.log(`\n[${tableId}] length=${table.length}`);

  if (table.includes("尚無任何資料")) {
    console.log(`[${tableId}] 尚無任何資料`);
    return [];
  }

  const rows = table.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];

  const results: any[] = [];

  for (const row of rows) {
    const cells =
      row.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) ?? [];

    if (cells.length < 4) continue;

    const values = cells.map(stripHtml);

    if (
      values[0] === "編號" ||
      values[1] === "類別" ||
      values[2] === "提案議員"
    ) {
      continue;
    }

    if (values.join(" ").includes("尚無任何資料")) {
      continue;
    }

    const links =
      row.match(/href="([^"]+)"/gi) ?? [];

    results.push({
      number: values[0],
      category: values[1],
      councilor: values[2],
      subject: values[3],
      status: values[4] ?? "",
      remark: values[5] ?? "",
      link: links[0]
        ? decodeHtml(links[0].replace(/^href="/i, "").replace(/"$/, ""))
        : "",
    });
  }

  return results;
}

async function main() {
  const getResp = await fetch(URL, {
    headers: {
      "User-Agent": UA,
    },
  });

  const html = await getResp.text();

  console.log("GET status:", getResp.status);
  console.log("GET length:", html.length);

  const viewState = getHidden(html, "__VIEWSTATE");
  const viewStateGenerator = getHidden(
    html,
    "__VIEWSTATEGENERATOR",
  );
  const eventValidation = getHidden(
    html,
    "__EVENTVALIDATION",
  );

  console.log("VIEWSTATE:", viewState.length);
  console.log(
    "VIEWSTATEGENERATOR:",
    viewStateGenerator,
  );
  console.log(
    "EVENTVALIDATION:",
    eventValidation.length,
  );

  const form = new URLSearchParams();

  form.append("__EVENTTARGET", "linkBtnSearch");
  form.append("__EVENTARGUMENT", "");
  form.append("__LASTFOCUS", "");

  form.append("__VIEWSTATE", viewState);
  form.append(
    "__VIEWSTATEGENERATOR",
    viewStateGenerator,
  );
  form.append("__VIEWSTATEENCRYPTED", "");
  form.append(
    "__EVENTVALIDATION",
    eventValidation,
  );

  form.append("ToolkitScriptManager1_HiddenField", "");

  form.append(
    "uscPeriodSessionMeeting$ddlPeriod",
    "07",
  );

  form.append(
    "uscPeriodSessionMeeting$ddlSession",
    "0704",
  );

  form.append(
    "uscPeriodSessionMeeting$ddlMeeting",
    "07040700",
  );

  form.append(
    "SearchSelect",
    "rad01",
  );

  form.append(
    "ddlCouncilor",
    "陳慧文",
  );

  form.append(
    "txtCouncilorFullName",
    "",
  );

  form.append(
    "hidCurrentTab",
    "",
  );

  const postResp = await fetch(URL, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Referer": URL,
      "Content-Type":
        "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });

  const postHtml = await postResp.text();

  console.log("\nPOST status:", postResp.status);
  console.log("POST length:", postHtml.length);

  console.log(
    "\nselected meeting:",
    /<select[^>]+name="uscPeriodSessionMeeting\$ddlMeeting"[\s\S]*?<\/select>/i
      .exec(postHtml)?.[0]
      ?.match(/<option selected="selected" value="([^"]+)">([^<]+)<\/option>/i)
      ?.slice(1)
      .join(" | ") ?? "NOT FOUND",
  );

  console.log(
    "selected councilor:",
    /<select[^>]+name="ddlCouncilor"[\s\S]*?<\/select>/i
      .exec(postHtml)?.[0]
      ?.match(/<option selected="selected" value="([^"]+)">([^<]+)<\/option>/i)
      ?.slice(1)
      .join(" | ") ?? "NOT FOUND",
  );

  const proposals = parseTable(
    postHtml,
    "gvIndex01",
  );

  const temporary = parseTable(
    postHtml,
    "gvIndex02",
  );

  console.log(
    "\n===== 議員提案 =====",
  );

  console.log(
    JSON.stringify(
      proposals,
      null,
      2,
    ),
  );

  console.log(
    "\n===== 議員臨時提案 =====",
  );

  console.log(
    JSON.stringify(
      temporary,
      null,
      2,
    ),
  );

  console.log(
    "\n===== SUMMARY =====",
  );

  console.log(
    "議員提案:",
    proposals.length,
  );

  console.log(
    "議員臨時提案:",
    temporary.length,
  );

  console.log(
    "陳慧文 occurrences:",
    (
      postHtml.match(/陳慧文/g) ?? []
    ).length,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
