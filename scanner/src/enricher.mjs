import { open, stat, readFile, writeFile } from 'node:fs/promises';
import {
  createPublicClient, http, parseAbi, parseAbiItem, getAddress, formatUnits,
} from 'viem';

const ZERO='0x0000000000000000000000000000000000000000';
const cfg={
  rpc:process.env.RH_HTTP_URL||'https://rpc.mainnet.chain.robinhood.com',
  webhook:String(process.env.SHEET_WEBHOOK_URL||'').trim(),
  secret:String(process.env.SHEET_INGEST_SECRET||'').trim(),
  factory:(process.env.PONS_V2_FACTORY||'0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e'),
  weth:(process.env.WETH||'0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'),
  chain:process.env.DEXSCREENER_CHAIN_ID||'robinhood',
  blockscout:(process.env.BLOCKSCOUT_API_BASE||'https://robinhoodchain.blockscout.com/api/v2').replace(/\/$/,''),
  bpm:Math.max(30,Number(process.env.BLOCKS_PER_MINUTE||120)),
  poll:Math.max(500,Number(process.env.ENRICH_POLL_MS||1000)),
  queuePath:String(process.env.ENRICH_QUEUE_PATH||'/tmp/rh_enrich_queue.jsonl'),
  offsetPath:String(process.env.ENRICH_OFFSET_PATH||'/tmp/rh_enrich_queue.offset'),
};
const extraQuotes=(process.env.QUOTE_TOKENS||'').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean);
const quotes=new Set([cfg.weth.toLowerCase(),...extraQuotes]);
const delays=[15000,60000,180000,600000];

const buyEvent=parseAbiItem('event CurveBuy(address indexed buyer,address indexed recipient,uint256 quoteIn,uint256 tokensOut,uint256 fee,uint256 tax)');
const sellEvent=parseAbiItem('event CurveSell(address indexed seller,address indexed recipient,uint256 tokensIn,uint256 quoteOut,uint256 fee,uint256 tax)');
const erc20=parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)'
]);
const tokenInfoAbi=parseAbi([
  'struct Socials { string twitter; string telegram; string discord; string website; string farcaster; }',
  'function getTokenInfo() view returns (address tokenDeployer,string tokenLogo,string tokenDescription,Socials tokenSocials)'
]);
const factoryAbi=parseAbi([
  'struct LaunchedToken { address token; address curve; address deployer; address creatorFeeRecipient; address pairToken; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps; bool buybackEnabled; uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; bool exists; }',
  'function getLaunchedToken(address token) view returns (LaunchedToken)'
]);
const curveAbi=parseAbi([
  'function getReserves() view returns (uint256 quoteReserve,uint256 tokenReserve)',
  'function realQuoteReserve() view returns (uint256)',
  'function graduationThreshold() view returns (uint256)'
]);

const client=createPublicClient({
  chain:{
    id:4663,name:'Robinhood Chain',
    nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},
    rpcUrls:{default:{http:[cfg.rpc]}}
  },
  transport:http(cfg.rpc,{timeout:15000,retryCount:1})
});

const q=new Map(),priceCache=new Map(),decimalsCache=new Map();
let offset=0,lastBlock=0;

const addr=x=>/^0x[a-fA-F0-9]{40}$/.test(String(x||''))?String(x):'';
const native=x=>!x||String(x).toLowerCase()===ZERO;
const phaseName=n=>['Curve','Swept','PoolCreated','Rescued'][Number(n)]||`Phase${n}`;
const num=(x,d)=>{try{return Number(formatUnits(BigInt(x),d))}catch{return null}};

async function read(address,abi,functionName,args=[]){
  try{return await client.readContract({address:getAddress(address),abi,functionName,args})}
  catch{return null}
}
async function json(url,ms=6000){
  try{
    const r=await fetch(url,{
      headers:{accept:'application/json','user-agent':'rh-chain-monitor-enricher/2.2'},
      signal:AbortSignal.timeout(ms)
    });
    return r.ok?await r.json():null
  }catch{return null}
}
async function post(p){
  if(!cfg.webhook||!cfg.secret)return false;
  try{
    const r=await fetch(cfg.webhook,{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({...p,secret:cfg.secret}),signal:AbortSignal.timeout(25000)
    });
    const t=await r.text();let j=null;try{j=JSON.parse(t)}catch{}
    if(!r.ok||j?.ok===false)throw new Error(`${r.status}:${t.slice(0,150)}`);
    return true
  }catch(e){console.error('[enrich webhook]',e.message);return false}
}
async function dexPairs(token){
  const d=await json(`https://api.dexscreener.com/token-pairs/v1/${cfg.chain}/${token}`);
  return Array.isArray(d)?d:[]
}
const bestPair=a=>[...a].sort((x,y)=>Number(y?.liquidity?.usd||0)-Number(x?.liquidity?.usd||0))[0]||null;

async function quoteUsd(quote){
  const k=native(quote)?'eth':String(quote).toLowerCase(),c=priceCache.get(k);
  if(c&&Date.now()-c.t<60000)return c.p;
  let p=null;
  if(native(quote)||k===cfg.weth.toLowerCase()){
    const d=await json('https://api.coinbase.com/v2/prices/ETH-USD/spot',5000),n=Number(d?.data?.amount);
    if(n>0)p=n
  }
  if(!p&&!native(quote)){
    const b=bestPair(await dexPairs(quote)),n=Number(b?.priceUsd);
    if(n>0)p=n
  }
  if(p)priceCache.set(k,{p,t:Date.now()});
  return p
}
async function holders(token){
  const d=await json(`${cfg.blockscout}/tokens/${token}/counters`,5000);
  const n=Number(d?.token_holders_count??d?.holders_count);
  return Number.isFinite(n)?n:null
}
async function quoteDecimals(quote){
  if(native(quote))return 18;
  const k=String(quote).toLowerCase();
  if(decimalsCache.has(k))return decimalsCache.get(k);
  const d=await read(quote,erc20,'decimals');
  const out=d==null?null:Number(d);
  if(out!=null)decimalsCache.set(k,out);
  return out
}

function enqueue(x,fast=false){
  const token=addr(x.token);if(!token)return;
  const k=token.toLowerCase(),old=q.get(k),now=Date.now();
  q.set(k,{
    token,source:x.source||old?.source||'Robinhood Chain',
    stage:x.stage||old?.stage||'',pool:x.pool||old?.pool||'',
    curve:x.curve||old?.curve||'',pairToken:x.pairToken||old?.pairToken||'',
    deployer:x.deployer||old?.deployer||'',block:Number(x.block||old?.block||0),
    firstSeen:old?.firstSeen||x.firstSeen||new Date().toISOString(),
    born:old?.born||now,attempt:old?.attempt||0,
    next:Math.min(old?.next??Infinity,now+(fast?3000:delays[0])),
    promising:old?.promising||false,
  })
}

async function loadOffset(){
  try{
    const n=Number(String(await readFile(cfg.offsetPath,'utf8')).trim());
    return Number.isFinite(n)&&n>=0?n:0
  }catch{return 0}
}
async function saveOffset(){
  try{await writeFile(cfg.offsetPath,String(offset),'utf8')}
  catch(e){console.error('[queue offset]',e.message)}
}
async function consumeQueue(){
  let s;try{s=await stat(cfg.queuePath)}catch{return 0}
  if(s.size<offset){offset=0;await saveOffset()}
  if(s.size<=offset)return 0;
  const maxRead=Math.min(s.size-offset,1024*1024);
  const fh=await open(cfg.queuePath,'r');
  const buf=Buffer.alloc(maxRead);
  let bytesRead=0;
  try{({bytesRead}=await fh.read(buf,0,maxRead,offset))}
  finally{await fh.close()}
  if(!bytesRead)return 0;
  const text=buf.subarray(0,bytesRead).toString('utf8'),cut=text.lastIndexOf('\n');
  if(cut<0)return 0;
  const complete=text.slice(0,cut);
  offset+=Buffer.byteLength(text.slice(0,cut+1),'utf8');
  await saveOffset();

  let accepted=0;
  for(const line of complete.split('\n')){
    if(!line.trim())continue;
    try{
      const p=JSON.parse(line),token=addr(p.tokenCa||p.token);
      if(!token)continue;
      const stage=String(p.stage||''),isPons=String(p.source||'').includes('Pons');
      enqueue({
        token,source:p.source||'Robinhood Chain',stage,pool:p.pool||'',
        curve:isPons&&stage==='TokenLaunched'?addr(p.pool):'',
        pairToken:p.pairToken||'',deployer:p.deployer||'',
        block:Number(p.block||0),firstSeen:p.firstSeen||''
      },/Graduated|PoolInitialized|PoolCreated|V3|V4/.test(stage));
      lastBlock=Math.max(lastBlock,Number(p.block||0));
      accepted++
    }catch(e){console.error('[queue parse]',e.message)}
  }
  return accepted
}

async function stats(curve,launchBlock,latest,decimals,usd){
  if(!curve||decimals==null||!latest)return null;
  const hour=BigInt(cfg.bpm*60),minute=BigInt(cfg.bpm),end=BigInt(latest);
  const launch=BigInt(launchBlock||0),start=launch>end-hour?launch:end-hour,from=start>0n?start:0n;
  let logs;
  try{
    logs=await client.getLogs({address:getAddress(curve),events:[buyEvent,sellEvent],fromBlock:from,toBlock:end})
  }catch{return null}
  let b1=0,s1=0,v1=0n,bh=0n,sh=0n,first=null;
  const traders=new Set(),mstart=end>minute?end-minute:0n;
  for(const l of logs){
    const bn=BigInt(l.blockNumber||0);
    if(first==null||bn<first)first=bn;
    if(l.eventName==='CurveBuy'){
      const z=BigInt(l.args?.quoteIn||0);bh+=z;
      if(bn>=mstart){b1++;v1+=z}
      if(l.args?.buyer)traders.add(String(l.args.buyer).toLowerCase())
    }else if(l.eventName==='CurveSell'){
      const z=BigInt(l.args?.quoteOut||0);sh+=z;
      if(bn>=mstart){s1++;v1+=z}
      if(l.args?.seller)traders.add(String(l.args.seller).toLowerCase())
    }
  }
  let firstTrade='';
  if(first!=null)try{
    const b=await client.getBlock({blockNumber:first});
    firstTrade=new Date(Number(b.timestamp)*1000).toISOString()
  }catch{}
  const v=num(v1,decimals),bu=num(bh,decimals),se=num(sh,decimals);
  return{
    buys1m:b1,sells1m:s1,volume1m:usd&&v!=null?v*usd:null,
    buyUsd1h:usd&&bu!=null?bu*usd:null,sellUsd1h:usd&&se!=null?se*usd:null,
    uniqueTraders:traders.size,firstTrade,trades:logs.length
  }
}

async function enrich(it,latest){
  const token=getAddress(it.token);
  const [symbol,td,launch]=await Promise.all([
    read(token,erc20,'symbol'),read(token,erc20,'decimals'),
    read(cfg.factory,factoryAbi,'getLaunchedToken',[token])
  ]);
  const pons=Boolean(launch?.exists),phase=pons?Number(launch.phase):null;
  const curve=pons?addr(launch.curve):it.curve;
  const pairToken=pons?(addr(launch.pairToken)||ZERO):(it.pairToken||ZERO);
  const deployer=pons?addr(launch.deployer):it.deployer;
  const pairPromise=dexPairs(token);
  const qd=await quoteDecimals(pairToken),qusd=await quoteUsd(pairToken);
  const notes=[],risk=[];
  let price='',lp='',progress=null,reserveUsd=null;
  const fee=pons?Number(launch.poolFee??0):null;
  const tax=pons?Number(launch.creatorTaxBps??0):null;
  const buyback=pons?Boolean(launch.buybackEnabled):null;

  if(pons){
    risk.push('PonsV2标准合约');
    if(phase===3)risk.push('🔴 Rescued阶段');
    if(!native(pairToken)&&!quotes.has(pairToken.toLowerCase()))risk.push('⚠️自定义配对资产')
  }
  let desc='';
  if(pons&&it.attempt>=1){
    const info=await read(token,tokenInfoAbi,'getTokenInfo');
    if(info)desc=String(info[2]||'').slice(0,120)
  }

  if(curve&&phase===0){
    const real=await read(curve,curveAbi,'realQuoteReserve');
    const th=launch?.graduationThreshold??await read(curve,curveAbi,'graduationThreshold');
    if(real!=null&&th!=null&&BigInt(th)>0n){
      progress=Number(real)/Number(th);
      const x=num(real,qd);if(x!=null&&qusd)reserveUsd=x*qusd
    }
    if(it.attempt>=1){
      const r=await read(curve,curveAbi,'getReserves');
      if(r&&td!=null&&qd!=null&&qusd){
        const a=num(r[0],qd),b=num(r[1],Number(td));
        if(a!=null&&b>0)price=a/b*qusd
      }
    }
  }

  if(tax>=800)risk.push(`⚠️高CreatorTax ${(tax/100).toFixed(1)}%`);
  else if(tax>=300)risk.push(`CreatorTax ${(tax/100).toFixed(1)}%`);

  let s=null;
  if(curve&&phase===0&&it.attempt>=1&&(it.attempt<=2||it.promising)){
    s=await stats(curve,it.block,latest,qd,qusd)
  }

  const pair=bestPair(await pairPromise);
  if(pair){
    const p=Number(pair.priceUsd),l=Number(pair?.liquidity?.usd);
    if(p>0)price=p;if(Number.isFinite(l))lp=l;
    notes.push(`DEX=${pair.dexId||'?'}:${pair.pairAddress||'?'}`);
    const vv=Number(pair?.volume?.m5);if(Number.isFinite(vv))notes.push(`DS5mVol=$${Math.round(vv)}`)
  }

  const hc=it.attempt>=1?await holders(token):null;
  if(phase!=null)notes.push(`phase=${phaseName(phase)}`);
  if(progress!=null)notes.push(`curve=${(progress*100).toFixed(1)}%`);
  if(reserveUsd!=null)notes.push(`curveReserve=$${Math.round(reserveUsd)}`);
  if(fee!=null)notes.push(`poolFee=${fee}`);
  if(tax!=null)notes.push(`creatorTax=${(tax/100).toFixed(2)}%`);
  if(buyback!=null)notes.push(`buyback=${buyback?'on':'off'}`);
  if(s)notes.push(`curveTrades=${s.trades}`);
  if(desc)notes.push(`desc=${desc}`);

  const out={
    source:pons?'Pons V2':it.source,firstSeen:it.firstSeen,lastUpdate:new Date().toISOString(),
    stage:phase===2?'PoolGraduated':it.stage,symbol:symbol||'',tokenCa:token,
    pool:curve||it.pool||pair?.pairAddress||'',pairToken,
    pairType:pons?(phase===2?'Pons V2 / V4':(native(pairToken)?'Pons V2 / ETH Curve':'Pons V2 / Custom Curve')):it.stage,
    deployer,block:latest,firstTrade:s?.firstTrade||'',price,lp,
    volume1m:s?.volume1m??'',buys1m:s?.buys1m??'',sells1m:s?.sells1m??'',
    uniqueTraders:s?.uniqueTraders??'',holders:hc??'',
    buyUsd1h:s?.buyUsd1h??'',sellUsd1h:s?.sellUsd1h??'',
    riskFlags:risk.join('｜'),enrichment:'v2.2:queue+onchain+dexscreener+blockscout',
    notes:notes.join('；')
  };
  const activity=(Number(out.volume1m)||0)>=500
    ||((Number(out.buys1m)||0)+(Number(out.sells1m)||0))>=8
    ||(Number(lp)||0)>=10000||(progress??0)>=0.05;
  if(activity)it.promising=true;

  if(await post(out))console.log('[enrich]',JSON.stringify({
    token,symbol:out.symbol,attempt:it.attempt+1,stage:out.stage,price:out.price,
    lp:out.lp,vol1m:out.volume1m,buys:out.buys1m,sells:out.sells1m,
    holders:out.holders,promising:it.promising
  }))
}

async function processQueue(latest){
  const due=[...q.values()].filter(x=>x.next<=Date.now()).sort((a,b)=>a.next-b.next).slice(0,1);
  for(const it of due){
    try{await enrich(it,latest)}
    catch(e){console.error('[enrich]',it.token,e.message)}
    finally{
      it.attempt++;
      const k=it.token.toLowerCase();
      if(it.attempt>=delays.length||(it.attempt>=3&&!it.promising))q.delete(k);
      else{
        it.next=it.born+delays[it.attempt];
        if(it.next<=Date.now())it.next=Date.now()+5000;
        q.set(k,it)
      }
    }
  }
}

async function main(){
  offset=await loadOffset();
  console.log('[enricher boot]',JSON.stringify({
    version:'2.2.0',mode:'local-queue',queue:cfg.queuePath,offset,
    factory:cfg.factory,chain:cfg.chain
  }));
  let lastRpcBlockCheck=0,latest=0;
  while(true){
    try{
      const n=await consumeQueue(),now=Date.now();
      const due=[...q.values()].some(x=>x.next<=now);
      if(due&&(now-lastRpcBlockCheck>5000||!latest)){
        try{latest=Number(await client.getBlockNumber());lastRpcBlockCheck=now}
        catch(e){console.error('[enricher block]',e.message)}
      }
      latest=Math.max(latest,lastBlock);
      if(due&&latest)await processQueue(latest);
      if(n>0)console.log('[queue consume]',JSON.stringify({accepted:n,pending:q.size,offset}))
    }catch(e){console.error('[enricher loop]',e.message)}
    await new Promise(r=>setTimeout(r,cfg.poll))
  }
}
main().catch(e=>{console.error('[enricher fatal]',e);process.exitCode=1});
