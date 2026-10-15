import { LocalStore } from '../src/local/store.mjs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadTypeScriptParser } from '../src/ingestion/collector.mjs';
import { runKccCollection, validatePdfExtraction } from '../src/ingestion/kcc-collector.mjs';
import { parseMeetingPage, parseAttachments, parseDetail, assertQuery, controls } from '../src/ingestion/kcc-html.mjs';
const P='ctl00$ContentPlaceHolder1$', M=`${P}uscPeriodSessionMeeting$`;
const e=(s)=>String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;');
const input=(name,value='')=>`<input name="${e(name)}" value="${e(value)}"/>`;
const select=(name,values,selected)=>`<select name="${e(name)}">${values.map((v)=>`<option value="${v}"${v===selected?' selected="selected"':''}>${v}</option>`).join('')}</select>`;
function proposalRow(id){return `<tr><td>${input(`${P}gvIndex$ctl${id}$hidProposalSN`,id)}${input(`${P}gvIndex$ctl${id}$hidProposalKind`,'1')}</td><td>${id}</td><td>工務</td><td>測試提案人</td><td onclick="location.href='Detail.aspx?s=ENCRYPTED${id}'">議案${id}</td><td>結案</td></tr>`;}
const totals={1:3,2:1,3:0,4:2,5:0,6:0,7:0,8:0,9:0};
function fixture(query={period:'07',session:'0704',keyword:''},pages={},sizes={},duplicate=false){
 const form=input('__VIEWSTATE','public-state')+input('__EVENTVALIDATION','public-validation')+select(`${M}ddlPeriod`,['07'],query.period)+select(`${M}ddlSession`,['0701','0704'],query.session)+select(`${M}ddlMeeting`,[''],'')+input(`${P}txtKeyword`,query.keyword);
 return form+Object.keys(totals).map(id=>`<a href="#tabs-${id}">tab${id}</a>`).join('')+Object.entries(totals).map(([id,total])=>{
  const page=pages[id]||1,size=sizes[id]||2,pageCount=Math.ceil(total/size),first=duplicate&&page===2?0:(page-1)*size;
  const rows=Array.from({length:Math.min(size,Math.max(0,total-(page-1)*size))},(_,i)=>proposalRow(String(Number(id)*100+first+i)));
  return `<div id="tabs-${id}">${rows.join('')}${total?`<span id="ContentPlaceHolder1_DataPager${id}">共 ${total} 筆 | ${page} / ${pageCount} 頁 | ${page<pageCount?`<a href="javascript:__doPostBack('ctl00$ContentPlaceHolder1$DataPager${id}$ctl01$ctl02','')">下一頁</a>`:'<a>下一頁</a>'}${input(`${P}DataPager${id}$ctl02$txtCurrentPage`)}${input(`${P}DataPager${id}$ctl02$txtPageSize`,size)}</span>`:'尚無任何資料!'}</div>`;
 }).join('')+'<div id="tabs-10"></div>';
}
function harness({duplicate=false,failImport=false,failReconciliation=false}={}){
 let time=0,failed=false;const starts=[],requests=[],raw=new Map(),snapshots=new Map(),releases=new Map();
 const store={close(){},async putRawObject(o){raw.set(o.sha256,o.bytes_base64);},async importSnapshot(s){
  if(failImport&&!failed){failed=true;throw Object.assign(new Error('test publication failure'),{code:'IMPORT_FAILED'});}
  for(const r of s.records)assert(raw.has(r.raw_sha256));
  snapshots.set(s.dataset,s);const receipt={status:'imported',dataset:s.dataset,snapshot_id:s.snapshot_id,record_count:s.records.length,coverage:s.coverage,manifest_sha256:createHash('sha256').update(JSON.stringify(s)).digest('hex')};releases.set(s.dataset,receipt);return receipt;
 },async hasDataset(dataset){return snapshots.has(dataset);},async queryRecords(dataset,options={}){if(!snapshots.has(dataset))throw Object.assign(new Error('no dataset'),{reasonCode:'LOCAL_DATA_UNAVAILABLE'});const all=snapshots.get(dataset).records;return{records:all.slice(options.offset||0,(options.offset||0)+(options.limit??1000)),release:releases.get(dataset),local_match_count:all.length};}};
 const fetchImpl=async(url,options)=>{ starts.push(time); requests.push({url,body:options.body});
  let html=fixture();
  if(options.method==='POST'){
   const f=new URLSearchParams(options.body),query={period:f.get(`${M}ddlPeriod`),session:f.get(`${M}ddlSession`),keyword:f.get(`${P}txtKeyword`)},pages={},sizes={};
   for(const id of Object.keys(totals)){ pages[id]=Number(f.get(`${P}DataPager${id}$ctl02$txtCurrentPage`))||1; sizes[id]=Number(f.get(`${P}DataPager${id}$ctl02$txtPageSize`))||2; }
   html=fixture(query,pages,sizes,duplicate);if(failReconciliation&&sizes[1]===3)html=html.replace(proposalRow('102'),proposalRow('100'));
  }
  return new Response(html,{status:200,headers:{'content-type':'text/html;charset=utf-8'}});
 };
 return{store,raw,snapshots,releases,requests,starts,dependencies:{storeFactory:async()=>store,fetchImpl,now:()=>time,sleep:async(ms)=>{time+=ms;}}};
}
function bindSource(h,dataset,records){
 const originalQuery=h.store.queryRecords.bind(h.store),originalHas=h.store.hasDataset.bind(h.store);
 const release={dataset,snapshot_id:'verified-source',manifest_sha256:'a'.repeat(64),record_count:records.length,coverage:{complete:true}};
 h.store.hasDataset=async(name)=>name===dataset||originalHas(name);
 h.store.queryRecords=async(name,options={})=>name===dataset?{records:records.slice(options.offset||0,(options.offset||0)+(options.limit??1000)),local_match_count:records.length,release}:originalQuery(name,options);
 return release;
}
function meetingTermBoundaryHarness(){
 const h=harness(),sourceTotals={'0701':3,'0702':2};let lastHtml='',unsafeSwitches=0;
 const render=(session,offset,size)=>{
  const total=sourceTotals[session],empty=offset>=total,page=Math.floor(offset/size)+1,pages=Math.ceil(total/size);
  const form=input('__VIEWSTATE',JSON.stringify({session,offset,size}))+input('__EVENTVALIDATION','public-validation')+select(`${M}ddlPeriod`,['07'],'07')+select(`${M}ddlSession`,['0701','0702'],session)+select(`${M}ddlMeeting`,[''],'')+input(`${P}txtKeyword`,'');
  const rows=empty?'<tr><td>尚無任何資料!</td></tr>':Array.from({length:Math.min(size,total-offset)},(_,i)=>{const id=String((session==='0701'?100:200)+offset+i+1);return `<tr><td>${offset+i+1}</td><td>100/01/01</td><td>${session}會議${id}</td><td><a href="/Upload/Attachment/MeetingRecord/${id}/original.pdf">PDF</a></td><td></td></tr>`;}).join('');
  const footer=empty?'':`<span id="ContentPlaceHolder1_DataPager1">共 ${total} 筆 | ${page} / ${pages} 頁 | ${page<pages?`<a href="javascript:__doPostBack('ctl00$ContentPlaceHolder1$DataPager1$ctl01$ctl02','')">下一頁</a>`:'<a>下一頁</a>'}${input(`${P}DataPager1$ctl02$txtCurrentPage`)}${input(`${P}DataPager1$ctl02$txtPageSize`,size)}</span>`;
  return form+`<table id="ContentPlaceHolder1_gvIndex">${rows}</table>`+footer;
 };
 const fetchImpl=async(url,options={})=>{
  let session='0701',offset=0,size=2;
  if(options.method==='POST'){
   const f=new URLSearchParams(options.body),previous=JSON.parse(f.get('__VIEWSTATE'));session=f.get(`${M}ddlSession`);size=Number(f.get(`${P}DataPager1$ctl02$txtPageSize`))||previous.size;
   if(f.get('__EVENTTARGET')===`${P}linkBtnSearch`){offset=previous.offset;if(previous.session!==session&&offset>0)unsafeSwitches++;}
   else offset=((Number(f.get(`${P}DataPager1$ctl02$txtCurrentPage`))||1)-1)*size;
  }
  lastHtml=render(session,offset,size);return new Response(lastHtml,{headers:{'content-type':'text/html'}});
 };
 return{...h,sourceTotals,getLastHtml:()=>lastHtml,getUnsafeSwitches:()=>unsafeSwitches,dependencies:{...h.dependencies,fetchImpl}};
}
const temp=await mkdtemp(path.join(await realpath(os.tmpdir()),'kcc-ingestion-test-'));
let passed=0;
async function test(name,fn){await fn();passed++;console.log(`PASS ${name}`);}
try{
 await test('每tab獨立全頁、分段續作與單網域節流',async()=>{
  const h=harness(),root=path.join(temp,'resume'),opts={profile:'kcc-proposals-full',root,sessions:['0704'],pageSize:2,maxPages:1,maxRequests:20};
  const first=await runKccCollection(opts,h.dependencies);assert.equal(first.status,'paused');assert.equal(first.record_count,2);assert.equal(first.coverage.source_total,6);assert.equal(first.continuation_required,true);
  const second=await runKccCollection(opts,h.dependencies);assert.equal(second.record_count,3);assert.equal(second.progress.queries['07/0704'].tabs['1'].complete,true);
  const last=await runKccCollection({...opts,maxPages:20},h.dependencies);assert.equal(last.status,'complete');assert.equal(last.record_count,6);assert.equal(last.coverage.complete,true);assert.equal(h.snapshots.get('kcc-proposals').records.length,6);
  const state=JSON.parse(await readFile(last.checkpoint_path,'utf8'));assert.deepEqual(state.queries['07/0704'].tabs['1'].pages_proof.map(p=>p.page),[1,2]);
  for(let i=1;i<h.starts.length;i++) if(h.starts[i]!==0) assert(h.starts[i]-h.starts[i-1]>=0);
  // Each invocation has its own limiter; requests inside one invocation are >=1s.
  const another=harness();await runKccCollection({...opts,root:path.join(temp,'rate'),maxPages:20},another.dependencies);for(let i=1;i<another.starts.length;i++)assert(another.starts[i]-another.starts[i-1]>=1000);
  assert(!JSON.stringify(state).includes('Cookie'));assert(!JSON.stringify(state).includes('__VIEWSTATE'));
 });
 await test('發布失敗cursor不前進；pending以相同資料重放後續作',async()=>{
  const h=harness({failImport:true}),opts={profile:'kcc-proposals-full',root:path.join(temp,'import-failure'),sessions:['0704'],pageSize:2,maxRequests:20,maxPages:1};
  const blocked=await runKccCollection(opts,h.dependencies);assert.equal(blocked.status,'blocked');assert.equal(blocked.record_count,0);const state=JSON.parse(await readFile(blocked.checkpoint_path,'utf8'));assert.equal(state.queries['07/0704'].tabs['1'].next_page,1);
  const resumed=await runKccCollection({...opts,maxPages:20},h.dependencies);assert.equal(resumed.status,'complete');assert.equal(resumed.record_count,6);
 });
 await test('重複頁拒絕完整宣告並保留上一頁cursor',async()=>{
  const h=harness({duplicate:true,failReconciliation:true});const result=await runKccCollection({profile:'kcc-proposals-full',root:path.join(temp,'duplicate'),sessions:['0704'],pageSize:2,maxRequests:20},h.dependencies);assert.equal(result.status,'blocked');assert.equal(result.error_code,'DUPLICATE_SOURCE_ROW');assert.equal(result.record_count,2);assert.equal(result.coverage.complete,false);
 });
 await test('來源失敗不建立空成功快照',async()=>{
  const h=harness();const result=await runKccCollection({profile:'kcc-proposals-full',root:path.join(temp,'http'),sessions:['0704'],pageSize:2},{...h.dependencies,fetchImpl:async()=>new Response('failure',{status:503})});assert.equal(result.status,'blocked');assert.equal(result.record_count,0);assert.equal(h.snapshots.size,0);
 });
 await test('附件空集合需要官方明示、詳情ID必須一致',async()=>{
  assert.deepEqual(parseAttachments('尚無任何資料!','100'),[]);assert.throws(()=>parseAttachments('<p>暫停服務</p>','100'),/附件/);
  assert.throws(()=>parseDetail(`${input(`${P}hidProposalSN`,'101')}<tr><td>案由</td><td>測試</td></tr>`,'100','https://cissearch.kcc.gov.tw/System/Proposal/Detail.aspx?s=encrypted'),{code:'SOURCE_ID_MISMATCH'});
  const detail=parseDetail(`${input(`${P}hidProposalSN`,'100')}<tr><td>案由</td><td>測試</td></tr>`,'100','https://cissearch.kcc.gov.tw/System/Proposal/Detail.aspx?s=encrypted');assert(detail.source_id_verified);assert.equal(detail.proposal_sn,'100');
 });
 await test('詳情、附件清單及原件跨段續作後才發布',async()=>{
  const h=harness(),root=path.join(temp,'details'),id='100';
  const source={id,title:'測試',text:'測試',data:{proposal_sn:id,detail_url:'https://cissearch.kcc.gov.tw/System/Proposal/Detail.aspx?s=ABC123'},source_url:'https://cissearch.kcc.gov.tw/System/Proposal/Default.aspx',raw_sha256:'a'.repeat(64),retrieved_at:'2026-10-15T00:00:00Z'};
  bindSource(h,'kcc-proposals',[source]);
  const fetchImpl=async(url)=>new Response(url.includes('Detail.aspx')?`${input(`${P}uscAttachment$hidDataSN`,id)}${input(`${P}uscAttachment$hidDataType`,'1')}<tr><td>案由</td><td>真實案由</td><td>說明</td><td>資料</td></tr>`:url.includes('.ashx')?'<table><tr><td>1</td><td>附件說明</td><td><a href="/Upload/Attachment/Proposal/100/file.pdf">file.pdf</a></td><td>10 bytes</td></tr></table>':'%PDF-test-original',{headers:{'content-type':url.endsWith('.pdf')?'application/pdf':'text/html'}});
  const options={profile:'kcc-proposal-details',root,maxRequests:2};const first=await runKccCollection(options,{...h.dependencies,fetchImpl});assert.equal(first.status,'paused');assert.equal(first.record_count,0);assert.equal(first.progress.current_id,id);
  const last=await runKccCollection({...options,maxRequests:1},{...h.dependencies,fetchImpl});assert.equal(last.status,'complete');assert.equal(last.record_count,1);const d=h.snapshots.get('kcc-proposal-details').records[0],a=h.snapshots.get('kcc-proposal-attachments').records[0];assert.equal(d.data.source_identity_field,'uscAttachment.hidDataSN');assert.notEqual(d.raw_sha256,a.raw_sha256);assert(h.raw.has(a.data.attachments[0].raw_sha256));assert.equal(last.coverage.complete,true);
 });
 await test('多版本PDF跨段續作保全原件及各自頁序',async()=>{
  const h=harness(),root=path.join(temp,'pdf-versions'),id='9864',urls=['a','corrected'].map(n=>`https://cissearch.kcc.gov.tw/Upload/Attachment/MeetingRecord/${id}/${n}.pdf`);
  const source={id,title:'會議',text:'會議',data:{record_id:id,pdf_url:urls[1],pdf_urls:urls},source_url:'https://cissearch.kcc.gov.tw/System/meetingrecord/default.aspx',raw_sha256:'b'.repeat(64),retrieved_at:'2026-10-15T00:00:00Z'};
  bindSource(h,'kcc-meetings',[source]);
  const deps={...h.dependencies,fetchImpl:async(url)=>new Response(`%PDF-${url}`),pdfExtractor:async(bytes)=>({total_pages:2,pages:[{page:1,text:bytes.toString()},{page:2,text:''}]})};
  const options={profile:'kcc-meeting-records',root,maxRequests:1};const first=await runKccCollection(options,deps);assert.equal(first.status,'paused');assert.equal(first.record_count,0);const last=await runKccCollection(options,deps);assert.equal(last.status,'partial');assert.equal(last.archive_complete,true);assert.equal(last.fulltext_complete,false);const pdf=h.snapshots.get('kcc-meeting-records').records[0];assert.equal(pdf.data.pdf_versions.length,2);assert.equal(pdf.data.pdf_url,urls[1]);assert.equal(pdf.raw_sha256,pdf.data.pdf_versions[1].raw_sha256);assert.equal(pdf.data.text_layer_status,'partial');assert.deepEqual(pdf.data.empty_text_pages,[2]);assert(h.raw.has(pdf.data.pdf_versions[0].raw_sha256));
 });
 await test('onclick的HTML編碼引號不污染詳情URL',async()=>{
  const parser=await loadTypeScriptParser('../kcc/search.ts',{forceNative:true,replace:(source)=>source.replace(/^import[^\n]+from "\.\/client";?\s*$/m,"const fetchWebFormsTokens=()=>{};")});
  const encoded=proposalRow('100').replace("location.href='Detail.aspx?s=ENCRYPTED100'","location.href=&#39;Detail.aspx?s=ABC123&amp;ct=DEF456&#39;");
  assert.equal(parser.parseProposalRows(encoded)[0].detail_url,'Detail.aspx?s=ABC123&ct=DEF456');
 });
 await test('PDF頁序嚴格驗證、空白文字層明示且不推定發言者',async()=>{
  const pdf=validatePdfExtraction({total_pages:2,pages:[{page:1,text:'有字'},{page:2,text:''}]});assert.equal(pdf.text_layer_status,'partial');assert.deepEqual(pdf.empty_text_pages,[2]);assert.equal(pdf.speaker_attribution,'not-inferred');assert.throws(()=>validatePdfExtraction({total_pages:2,pages:[{page:1,text:'字'}]}),/PDF/);
 });
 await test('P1 PDF跨record redirect在擷取及發布前拒絕',async()=>{
  const h=harness(),id='9864',url=`https://cissearch.kcc.gov.tw/Upload/Attachment/MeetingRecord/${id}/original.pdf`;
  bindSource(h,'kcc-meetings',[{id,title:'會議',text:'會議',data:{record_id:id,pdf_url:url,pdf_urls:[url]},source_url:'https://cissearch.kcc.gov.tw/System/meetingrecord/default.aspx'}]);
  let extractions=0;
  const result=await runKccCollection({profile:'kcc-meeting-records',root:path.join(temp,'pdf-redirect'),maxRequests:5},{...h.dependencies,fetchImpl:async(requested)=>requested===url?new Response('',{status:302,headers:{location:'https://cissearch.kcc.gov.tw/Upload/Attachment/MeetingRecord/9999/wrong.pdf'}}):new Response('%PDF-wrong-record'),pdfExtractor:async()=>{extractions++;return{total_pages:1,pages:[{page:1,text:'錯誤會議'}]};}});
  assert.equal(result.status,'blocked');assert.equal(result.error_code,'SOURCE_ID_MISMATCH');assert.equal(extractions,0);assert.equal(h.snapshots.size,0);assert.equal(result.record_count,0);assert.equal(result.coverage.complete,false);
 });
 await test('P1 附件跨proposal redirect拒絕寫入已驗證附件清單',async()=>{
  const h=harness(),id='100',url='https://cissearch.kcc.gov.tw/Upload/Attachment/Proposal/100/original.pdf';
  bindSource(h,'kcc-proposals',[{id,title:'提案',text:'提案',data:{proposal_sn:id,detail_url:'https://cissearch.kcc.gov.tw/System/Proposal/Detail.aspx?s=ABC'},source_url:'https://cissearch.kcc.gov.tw/System/Proposal/Default.aspx'}]);
  const fetchImpl=async(requested)=>requested.includes('Detail.aspx')?new Response(`${input(`${P}uscAttachment$hidDataSN`,id)}${input(`${P}uscAttachment$hidDataType`,'1')}<tr><td>案由</td><td>提案</td></tr>`):requested.includes('.ashx')?new Response(`<tr><td>1</td><td>原件</td><td><a href="${url}">original.pdf</a></td><td>10 bytes</td></tr>`):requested===url?new Response('',{status:302,headers:{location:'https://cissearch.kcc.gov.tw/Upload/Attachment/Proposal/999/wrong.pdf'}}):new Response('%PDF-wrong-proposal');
  const result=await runKccCollection({profile:'kcc-proposal-details',root:path.join(temp,'attachment-redirect'),maxRequests:5},{...h.dependencies,fetchImpl});
  assert.equal(result.status,'blocked');assert.equal(result.error_code,'SOURCE_ID_MISMATCH');assert.equal(h.snapshots.size,0);assert.equal(result.record_count,0);
 });
 await test('P1 complete checkpoint核active snapshot及manifest，拒覆蓋別scope',async()=>{
  const h=harness(),options={profile:'kcc-proposals-full',root:path.join(temp,'release-drift'),sessions:['0704'],pageSize:2,maxRequests:20};
  const done=await runKccCollection(options,h.dependencies);assert.equal(done.status,'complete');
  const old=h.snapshots.get('kcc-proposals');await h.store.importSnapshot({...old,snapshot_id:'another-scope',records:old.records.slice(0,1),coverage:{scope:'other',complete:true,source_total:1}});
  const blocked=await runKccCollection(options,h.dependencies);assert.equal(blocked.error_code,'RELEASE_DRIFT');assert.equal(blocked.status,'blocked');assert.equal(blocked.needs_reconciliation,true);assert.equal(blocked.coverage.complete,false);assert.equal(blocked.attempted,0);assert.equal(h.snapshots.get('kcc-proposals').snapshot_id,'another-scope');
  // Even a matching snapshot id cannot excuse a changed native manifest.
  h.releases.set('kcc-proposals',{...done.receipt,manifest_sha256:'f'.repeat(64)});
  const manifestDrift=await runKccCollection(options,h.dependencies);assert.equal(manifestDrift.error_code,'RELEASE_DRIFT');assert.equal(manifestDrift.attempted,0);
 });
 await test('P1 詳情所有已存在的身分欄位一致才通過',async()=>{
  const body='<tr><td>案由</td><td>測試</td></tr>',url='https://cissearch.kcc.gov.tw/System/Proposal/Detail.aspx?s=ABC';
  const identities=(p,a,t)=>input(`${P}hidProposalSN`,p)+input(`${P}uscAttachment$hidDataSN`,a)+input(`${P}uscAttachment$hidDataType`,t);
  for(const [p,a,t] of [['999','100','1'],['100','999','1'],['100','100','2']])assert.throws(()=>parseDetail(identities(p,a,t)+body,'100',url),{code:'SOURCE_ID_MISMATCH'});
  assert.throws(()=>parseDetail(identities('100','100','1')+input(`${P}hidProposalSN`,'100')+body,'100',url),{code:'SOURCE_ID_MISMATCH'});
  assert.equal(parseDetail(identities('100','100','1')+body,'100',url).source_id_verified,true);
 });
 await test('P1 母集分頁A1000+B1以DEPENDENCY_DRIFT拒絕混合',async()=>{
  const h=harness(),dataset='kcc-meetings';h.store.hasDataset=async(name)=>name===dataset;
  h.store.queryRecords=async(name,{offset=0}={})=>({records:Array.from({length:offset?1:1000},(_,i)=>({id:String(offset+i),title:'會議',data:{record_id:String(offset+i)}})),local_match_count:1001,release:{dataset,snapshot_id:offset?'B':'A',manifest_sha256:(offset?'b':'a').repeat(64),record_count:1001,coverage:{complete:true}}});
  const result=await runKccCollection({profile:'kcc-meeting-records',root:path.join(temp,'mixed-source')},h.dependencies);
  assert.equal(result.error_code,'DEPENDENCY_DRIFT');assert.equal(result.attempted,0);assert.equal(h.snapshots.size,0);assert.equal(result.progress.total,null);
 });
 await test('P1 雙dataset部分發布保存confirmed receipt並原生核對後恢復',async()=>{
  const h=harness(),id='100',root=path.join(temp,'partial-publication');
  bindSource(h,'kcc-proposals',[{id,title:'提案',text:'提案',data:{proposal_sn:id,detail_url:'https://cissearch.kcc.gov.tw/System/Proposal/Detail.aspx?s=ABC'},source_url:'https://cissearch.kcc.gov.tw/System/Proposal/Default.aspx'}]);
  const original=h.store.importSnapshot.bind(h.store);let fail=true,detailImports=0;
  h.store.importSnapshot=async(snapshot)=>{if(snapshot.dataset==='kcc-proposal-details')detailImports++;if(snapshot.dataset==='kcc-proposal-attachments'&&fail){fail=false;throw Object.assign(new Error('attachment publication outcome unknown'),{code:'IMPORT_FAILED'});}return original(snapshot);};
  const fetchImpl=async(url)=>new Response(url.includes('Detail.aspx')?`${input(`${P}uscAttachment$hidDataSN`,id)}${input(`${P}uscAttachment$hidDataType`,'1')}<tr><td>案由</td><td>提案</td></tr>`:'尚無任何資料!');
  const options={profile:'kcc-proposal-details',root,maxRequests:5};const failed=await runKccCollection(options,{...h.dependencies,fetchImpl});
  assert.equal(failed.status,'blocked');assert.equal(failed.commit_state,'unknown');assert.equal(failed.publication_status,'partial');assert.equal(failed.record_count,1);assert(failed.receipts['kcc-proposal-details']);assert.deepEqual(failed.uncertain_datasets,['kcc-proposal-attachments']);assert.equal(failed.needs_reconciliation,true);assert.equal(failed.progress.cursor,0);
  const pending=JSON.parse(await readFile(path.join(path.dirname(failed.checkpoint_path),'pending-publication.json'),'utf8'));assert(pending.confirmed_receipts['kcc-proposal-details']);assert.equal(pending.publication_states['kcc-proposal-attachments'],'unknown');
  const recovered=await runKccCollection(options,{...h.dependencies,fetchImpl});assert.equal(recovered.status,'complete');assert.equal(recovered.commit_state,'committed');assert.equal(recovered.attempted,0);assert.equal(detailImports,1);assert.equal(recovered.progress.cursor,1);
 });
 await test('P1 原生SQLite active release被別scope取代後保留新scope',async()=>{
  const h=harness(),root=path.join(temp,'native-release-drift'),options={profile:'kcc-proposals-full',root,sessions:['0704'],pageSize:2,maxRequests:20};
  const dependencies={...h.dependencies,storeFactory:async(location)=>new LocalStore(location,{readOnly:false})};
  const first=await runKccCollection(options,dependencies);assert.equal(first.status,'complete');
  const native=new LocalStore(root,{readOnly:false}),old=await native.queryRecords('kcc-proposals',{limit:1});
  const foreign=await native.importSnapshot({dataset:'kcc-proposals',snapshot_id:'native-foreign-scope',records:old.records.map(({json,...r})=>r),coverage:{scope:'independent-review-other-scope',complete:true,source_total:1},raw_objects:[],parser_version:'review-fixture',validator_version:'review-fixture',validation_status:'passed'});native.close();
  const replay=await runKccCollection(options,dependencies);assert.equal(replay.error_code,'RELEASE_DRIFT');assert.equal(replay.attempted,0);assert.equal(replay.coverage.complete,false);
  const readback=new LocalStore(root),active=(await readback.queryRecords('kcc-proposals',{limit:0})).release;readback.close();assert.equal(active.snapshot_id,foreign.snapshot_id);assert.equal(active.manifest_sha256,foreign.manifest_sha256);assert.equal(active.record_count,1);
 });
 await test('P1 原生SQLite雙發布後拋錯由原生相同snapshot收據冪等恢復',async()=>{
  const root=path.join(temp,'native-publication-uncertain'),id='100',raw=Buffer.from('public-index-fixture'),hash=createHash('sha256').update(raw).digest('hex');
  const seed=new LocalStore(root,{readOnly:false});await seed.putRawObject({sha256:hash,bytes_base64:raw.toString('base64')});await seed.importSnapshot({dataset:'kcc-proposals',snapshot_id:'native-source',records:[{id,title:'提案',text:'提案',data:{proposal_sn:id,detail_url:'https://cissearch.kcc.gov.tw/System/Proposal/Detail.aspx?s=ABC'},source_url:'https://cissearch.kcc.gov.tw/System/Proposal/Default.aspx',retrieved_at:'2026-10-15T00:00:00Z',raw_sha256:hash}],coverage:{scope:'native-source',complete:true,source_total:1},raw_objects:[],parser_version:'review-fixture',validator_version:'review-fixture',validation_status:'passed'});seed.close();
  const h=harness();let fault=true,detailCalls=0,unchanged=0;
  const deps={...h.dependencies,fetchImpl:async(url)=>new Response(url.includes('Detail.aspx')?`${input(`${P}uscAttachment$hidDataSN`,id)}${input(`${P}uscAttachment$hidDataType`,'1')}<tr><td>案由</td><td>提案</td></tr>`:'尚無任何資料!'),storeFactory:async(location)=>{const store=new LocalStore(location,{readOnly:false}),original=store.importSnapshot.bind(store);store.importSnapshot=async(snapshot)=>{if(snapshot.dataset==='kcc-proposal-details')detailCalls++;const receipt=await original(snapshot);if(receipt.status==='unchanged')unchanged++;if(snapshot.dataset==='kcc-proposal-attachments'&&fault){fault=false;throw Object.assign(new Error('fault after native publication'),{code:'AFTER_WRITE_UNKNOWN'});}return receipt;};return store;}};
  const options={profile:'kcc-proposal-details',root,maxRequests:3},first=await runKccCollection(options,deps);assert.equal(first.commit_state,'unknown');assert.equal(first.publication_status,'partial');assert.equal(first.record_count,1);assert.equal(first.progress.cursor,0);
  const native=new LocalStore(root);assert.equal((await native.queryRecords('kcc-proposal-details',{limit:0})).release.record_count,1);assert.equal((await native.queryRecords('kcc-proposal-attachments',{limit:0})).release.record_count,1);native.close();
  const recovered=await runKccCollection(options,deps);assert.equal(recovered.status,'complete');assert.equal(recovered.attempted,0);assert.equal(detailCalls,1);assert.equal(unchanged,1);assert.equal(recovered.progress.cursor,1);
 });
 await test('真實排序類型碰撞以單回應完整列舉恢復且保留成功cursor及原件',async()=>{
  const h=harness({duplicate:true}),root=path.join(temp,'single-response-recovery'),options={profile:'kcc-proposals-full',root,sessions:['0704'],pageSize:2,maxRequests:20,maxPages:1};
  const first=await runKccCollection(options,h.dependencies);const before=JSON.parse(await readFile(first.checkpoint_path,'utf8'));assert.equal(first.record_count,2);
  const resumed=await runKccCollection({...options,maxPages:20},h.dependencies);assert.equal(resumed.status,'paused');assert.equal(resumed.record_count,3);const last=await runKccCollection({...options,maxPages:20},h.dependencies);assert.equal(last.status,'complete');assert.equal(last.record_count,6);
  const state=JSON.parse(await readFile(first.checkpoint_path,'utf8')),tab=state.queries['07/0704'].tabs['1'];assert.equal(tab.complete,true);assert.equal(tab.next_page,2);assert.equal(tab.pages_proof.length,1);assert.equal(tab.reconciliation.response.unique_count,3);assert.equal(tab.reconciliation.response.row_count,3);assert.equal(tab.reconciliation.prior_ids_covered,true);
  for(const [id,record]of Object.entries(before.records['kcc-proposals']))assert.deepEqual(state.records['kcc-proposals'][id],record);
 });
 await test('議事錄只含Word的列照計入官方100筆分頁，不冒充PDF或略過',async()=>{
  const header='<table id="ContentPlaceHolder1_gvIndex">',row=`<tr><td>1</td><td>103/08/22</td><td>早期議事錄</td><td>${input(`${P}gvIndex$ctl02$rptAttachment$ctl00$hidDataSN`,'1449')}<a href="/Upload/Attachment/MeetingRecord/1449/original.doc">Word</a></td><td></td></tr>`;
  const footer=`</table><span id="ContentPlaceHolder1_DataPager1">共 1 筆 | 1 / 1 頁 | <a>下一頁</a>${input(`${P}DataPager1$ctl02$txtPageSize`,'100')}</span>`;
  const parsed=parseMeetingPage(header+row+footer)[0];assert.equal(parsed.rows.length,1);assert.equal(parsed.rows[0].record_id,'1449');assert.deepEqual(parsed.rows[0].pdf_urls,[]);assert.equal(parsed.rows[0].original_files[0].file_type,'doc');assert.equal(parsed.rows[0].original_availability,'non_pdf_originals_only');
 });
 await test('Word原件可信歸檔後回partial與未索引，完整母集不減筆',async()=>{
  const h=harness(),id='1449',url=`https://cissearch.kcc.gov.tw/Upload/Attachment/MeetingRecord/${id}/original.doc`;
  bindSource(h,'kcc-meetings',[{id,title:'Word議事錄',text:'會議',data:{record_id:id,pdf_url:null,pdf_urls:[],original_files:[{download_url:url,file_type:'doc'}]},source_url:'https://cissearch.kcc.gov.tw/System/meetingrecord/default.aspx'}]);
  let extracted=0;const result=await runKccCollection({profile:'kcc-meeting-records',root:path.join(temp,'word-original'),maxRequests:2},{...h.dependencies,fetchImpl:async()=>new Response(Buffer.from('d0cf11e0a1b11ae1','hex')),pdfExtractor:async()=>{extracted++;throw new Error('must not interpret Word as PDF');}});
  assert.equal(result.status,'partial');assert.equal(result.source_exhausted,true);assert.equal(result.archive_complete,true);assert.equal(result.fulltext_complete,false);assert.equal(result.record_count,1);assert.equal(result.coverage.source_total,1);assert.equal(result.coverage.complete,false);assert.equal(result.unindexed_records,1);assert.equal(extracted,0);
  const record=h.snapshots.get('kcc-meeting-records').records[0];assert.equal(record.data.content_index_status,'unindexed_non_pdf');assert.equal(record.data.originals_complete,true);assert.equal(record.data.original_versions.length,1);assert(h.raw.has(record.data.original_versions[0].raw_sha256));assert.equal(record.data.pdf_url,null);assert.equal(record.data.total_pages,null);assert.deepEqual(record.data.pages,[]);
 });
 await test('PDF加Word混合原件完整保存仍明示fulltext未完整',async()=>{
  const h=harness(),id='1449',base=`https://cissearch.kcc.gov.tw/Upload/Attachment/MeetingRecord/${id}/`,files=[{download_url:base+'original.pdf',file_type:'pdf'},{download_url:base+'correction.doc',file_type:'doc'}];
  bindSource(h,'kcc-meetings',[{id,title:'混合議事錄',text:'會議',data:{record_id:id,pdf_url:files[0].download_url,pdf_urls:[files[0].download_url],original_files:files},source_url:'https://cissearch.kcc.gov.tw/System/meetingrecord/default.aspx'}]);
  const result=await runKccCollection({profile:'kcc-meeting-records',root:path.join(temp,'mixed-originals'),maxRequests:2},{...h.dependencies,fetchImpl:async(url)=>new Response(url.endsWith('.pdf')?'%PDF-test':Buffer.from('d0cf11e0a1b11ae1','hex')),pdfExtractor:async()=>({total_pages:1,pages:[{page:1,text:'PDF頁面'}]})});
  assert.equal(result.status,'partial');assert.equal(result.archive_complete,true);assert.equal(result.fulltext_complete,false);const record=h.snapshots.get('kcc-meeting-records').records[0];assert.equal(record.data.original_versions.length,2);assert.equal(record.data.pdf_versions.length,1);assert.equal(record.data.unindexed_original_count,1);assert.equal(record.data.fulltext_complete,false);assert.equal(record.source_url,files[0].download_url);assert.equal(record.raw_sha256,record.data.pdf_versions[0].raw_sha256);for(const original of record.data.original_versions){assert(original.download_url);assert(h.raw.has(original.raw_sha256));}
 });
 await test('P1 大於16MiB完整tab成功後立即yield，下一段其他tab恢復正常尺寸',async()=>{
  const old=totals[4];totals[4]=3;
  try{
   const h=harness({duplicate:true}),root=path.join(temp,'large-recovery-boundary'),options={profile:'kcc-proposals-full',root,sessions:['0704'],pageSize:2,maxRequests:30};let largeResponses=0;
   const fetchImpl=async(url,options)=>{const response=await h.dependencies.fetchImpl(url,options),form=new URLSearchParams(options.body||'');if(options.method==='POST'&&form.get(`${P}DataPager1$ctl02$txtPageSize`)==='3'){largeResponses++;return new Response((await response.text())+'<!--'+'x'.repeat(16*1024*1024)+'-->',{headers:{'content-type':'text/html'}});}return response;};
   const first=await runKccCollection(options,{...h.dependencies,fetchImpl});assert.equal(first.status,'paused');assert.equal(first.continuation_required,true);assert.equal(first.record_count,3);assert.equal(first.progress.queries['07/0704'].tabs['1'].reconciliation.response.raw_row_count,3);assert(first.progress.queries['07/0704'].tabs['1'].reconciliation.response.byte_length>16*1024*1024);assert.equal(largeResponses,1);
   const last=await runKccCollection(options,{...h.dependencies,fetchImpl});assert.equal(last.status,'complete');assert.equal(last.record_count,7);assert.equal(last.error_code,null);assert.equal(largeResponses,1);
  }finally{totals[4]=old;}
 });
 await test('P1 原始4列含重複ID不准由TS Map去重成3列完整證明',async()=>{
  const h=harness({duplicate:true});const fetchImpl=async(url,options)=>{const response=await h.dependencies.fetchImpl(url,options),form=new URLSearchParams(options.body||'');if(form.get(`${P}DataPager1$ctl02$txtPageSize`)==='3')return new Response((await response.text()).replace('<div id="tabs-1">','<div id="tabs-1">'+proposalRow('100')));return response;};
  const result=await runKccCollection({profile:'kcc-proposals-full',root:path.join(temp,'raw-duplicate-row'),sessions:['0704'],pageSize:2,maxRequests:20},{...h.dependencies,fetchImpl});assert.equal(result.status,'blocked');assert.equal(result.error_code,'DUPLICATE_SOURCE_ROW');assert.equal(result.record_count,2);assert.equal(result.coverage.complete,false);assert.equal(result.progress.queries['07/0704'].tabs['1'].complete,false);assert.equal(result.progress.queries['07/0704'].tabs['1'].next_page,2);
 });
 await test('P1 實際assertQuery要求所有官方控制項存在且唯一，空期望亦適用',async()=>{
  const query={period:'07',session:'0704',keyword:''},valid=fixture();assert.doesNotThrow(()=>assertQuery(valid,query));
  const missingKeyword=valid.replace(input(`${P}txtKeyword`,''),''),missingMeeting=valid.replace(select(`${M}ddlMeeting`,[''],''),'');
  const conflictingPeriod=select(`${M}ddlPeriod`,['09'],'09')+valid,duplicateKeyword=valid+input(`${P}txtKeyword`,''),wrongId=valid.replace(`name="${M}ddlPeriod"`,`name="${M}ddlPeriod" id="ContentPlaceHolder1_wrong"`);
  for(const html of [missingKeyword,missingMeeting,conflictingPeriod,duplicateKeyword,wrongId,missingKeyword+input('ctl00$txtKeyword','')])assert.throws(()=>assertQuery(html,query),{code:'FILTER_NOT_CONFIRMED'});
  const idOnly=valid.replace(`name="${M}ddlPeriod"`,'id="ContentPlaceHolder1_uscPeriodSessionMeeting_ddlPeriod"');assert.doesNotThrow(()=>assertQuery(idOnly,query));
 });
 await test('P1 collector及recovery實際路徑拒缺少空keyword或矛盾period',async()=>{
  for(const mode of ['missing-keyword','duplicate-period']){
   const h=harness(),fetchImpl=async(url,options)=>{const response=await h.dependencies.fetchImpl(url,options);if(options.method!=='POST')return response;const html=await response.text();return new Response(mode==='missing-keyword'?html.replace(input(`${P}txtKeyword`,''),''):select(`${M}ddlPeriod`,['09'],'09')+html);};
   const result=await runKccCollection({profile:'kcc-proposals-full',root:path.join(temp,mode),sessions:['0704'],pageSize:2,maxRequests:20},{...h.dependencies,fetchImpl});assert.equal(result.error_code,'FILTER_NOT_CONFIRMED');assert.equal(result.record_count,0);assert.equal(h.snapshots.size,0);
  }
  const h=harness({duplicate:true}),fetchImpl=async(url,options)=>{const response=await h.dependencies.fetchImpl(url,options),form=new URLSearchParams(options.body||'');return form.get(`${P}DataPager1$ctl02$txtPageSize`)==='3'?new Response((await response.text()).replace(input(`${P}txtKeyword`,''),'')):response;};
  const result=await runKccCollection({profile:'kcc-proposals-full',root:path.join(temp,'recovery-missing-control'),sessions:['0704'],pageSize:2,maxRequests:20},{...h.dependencies,fetchImpl});assert.equal(result.error_code,'FILTER_NOT_CONFIRMED');assert.equal(result.record_count,2);assert.equal(result.coverage.complete,false);
 });
 await test('P1 DOC的HTML/octet-stream、錯magic與未驗證格式保留raw但不完成原件',async()=>{
  const cases=[['html','doc',Buffer.from('<!DOCTYPE html><html><body>temporary upstream error</body></html>'),'ORIGINAL_SIGNATURE_INVALID'],['bad-magic','doc',Buffer.from('not a Word original'),'ORIGINAL_SIGNATURE_INVALID'],['short-cfbf','doc',Buffer.from('d0cf11e0a1b11a','hex'),'ORIGINAL_SIGNATURE_INVALID'],['unknown-docx','docx',Buffer.from('504b030400000000','hex'),'ORIGINAL_FORMAT_UNSUPPORTED'],['unknown-odt','odt',Buffer.from('504b030400000000','hex'),'ORIGINAL_FORMAT_UNSUPPORTED']];
  for(const [label,fileType,body,code]of cases){
   const h=harness(),id='1449',url=`https://cissearch.kcc.gov.tw/Upload/Attachment/MeetingRecord/${id}/original.${fileType}`;bindSource(h,'kcc-meetings',[{id,title:'會議',text:'會議',data:{record_id:id,pdf_urls:[],original_files:[{download_url:url,file_type:fileType}]},source_url:'https://cissearch.kcc.gov.tw/System/meetingrecord/default.aspx'}]);
   const result=await runKccCollection({profile:'kcc-meeting-records',root:path.join(temp,label),maxRequests:2},{...h.dependencies,fetchImpl:async()=>new Response(body,{headers:{'content-type':'application/octet-stream'}})});assert.equal(result.status,'blocked');assert.equal(result.error_code,code);assert.equal(result.archive_complete,false);assert.equal(result.record_count,0);assert.equal(h.snapshots.size,0);assert.equal(h.raw.size,1);assert.deepEqual(Buffer.from([...h.raw.values()][0],'base64'),body);
  }
 });
 await test('舊checkpoint有效DOC原件以CAS補驗CFBF證據，原cursor及raw不重設',async()=>{
  const h=harness(),root=path.join(temp,'legacy-doc-revalidation'),id='1449',url=`https://cissearch.kcc.gov.tw/Upload/Attachment/MeetingRecord/${id}/original.doc`;bindSource(h,'kcc-meetings',[{id,title:'會議',text:'會議',data:{record_id:id,pdf_urls:[],original_files:[{download_url:url,file_type:'doc'}]},source_url:'https://cissearch.kcc.gov.tw/System/meetingrecord/default.aspx'}]);
  const options={profile:'kcc-meeting-records',root,maxRequests:1},deps={...h.dependencies,fetchImpl:async()=>new Response(Buffer.from('d0cf11e0a1b11ae1','hex'))};const first=await runKccCollection(options,deps),state=JSON.parse(await readFile(first.checkpoint_path,'utf8')),snapshot=structuredClone(h.snapshots.get('kcc-meeting-records'));
  delete snapshot.records[0].data.original_versions[0].format_validation;snapshot.snapshot_id='legacy-doc-unverified-container';const receipt=await h.store.importSnapshot(snapshot);state.records['kcc-meeting-records'][id]=snapshot.records[0];state.receipts['kcc-meeting-records']=receipt;await import('node:fs/promises').then(fs=>fs.writeFile(first.checkpoint_path,JSON.stringify(state)));
  const result=await runKccCollection(options,deps);assert.equal(result.status,'partial');assert.equal(result.archive_complete,true);assert.equal(result.attempted,0);assert.equal(result.progress.cursor,1);const migrated=h.snapshots.get('kcc-meeting-records').records[0];assert.equal(migrated.raw_sha256,snapshot.records[0].raw_sha256);assert.equal(migrated.data.original_versions[0].format_validation.validation_version,'cfbf-magic-8-v1');
 });
 await test('跨屆完成即yield：舊末頁offset使下一屆假零筆，新段fresh GET可完整接續',async()=>{
  const h=meetingTermBoundaryHarness(),options={profile:'kcc-meetings-full',root:path.join(temp,'term-boundary'),pageSize:2,maxRequests:30};
  const first=await runKccCollection(options,h.dependencies);assert.equal(first.status,'paused');assert.equal(first.record_count,3);assert.equal(first.progress.queries['07/0701'].complete,true);assert.equal(first.progress.queries['07/0701'].tabs['1'].next_page,3);assert.equal(first.progress.queries['07/0702'].tabs['1'].total,2);assert.equal(h.getUnsafeSwitches(),0);
  const before=JSON.parse(await readFile(first.checkpoint_path,'utf8')),form=controls(h.getLastHtml());form.set('__EVENTTARGET',`${P}linkBtnSearch`);form.set(`${M}ddlSession`,'0702');const bad=await h.dependencies.fetchImpl('https://cissearch.kcc.gov.tw/System/meetingrecord/default.aspx',{method:'POST',body:form.toString()});assert.equal(parseMeetingPage(await bad.text())[0].total,0);assert.equal(h.getUnsafeSwitches(),1);
  const last=await runKccCollection(options,h.dependencies);assert.equal(last.status,'complete');assert.equal(last.record_count,5);assert.equal(last.coverage.source_total,5);assert.equal(last.coverage.complete,true);assert.equal(h.getUnsafeSwitches(),1);const after=JSON.parse(await readFile(last.checkpoint_path,'utf8'));for(const [id,record]of Object.entries(before.records['kcc-meetings']))assert.deepEqual(after.records['kcc-meetings'][id],record);assert.deepEqual(after.queries['07/0701'],before.queries['07/0701']);
 });
 await test('跨屆fresh GET仍核原枚舉總數：真正來源變動維持SOURCE_DRIFT',async()=>{
  const h=meetingTermBoundaryHarness(),options={profile:'kcc-meetings-full',root:path.join(temp,'term-real-drift'),pageSize:2,maxRequests:30};const first=await runKccCollection(options,h.dependencies);assert.equal(first.status,'paused');assert.equal(first.record_count,3);h.sourceTotals['0702']=3;
  const next=await runKccCollection(options,h.dependencies);assert.equal(next.status,'blocked');assert.equal(next.error_code,'SOURCE_DRIFT');assert.equal(next.record_count,3);assert.equal(next.receipt.snapshot_id,first.receipt.snapshot_id);assert.equal(next.receipt.manifest_sha256,first.receipt.manifest_sha256);assert.equal(next.progress.queries['07/0702'].tabs['1'].total,2);assert.equal(h.getUnsafeSwitches(),0);
 });
 console.log(`${passed} meaningful KCC ingestion tests passed`);
}finally{await rm(temp,{recursive:true,force:true});}
