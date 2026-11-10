import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPublicClient, defineChain, encodeDeployData, encodeFunctionData, getContractAddress, http, keccak256, parseAbi, toHex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

const root = fileURLToPath(new URL('../../', import.meta.url))
export const USDC = '0x3600000000000000000000000000000000000000'
export const tokenAbi = parseAbi(['function decimals() view returns (uint8)', 'function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)'])

export async function freePort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

/** Fresh non-forked loopback node, ephemeral in-memory keys, no production configuration. */
export async function startLocalArc() {
  const scratch = process.env.TMPDIR || path.join(homedir(), '.hermes/cache/scratch')
  await mkdir(scratch, { recursive: true })
  const directory = await mkdtemp(path.join(scratch, 'retempo-phase4-'))
  const port = await freePort()
  const url = `http://127.0.0.1:${port}`
  const binary = path.join(homedir(), '.local/share/retempo/toolchains/arc-foundry-v0.8.0-4/arc-anvil')
  const child = spawn(binary, ['--network', 'arc', '--chain-id', '5042', '--host', '127.0.0.1', '--port', String(port), '--accounts', '0', '--quiet'], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: process.env.HOME } })
  let startupError
  let stopped = false
  child.on('error', error => { startupError = error })
  // Drain pipes without writing keys or provider payloads to logs.
  child.stdout.resume()
  child.stderr.resume()
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      const exit = once(child, 'exit')
      child.kill('SIGTERM')
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000)
      await exit
      clearTimeout(timer)
    }
    stopped = true
  }
  const rpc = async (method, params = []) => {
    assert.equal(new URL(url).hostname, '127.0.0.1', 'diagnostic writes must stay local')
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(5000) })
    const body = await response.json()
    if (body.error) throw new Error(body.error.message)
    return body.result
  }
  try {
    let ready = false
    for (let attempt = 0; attempt < 100; attempt++) {
      if (startupError) throw startupError
      try { assert.equal(await rpc('eth_chainId'), '0x13b2'); ready = true; break } catch { await new Promise(resolve => setTimeout(resolve, 100)) }
    }
    assert.ok(ready, 'owned local Arc node is ready')
    const chain = defineChain({ id: 5042, name: 'Retempo local acceptance', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [url] } } })
    const client = createPublicClient({ chain, transport: http(url, { retryCount: 0, timeout: 5000 }), pollingInterval: 20 })
    const roles = Object.fromEntries(['deployer', 'admin', 'pauser', 'config', 'arbManager', 'arbitrator', 'merchant', 'customer', 'outsider', 'payout'].map(name => [name, privateKeyToAccount(generatePrivateKey())]))
    for (const account of Object.values(roles)) await rpc('anvil_setBalance', [account.address, toHex(10_000n * 10n ** 18n)])
    const artifact = async name => JSON.parse(await readFile(`${root}contracts/contract-metadata/phase-3-build/${name}.sol/${name}.json`, 'utf8'))
    const E = await artifact('RetempoEscrow')
    const M = await artifact('RetempoSubscriptionManager')
    const sourceFingerprints = {}
    for (const compiled of [E, M]) for (const [source, metadata] of Object.entries(compiled.metadata.sources)) {
      if (!source.startsWith('contracts/')) continue
      const actual = keccak256(await readFile(path.join(root, source)))
      assert.equal(actual, metadata.keccak256, `frozen source ${source} matches approved bytecode`)
      sourceFingerprints[source] = actual
    }
    const receipts = []
    const signed = async (account, to, data, gas = 1_000_000n, value = 0n) => {
      const nonce = await client.getTransactionCount({ address: account.address })
      const raw = await account.signTransaction({ chainId: 5042, type: 'legacy', nonce, gas, gasPrice: await client.getGasPrice(), value, ...(to ? { to } : {}), data })
      return rpc('eth_sendRawTransaction', [raw])
    }
    const confirm = async hash => {
      const receipt = await client.waitForTransactionReceipt({ hash, timeout: 10_000 })
      assert.equal(receipt.status, 'success')
      receipts.push(receipt)
      return receipt
    }
    const send = async (account, address, abi, functionName, args = []) => confirm(await signed(account, address, encodeFunctionData({ abi, functionName, args })))
    const read = (address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args })
    const predicted = getContractAddress({ from: roles.deployer.address, nonce: 1n })
    const deployedEscrow = await confirm(await signed(roles.deployer, undefined, encodeDeployData({ abi: E.abi, bytecode: E.bytecode.object, args: [USDC, predicted, roles.admin.address, 86400, roles.pauser.address, roles.config.address, roles.arbManager.address, 10n ** 18n] }), 7_000_000n))
    const escrow = deployedEscrow.contractAddress
    const deployedManager = await confirm(await signed(roles.deployer, undefined, encodeDeployData({ abi: M.abi, bytecode: M.bytecode.object, args: [USDC, escrow, roles.admin.address, 86400, roles.pauser.address, roles.config.address] }), 7_000_000n))
    const manager = deployedManager.contractAddress
    assert.equal(manager.toLowerCase(), predicted.toLowerCase())
    await send(roles.admin, escrow, E.abi, 'unpause')
    await send(roles.admin, manager, M.abi, 'unpause')
    await send(roles.arbManager, escrow, E.abi, 'addArbitrator', [roles.arbitrator.address])
    const genesis = await client.getBlock({ blockNumber: 0n })
    const configuration = { chainId: 5042, mode: 'local', configured: true, rpcUrl: url, explorerUrl: null, usdc: USDC, usdcDecimals: 6, manager, escrow, startBlock: deployedEscrow.blockNumber.toString(), genesisHash: genesis.hash, managerCodeHash: keccak256(await client.getCode({ address: manager })), escrowCodeHash: keccak256(await client.getCode({ address: escrow })) }
    return { directory, url, rpc, client, chain, roles, manager, escrow, usdc: USDC, managerAbi: M.abi, escrowAbi: E.abi, tokenAbi, configuration, sourceFingerprints, receipts, signed, confirm, send, read, stop, get stopped() { return stopped } }
  } catch (error) {
    await stop()
    throw error
  }
}
