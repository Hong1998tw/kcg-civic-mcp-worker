async function main() {
  const url =
    "https://cissearch.kcc.gov.tw/System/Councilor/Default_RWD.aspx";

  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/154.0.0.0 Safari/537.36",
  };

  const getResp = await fetch(url, { headers });
  const html = await getResp.text();

  const extract = (name: string) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(
      `<input[^>]*name="${escaped}"[^>]*value="([^"]*)"`,
      "i",
    );
    return html.match(re)?.[1] ?? "";
  };

  const viewState = extract("__VIEWSTATE");
  const viewStateGenerator = extract("__VIEWSTATEGENERATOR");
  const eventValidation = extract("__EVENTVALIDATION");

  const cookies = getResp.headers.getSetCookie?.() ?? [];
  const cookieHeader = cookies
    .map((x) => x.split(";")[0])
    .join("; ");

  console.log("GET:", getResp.status);
  console.log("VIEWSTATE:", viewState.length);
  console.log("EVENTVALIDATION:", eventValidation.length);
  console.log("COOKIE:", cookieHeader);

  console.log("\n===== 原始 ddlMeeting =====");
  const meetingHtml =
    /<select[^>]*name="ddlMeeting"[\s\S]*?<\/select>/i.exec(html)?.[0] ?? "";
  console.log(meetingHtml.slice(0, 10000));

  console.log("\n===== 原始 ddlCouncilor =====");
  const councilorHtml =
    /<select[^>]*name="ddlCouncilor"[\s\S]*?<\/select>/i.exec(html)?.[0] ?? "";
  console.log(councilorHtml.slice(0, 10000));

  console.log("\n===== SearchSelect =====");
  const searchSelectMatches =
    html.match(/<input[^>]*name="SearchSelect"[^>]*>/gi) ?? [];
  console.log(searchSelectMatches.join("\n"));

  const formData = new URLSearchParams();

  formData.append("__EVENTTARGET", "linkBtnSearch");
  formData.append("__EVENTARGUMENT", "");
  formData.append("__LASTFOCUS", "");
  formData.append("__VIEWSTATE", viewState);
  formData.append("__VIEWSTATEGENERATOR", viewStateGenerator);
  formData.append("__VIEWSTATEENCRYPTED", "");
  formData.append("__EVENTVALIDATION", eventValidation);

  formData.append("SearchSelect", "rad01");
  formData.append("ddlMeeting", "07040700");
  formData.append("ddlCouncilor", "陳慧文");

  console.log("\n===== POST FORM =====");
  console.log(formData.toString());

  const postResp = await fetch(url, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookieHeader,
      Referer: url,
    },
    body: formData.toString(),
  });

  const postHtml = await postResp.text();

  console.log("\n===== POST RESULT =====");
  console.log("status:", postResp.status);
  console.log("length:", postHtml.length);

  console.log("\n===== POST 後 ddlMeeting selected =====");

  const selectedMeeting =
    /<select[^>]*name="ddlMeeting"[\s\S]*?<\/select>/i.exec(postHtml)?.[0] ??
    "";

  console.log(
    selectedMeeting
      .split("\n")
      .filter((line) => line.includes("selected"))
      .join("\n"),
  );

  console.log("\n===== POST 後 ddlCouncilor selected =====");

  const selectedCouncilor =
    /<select[^>]*name="ddlCouncilor"[\s\S]*?<\/select>/i.exec(postHtml)?.[0] ??
    "";

  console.log(
    selectedCouncilor
      .split("\n")
      .filter((line) => line.includes("selected"))
      .join("\n"),
  );

  console.log("\n===== POST 後 SearchSelect =====");

  const postSearchSelect =
    postHtml.match(/<input[^>]*name="SearchSelect"[^>]*>/gi) ?? [];

  console.log(postSearchSelect.join("\n"));

  console.log("\n===== POST 後 li01/li02/li03 =====");

  for (const id of ["li01", "li02", "li03"]) {
    const re = new RegExp(
      `<li[^>]*id="${id}"[^>]*>[\\s\\S]*?<\\/li>`,
      "i",
    );

    console.log(`\n${id}:`);
    console.log(re.exec(postHtml)?.[0] ?? "NOT FOUND");
  }

  console.log("\n===== 搜尋條件附近文字 =====");

  for (const keyword of [
    "陳慧文",
    "07040700",
    "第7次定期大會",
  ]) {
    const index = postHtml.indexOf(keyword);

    console.log(`\n--- ${keyword} ---`);

    if (index === -1) {
      console.log("NOT FOUND");
    } else {
      console.log(
        postHtml.slice(
          Math.max(0, index - 500),
          Math.min(postHtml.length, index + 1200),
        ),
      );
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
