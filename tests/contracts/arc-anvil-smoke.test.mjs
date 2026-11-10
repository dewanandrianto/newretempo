import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, readFile, writeFile, open } from 'node:fs/promises';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createPublicClient, defineChain, encodeFunctionData, encodeDeployData, getContractAddress, http, keccak256, parseAbi, toHex, stringToHex, encodeAbiParameters } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

// Only a fresh, non-forked child node is writable. Keys never leave memory.
const root = fileURLToPath(new URL('../../', import.meta.url));
const scratch = '/home/deseti/.hermes/cache/scratch/retempo-phase3-anvil';
const artifacts = process.env.ARC_SMOKE_ARTIFACTS ?? `${root}contracts/contract-metadata/phase-3-build`;
const binary = '/home/deseti/.local/share/retempo/toolchains/arc-foundry-v0.8.0-4/arc-anvil';
const evidencePath = `${root}docs/phase-3-evidence/arc-anvil-smoke.json`;
const USDC = '0x3600000000000000000000000000000000000000';
const SCALE = 10n ** 12n, PRICE = 100_000_000n, VEST = 14 * 86400;
const tokenAbi = parseAbi(['function decimals() view returns (uint8)', 'function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function blacklister() view returns (address)', 'function blacklist(address)', 'function isBlacklisted(address) view returns (bool)']);
const chain = defineChain({ id: 5042, name: 'Isolated ArcAnvil', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: ['http://127.0.0.1'] } } });
const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n';
const hash = text => keccak256(stringToHex(text));
const pair = (types, values) => keccak256(encodeAbiParameters(types.map(type => ({ type })), values));

test('genuine signed local Arc USDC acceptance and blocklist probes', { timeout: 120_000 }, async () => {
  await mkdir(scratch, { recursive: true });
  await mkdir(`${root}docs/phase-3-evidence`, { recursive: true });
  const report = { scope: 'Fresh local ArcAnvil only; no fork or remote RPC', chainId: 5042, toolchain: 'Arc Foundry v0.8.0-4', limits: ['Local predeploy and transaction-validation semantics only, not live mainnet acceptance or issuer policy.', 'Blocked EOA probe uses a genuinely signed zero-value setPayoutAddress transaction; no Foundry prank or tracer.', 'Relay recovery covers credit claimed before blacklisting, not new claims or refunds by a blocked signer.', 'Issuer blacklist change alone uses local impersonation; all application transactions use ephemeral signed EOAs.', 'Compiled artifacts are supplied by preflight; no contracts are compiled or modified by this test.'], steps: [], probes: {}, passed: false };
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const url = `http://127.0.0.1:${port}`;
  const log = await open(`${root}docs/phase-3-evidence/arc-anvil-node.log`, 'w', 0o600);
  const child = spawn(binary, ['--network', 'arc', '--chain-id', '5042', '--host', '127.0.0.1', '--port', String(port), '--accounts', '0', '--quiet'], { cwd: scratch, stdio: ['ignore', log.fd, log.fd], env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 110_000);
  const rpc = async (method, params = []) => {
    assert.equal(new URL(url).hostname, '127.0.0.1');
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(4000) });
    const body = await response.json();
    if (body.error) { const error = new Error(body.error.message); error.rpc = body.error; throw error; }
    return body.result;
  };
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { assert.equal(await rpc('eth_chainId'), '0x13b2'); ready = true; break; } catch { await new Promise(r => setTimeout(r, 100)); }
    }
    assert.ok(ready, 'child node ready on chain 5042');
    const client = createPublicClient({ chain, transport: http(url, { retryCount: 0, timeout: 4000 }), pollingInterval: 20 });
    const roles = Object.fromEntries(['deployer', 'admin', 'pauser', 'config', 'arbManager', 'arbitrator', 'merchant', 'customer', 'relayer', 'payout'].map(name => [name, privateKeyToAccount(generatePrivateKey())]));
    report.addresses = Object.fromEntries(Object.entries(roles).map(([name, account]) => [name, account.address]));
    for (const account of Object.values(roles)) await rpc('anvil_setBalance', [account.address, toHex(10_000n * 10n ** 18n)]);
    const load = async name => JSON.parse(await readFile(`${artifacts}/${name}.sol/${name}.json`, 'utf8'));
    const E = await load('RetempoEscrow'), M = await load('RetempoSubscriptionManager');
    report.validatedSourceKeccak = {};
    for (const artifact of [E, M]) {
      for (const [source, metadata] of Object.entries(artifact.metadata.sources)) {
        if (!source.startsWith('contracts/')) continue;
        const actual = keccak256(await readFile(`${root}${source}`));
        assert.equal(actual, metadata.keccak256, `compiled source must match current ${source}`);
        report.validatedSourceKeccak[source] = actual;
      }
    }
    const read = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args });
    const gasPrice = await client.getGasPrice();
    assert.ok(gasPrice > 0n, 'nonzero native gas price');
    const signed = async (account, to, data, gas = 1_000_000n) => {
      const nonce = await client.getTransactionCount({ address: account.address });
      const raw = await account.signTransaction({ chainId: 5042, type: 'legacy', nonce, gas, gasPrice, value: 0n, ...(to ? { to } : {}), data });
      return rpc('eth_sendRawTransaction', [raw]);
    };
    const receipt = async txHash => client.waitForTransactionReceipt({ hash: txHash, timeout: 6000 });
    const record = (name, r) => { report.steps.push({ name, transactionHash: r.transactionHash, blockNumber: r.blockNumber, status: r.status, gasUsed: r.gasUsed, effectiveGasPrice: r.effectiveGasPrice }); assert.equal(r.status, 'success', name); return r; };
    const send = async (name, account, address, abi, functionName, args = []) => record(name, await receipt(await signed(account, address, encodeFunctionData({ abi, functionName, args }))));
    const a = name => roles[name].address;
    const predicted = getContractAddress({ from: a('deployer'), nonce: 1n });
    const eReceipt = record('deploy escrow', await receipt(await signed(roles.deployer, undefined, encodeDeployData({ abi: E.abi, bytecode: E.bytecode.object, args: [USDC, predicted, a('admin'), 86400, a('pauser'), a('config'), a('arbManager'), 10n ** 18n] }), 7_000_000n)));
    const escrow = eReceipt.contractAddress;
    const mReceipt = record('deploy manager', await receipt(await signed(roles.deployer, undefined, encodeDeployData({ abi: M.abi, bytecode: M.bytecode.object, args: [USDC, escrow, a('admin'), 86400, a('pauser'), a('config')] }), 7_000_000n)));
    const manager = mReceipt.contractAddress;
    report.contracts = { escrow, manager };
    assert.equal(manager.toLowerCase(), predicted.toLowerCase());
    assert.equal((await read(escrow, E.abi, 'manager')).toLowerCase(), manager.toLowerCase());
    assert.equal((await read(manager, M.abi, 'escrow')).toLowerCase(), escrow.toLowerCase());
    assert.equal(await read(escrow, E.abi, 'paused'), true);
    assert.equal(await read(manager, M.abi, 'paused'), true);
    assert.equal(await read(USDC, tokenAbi, 'decimals'), 6);
    await send('unpause escrow', roles.admin, escrow, E.abi, 'unpause');
    await send('unpause manager', roles.admin, manager, M.abi, 'unpause');
    await send('allowlist arbitrator', roles.arbManager, escrow, E.abi, 'addArbitrator', [a('arbitrator')]);
    await send('approve native USDC ERC20 view', roles.customer, USDC, tokenAbi, 'approve', [manager, 2n * PRICE]);
    assert.equal(await read(USDC, tokenAbi, 'allowance', [a('customer'), manager]), 2n * PRICE);
    const pref = hash('arc signed smoke plan');
    await send('create escrow plan', roles.merchant, manager, M.abi, 'createPlan', [pref, a('merchant'), PRICE, 30 * 86400, 0, 3 * 86400, VEST, a('arbitrator'), false]);
    const planKey = await read(manager, M.abi, 'planKey', [a('merchant'), pref]);
    const exact = async (locked, credit, label) => {
      assert.equal(await read(escrow, E.abi, 'totalLocked'), locked, `${label}: locked`);
      assert.equal(await read(escrow, E.abi, 'totalWithdrawable'), credit, `${label}: credits`);
      assert.equal(await read(USDC, tokenAbi, 'balanceOf', [escrow]), locked + credit, `${label}: ERC20 liabilities`);
      assert.equal(await client.getBalance({ address: escrow }), (locked + credit) * SCALE, `${label}: native liabilities`);
      report.steps.push({ name: label, status: 'success', locked, credit });
    };
    const keys = [];
    for (let i = 0; i < 2; i++) {
      const sref = hash(`arc signed subscription ${i}`);
      const before = await client.getBalance({ address: a('customer') });
      const r = await send(`subscribe ${i}`, roles.customer, manager, M.abi, 'subscribe', [sref, planKey, a('arbitrator')]);
      assert.equal(await client.getBalance({ address: a('customer') }), before - PRICE * SCALE - r.gasUsed * r.effectiveGasPrice, 'customer payment plus native gas');
      const subKey = await read(manager, M.abi, 'subscriptionKey', [a('customer'), sref]);
      keys.push(pair(['address', 'bytes32'], [a('merchant'), pair(['bytes32', 'uint32'], [subKey, 1])]));
    }
    await exact(2n * PRICE, 0n, 'two subscriptions exactly funded');
    assert.equal(await client.getBalance({ address: manager }), 0n);
    await rpc('evm_increaseTime', [VEST + 1]);
    await rpc('evm_mine');
    await send('claim first vested credit', roles.merchant, escrow, E.abi, 'claim', [keys[0]]);
    await exact(PRICE, PRICE, 'first claim exact liabilities');
    const before = await client.getBalance({ address: a('merchant') });
    const withdrawn = await send('merchant withdraw', roles.merchant, escrow, E.abi, 'withdraw', [a('merchant')]);
    assert.equal(await client.getBalance({ address: a('merchant') }), before + PRICE * SCALE - withdrawn.gasUsed * withdrawn.effectiveGasPrice, 'beneficiary receives exact USDC less its actual native gas');
    report.beneficiaryBalance = { before, after: await client.getBalance({ address: a('merchant') }), payment: PRICE * SCALE, gasCost: withdrawn.gasUsed * withdrawn.effectiveGasPrice };
    await exact(PRICE, 0n, 'first withdrawal exact liabilities');
    await send('claim existing credit before blocklist', roles.merchant, escrow, E.abi, 'claim', [keys[1]]);
    await exact(0n, PRICE, 'existing credit exact liabilities');
    const issuer = await read(USDC, tokenAbi, 'blacklister');
    await rpc('anvil_setBalance', [issuer, toHex(100n * 10n ** 18n)]);
    await rpc('anvil_impersonateAccount', [issuer]);
    try {
      const txHash = await rpc('eth_sendTransaction', [{ from: issuer, to: USDC, data: encodeFunctionData({ abi: tokenAbi, functionName: 'blacklist', args: [a('merchant')] }), gas: toHex(1_000_000n), gasPrice: toHex(gasPrice), value: '0x0' }]);
      record('local issuer blacklists merchant', await receipt(txHash));
    } finally { await rpc('anvil_stopImpersonatingAccount', [issuer]); }
    assert.equal(await read(USDC, tokenAbi, 'isBlacklisted', [a('merchant')]), true);
    // Classification is observational: accepted execution and pool rejection are distinct results.
    const nonceBefore = await client.getTransactionCount({ address: a('merchant') });
    const blockedBefore = await client.getBalance({ address: a('merchant') });
    try {
      const txHash = await signed(roles.merchant, escrow, encodeFunctionData({ abi: E.abi, functionName: 'setPayoutAddress', args: [a('payout')] }));
      const r = await receipt(txHash);
      report.probes.blocklistedZeroValue = { outcome: 'mined', status: r.status, transactionHash: txHash, gasUsed: r.gasUsed };
      if (r.status === 'success') assert.equal((await read(escrow, E.abi, 'payoutAddress', [a('merchant')])).toLowerCase(), a('payout').toLowerCase());
    } catch (error) {
      if (!error.rpc) throw error;
      assert.match(error.rpc.message, /transaction rejected: address .* is blocklisted by NativeCoinControl/, 'rejection must be native blocklist validation, not an unrelated RPC failure');
      report.probes.blocklistedZeroValue = { outcome: 'RPC transaction validation rejection', error: error.rpc, value: '0', nonceUnchanged: true, nativeBalanceUnchanged: true };
      assert.equal(await client.getTransactionCount({ address: a('merchant') }), nonceBefore);
      assert.equal(await client.getBalance({ address: a('merchant') }), blockedBefore);
    }
    assert.equal(await read(escrow, E.abi, 'withdrawableOf', [a('merchant')]), PRICE);
    const nonce = await read(escrow, E.abi, 'nonces', [a('merchant')]);
    const deadline = (await client.getBlock()).timestamp + 3600n;
    const signature = await roles.merchant.signTypedData({ domain: { name: 'RetempoEscrow', version: '1', chainId: 5042, verifyingContract: escrow }, types: { SetPayoutAddress: [{ name: 'account', type: 'address' }, { name: 'newPayout', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] }, primaryType: 'SetPayoutAddress', message: { account: a('merchant'), newPayout: a('payout'), nonce, deadline } });
    await send('clean relayer EIP712 payout update', roles.relayer, escrow, E.abi, 'setPayoutAddressBySig', [a('merchant'), a('payout'), deadline, signature]);
    assert.equal(await read(escrow, E.abi, 'nonces', [a('merchant')]), nonce + 1n);
    assert.equal((await read(escrow, E.abi, 'payoutAddress', [a('merchant')])).toLowerCase(), a('payout').toLowerCase());
    const payoutBefore = await client.getBalance({ address: a('payout') });
    const merchantBefore = await client.getBalance({ address: a('merchant') });
    await send('clean relayer withdrawToPayout existing blocked credit', roles.relayer, escrow, E.abi, 'withdrawToPayout', [a('merchant')]);
    assert.equal(await client.getBalance({ address: a('payout') }), payoutBefore + PRICE * SCALE);
    assert.equal(await client.getBalance({ address: a('merchant') }), merchantBefore);
    assert.equal(await read(escrow, E.abi, 'withdrawableOf', [a('merchant')]), 0n);
    assert.equal(await read(USDC, tokenAbi, 'isBlacklisted', [a('merchant')]), true);
    await exact(0n, 0n, 'final escrow empty with zero liabilities');
    report.probes.cleanRelayer = { payoutUpdate: 'success', existingCreditWithdrawal: 'success', merchantStillBlacklisted: true };
    report.passed = true;
  } catch (error) {
    report.failure = { name: error.name, message: error.shortMessage ?? error.message };
    throw new Error(`Arc smoke failed: ${error.shortMessage ?? error.message}`);
  } finally {
    clearTimeout(watchdog);
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      const hardStop = setTimeout(() => child.kill('SIGKILL'), 2000);
      await exited;
      clearTimeout(hardStop);
    }
    report.childStopped = child.exitCode !== null || child.signalCode !== null;
    report.childExit = { code: child.exitCode, signal: child.signalCode };
    await log.close();
    await writeFile(evidencePath, json(report));
    assert.equal(report.childStopped, true, 'owned child node stopped');
  }
});
