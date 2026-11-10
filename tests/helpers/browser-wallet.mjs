import assert from 'node:assert/strict'

/** A test-only EIP-1193 wallet: real in-memory signatures, exclusively on the owned Arc node. */
export async function installLocalWallet(context, arc, account) {
  const control = { rejectNext: false, wrongGenesis: false, writes: [] }
  await context.exposeBinding('__retempoLocalWallet', async (_source, { method, params = [] }) => {
    try {
      if (['eth_accounts', 'eth_requestAccounts'].includes(method)) return { result: [account.address] }
      if (method === 'eth_chainId') return { result: '0x13b2' }
      if (['wallet_getPermissions', 'wallet_requestPermissions'].includes(method)) return { result: [{ parentCapability: 'eth_accounts' }] }
      if (method === 'wallet_switchEthereumChain') { assert.equal(params[0].chainId, '0x13b2'); return { result: null } }
      if (method === 'wallet_getCapabilities') return { result: {} }
      if (method === 'personal_sign') return { result: await account.signMessage({ message: { raw: params[0] } }) }
      if (method === 'eth_sendTransaction') {
        if (control.rejectNext) { control.rejectNext = false; return { error: { code: 4001, message: 'User rejected the local test-wallet request' } } }
        const tx = params[0]
        assert.equal(tx.from.toLowerCase(), account.address.toLowerCase())
        assert.ok([arc.usdc, arc.manager, arc.escrow].some(address => address.toLowerCase() === tx.to?.toLowerCase()), 'wallet cannot send outside the local application')
        assert.equal(BigInt(tx.value ?? '0'), 0n)
        const gas = tx.gas ? BigInt(tx.gas) : await arc.client.estimateGas({ account: account.address, to: tx.to, data: tx.data })
        const hash = await arc.signed(account, tx.to, tx.data, gas)
        const receipt = await arc.confirm(hash)
        control.writes.push({ hash, to: tx.to, status: receipt.status })
        return { result: hash }
      }
      assert.ok(method.startsWith('eth_') || method === 'net_version', `Unsupported local wallet method ${method}`)
      assert.notEqual(method, 'eth_sendRawTransaction', 'browser cannot bypass the in-memory account signer')
      const result = await arc.rpc(method, params)
      if (control.wrongGenesis && method === 'eth_getBlockByNumber' && params[0] === '0x0') return { result: { ...result, hash: `0x${'ff'.repeat(32)}` } }
      return { result }
    } catch (error) { return { error: { code: error.code ?? -32603, message: error.shortMessage ?? error.message } } }
  })
  await context.addInitScript(({ address }) => {
    const listeners = new Map()
    const provider = {
      isMetaMask: true, isConnected: () => true, selectedAddress: address, chainId: '0x13b2',
      request: async payload => { const response = await window.__retempoLocalWallet(payload); if (response.error) throw Object.assign(new Error(response.error.message), { code: response.error.code }); return response.result },
      on: (name, listener) => { const set = listeners.get(name) ?? new Set(); set.add(listener); listeners.set(name, set); return provider },
      removeListener: (name, listener) => { listeners.get(name)?.delete(listener); return provider },
    }
    Object.defineProperty(window, 'ethereum', { value: provider, configurable: true })
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { uuid: 'ecddf628-1918-47d6-bd1a-b5d4ff498d4a', name: 'Local Arc Wallet', icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>', rdns: 'local.retempo.wallet' }, provider } }))
    window.addEventListener('eip6963:requestProvider', announce)
    announce()
  }, { address: account.address })
  return control
}
