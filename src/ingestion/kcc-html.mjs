import { CollectorError, validateOfficialUrl } from './collector.mjs';
export const KCC_HOST = 'cissearch.kcc.gov.tw';
export const PROPOSAL_URL = `https://${KCC_HOST}/System/Proposal/Default.aspx`;
export const MEETING_URL = `https://${KCC_HOST}/System/meetingrecord/default.aspx`;
export const PREFIX = 'ctl00$ContentPlaceHolder1$';
export const MEETING_PREFIX = `${PREFIX}uscPeriodSessionMeeting$`;
export const decodeHtml = (value) => String(value).replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#x([a-f\d]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/gi, '&');
export const text = (value) => decodeHtml(String(value).replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<style\b[\s\S]*?<\/style>/gi, '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
export function attr(element, name) { return decodeHtml(element.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'))?.[2] || ''); }
export function official(value, base = PROPOSAL_URL) { return validateOfficialUrl(new URL(decodeHtml(value), base).toString(), [KCC_HOST]).toString(); }
export function controls(html) {
  const result = new URLSearchParams();
  for (const tag of html.match(/<input\b[^>]*>/gi) || []) {
    const name = attr(tag, 'name'), type = attr(tag, 'type').toLowerCase();
    if (!name || ['submit', 'button', 'image', 'checkbox', 'radio'].includes(type)) continue;
    result.set(name, attr(tag, 'value'));
  }
  for (const match of html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
    const name = attr(match[1], 'name'); if (!name) continue;
    const options = [...match[2].matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)];
    const selected = options.find((m) => /(?:^|\s)selected(?:\s|=|$)/i.test(m[1])) || options[0];
    result.set(name, selected ? attr(selected[1], 'value') : '');
  }
  for (const match of html.matchAll(/<input\b[^>]*>/gi)) {
    const tag = match[0]; if (/^(?:radio|checkbox)$/i.test(attr(tag, 'type')) && /\schecked(?:\s|=|>)/i.test(tag)) result.set(attr(tag, 'name'), attr(tag, 'value'));
  }
  result.set('__EVENTTARGET', ''); result.set('__EVENTARGUMENT', ''); result.set('__LASTFOCUS', '');
  return result;
}
export function optionsFor(html, suffix) {
  const name = `${MEETING_PREFIX}${suffix}`;
  for (const match of html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
    if (attr(match[1], 'name') !== name) continue;
    return [...match[2].matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)].map((m) => ({ value: attr(m[1], 'value'), label: text(m[2]) })).filter((v) => v.value && v.value !== '-1');
  }
  throw new CollectorError('PARSER_CONTRACT_CHANGED', `官方選單 ${suffix} 不存在`);
}
function exactControlValue(html,name,id,kind) {
  const readAttribute=(tag,key)=>{const match=tag.match(new RegExp(`(?:^|\\s)${key}\\s*=\\s*(["'])(.*?)\\1`,'i'));return match?decodeHtml(match[2]):undefined;};
  const candidates=(html.match(/<(?:input|select)\b[^>]*>/gi)||[]).filter((tag)=>{
    const actualName=readAttribute(tag,'name'),actualId=readAttribute(tag,'id');
    if(actualName!==name&&actualId!==id)return false;
    if((actualName!==undefined&&actualName!==name)||(actualId!==undefined&&actualId!==id))throw new CollectorError('FILTER_NOT_CONFIRMED','官方控制項name/id矛盾');
    return true;
  });
  if(candidates.length!==1)throw new CollectorError('FILTER_NOT_CONFIRMED',`官方控制項${name}缺少或不唯一`);
  const tag=candidates[0];
  if(!new RegExp(`^<${kind}\\b`,'i').test(tag))throw new CollectorError('FILTER_NOT_CONFIRMED','官方控制項類型不一致');
  if(kind==='input')return readAttribute(tag,'value')??'';
  const start=html.indexOf(tag)+tag.length,end=html.slice(start).search(/<\/select\s*>/i);
  if(end<0)throw new CollectorError('FILTER_NOT_CONFIRMED','官方下拉控制項未結束');
  const options=html.slice(start,start+end).match(/<option\b[^>]*>/gi)||[],selected=options.filter((option)=>/(?:^|\s)selected(?:\s|=|>)/i.test(option));
  if(!options.length||selected.length>1)throw new CollectorError('FILTER_NOT_CONFIRMED','官方下拉控制項選取值不唯一');
  const value=readAttribute(selected[0]||options[0],'value');
  if(value===undefined)throw new CollectorError('FILTER_NOT_CONFIRMED','官方選項缺少明確value');
  return value;
}
export function assertQuery(html, query) {
  for (const [field, name] of [['period', `${MEETING_PREFIX}ddlPeriod`], ['session', `${MEETING_PREFIX}ddlSession`], ['meeting', `${MEETING_PREFIX}ddlMeeting`], ['keyword', `${PREFIX}txtKeyword`]]) {
    const id=name.replace(/^ctl00\$/,'').replaceAll('$','_'),kind=field==='keyword'?'input':'select';
    if(exactControlValue(html,name,id,kind)!==(query[field]||''))throw new CollectorError('FILTER_NOT_CONFIRMED',`${field}未被來源確認`);
  }
}
function pager(section) {
  const match = section.match(/<span\b[^>]*id=["']ContentPlaceHolder1_DataPager(\d+)["'][^>]*>([\s\S]*?)<\/span>/i);
  if (!match) {
    if (/尚無任何資料/.test(section)) return { total: 0, page: 1, pages: 0, pageSize: 10, pagerId: null, nextTarget: null };
    throw new CollectorError('PARSER_CONTRACT_CHANGED', '缺少官方頁碼或明確空集合');
  }
  const rendered = text(match[2]);
  const counts = rendered.match(/共\s*([\d,]+)\s*筆\s*\|\s*(\d+)\s*\/\s*(\d+)\s*頁/);
  if (!counts) throw new CollectorError('PARSER_CONTRACT_CHANGED', '無法解析獨立頁碼總數');
  const total = Number(counts[1].replace(/,/g, '')), page = Number(counts[2]), pages = Number(counts[3]);
  const pageSize=Number(exactControlValue(section,`${PREFIX}DataPager${match[1]}$ctl02$txtPageSize`,`ContentPlaceHolder1_DataPager${match[1]}_ctl02_txtPageSize`,'input'));
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || page < 1 || pages < 1 || pages !== Math.ceil(total / pageSize) || page > pages) throw new CollectorError('PAGER_INCONSISTENT', '總數、頁碼與每頁筆數不一致');
  const nextAnchor = [...match[2].matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].find((m) => text(m[2]).includes('下一頁'));
  const nextTarget = nextAnchor ? attr(nextAnchor[1], 'href').match(/__doPostBack\('([^']+)'/)?.[1] || null : null;
  if ((page < pages) !== Boolean(nextTarget)) throw new CollectorError('PAGER_INCONSISTENT', '下一頁控制與頁數不一致');
  return { total, page, pages, pageSize, pagerId: match[1], nextTarget };
}
export function parseProposalTabs(html, parseRows) {
  const starts = [...html.matchAll(/<div\b[^>]*id=["']tabs-(\d+)["'][^>]*>/gi)];
  if (!starts.length) throw new CollectorError('PARSER_CONTRACT_CHANGED', '議案tab容器不存在');
  const announced = [...new Set([...html.matchAll(/href=["']#tabs-(\d+)["']/gi)].map((m)=>m[1]))];
  if (!announced.length || announced.some((id)=>!starts.some((m)=>m[1]===id))) throw new CollectorError('PARSER_CONTRACT_CHANGED', '議案tab導覽與資料容器不一致');
  const result = [];
  for (const [index,m] of starts.entries()) {
    const section = html.slice(m.index, starts[index + 1]?.index || html.length);
    if (!announced.includes(m[1])) {
      if (/hidProposalSN|ContentPlaceHolder1_DataPager/i.test(section)) throw new CollectorError('PARSER_CONTRACT_CHANGED', '未列於官方tab導覽的容器出現資料，拒絕遺漏');
      continue;
    }
    const sourceIds=(section.match(/<tr\b[\s\S]*?<\/tr>/gi)||[]).filter((row)=>/hidProposalSN/i.test(row)).map((row)=>{
      const ids=(row.match(/<input\b[^>]*>/gi)||[]).filter((tag)=>attr(tag,'name').endsWith('$hidProposalSN')).map((tag)=>attr(tag,'value'));
      if(ids.length!==1||!/^\d+$/.test(ids[0]))throw new CollectorError('RECORD_INVALID','議案原始資料列缺少唯一數字識別碼');
      return ids[0];
    });
    if(new Set(sourceIds).size!==sourceIds.length)throw new CollectorError('DUPLICATE_SOURCE_ROW','同一官方回應含重複議案原始資料列，拒絕以parser去重掩蓋');
    const rows = parseRows(section), metadata = pager(section);
    if(rows.length!==sourceIds.length)throw new CollectorError('ROWS_TOTAL_MISMATCH','正規化列數與原始議案資料列數不一致');
    if (rows.length !== Math.min(metadata.pageSize, Math.max(0, metadata.total - (metadata.page - 1) * metadata.pageSize))) throw new CollectorError('ROWS_TOTAL_MISMATCH', `tab${m[1]}列數與頁碼不一致`);
    result.push({ tab:m[1],rows,source_row_count:sourceIds.length,source_unique_id_count:new Set(sourceIds).size,...metadata });
  }
  return result;
}
export function parseMeetingPage(html) {
  const table = html.match(/<table\b[^>]*id=["']ContentPlaceHolder1_gvIndex["'][^>]*>([\s\S]*?)<\/table>/i)?.[1];
  if (!table) throw new CollectorError('PARSER_CONTRACT_CHANGED', '議事錄索引表不存在');
  const rows = [];
  for (const match of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...match[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
    if (cells.length < 3 || /尚無任何資料/.test(match[1])) continue;
    // Historical rows may publish Word originals without a PDF. All official
    // originals belong in the index; extension is availability, not identity.
    const originals = [...new Set([...String(cells[3] || '').matchAll(/<a\b([^>]*)>/gi)].map((m)=>attr(m[1],'href')).filter(Boolean))].map((href)=>{
      const url = official(href,MEETING_URL), file = new URL(url).pathname;
      if (!/^\/Upload\/Attachment\/MeetingRecord\/\d+\/[^/]+$/i.test(file)) throw new CollectorError('SOURCE_ID_MISMATCH','議事錄原件URL不符合官方record檔案身分');
      const fileType = file.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() || 'unknown';
      return { download_url:url,file_type:fileType };
    });
    const hiddenIds = (match[1].match(/<input\b[^>]*>/gi) || []).filter((tag)=>/\$rptAttachment\$[^$]+\$hidDataSN$/.test(attr(tag,'name'))).map((tag)=>attr(tag,'value'));
    const ids = [...new Set([...originals.map((item)=>new URL(item.download_url).pathname.match(/\/MeetingRecord\/(\d+)\//i)?.[1]),...hiddenIds].filter(Boolean))];
    if (ids.length !== 1 || !/^\d+$/.test(ids[0])) throw new CollectorError('MEETING_SOURCE_ID_MISSING',`議事錄第${text(cells[0])}列缺少一致且唯一的官方識別碼`);
    const pdfs = originals.filter((item)=>item.file_type==='pdf').map((item)=>item.download_url);
    rows.push({ record_id:ids[0],meeting:text(cells[2]),meeting_name:text(cells[2]),date:text(cells[1]),meeting_date:text(cells[1]),record_type:'議事錄',pdf_url:pdfs.at(-1)||null,pdf_urls:pdfs,original_files:originals,original_availability:pdfs.length?'pdf_available':originals.length?'non_pdf_originals_only':'no_originals_published',content_index_status:pdfs.length?'pending_pdf_extraction':originals.length?'unindexed_non_pdf':'no_original_published' });
  }
  const metadata = pager(html);
  if (rows.length !== Math.min(metadata.pageSize, Math.max(0, metadata.total - (metadata.page - 1) * metadata.pageSize))) throw new CollectorError('ROWS_TOTAL_MISMATCH', '議事錄列數與來源分頁不一致');
  return [{ tab: '1', rows, ...metadata }];
}
export function parseDetail(html, sn, url) {
  const inputs = html.match(/<input\b[^>]*>/gi) || [];
  const officialHidden = (suffix) => {
    const name = `${PREFIX}${suffix}`, id = `ContentPlaceHolder1_${suffix.replaceAll('$','_')}`;
    return inputs.filter((tag)=>{
      const actualName = attr(tag,'name'), actualId = attr(tag,'id');
      if (actualName !== name && actualId !== id) return false;
      if ((actualName && actualName !== name) || (actualId && actualId !== id)) throw new CollectorError('SOURCE_ID_MISMATCH','官方詳情身分欄位name/id矛盾');
      return true;
    });
  };
  const input = officialHidden('hidProposalSN');
  const attachmentId = officialHidden('uscAttachment$hidDataSN');
  const attachmentType = officialHidden('uscAttachment$hidDataType');
  const hasAttachmentIdentity = attachmentId.length > 0 || attachmentType.length > 0;
  if (input.length > 1 || attachmentId.length > 1 || attachmentType.length > 1 ||
      (input.length && attr(input[0], 'value') !== sn) ||
      (hasAttachmentIdentity && (attachmentId.length !== 1 || attachmentType.length !== 1 || attr(attachmentId[0], 'value') !== sn || attr(attachmentType[0], 'value') !== '1')) ||
      (!input.length && !hasAttachmentIdentity)) {
    throw new CollectorError('SOURCE_ID_MISMATCH', '議案詳情所有官方身分欄位必須唯一且與索引一致');
  }
  const identity = input.length ? 'hidProposalSN' : 'uscAttachment.hidDataSN';
  const labels = { '類別':'category', '編號':'number', '提案單位':'proposing_unit', '承辦單位':'handling_unit', '相關單位':'related_units', '連署人':'co_signers', '案由':'subject', '說明':'explanation', '辦法':'method', '備註':'remarks', '提案類型':'proposal_type', '會議':'meeting', '狀態':'official_status' }, data = {}, review = {};
  for (const row of html.match(/<tr\b[\s\S]*?<\/tr>/gi) || []) {
    const cells = [...row.matchAll(/<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)].map((m) => text(m[1]));
    for (let i = 0; i < cells.length - 1; i++) { const field = labels[cells[i].replace(/[：:]$/, '').trim()]; if (field) data[field] = cells[i + 1]; }
    const rawCells = [...row.matchAll(/<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)].map((m)=>m[1]);
    const field = { '一讀(交付)':'first_reading', '委員會審查意見':'committee_opinion', '二讀決議':'second_reading_resolution', '三讀決議':'third_reading_session' }[cells[0]];
    if (field && rawCells.length >= 2) {
      const date = cells[1].match(/(?:決議\/交付日期|交付日期|一讀日期|審查日期|決議日期)\s*[：:]\s*(\d{2,4}[-/]\d{1,2}[-/]\d{1,2})/)?.[1] || '';
      const decision = text(rawCells[1].replace(/<(span|div)\b[^>]*>[\s\S]*?<\/\1>/gi,(block)=>/日期|決議大會屆次/.test(text(block))?' ':block));
      review[field] = field === 'third_reading_session' ? cells[1].match(/決議大會屆次\s*[：:]\s*(.*?)(?=決議日期|$)/)?.[1]?.trim() || '' : decision;
      review[{first_reading:'first_reading_date',committee_opinion:'committee_date',second_reading_resolution:'second_reading_date',third_reading_session:'third_reading_date'}[field]] = date;
    }
  }
  const heading = [...html.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map((m)=>text(m[1])).find((v)=>/^高雄市議會第/.test(v));
  if (heading) {
    data.meeting ||= heading.replace(/(?:市政府|議員|人民請願|議長交議).*$/, '').trim();
    data.proposal_type ||= heading.slice(data.meeting.length).trim();
  }
  if (!data.subject) throw new CollectorError('PARSER_CONTRACT_CHANGED', '議案詳情缺少案由');
  return { ...data, review, proposal_sn: sn, detail_url: url, source_id_verified: true, source_identity_field: identity, source_proposal_sn: sn };
}
export function parseAttachments(html, sn) {
  if (/尚無任何資料|總大小\s*0\s*bytes/i.test(html)) return [];
  const files = [];
  for (const match of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...match[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => text(m[1]));
    if (cells.length < 4 || cells[0] === '序號') continue;
    const href = [...match[1].matchAll(/<a\b([^>]*)>/gi)].map((m) => attr(m[1], 'href')).find(Boolean);
    if (!href) throw new CollectorError('PARSER_CONTRACT_CHANGED', '附件缺少官方下載連結');
    files.push({ no: cells[0], description: cells[1], name: cells[2], size: cells[3], download_url: official(href), proposal_sn: sn });
  }
  if (!files.length) throw new CollectorError('PARSER_CONTRACT_CHANGED', '附件無明確空集合或有效資料');
  return files;
}
