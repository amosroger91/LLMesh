import solc from 'solc';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
export function compile() {
  const input = { language: 'Solidity', sources: { 'LLMesh.sol': { content: readFileSync('contracts/LLMesh.sol', 'utf8') } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } };
  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: path => {
    if (!path.startsWith('@openzeppelin/contracts/')) return { error: 'Unsupported import' };
    return { contents: readFileSync(resolve('node_modules', path), 'utf8') };
  } }));
  const errors = output.errors?.filter(error => error.severity === 'error');
  if (errors?.length) throw new Error(errors.map(error => error.formattedMessage).join('\n'));
  return output.contracts['LLMesh.sol'];
}
if (process.argv[1] && resolve(process.argv[1]) === resolve('scripts/compile-contracts.js')) {
  mkdirSync('src/contracts', { recursive: true });
  const compiled = compile();
  for (const name of ['LLMeshToken', 'LLMeshEscrow']) writeFileSync(`src/contracts/${name}.json`, JSON.stringify({ abi: compiled[name].abi, bytecode: '0x' + compiled[name].evm.bytecode.object }, null, 2));
  console.log('Compiled LLMesh token and escrow');
}
