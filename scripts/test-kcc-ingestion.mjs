import { LocalStore } from '../src/local/store.mjs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadTypeScriptParser } from '../src/ingestion/collector.mjs';
import { runKccCollection, validatePdfExtraction } from '../src/ingestion/kcc-collector.mjs';
import { parseMeetingPage, parseAttachments, parseDetail } from '../src/ingestion/kcc-html.mjs';
const P='ctl00$ContentPlaceHolder1$', M=`${P}uscPeriodSessionMeeting$`;
const e=(s)=>String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;');
const input=(name,value='')=>`<input name="${e(name)}" value="${e(value)}"/>`;
const select=(name,values,selected)=>`<select name="${e(name)}">${values.map((v)=>`<option value="${v}"${v===selected?' selected="selected"':''}>${v}</option>`).join('')}</select>`;
function proposalRow(id){return `<tr><td>${input(`${P}gvIndex$ctl${id}$hidProposalSN`,id)}${input(`${P}gvIndex$ctl${id}$hidProposalKind`,'1')}</td><td>${id}</td><td>工務</td><td>測試提案人</td><td onclick="location.href='Detail.aspx?s=ENCRYPTED${id}'">議案${id}</td><td>結案</td></tr>`;}
const totals={1:3,2:1,3:0,4:2,5:0,6:0,7:0,8:0,9:0};
function fixture(query={period:'07',session:'0704',keyword:''},pages={},sizes={},duplicate=false){
 const form=input('__VIEWSTATE','public-state')+input('__EVENTVALIDATION','public-validation')+select(`${M}ddlPeriod`,['07'],query.period)+select(`${M}ddlSession`,['0701','0704'],query.session)+input(`${M}ddlMeeting`)+input(`${P}txtKeyword`,query.keyword);
 return form+Object.keys(totals).map(id=>`<a href="#tabs-${id}">tab${id}</a>`).join('')+Object.entries(totals).map(([id,total])=>{
  const page=pages[id]||1,size=sizes[id]||2,pageCount=Math.ceil(total/size),first=duplicate&&page===2?0:(page-1)*size;
  const rows=Array.from({length:Math.min(size,Math.max(0,total-(page-1)*size))},(_,i)=>proposalRow(String(Number(id)*100+first+i)));
  return `<div id="tabs-${id}">${rows.join('')}${total?`<span id="ContentPlaceHolder1_DataPager${id}">共 ${total} 筆 | ${page} / ${pageCount} 頁 | ${page<pageCount?`<a href="javascript:__doPostBack('ctl00$ContentPlaceHolder1$DataPager${id}$ctl01$ctl02','')">下一頁</a>`:'<a>下一頁</a>'}${input(`${P}DataPager${id}$ctl02$txtCurrentPage`)}${input(`${P}DataPager${id}$ctl02$txtPageSize`,size)}</span>`:'尚無任何資料!'}</div>`;
 }).join('')+'<div id="tabs-10"></div>';
}
function harness({duplicate=false,failImport=false}={}){
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
   html=fixture(query,pages,sizes,duplicate);
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
  const h=harness({duplicate:true});const result=await runKccCollection({profile:'kcc-proposals-full',root:path.join(temp,'duplicate'),sessions:['0704'],pageSize:2,maxRequests:20},h.dependencies);assert.equal(result.status,'blocked');assert.equal(result.error_code,'DUPLICATE_PAGE_OR_ID');assert.equal(result.record_count,2);assert.equal(result.coverage.complete,false);
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
  const options={profile:'kcc-meeting-records',root,maxRequests:1};const first=await runKccCollection(options,deps);assert.equal(first.status,'paused');assert.equal(first.record_count,0);const last=await runKccCollection(options,deps);assert.equal(last.status,'complete');const pdf=h.snapshots.get('kcc-meeting-records').records[0];assert.equal(pdf.data.pdf_versions.length,2);assert.equal(pdf.data.pdf_url,urls[1]);assert.equal(pdf.raw_sha256,pdf.data.pdf_versions[1].raw_sha256);assert.equal(pdf.data.text_layer_status,'partial');assert.deepEqual(pdf.data.empty_text_pages,[2]);assert(h.raw.has(pdf.data.pdf_versions[0].raw_sha256));
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
 console.log(`${passed} meaningful KCC ingestion tests passed`);
}finally{await rm(temp,{recursive:true,force:true});}
