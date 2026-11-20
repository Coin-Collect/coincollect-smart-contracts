const { spawn } = require('node:child_process')
const { createServer } = require('node:net')
const { setTimeout: delay } = require('node:timers/promises')
const { providers } = require('ethers')

async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  return port
}

async function startLocalAnvil(fork = []) {
  const architecture = process.arch === 'x64' ? 'amd64' : process.arch
  const binary = process.env.ANVIL_BIN || require.resolve(
    '@foundry-rs/anvil-' + process.platform + '-' + architecture + '/bin/anvil',
  )
  const port = await freePort()
  const url = 'http://127.0.0.1:' + port
  const child = spawn(binary, ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337', ...fork], {
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  let spawnError
  child.on('error', (error) => { spawnError = error })
  const provider = new providers.StaticJsonRpcProvider({ url, timeout: fork.length ? 15_000 : 1_000 }, 31337)
  provider.pollingInterval = 50
  const close = () => child.kill()
  try {
    for (let i = 0; i < 150; i++) {
      if (spawnError) throw spawnError
      if (child.exitCode !== null) throw new Error('Anvil exited before accepting connections.')
      const chainId = await provider.send('eth_chainId', []).catch(() => undefined)
      if (chainId !== undefined) {
        if (chainId !== '0x7a69') throw new Error('Local test refused a node outside chain 31337.')
        await provider.send('anvil_nodeInfo', [])
        return { provider, close, url }
      }
      await delay(100)
    }
    throw new Error('Anvil did not accept connections in time.')
  } catch (error) {
    close()
    throw error
  }
}

module.exports = { startLocalAnvil }
