import http from 'node:http';
import { appendFile } from 'node:fs/promises';
import {
  createPublicClient, http as viemHttp, parseAbiItem, decodeEventLog,
  decodeAbiParameters, getAddress,
} from 'viem';
import { loadScannerCursor, saveScannerCursor } from './scanner_state.mjs';
import {
  ensureCurveFirstSwapSchema,
  loadPendingCurveRegistry,
  persistCurveFirstSwap,
  getCurveFirstSwapHealth,
} from './curve_first_swap.mjs';

const CFG = {
  chainId: 4663,
  rpcUrl: process.env.RH_HTTP_URL || 'https://rpc.mainnet.chain.robinhood.com',
  pollMs: Number(process.env.POLL_MS || 5000),
  heartbeatMs: Number(process.env.HEARTBEAT_MS || 120000),
  backfillBlocks: Number(process.env.BACKFILL_BLOCKS || 120),
  reorgBlocks: Math.max(0, Number(process.env.CURSOR_REORG_BLOCKS || 3)),
  scannerName: String(process.env.SCANNER_NAME || 'combined-main'),
  port: Number(process.env.PORT || 3000),
  dryRun: String(process.env.DRY_RUN || '').toLowerCase() === 'true',
  webhookUrl: String(process.env.SHEET_WEBHOOK_URL || '').trim(),
  webhookSecret: String(process.env.SHEET_INGEST_SECRET || '').trim(),
  enrichQueuePath: String(process.env.ENRICH_QUEUE_PATH || '/tmp/rh_enrich_queue.jsonl'),
  legacyEnricher: /^(1|true|yes)$/i.test(String(process.env.LEGACY_ENRICHER_ENABLED || 'false')),
  ponsV2Factory: norm(process.env.PONS_V2_FACTORY || '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e'),
  v4PoolManager: norm(process.env.UNIV4_POOL_MANAGER || '0x8366a39cc670b4001a1121b8f6a443a643e40951'),
  v3Factory: norm(process.env.UNIV3_FACTORY || ''),
  weth: norm(process.env.WETH || '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'),
  curveBatchSize: Math.max(25, Math.min(500, Number(process.env.CURVE_LOG_BATCH_SIZE || 250))),
};

const QUOTES = new Set([CFG.weth, ...(process.env.QUOTE_TOKENS || '').split(',').map(norm)]
  .filter(Boolean).map(x => x.toLowerCase()));

const PONS_LAUNCHED = '0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607';
const PONS_GRADUATED = '0x0a44ef75df69c534f43cd6c1aa3ef8983065fe5fe79ef9e79f6494e6f258c259';
const V4_INIT_TOPIC = '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438';
const V4_INIT = parseAbiItem('event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)');
const V3_POOL_CREATED = parseAbiItem('event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)');
const CURVE_BUY = parseAbiItem('event CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)');
const CURVE_SELL = parseAbiItem('event CurveSell(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax)');

const client = createPublicClient({
  chain: { id: CFG.chainId, name: 'Robinhood Chain',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [CFG.rpcUrl] } } },
  transport: viemHttp(CFG.rpcUrl, { timeout: 15000, retryCount: 1 }),
});

const state = {
  startedAt:new Date().toISOString(),lastBlock:null,lastPollAt:null,lastHeartbeatAt:null,
  lastEventAt:null,eventsSeen:0,webhookOk:0,webhookFail:0,queueWrites:0,queueErrors:0,
  rawOutbox:0,lastError:null,cursorSource:null,cursorSavedAt:null,
  curveRegistry:0,curveFirstSwapCaptured:0,lastCurveFirstSwap:null,
};
const seen = new Map(), rawOutbox = [];
const curveRegistry = new Map();
const blockTimeCache = new Map();
let rawWebhookActive = 0, queueWriteTail = Promise.resolve();

function norm(v){const s=String(v||'').trim();return /^0x[a-fA-F0-9]{40}$/.test(s)?s:''}
function topicAddress(t){return t&&t.length===66?norm('0x'+t.slice(26)):''}
function isQuote(a){return a&&QUOTES.has(a.toLowerCase())}
function tokenFromPair(a,b){if(isQuote(a)&&!isQuote(b))return b;if(isQuote(b)&&!isQuote(a))return a;return ''}
function hexBlock(n){return '0x'+BigInt(n).toString(16)}
function blockNum(v){try{return Number(BigInt(v||0))}catch{return 0}}
function logIndex(v){try{return Number(BigInt(v||0))}catch{return 0}}
function deDupeKey(p){return [p.stage,p.tokenCa,p.pool,p.txHash].filter(Boolean).join('|').toLowerCase()}
function shouldEmit(p){
  const k=deDupeKey(p);if(!k)return true;
  const now=Date.now(),prev=seen.get(k)||0;if(now-prev<15*60*1000)return false;
  seen.set(k,now);
  if(seen.size>5000)for(const [key,ts] of seen)if(now-ts>6*60*60*1000)seen.delete(key);
  return true;
}
function registerCurve({curve,token,launchAt='',launchBlock=null,pairToken=''}){
  const c=norm(curve),t=norm(token);if(!c||!t)return false;
  const key=c.toLowerCase();
  if(!curveRegistry.has(key))curveRegistry.set(key,{curve:c,token:t,launchAt,pairToken,launchBlock});
  else {
    const old=curveRegistry.get(key);
    curveRegistry.set(key,{...old,curve:c,token:t,launchAt:launchAt||old.launchAt,pairToken:pairToken||old.pairToken,launchBlock:launchBlock??old.launchBlock});
  }
  state.curveRegistry=curveRegistry.size;return true;
}
function primeCurveRegistry(){
  ensureCurveFirstSwapSchema();
  const rows=loadPendingCurveRegistry(5000);
  for(const r of rows)registerCurve({curve:r.curve_address,token:r.token_address,launchAt:r.launch_at||'',launchBlock:r.launch_block,pairToken:r.quote_token||''});
  console.log('[curve-registry]',JSON.stringify({mode:'centralized',loaded:rows.length,active:curveRegistry.size,batchSize:CFG.curveBatchSize}));
}
async function blockEventTime(blockNumber){
  const n=blockNum(blockNumber);if(!n)return new Date().toISOString();
  if(blockTimeCache.has(n))return blockTimeCache.get(n);
  try{
    const b=await client.getBlock({blockNumber:BigInt(n)});
    const iso=new Date(Number(b.timestamp)*1000).toISOString();
    blockTimeCache.set(n,iso);
    if(blockTimeCache.size>1000)blockTimeCache.delete(blockTimeCache.keys().next().value);
    return iso;
  }catch{return new Date().toISOString()}
}

async function postWebhook(payload){
  if(CFG.dryRun||!CFG.webhookUrl||!CFG.webhookSecret){
    console.log('[event]',JSON.stringify({...payload,webhook:CFG.dryRun?'dry-run':'not-configured'}));
    return;
  }
  try{
    const r=await fetch(CFG.webhookUrl,{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({...payload,secret:CFG.webhookSecret}),signal:AbortSignal.timeout(20000)});
    const t=await r.text();let j=null;try{j=JSON.parse(t)}catch{}
    if(!r.ok||j?.ok===false)throw new Error(`webhook ${r.status}: ${t.slice(0,200)}`);
    state.webhookOk++;
  }catch(e){
    state.webhookFail++;state.lastError=String(e?.message||e);
    if(state.webhookFail<=5||state.webhookFail%25===0)console.error('[webhook]',state.lastError,`fail=${state.webhookFail}`);
  }
}
function pumpRawWebhooks(){
  while(rawWebhookActive<2&&rawOutbox.length){
    const p=rawOutbox.shift();rawWebhookActive++;state.rawOutbox=rawOutbox.length;
    postWebhook(p).finally(()=>{rawWebhookActive--;state.rawOutbox=rawOutbox.length;setImmediate(pumpRawWebhooks)});
  }
}
function enqueueRawWebhook(p){
  if(rawOutbox.length>=5000){rawOutbox.shift();console.error('[webhook] outbox full; dropped oldest')}
  rawOutbox.push(p);state.rawOutbox=rawOutbox.length;pumpRawWebhooks();
}
function appendEnrichmentQueue(p){
  if(!CFG.legacyEnricher)return Promise.resolve();
  const item={source:p.source||'Robinhood Chain',firstSeen:p.firstSeen||new Date().toISOString(),
    lastUpdate:p.lastUpdate||new Date().toISOString(),stage:p.stage||'',tokenCa:p.tokenCa||'',
    pool:p.pool||'',deployer:p.deployer||'',pairToken:p.pairToken||'',pairType:p.pairType||'',
    txHash:p.txHash||'',block:Number(p.block||0),notes:p.notes||''};
  if(!item.tokenCa)return Promise.resolve();
  queueWriteTail=queueWriteTail.then(()=>appendFile(CFG.enrichQueuePath,JSON.stringify(item)+'\n','utf8'))
    .then(()=>{state.queueWrites++}).catch(e=>{state.queueErrors++;state.lastError=`queue: ${e.message}`;console.error('[queue]',e.message)});
  return queueWriteTail;
}
async function emit(p){
  if(!shouldEmit(p))return;
  state.eventsSeen++;state.lastEventAt=new Date().toISOString();
  const event={source:p.source||'Robinhood Chain',firstSeen:p.firstSeen||new Date().toISOString(),
    lastUpdate:new Date().toISOString(),...p};
  await appendEnrichmentQueue(event);enqueueRawWebhook(event);
}
function baseLogPayload(l){return{block:blockNum(l.blockNumber),txHash:l.transactionHash||'',firstSeen:new Date().toISOString()}}

async function handlePons(log,topic0){
  if(topic0===PONS_LAUNCHED){
    const token=topicAddress(log.topics?.[1]),curve=topicAddress(log.topics?.[2]),deployer=topicAddress(log.topics?.[3]);
    if(!token)return;
    let pairToken='';try{pairToken=norm(decodeAbiParameters([{type:'address'},{type:'uint256'},{type:'uint256'}],log.data||'0x')?.[0])}catch{}
    const launchAt=await blockEventTime(log.blockNumber);
    registerCurve({curve,token,launchAt,launchBlock:blockNum(log.blockNumber),pairToken});
    console.log('[launch]',JSON.stringify({token,curve,block:blockNum(log.blockNumber),chainTime:launchAt,tx:log.transactionHash||''}));
    await emit({...baseLogPayload(log),firstSeen:launchAt,chainTime:launchAt,source:'Pons V2',stage:'TokenLaunched',tokenCa:token,pool:curve,
      deployer,pairToken,pairType:isQuote(pairToken)?'Quote':'',enrichment:'raw-chain'});
  }else if(topic0===PONS_GRADUATED){
    const token=topicAddress(log.topics?.[1]);if(!token)return;
    await emit({...baseLogPayload(log),source:'Pons V2',stage:'PoolGraduated',tokenCa:token,enrichment:'raw-chain'});
  }
}
async function handleV4(log){
  try{
    const d=decodeEventLog({abi:[V4_INIT],data:log.data,topics:log.topics});
    const a=norm(d.args.currency0),b=norm(d.args.currency1),token=tokenFromPair(a,b);
    if(!token)return;const quote=isQuote(a)?a:b;
    await emit({...baseLogPayload(log),source:'Uniswap V4',stage:'V4 PoolInitialized',tokenCa:token,
      pool:String(d.args.id||''),pairToken:quote,pairType:'V4',
      notes:`hook=${d.args.hooks}; fee=${d.args.fee}; tickSpacing=${d.args.tickSpacing}`,enrichment:'raw-chain'});
  }catch(e){console.warn('[v4 decode]',String(e?.message||e))}
}

async function handleCurveFirstSwap(log,direction){
  const key=String(log.address||'').toLowerCase();
  const reg=curveRegistry.get(key);if(!reg)return;
  const chainTime=await blockEventTime(log.blockNumber);
  const detectedAt=new Date().toISOString();
  const event={
    ...baseLogPayload(log),firstSeen:chainTime,chainTime,detectedAt,
    source:'Pons V2',stage:'First Swap',tokenCa:reg.token,pool:reg.curve,
    pairToken:reg.pairToken||'',pairType:'Curve',direction,launchAt:reg.launchAt||'',
    notes:`centralized Curve${direction==='buy'?'Buy':'Sell'} first real trade`,enrichment:'raw-chain',
  };
  const saved=persistCurveFirstSwap(event);
  if(!saved?.inserted){curveRegistry.delete(key);state.curveRegistry=curveRegistry.size;return}
  state.curveFirstSwapCaptured++;
  state.lastCurveFirstSwap={token:reg.token,curve:reg.curve,direction,block:blockNum(log.blockNumber),tx:log.transactionHash||'',chainTime,detectedAt,launchAt:reg.launchAt||'',launchToSwapSec:saved.launchToSwapSec};
  curveRegistry.delete(key);state.curveRegistry=curveRegistry.size;
  console.log('[curve-first-swap]',JSON.stringify(state.lastCurveFirstSwap));
  await emit(event);
}

async function scanCombined(fromBlock,toBlock){
  const addresses=[CFG.ponsV2Factory,CFG.v4PoolManager].filter(Boolean).map(getAddress);
  const logs=await client.request({method:'eth_getLogs',params:[{
    address:addresses,
    topics:[[PONS_LAUNCHED,PONS_GRADUATED,V4_INIT_TOPIC]],
    fromBlock:hexBlock(fromBlock),toBlock:hexBlock(toBlock)
  }]});
  const pons=CFG.ponsV2Factory.toLowerCase(),v4=CFG.v4PoolManager.toLowerCase();
  for(const log of logs){
    const a=String(log.address||'').toLowerCase(),t=String(log.topics?.[0]||'').toLowerCase();
    if(a===pons)await handlePons(log,t);
    else if(a===v4&&t===V4_INIT_TOPIC)await handleV4(log);
  }
}
async function scanCurveTrades(fromBlock,toBlock){
  if(!curveRegistry.size)return;
  const addresses=[...curveRegistry.values()].map(x=>x.curve);
  for(let i=0;i<addresses.length;i+=CFG.curveBatchSize){
    const batch=addresses.slice(i,i+CFG.curveBatchSize).map(getAddress);
    const [buys,sells]=await Promise.all([
      client.getLogs({address:batch,event:CURVE_BUY,fromBlock:BigInt(fromBlock),toBlock:BigInt(toBlock)}),
      client.getLogs({address:batch,event:CURVE_SELL,fromBlock:BigInt(fromBlock),toBlock:BigInt(toBlock)}),
    ]);
    const events=[
      ...buys.map(log=>({log,direction:'buy'})),
      ...sells.map(log=>({log,direction:'sell'})),
    ].sort((a,b)=>blockNum(a.log.blockNumber)-blockNum(b.log.blockNumber)||logIndex(a.log.logIndex)-logIndex(b.log.logIndex));
    for(const e of events)await handleCurveFirstSwap(e.log,e.direction);
  }
}
async function scanV3(fromBlock,toBlock){
  if(!CFG.v3Factory)return;
  const logs=await client.getLogs({address:getAddress(CFG.v3Factory),event:V3_POOL_CREATED,fromBlock:BigInt(fromBlock),toBlock:BigInt(toBlock)});
  for(const log of logs)try{
    const d=decodeEventLog({abi:[V3_POOL_CREATED],data:log.data,topics:log.topics});
    const a=norm(d.args.token0),b=norm(d.args.token1),token=tokenFromPair(a,b);if(!token)continue;
    const quote=isQuote(a)?a:b;
    await emit({...baseLogPayload(log),source:'Uniswap V3',stage:'V3 PoolCreated',tokenCa:token,
      pool:norm(d.args.pool),pairToken:quote,pairType:'V3',
      notes:`fee=${d.args.fee}; tickSpacing=${d.args.tickSpacing}`,enrichment:'raw-chain'});
  }catch(e){console.warn('[v3 decode]',String(e?.message||e))}
}
async function scanRange(fromBlock,toBlock){
  try{await scanCombined(fromBlock,toBlock)}
  catch(e){state.lastError=`combined: ${String(e?.message||e)}`;console.error('[scan]',state.lastError);
    if(state.lastError.includes('429'))await new Promise(r=>setTimeout(r,4000))}
  try{await scanCurveTrades(fromBlock,toBlock)}
  catch(e){state.lastError=`curve-first-swap: ${String(e?.message||e)}`;console.error('[scan]',state.lastError)}
  if(CFG.v3Factory)try{await scanV3(fromBlock,toBlock)}
  catch(e){state.lastError=`v3: ${String(e?.message||e)}`;console.error('[scan]',state.lastError)}
}

function heartbeat(){
  state.lastHeartbeatAt=new Date().toISOString();
  if(rawOutbox.length>50)return;
  enqueueRawWebhook({kind:'heartbeat',heartbeat:state.lastHeartbeatAt,latestBlock:state.lastBlock,
    provider:'Robinhood RPC polling',listeners:{'Pons V2':Boolean(CFG.ponsV2Factory),
      'Pons Curve First Swap':'centralized','Uniswap V4':Boolean(CFG.v4PoolManager),'Uniswap V3':Boolean(CFG.v3Factory)}});
}

async function mainLoop(){
  primeCurveRegistry();
  let latest=await client.getBlockNumber();
  const saved=loadScannerCursor(CFG.scannerName);
  let cursor;
  if(saved?.lastBlock>0&&BigInt(saved.lastBlock)<=latest){
    const reorg=BigInt(CFG.reorgBlocks);
    cursor=BigInt(saved.lastBlock)>reorg?BigInt(saved.lastBlock)-reorg:0n;
    state.cursorSource='sqlite';
    saveScannerCursor(CFG.scannerName,saved.lastBlock,Number(latest),{resumed:true});
  }else{
    cursor=latest>BigInt(CFG.backfillBlocks)?latest-BigInt(CFG.backfillBlocks):0n;
    state.cursorSource='startup-backfill';
  }
  state.lastBlock=Number(cursor);
  console.log('[boot]',JSON.stringify({version:'2.4.0',scanMode:'combined-log-filter+centralized-curve-first-swap',chainId:CFG.chainId,
    rpc:CFG.rpcUrl,pollMs:CFG.pollMs,backfillBlocks:CFG.backfillBlocks,reorgBlocks:CFG.reorgBlocks,
    cursorSource:state.cursorSource,savedCursor:saved?.lastBlock||null,startCursor:Number(cursor),
    webhookConfigured:Boolean(CFG.webhookUrl&&CFG.webhookSecret),dryRun:CFG.dryRun,
    legacyEnricher:CFG.legacyEnricher,ponsV2Factory:CFG.ponsV2Factory,v4PoolManager:CFG.v4PoolManager,
    v3Factory:CFG.v3Factory||null,curveRegistry:curveRegistry.size,curveBatchSize:CFG.curveBatchSize,quoteTokens:[...QUOTES]}));
  while(true){
    try{
      latest=await client.getBlockNumber();state.lastPollAt=new Date().toISOString();
      if(latest>cursor){
        let from=cursor+1n;
        while(from<=latest){
          const to=from+1999n<latest?from+1999n:latest;
          await scanRange(from,to);cursor=to;state.lastBlock=Number(cursor);from=to+1n;
          try{
            const c=saveScannerCursor(CFG.scannerName,Number(cursor),Number(latest));
            state.cursorSavedAt=c?.updatedAt||new Date().toISOString();
          }catch(e){
            state.lastError=`cursor: ${String(e?.message||e)}`;
            console.error('[cursor]',state.lastError);
          }
        }
      }
    }catch(e){state.lastError=String(e?.message||e);console.error('[poll]',state.lastError);
      if(state.lastError.includes('429')||/rate limit/i.test(state.lastError))await new Promise(r=>setTimeout(r,5000))}
    await new Promise(r=>setTimeout(r,CFG.pollMs));
  }
}

const server=http.createServer((req,res)=>{
  if(req.url==='/health'){
    let curveHealth=null;try{curveHealth=getCurveFirstSwapHealth()}catch(e){curveHealth={error:String(e?.message||e)}}
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({ok:true,service:'rh-newcoin-scanner',version:'2.4.0',...state,
      scannerName:CFG.scannerName,legacyEnricher:CFG.legacyEnricher,curveMode:'centralized',curveHealth,
      webhookConfigured:Boolean(CFG.webhookUrl&&CFG.webhookSecret),dryRun:CFG.dryRun}));return;
  }
  res.writeHead(404,{'content-type':'application/json'});res.end(JSON.stringify({ok:false,error:'not_found'}));
});
server.listen(CFG.port,'0.0.0.0',()=>console.log(`[health] listening on :${CFG.port}`));
setInterval(heartbeat,CFG.heartbeatMs).unref();heartbeat();
mainLoop().catch(e=>{console.error('[fatal]',e);process.exitCode=1});