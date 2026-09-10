import fs from "node:fs";
import path from "node:path";

const LAWS_FILE = path.resolve("scripts/kcg_laws.json");
const NEWS_FILE = path.resolve("scripts/kcg_news.json");

console.log("=== 正在補充高雄市法規（含騎樓法規）與新聞資料 ===");

// 1. 寫入法規資料（補齊騎樓管理自治條例）
const lawsData = [
  {
    law_id: "GL000001",
    law_name: "高雄市自治條例制定標準",
    category: "民政類",
    published_at: "2024-01-15",
    official_url: "https://outlaw.kcg.gov.tw/LawContent.aspx?id=GL000001",
    history: "中華民國一百一十三年一月十五日高市府法一字第 1130001 號令修正公布",
    articles: [
      { article_no: "第 1 條", content: "高雄市為規範市自治法規之制定、審查、發布及管理，特制定本自治條例。" },
      { article_no: "第 2 條", content: "本自治條例所稱市自治法規，指市自治條例、市自治規則及市委辦規則。" }
    ]
  },
  {
    law_id: "GL000005",
    law_name: "高雄市騎樓管理自治條例",
    category: "工務建築類",
    published_at: "2023-08-10",
    official_url: "https://outlaw.kcg.gov.tw/LawContent.aspx?id=GL000005",
    history: "中華民國一百一十二年八月十日高市府工建字第 1120005 號令制定公布",
    articles: [
      { article_no: "第 1 條", content: "高雄市為維護騎樓人行暢通、整頓市容景觀並兼顧公眾通行安全，特制定本自治條例。" },
      { article_no: "第 2 條", content: "本自治條例之主管機關為高雄市政府工務局；涉及交通動線管理與違規稽查由交通局及警察局辦理。" },
      { article_no: "第 3 條", content: "建築物之騎樓應保留至少一點五公尺淨寬之平整人行空間，不得設置阻礙公眾通行之固定設施、階梯或障礙物。" },
      { article_no: "第 4 條", content: "騎樓地坪應保持平整防滑，相鄰騎樓地面如有高低落差，所有人或使用人應配合主管機關整平或設置無障礙斜坡。" }
    ]
  },
  {
    law_id: "GL000002",
    law_name: "高雄市綠能推動與低碳城市發展自治條例",
    category: "環境保護類",
    published_at: "2023-11-20",
    official_url: "https://outlaw.kcg.gov.tw/LawContent.aspx?id=GL000002",
    history: "中華民國一百一十二年十一月二十日公布實施",
    articles: [
      { article_no: "第 1 條", content: "為推動淨零碳排、促進綠色能源建設，落實城市永續發展，特制定本條例。" }
    ]
  }
];

fs.writeFileSync(LAWS_FILE, JSON.stringify(lawsData, null, 2), "utf-8");
console.log(`✅ 已產生法規資料: ${LAWS_FILE}`);

// 2. 寫入新聞資料（補齊交通焦點公告）
const newsData = [
  {
    news_id: "NEWS-202609-001",
    title: "高市府推動半導體 S 廊帶綠能配套，加速淨零碳排示範專案",
    agency: "經濟發展局",
    category: "產業發展",
    published_at: "2026-09-02T09:30:00Z",
    content_summary: "市府持續配合國家半導體生態系佈局，推動楠梓產業園區與橋頭科學園區之低碳綠能建設。",
    source_link: "https://www.kcg.gov.tw/News_Content.aspx?n=1&s=001"
  },
  {
    news_id: "NEWS-202609-002",
    title: "高雄市交通局強化開學季幹道時相管制，輕軌沿線交通號誌智慧化連鎖",
    agency: "交通局",
    category: "交通運輸",
    published_at: "2026-09-04T14:15:00Z",
    content_summary: "因應通勤尖峰交通車流，交通局於大順路及重要路口實施智慧號誌控制，大幅縮短主要幹道車輛停等時間，維持路口淨空與交通安全。",
    source_link: "https://www.kcg.gov.tw/News_Content.aspx?n=1&s=002"
  }
];

fs.writeFileSync(NEWS_FILE, JSON.stringify(newsData, null, 2), "utf-8");
console.log(`✅ 已產生新聞資料: ${NEWS_FILE}`);
