// Development-only, in-memory JSON-RPC chain. No connection to Base or real funds.
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { Hardfork, Mainnet, createCustomCommon } from '@ethereumjs/common';
import { createVM, runTx } from '@ethereumjs/vm';
import { createBlock } from '@ethereumjs/block';
import { createTxFromRLP } from '@ethereumjs/tx';
import { createAccount, createAddressFromString, hexToBytes, bytesToHex } from '@ethereumjs/util';
import { HDNodeWallet, keccak256, toUtf8Bytes } from 'ethers';
const hex = value => '0x' + BigInt(value).toString(16), zero = '0x' + '0'.repeat(64);
export async function localChain() {
  const common = createCustomCommon({ chainId: 31337 }, Mainnet, { hardfork: Hardfork.Cancun });
  const vm = await createVM({ common }), accounts = Array.from({ length: 5 }, (_, index) => HDNodeWallet.fromPhrase('test test test test test test test test test test test junk', undefined, `m/44'/60'/0'/0/${index}`));
  for (const account of accounts) await vm.stateManager.putAccount(createAddressFromString(account.address), createAccount({ balance: 10n ** 24n }));
  let height = 0, timestamp = Math.floor(Date.now() / 1000), queue = Promise.resolve();
  const receipts = new Map(), transactions = new Map();
  const blockHash = number => keccak256(toUtf8Bytes('llmesh-local:' + number));
  const block = () => createBlock({ header: { number: BigInt(height), timestamp: BigInt(timestamp), gasLimit: 30000000n, baseFeePerGas: 1n } }, { common });
  const address = value => createAddressFromString(value ?? accounts[0].address);
  async function call(transaction) {
    await vm.stateManager.checkpoint();
    try {
      const result = await vm.evm.runCall({ to: transaction.to ? address(transaction.to) : undefined, caller: address(transaction.from),
        data: hexToBytes(transaction.data ?? '0x'), value: BigInt(transaction.value ?? 0), gasLimit: 12000000n, block: block() });
      if (result.execResult.exceptionError) { const error = new Error('EVM reverted'); error.data = bytesToHex(result.execResult.returnValue); throw error; }
      return bytesToHex(result.execResult.returnValue);
    } finally { await vm.stateManager.revert(); }
  }
  async function rpc(method, params = []) {
    switch (method) {
      case 'eth_chainId': return hex(31337);
      case 'net_version': return '31337';
      case 'eth_accounts': return accounts.map(account => account.address);
      case 'eth_blockNumber': return hex(height);
      case 'eth_gasPrice': case 'eth_maxPriorityFeePerGas': return hex(1000000000);
      case 'eth_getBalance': return hex((await vm.stateManager.getAccount(address(params[0])))?.balance ?? 0);
      case 'eth_getTransactionCount': return hex((await vm.stateManager.getAccount(address(params[0])))?.nonce ?? 0);
      case 'eth_getCode': return bytesToHex(await vm.stateManager.getCode(address(params[0])));
      case 'eth_call': return call(params[0]);
      case 'eth_estimateGas': await call(params[0]); return hex(12000000);
      case 'eth_getBlockByNumber': {
        const number = params[0] === 'latest' || params[0] === 'pending' ? height : Number(BigInt(params[0]));
        return { hash: blockHash(number), parentHash: number ? blockHash(number - 1) : zero, number: hex(number), timestamp: hex(timestamp),
          nonce: '0x0000000000000000', difficulty: '0x0', gasLimit: hex(30000000), gasUsed: '0x0', miner: '0x' + '0'.repeat(40),
          extraData: '0x', transactions: [], baseFeePerGas: '0x1' };
      }
      case 'eth_sendRawTransaction': {
        const tx = createTxFromRLP(hexToBytes(params[0]), { common }); height++; timestamp++;
        const result = await runTx(vm, { tx, block: block() }); const hash = bytesToHex(tx.hash()), json = tx.toJSON();
        const logs = result.execResult.logs?.map(([logAddress, topics, data], index) => ({ address: bytesToHex(logAddress), topics: topics.map(bytesToHex), data: bytesToHex(data),
          blockNumber: hex(height), blockHash: blockHash(height), transactionHash: hash, transactionIndex: '0x0', logIndex: hex(index), removed: false })) ?? [];
        receipts.set(hash, { transactionHash: hash, blockHash: blockHash(height), blockNumber: hex(height), transactionIndex: '0x0',
          from: tx.getSenderAddress().toString(), to: tx.to?.toString() ?? null, contractAddress: result.createdAddress?.toString() ?? null,
          cumulativeGasUsed: hex(result.totalGasSpent), gasUsed: hex(result.totalGasSpent), effectiveGasPrice: hex(1000000001),
          logsBloom: '0x' + '0'.repeat(512), logs, status: result.execResult.exceptionError ? '0x0' : '0x1', type: hex(tx.type) });
        transactions.set(hash, { ...json, hash, from: tx.getSenderAddress().toString(), to: tx.to?.toString() ?? null,
          input: json.data, gas: json.gasLimit, chainId: hex(31337), blockHash: blockHash(height), blockNumber: hex(height), transactionIndex: '0x0' });
        return hash;
      }
      case 'eth_getTransactionReceipt': return receipts.get(params[0]) ?? null;
      case 'eth_getTransactionByHash': return transactions.get(params[0]) ?? null;
      case 'evm_increaseTime': timestamp += Number(params[0]); return timestamp;
      case 'evm_mine': height++; timestamp++; return '0x0';
      default: throw new Error('Unsupported development RPC: ' + method);
    }
  }
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const part of req) { raw += part; if (raw.length > 2000000) { res.writeHead(413); return res.end(); } }
    try {
      const messages = JSON.parse(raw);
      const handle = async message => {
        const execute = queue.catch(() => {}).then(() => rpc(message.method, message.params)); queue = execute;
        try { return { jsonrpc: '2.0', id: message.id, result: await execute }; }
        catch (error) { return { jsonrpc: '2.0', id: message.id, error: { code: -32000, message: error.message, data: error.data } }; }
      };
      const result = Array.isArray(messages) ? await Promise.all(messages.map(handle)) : await handle(messages);
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result));
    } catch { res.writeHead(400); res.end(); }
  });
  return { server, accounts };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { server, accounts } = await localChain(); server.listen(8545, '127.0.0.1');
  console.log('LOCAL TEST CHAIN ONLY · chain 31337 · http://127.0.0.1:8545 · resets on exit. Never send real funds to these public test keys.');
  console.log(accounts.map(wallet => ({ address: wallet.address, privateKey: wallet.privateKey })));
}
