import { Common, Hardfork, Mainnet } from '@ethereumjs/common';
import { createLegacyTx } from '@ethereumjs/tx';
import { createAccount, createAddressFromString, createAddressFromPrivateKey, hexToBytes, bytesToHex } from '@ethereumjs/util';
import { createVM, runTx } from '@ethereumjs/vm';
import { createBlock } from '@ethereumjs/block';
import { Interface, Wallet } from 'ethers';

export async function evm() {
  const common = new Common({ chain: Mainnet, hardfork: Hardfork.Cancun }); const vm = await createVM({ common });
  const accounts = Array.from({ length: 4 }, () => Wallet.createRandom());
  for (const account of accounts) await vm.stateManager.putAccount(createAddressFromString(account.address), createAccount({ balance: 10n ** 24n }));
  let timestamp = BigInt(Math.floor(Date.now() / 1000));
  const block = () => createBlock({ header: { number: 1n, timestamp, gasLimit: 30000000n, baseFeePerGas: 1n } }, { common });
  async function transaction(wallet, data, to) {
    const key = hexToBytes(wallet.privateKey), address = createAddressFromPrivateKey(key), account = await vm.stateManager.getAccount(address);
    const tx = createLegacyTx({ nonce: account.nonce, gasLimit: 12000000n, gasPrice: 1000000000n, data: hexToBytes(data),
      to: to ? createAddressFromString(to) : undefined }, { common }).sign(key);
    const result = await runTx(vm, { tx, block: block() });
    if (result.execResult.exceptionError) throw new Error(`EVM reverted: ${result.execResult.exceptionError.error}`);
    return result;
  }
  function contract(artifact, address) {
    const iface = new Interface(artifact.abi);
    return { address, iface,
      send: (wallet, method, args = []) => transaction(wallet, iface.encodeFunctionData(method, args), address),
      async read(method, args = []) {
        await vm.stateManager.checkpoint();
        try {
          const result = await vm.evm.runCall({ to: createAddressFromString(address), caller: createAddressFromString(accounts[0].address),
            data: hexToBytes(iface.encodeFunctionData(method, args)), block: block() });
          if (result.execResult.exceptionError) throw new Error('Read reverted');
          return iface.decodeFunctionResult(method, bytesToHex(result.execResult.returnValue));
        } finally { await vm.stateManager.revert(); }
      }
    };
  }
  return { accounts, chainId: 1,
    async deploy(artifact, args = []) {
      const iface = new Interface(artifact.abi), result = await transaction(accounts[0], '0x' + artifact.evm.bytecode.object + iface.encodeDeploy(args).slice(2));
      return contract(artifact, result.createdAddress.toString());
    }, advance(seconds) { timestamp += BigInt(seconds); }
  };
}
