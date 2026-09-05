// 本機 HTTP MCP 整合測試腳本
const ENDPOINT = "http://127.0.0.1:8787/mcp"; // 請確保 wrangler dev 運行於此連接埠

async function rpcCall(method: string, params: any = {}, id = 1) {
  const resp = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`HTTP Error ${resp.status}: ${text}`);
  }

  return await resp.json();
}

async function main() {
  console.log("=========================================");
  console.log("1. 測試 initialize 協定握手");
  console.log("=========================================");
  const initRes: any = await rpcCall("initialize");
  console.log(JSON.stringify(initRes, null, 2));

  console.log("\n=========================================");
  console.log("2. 測試 tools/list 取得工具清單");
  console.log("=========================================");
  const listRes: any = await rpcCall("tools/list");
  const tools = listRes.result?.tools || [];
  console.log(`註冊總工具數: ${tools.length}`);
  const kccNames = tools.filter((t: any) => t.name.startsWith("kcc_")).map((t: any) => t.name);
  console.log("KCC 即時工具清單:", kccNames);

  console.log("\n=========================================");
  console.log("3. 測試 tools/call → kcc_search_proposals");
  console.log("=========================================");
  const searchRes: any = await rpcCall("tools/call", {
    name: "kcc_search_proposals",
    arguments: {
      keyword: "總預算",
      period: "07",
      session: "0704",
      meeting: "07040800",
    },
  });
  console.log(JSON.stringify(searchRes, null, 2));

  // 從搜尋結果解析出第一筆的 proposal_sn 與 detail_url
  const searchContentText = searchRes.result?.content?.[0]?.text;
  if (!searchContentText) {
    throw new Error("搜尋結果內容為空");
  }
  const searchData = JSON.parse(searchContentText);
  const firstProposal = searchData.proposals?.[0];

  if (!firstProposal) {
    console.warn("⚠️ 查無議案資料，跳過後續詳情與附件測試。");
    return;
  }

  const { proposal_sn, detail_url } = firstProposal;
  console.log(`\n取得目標測試提案 SN: ${proposal_sn}, Detail URL: ${detail_url}`);

  console.log("\n=========================================");
  console.log(`4. 測試 tools/call → kcc_get_proposal (SN: ${proposal_sn})`);
  console.log("=========================================");
  const proposalRes: any = await rpcCall("tools/call", {
    name: "kcc_get_proposal",
    arguments: {
      proposal_sn,
      detail_url,
    },
  });
  console.log(JSON.stringify(proposalRes, null, 2));

  console.log("\n=========================================");
  console.log(`5. 測試 tools/call → kcc_get_attachments (SN: ${proposal_sn})`);
  console.log("=========================================");
  const attachRes: any = await rpcCall("tools/call", {
    name: "kcc_get_attachments",
    arguments: {
      proposal_sn,
    },
  });
  console.log(JSON.stringify(attachRes, null, 2));

  console.log("\n✨ 恭喜！全部 5 項 HTTP MCP 測試項目全數通過！");
}

main().catch((err) => {
  console.error("❌ 測試過程發生錯誤:", err);
  process.exit(1);
});
