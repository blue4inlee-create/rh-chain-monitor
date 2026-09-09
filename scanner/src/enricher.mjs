import {
  createPublicClient, http, parseAbi, parseAbiItem, decodeEventLog,
  getAddress, formatUnits,
} from 'viem';

const ZERO='0x0000000000000000000000000000000000000000';
const cfg={
  rpc:process.env.RH_HTTP_URL||'https://rpc.mainnet.chain.robinhood.com',
  webhook:String(process.env.SHEET_WEBHOOK_URL||'').trim(),
  secret:String(process.env.SHEET_INGEST_SECRET||'').trim(),
  factory:(process.env.PONS_V2_FACTORY||'0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e'),
  v4:(process.env.UNIV4_POOL_MANAGER||'0x8366a39cc670b4001a1121b8f6a443a643e40951'),
  weth:(process.env.WETH||'0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'),
  chain:process.env.DEXSCREENER_CHAIN_ID||'robinhood',
  blockscout:(process.env.BLOCKSCOUT_API_BASE||'https://robinhoodchain.blockscout.com/api/v2').replace(/\/$/,''),
  bpm:Math.max(30,Number(process.env.BLOCKS_PER_MINUTE||120)),
  poll:Number(process.env.POLL_MS||2000),
};
const extraQuotes=(process.env.QUOTE_TOKENS||'').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean);
const quotes=new Set([cfg.weth.toLowerCase(),...extraQuotes]);
const delays=[15000,60000,180000,600000];

const launchedTopic='0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607';
const graduatedTopic='0x0a44ef75df69c534f43cd6c1aa3ef8983065fe5fe79ef9e79f6494e6f258c259';
const v4Init=parseAbiItem('event Initialize(bytes32 indexed id,address indexed currency0,address indexed currency1,uint24 fee,int24 tickSpacing,address hooks,uint160 sqrtPriceX96,int24 tick)');
const buyEvent=parseAbiItem('event CurveBuy(address indexed buyer,address indexed recipient,uint256 quoteIn,uint256 tokensOut,uint256 fee,uint256 tax)');
const sellEvent=parseAbiItem('event CurveSell(address indexed seller,address indexed recipient,uint256 tokensIn,uint256 quoteOut,uint256 fee,uint256 tax)');
const erc20=parseAbi(['function name() view returns (string)','function symbol() view returns (string)','function decimals() view returns (uint8)']);
const tokenInfoAbi=parseAbi(['struct Socials { string twitter; string telegram; string discord; string website; string farcaster; }','function getTokenInfo() view returns (address tokenDeployer,string tokenLogo,string tokenDescription,Socials tokenSocials)']);
const factoryAbi=parseAbi(['struct LaunchedToken { address token; address curve; address deployer; address creatorFeeRecipient; address pairToken; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps; bool buybackEnabled; uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; bool exists; }','function getLaunchedToken(address token) view returns (LaunchedToken)']);
const curveAbi=parseAbi(['function getReserves() view returns (uint256 quoteReserve,uint256 tokenReserve)','function realQuoteReserve() view returns (uint256)','function graduationThreshold() view returns (uint256)','function feeBps() view returns (uint256)','function creatorTaxBps() view returns (uint256)','function buybackEnabled() view returns (bool)']);

const client=createPublicClient({chain:{id:4663,name:'Robinhood Chain',nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},rpcUrls:{default:{http:[cfg.rpc]}}},transport:http(cfg.rpc,{timeout:15000,retryCount:2})});
const q=new Map(), seen=new Set(), priceCache=new Map();
let cursor=0n;

const addr=x=>/^0x[a-fA-F0-9]{40}$/.test(String(x||''))?String(x):'';
const topicAddr=t=>t?.length===66?addr('0x'+t.slice(26)):'';
const native=x=>!x||String(x).toLowerCase()===ZERO;
const knownQuote=x=>native(x)||quotes.has(String(x).toLowerCase());
const phaseName=n=>['Curve','Swept','PoolCreated','Rescued'][Number(n)]||`Phase${n}`;
const num=(x,d)=>{try{return Number(formatUnits(BigInt(x),d))}catch{return null}};

async function read(address,abi,functionName,args=[]){try{return await client.readContract({address:getAddress(address),abi,functionName,args})}catch{return null}}
async function json(url,ms=6000){try{const r=await fetch(url,{headers:{accept:'application/json','user-agent':'rh-chain-monitor-enricher/2.1'},signal:AbortSignal.timeout(ms)});return r.ok?await r.json():null}catch{return null}}
async function post(p){
  if(!cfg.webhook||!cfg.secret)return false;
  try{const r=await fetch(cfg.webhook,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...p,secret:cfg.secret}),signal:AbortSignal.timeout(20000)});const t=await r.text();let j=null;try{j=JSON.parse(t)}catch{};if(!r.ok||j?.ok===false)throw new Error(`${r.status}:${t.slice(0,150)}`);return true}catch(e){console.error('[enrich webhook]',e.message);return false}
}
async function dexPairs(token){const d=await json(`https://api.dexscreener.com/token-pairs/v1/${cfg.chain}/${token}`);return Array.isArray(d)?d:[]}
const bestPair=a=>[...a].sort((x,y)=>Number(y?.liquidity?.usd||0)-Number(x?.liquidity?.usd||0))[0]||null;
async function quoteUsd(quote){
  const k=native(quote)?'eth':String(quote).toLowerCase(),c=priceCache.get(k);if(c&&Date.now()-c.t<60000)return c.p;
  let p=null;
  if(native(quote)||k===cfg.weth.toLowerCase()){const d=await json('https://api.coinbase.com/v2/prices/ETH-USD/spot',5000),n=Number(d?.data?.amount);if(n>0)p=n}
  if(!p&&!native(quote)){const b=bestPair(await dexPairs(quote)),n=Number(b?.priceUsd);if(n>0)p=n}
  if(p)priceCache.set(k,{p,t:Date.now()});return p;
}
async function holders(token){const d=await json(`${cfg.blockscout}/tokens/${token}/counters`,5000),n=Number(d?.token_holders_count??d?.holders_count);return Number.isFinite(n)?n:null}
async function quoteDecimals(quote){if(native(quote))return 18;const d=await read(quote,erc20,'decimals');return d==null?null:Number(d)}

function enqueue(x,fast=false){
  const token=addr(x.token);if(!token)return;const k=token.toLowerCase(),old=q.get(k),now=Date.now();
  q.set(k,{token,source:x.source||old?.source||'Robinhood Chain',stage:x.stage||old?.stage||'',pool:x.pool||old?.pool||'',curve:x.curve||old?.curve||'',pairToken:x.pairToken||old?.pairToken||'',deployer:x.deployer||old?.deployer||'',block:Number(x.block||old?.block||0),firstSeen:old?.firstSeen||new Date().toISOString(),born:old?.born||now,attempt:old?.attempt||0,next:Math.min(old?.next??Infinity,now+(fast?3000:delays[0]))});
}

async function discover(from,to){
  const logs=await client.getLogs({address:getAddress(cfg.factory),fromBlock:from,toBlock:to});
  for(const l of logs){const t=String(l.topics?.[0]||'').toLowerCase();if(t===launchedTopic){const token=topicAddr(l.topics?.[1]),curve=topicAddr(l.topics?.[2]),deployer=topicAddr(l.topics?.[3]);if(token)enqueue({token,curve,pool:curve,deployer,source:'Pons V2',stage:'TokenLaunched',block:l.blockNumber})}else if(t===graduatedTopic){const token=topicAddr(l.topics?.[1]);if(token)enqueue({token,source:'Pons V2',stage:'PoolGraduated',block:l.blockNumber},true)}}
  const v4logs=await client.getLogs({address:getAddress(cfg.v4),event:v4Init,fromBlock:from,toBlock:to});
  for(const l of v4logs){try{const d=decodeEventLog({abi:[v4Init],data:l.data,topics:l.topics}),a=addr(d.args.currency0)||ZERO,b=addr(d.args.currency1)||ZERO;let token='',quote='';if(knownQuote(a)&&!knownQuote(b)){token=b;quote=a}else if(knownQuote(b)&&!knownQuote(a)){token=a;quote=b}if(token)enqueue({token,pool:String(d.args.id||''),pairToken:quote,source:'Uniswap V4',stage:'V4 PoolInitialized',block:l.blockNumber},true)}catch{}}
}

async function stats(curve,launchBlock,latest,decimals,usd){
  if(!curve||decimals==null)return null;const hour=BigInt(cfg.bpm*60),minute=BigInt(cfg.bpm),end=BigInt(latest),start=BigInt(launchBlock||0)>end-hour?BigInt(launchBlock||0):end-hour,from=start>0n?start:0n;
  let logs;try{logs=await client.getLogs({address:getAddress(curve),events:[buyEvent,sellEvent],fromBlock:from,toBlock:end})}catch{return null}
  let b1=0,s1=0,v1=0n,bh=0n,sh=0n,first=null;const traders=new Set(),mstart=end>minute?end-minute:0n;
  for(const l of logs){const bn=BigInt(l.blockNumber||0);if(first==null||bn<first)first=bn;if(l.eventName==='CurveBuy'){const z=BigInt(l.args?.quoteIn||0);bh+=z;if(bn>=mstart){b1++;v1+=z}if(l.args?.buyer)traders.add(String(l.args.buyer).toLowerCase())}else if(l.eventName==='CurveSell'){const z=BigInt(l.args?.quoteOut||0);sh+=z;if(bn>=mstart){s1++;v1+=z}if(l.args?.seller)traders.add(String(l.args.seller).toLowerCase())}}
  let firstTrade='';if(first!=null)try{const b=await client.getBlock({blockNumber:first});firstTrade=new Date(Number(b.timestamp)*1000).toISOString()}catch{}
  const v=num(v1,decimals),bu=num(bh,decimals),se=num(sh,decimals);return{buys1m:b1,sells1m:s1,volume1m:usd&&v!=null?v*usd:null,buyUsd1h:usd&&bu!=null?bu*usd:null,sellUsd1h:usd&&se!=null?se*usd:null,uniqueTraders:traders.size,firstTrade,trades:logs.length}
}

async function enrich(it,latest){
  const token=getAddress(it.token),[name,symbol,td]=await Promise.all([read(token,erc20,'name'),read(token,erc20,'symbol'),read(token,erc20,'decimals')]);
  const launch=await read(cfg.factory,factoryAbi,'getLaunchedToken',[token]),pons=Boolean(launch?.exists),phase=pons?Number(launch.phase):null,curve=pons?addr(launch.curve):it.curve,pairToken=pons?(addr(launch.pairToken)||ZERO):(it.pairToken||ZERO),deployer=pons?addr(launch.deployer):it.deployer;
  const qd=await quoteDecimals(pairToken),qusd=await quoteUsd(pairToken),notes=[],risk=[];let price='',lp='',progress=null,reserveUsd=null,fee=null,tax=pons?Number(launch.creatorTaxBps):null,buyback=pons?Boolean(launch.buybackEnabled):null;
  if(pons){risk.push('PonsV2标准合约');if(phase===3)risk.push('🔴 Rescued阶段');if(!native(pairToken)&&!quotes.has(pairToken.toLowerCase()))risk.push('⚠️自定义配对资产')}
  let desc='';if(pons){const info=await read(token,tokenInfoAbi,'getTokenInfo');if(info)desc=String(info[2]||'').slice(0,120)}
  if(curve&&phase===0){const [r,real,th,f,t,bb]=await Promise.all([read(curve,curveAbi,'getReserves'),read(curve,curveAbi,'realQuoteReserve'),read(curve,curveAbi,'graduationThreshold'),read(curve,curveAbi,'feeBps'),read(curve,curveAbi,'creatorTaxBps'),read(curve,curveAbi,'buybackEnabled')]);if(f!=null)fee=Number(f);if(t!=null)tax=Number(t);if(bb!=null)buyback=Boolean(bb);if(real!=null&&th!=null&&BigInt(th)>0n){progress=Number(real)/Number(th);const x=num(real,qd);if(x!=null&&qusd)reserveUsd=x*qusd}if(r&&td!=null&&qd!=null&&qusd){const a=num(r[0],qd),b=num(r[1],Number(td));if(a!=null&&b>0)price=a/b*qusd}}
  if(tax>=800)risk.push(`⚠️高CreatorTax ${(tax/100).toFixed(1)}%`);else if(tax>=300)risk.push(`CreatorTax ${(tax/100).toFixed(1)}%`);
  const s=curve&&phase===0?await stats(curve,it.block,latest,qd,qusd):null,pair=bestPair(await dexPairs(token));if(pair){const p=Number(pair.priceUsd),l=Number(pair?.liquidity?.usd);if(p>0)price=p;if(Number.isFinite(l))lp=l;notes.push(`DEX=${pair.dexId||'?'}:${pair.pairAddress||'?'}`);const vv=Number(pair?.volume?.m5);if(Number.isFinite(vv))notes.push(`DS5mVol=$${Math.round(vv)}`)}
  const hc=it.attempt>=1?await holders(token):null;if(phase!=null)notes.push(`phase=${phaseName(phase)}`);if(progress!=null)notes.push(`curve=${(progress*100).toFixed(1)}%`);if(reserveUsd!=null)notes.push(`curveReserve=$${Math.round(reserveUsd)}`);if(fee!=null)notes.push(`fee=${(fee/100).toFixed(2)}%`);if(tax!=null)notes.push(`creatorTax=${(tax/100).toFixed(2)}%`);if(buyback!=null)notes.push(`buyback=${buyback?'on':'off'}`);if(s)notes.push(`curveTrades=${s.trades}`);if(desc)notes.push(`desc=${desc}`);
  const out={source:pons?'Pons V2':it.source,firstSeen:it.firstSeen,lastUpdate:new Date().toISOString(),stage:phase===2?'PoolGraduated':it.stage,symbol:symbol||'',tokenCa:token,pool:curve||it.pool||pair?.pairAddress||'',pairToken,pairType:pons?(phase===2?'Pons V2 / V4':(native(pairToken)?'Pons V2 / ETH Curve':'Pons V2 / Custom Curve')):it.stage,deployer,block:latest,firstTrade:s?.firstTrade||'',price,lp,volume1m:s?.volume1m??'',buys1m:s?.buys1m??'',sells1m:s?.sells1m??'',uniqueTraders:s?.uniqueTraders??'',holders:hc??'',buyUsd1h:s?.buyUsd1h??'',sellUsd1h:s?.sellUsd1h??'',riskFlags:risk.join('｜'),enrichment:'v2.1:onchain+curve+dexscreener+blockscout',notes:notes.join('；')};
  if(await post(out))console.log('[enrich]',JSON.stringify({token,symbol:out.symbol,attempt:it.attempt+1,stage:out.stage,price:out.price,lp:out.lp,vol1m:out.volume1m,buys:out.buys1m,sells:out.sells1m,holders:out.holders}));
}

async function processQueue(latest){const due=[...q.values()].filter(x=>x.next<=Date.now()).sort((a,b)=>a.next-b.next).slice(0,2);await Promise.all(due.map(async it=>{try{await enrich(it,latest)}catch(e){console.error('[enrich]',it.token,e.message)}finally{it.attempt++;const k=it.token.toLowerCase();if(it.attempt>=delays.length)q.delete(k);else{it.next=it.born+delays[it.attempt];if(it.next<=Date.now())it.next=Date.now()+5000;q.set(k,it)}}}))}

async function main(){let latest=await client.getBlockNumber();cursor=latest>120n?latest-120n:0n;console.log('[enricher boot]',JSON.stringify({version:'2.1.0',factory:cfg.factory,v4:cfg.v4,chain:cfg.chain}));while(true){try{latest=await client.getBlockNumber();if(latest>cursor){let from=cursor+1n;while(from<=latest){const to=from+999n<latest?from+999n:latest;await discover(from,to);cursor=to;from=to+1n}}await processQueue(Number(latest))}catch(e){console.error('[enricher loop]',e.message)}await new Promise(r=>setTimeout(r,cfg.poll))}}
main().catch(e=>{console.error('[enricher fatal]',e);process.exitCode=1});
