#!/usr/bin/env node

/**
 * Electrum Bitcoin Header Fetcher
 * Fetches all Bitcoin block headers from Electrum network
 * Saves as btc.archive.bin (completed epochs) and btc.current.bin (current epoch)
 *
 * Each epoch = 2016 blocks (difficulty adjustment period)
 * Each header = 80 bytes
 */

const tls = require('tls');
const fs = require('fs');
const path = require('path');

// Electrum server list (mainnet)
const ELECTRUM_SERVERS = [
  { host: 'electrum.blockstream.info', port: 50002 },
  { host: 'electrum.emzy.de', port: 50002 },
  { host: 'electrum.bitaroo.net', port: 50002 },
  { host: 'bolt.schulzemic.net', port: 50002 },
  { host: 'electrum.jochen-hoenicke.de', port: 50006 },
];

const EPOCH_SIZE = 2016; // Bitcoin difficulty adjustment period
const HEADER_SIZE = 80;  // Each header is 80 bytes
const BATCH_SIZE = 2016; // Headers per request

class ElectrumClient {
  constructor() {
    this.socket = null;
    this.requestId = 0;
    this.pending = new Map();
    this.buffer = '';
  }

  /**
   * Connect to an Electrum server
   */
  async connect(host, port) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Connection timeout to ${host}:${port}`));
      }, 10000);

      this.socket = tls.connect({
        host,
        port,
        rejectUnauthorized: false // Electrum servers often use self-signed certs
      }, () => {
        clearTimeout(timeout);
        console.log(`Connected to ${host}:${port}`);
        resolve();
      });

      this.socket.setEncoding('utf8');

      this.socket.on('data', (data) => this.handleData(data));

      this.socket.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      this.socket.on('close', () => {
        console.log('Connection closed');
      });
    });
  }

  /**
   * Handle incoming data from socket
   */
  handleData(data) {
    this.buffer += data;

    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const response = JSON.parse(line);
        const pending = this.pending.get(response.id);

        if (pending) {
          this.pending.delete(response.id);
          if (response.error) {
            pending.reject(new Error(response.error.message || JSON.stringify(response.error)));
          } else {
            pending.resolve(response.result);
          }
        }
      } catch (err) {
        console.error('Parse error:', err.message);
      }
    }
  }

  /**
   * Send JSON-RPC request
   */
  async request(method, params = []) {
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      const request = JSON.stringify({ id, method, params }) + '\n';

      this.pending.set(id, { resolve, reject });

      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, 60000);

      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timeout);
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        }
      });

      this.socket.write(request);
    });
  }

  /**
   * Subscribe to headers and get current tip
   */
  async subscribeHeaders() {
    const result = await this.request('blockchain.headers.subscribe');
    return {
      height: result.height,
      hex: result.hex
    };
  }

  /**
   * Get block headers starting from height
   * @param {number} startHeight - Starting block height
   * @param {number} count - Number of headers to fetch
   * @returns {Promise<string>} - Concatenated hex headers
   */
  async getBlockHeaders(startHeight, count) {
    const result = await this.request('blockchain.block.headers', [startHeight, count]);
    return result.hex;
  }

  /**
   * Close the connection
   */
  close() {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }
}

/**
 * Convert hex string to Buffer
 */
function hexToBuffer(hex) {
  return Buffer.from(hex, 'hex');
}

/**
 * Try connecting to servers until one succeeds
 */
async function connectToServer(client) {
  for (const server of ELECTRUM_SERVERS) {
    try {
      await client.connect(server.host, server.port);
      return server;
    } catch (err) {
      console.log(`Failed to connect to ${server.host}:${server.port} - ${err.message}`);
    }
  }
  throw new Error('Could not connect to any Electrum server');
}

/**
 * Fetch all headers and save to files
 */
async function fetchAndSaveHeaders() {
  const client = new ElectrumClient();

  try {
    // Connect to Electrum server
    await connectToServer(client);

    // Get current tip
    const tip = await client.subscribeHeaders();
    console.log(`Current chain tip: block ${tip.height}`);

    // Calculate epochs
    const completedEpochs = Math.floor(tip.height / EPOCH_SIZE);
    const archiveHeight = completedEpochs * EPOCH_SIZE; // Last block of completed epochs
    const currentEpochStart = archiveHeight;
    const currentEpochBlocks = tip.height - currentEpochStart + 1;

    console.log(`Completed epochs: ${completedEpochs} (${archiveHeight} blocks)`);
    console.log(`Current epoch: blocks ${currentEpochStart} to ${tip.height} (${currentEpochBlocks} blocks)`);

    // Fetch archive headers (completed epochs)
    console.log('\nFetching archive headers...');
    const archiveBuffers = [];

    for (let height = 0; height < archiveHeight; height += BATCH_SIZE) {
      const count = Math.min(BATCH_SIZE, archiveHeight - height);
      const progress = ((height / archiveHeight) * 100).toFixed(1);
      process.stdout.write(`\rProgress: ${progress}% (block ${height}/${archiveHeight})`);

      const headersHex = await client.getBlockHeaders(height, count);
      archiveBuffers.push(hexToBuffer(headersHex));
    }
    console.log(`\rProgress: 100% (block ${archiveHeight}/${archiveHeight})`);

    // Fetch current epoch headers
    console.log('\nFetching current epoch headers...');
    const currentBuffers = [];

    for (let height = currentEpochStart; height <= tip.height; height += BATCH_SIZE) {
      const count = Math.min(BATCH_SIZE, tip.height - height + 1);
      const headersHex = await client.getBlockHeaders(height, count);
      currentBuffers.push(hexToBuffer(headersHex));
    }

    // Combine and save archive
    if (archiveBuffers.length > 0) {
      const archiveData = Buffer.concat(archiveBuffers);
      const archivePath = path.join(process.cwd(), 'btc.archive.bin');
      fs.writeFileSync(archivePath, archiveData);
      console.log(`\nSaved ${archivePath}`);
      console.log(`  - ${archiveData.length} bytes (${archiveData.length / HEADER_SIZE} headers)`);
    }

    // Combine and save current epoch
    if (currentBuffers.length > 0) {
      const currentData = Buffer.concat(currentBuffers);
      const currentPath = path.join(process.cwd(), 'btc.current.bin');
      fs.writeFileSync(currentPath, currentData);
      console.log(`\nSaved ${currentPath}`);
      console.log(`  - ${currentData.length} bytes (${currentData.length / HEADER_SIZE} headers)`);
    }

    // Summary
    const totalHeaders = archiveHeight + currentEpochBlocks;
    const totalBytes = totalHeaders * HEADER_SIZE;
    console.log(`\nTotal: ${totalHeaders} headers (${totalBytes} bytes)`);

  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    client.close();
  }
}

/**
 * Verify header chain integrity
 */
async function verifyHeaders(filePath) {
  const crypto = require('crypto');
  const data = fs.readFileSync(filePath);
  const headerCount = data.length / HEADER_SIZE;

  console.log(`Verifying ${headerCount} headers in ${filePath}...`);

  let prevHash = '0000000000000000000000000000000000000000000000000000000000000000';

  for (let i = 0; i < headerCount; i++) {
    const header = data.slice(i * HEADER_SIZE, (i + 1) * HEADER_SIZE);

    // Extract prevHash from header (bytes 4-36, reversed)
    const headerPrevHash = Buffer.from(header.slice(4, 36)).reverse().toString('hex');

    // Skip genesis block prevHash check
    if (i > 0 && headerPrevHash !== prevHash) {
      console.error(`Chain broken at header ${i}`);
      console.error(`  Expected: ${prevHash}`);
      console.error(`  Got: ${headerPrevHash}`);
      return false;
    }

    // Compute this header's hash (double SHA-256, reversed)
    const hash1 = crypto.createHash('sha256').update(header).digest();
    const hash2 = crypto.createHash('sha256').update(hash1).digest();
    prevHash = Buffer.from(hash2).reverse().toString('hex');

    if (i % 10000 === 0) {
      process.stdout.write(`\rVerified ${i}/${headerCount} headers`);
    }
  }

  console.log(`\rVerified ${headerCount}/${headerCount} headers`);
  console.log('Chain is valid!');
  return true;
}

// Main execution
const args = process.argv.slice(2);

if (args[0] === '--verify') {
  const file = args[1] || 'btc.archive.bin';
  verifyHeaders(file).catch(console.error);
} else {
  fetchAndSaveHeaders().catch(console.error);
}
