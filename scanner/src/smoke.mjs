import { createPublicClient, http } from 'viem';

const rpcUrl = process.env.RH_HTTP_URL || 'https://rpc.mainnet.chain.robinhood.com';
const client = createPublicClient({
  chain: {
    id: 4663,
    name: 'Robinhood Chain',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  },
  transport: http(rpcUrl, { timeout: 15000, retryCount: 2 }),
});

const block = await client.getBlockNumber();
if (block <= 0n) throw new Error('invalid block number');
console.log(JSON.stringify({ ok: true, chainId: 4663, latestBlock: block.toString() }));
