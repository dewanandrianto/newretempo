import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

void test('default artifact path follows the exported repository, not the working directory', async () => {
  const { parseArgs } = await import('./compass-deploy');
  const previousCwd = process.cwd();
  try {
    process.chdir(fileURLToPath(new URL('../backend/', import.meta.url)));
    const options = parseArgs([
      'SubscriptionManager', '--mode', 'verify', '--blockchain', 'ARC-TESTNET',
      '--compass-chain', 'Arc_Testnet', '--rpc', 'https://rpc.testnet.arc.io',
    ]);
    assert.equal(options.artifactPath, fileURLToPath(new URL('../contracts/out/SubscriptionManager.sol/SubscriptionManager.json', import.meta.url)));
  } finally {
    process.chdir(previousCwd);
  }
});

// Importing the CLI must not require private Arc Studio-only packages or run a deployment.
void test('exported CLI parses Arc Testnet without deployment dependencies', async () => {
  const { parseArgs } = await import('./compass-deploy');
  const options = parseArgs([
    'SubscriptionManager', '--mode', 'verify', '--blockchain', 'ARC-TESTNET',
    '--compass-chain', 'Arc_Testnet', '--rpc', 'https://rpc.testnet.arc.io',
  ]);
  assert.equal(options.mode, 'verify');
  assert.equal(options.rpcUrl, 'https://rpc.testnet.arc.io');
});

void test('Arc chain metadata uses the supported SDK identity and canonical registry explorer', async () => {
  const { resolveChainDef } = await import('./compass-deploy');
  const chain = resolveChainDef('Arc_Testnet');
  assert.equal(chain.chainId, 5042002);
  assert.equal(chain.name, 'Arc Testnet');
  assert.equal(chain.nativeCurrency.symbol, 'USDC');
  assert.equal(chain.nativeCurrency.decimals, 18);
  assert.equal(chain.explorerUrl, 'https://explorer.testnet.arc.io');
});

void test('Base Sepolia retains ETH gas rather than confusing ERC-20 USDC with native currency', async () => {
  const { resolveChainDef } = await import('./compass-deploy');
  const chain = resolveChainDef('Base_Sepolia');
  assert.equal(chain.chainId, 84532);
  assert.equal(chain.nativeCurrency.symbol, 'ETH');
  assert.equal(chain.explorerUrl, 'https://sepolia.basescan.org');
});

void test('SDK-only EVM chains produce address-link bases instead of transaction templates', async () => {
  const { resolveChainDef } = await import('./compass-deploy');
  const chain = resolveChainDef('Linea');
  assert.equal(chain.chainId, 59144);
  assert.equal(chain.explorerUrl, 'https://lineascan.build');
});

void test('chain identifiers remain case-sensitive and non-EVM chains fail closed', async () => {
  const { resolveChainDef } = await import('./compass-deploy');
  for (const id of ['Not_A_Chain', 'arc_testnet', ' Arc_Testnet', 'Arc_Testnet ', 'Solana']) {
    assert.throws(() => resolveChainDef(id), /Unknown --compass-chain/);
  }
});

void test('CLI retains explicit artifact paths and metadata overrides', async () => {
  const { parseArgs } = await import('./compass-deploy');
  const options = parseArgs([
    'SubscriptionManager', '--mode=verify', '--blockchain=ARC-TESTNET',
    '--compass-chain=Arc_Testnet', '--rpc=https://rpc.testnet.arc.io',
    '--artifact=custom/artifact.json', '--gas-token=usdc',
    '--explorer=https://explorer.testnet.arc.io', '--chain-label=Arc Testnet',
  ]);
  assert.equal(options.artifactPath, 'custom/artifact.json');
});

void test('CLI still rejects unknown chains, invalid gas overrides, missing chain flags and unsafe private-key RPC defaults', async () => {
  const { parseArgs } = await import('./compass-deploy');
  const args = ['SubscriptionManager', '--blockchain', 'ARC-TESTNET', '--compass-chain', 'Arc_Testnet', '--rpc', 'https://rpc.testnet.arc.io'];
  assert.throws(() => parseArgs([...args, '--compass-chain=Not_A_Chain']), /Unknown --compass-chain/);
  assert.throws(() => parseArgs([...args, '--gas-token=USDC']), /Invalid --gas-token/);
  assert.throws(() => parseArgs(['SubscriptionManager']), /--blockchain is required/);
  assert.throws(() => parseArgs(['SubscriptionManager', '--blockchain=ARC-TESTNET']), /--compass-chain is required/);
  assert.throws(() => parseArgs([...args.slice(0, -2), '--signer=private-key', '--mode=live']), /--rpc is required for a --signer private-key live deploy/);
});
