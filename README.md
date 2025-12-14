# electrum-header-fetcher

Fetch Bitcoin block headers from the Electrum network and save them as binary files. Compatible with [NIP-333](https://github.com/nostr-protocol/nips/blob/master/333.md) Bitcoin Block Headers specification.

## Features

- Zero dependencies - uses only Node.js built-in modules
- Connects to Electrum servers via TLS
- Downloads all Bitcoin block headers (~75MB)
- Splits headers into archive (completed epochs) and current (in-progress epoch)
- Includes chain verification utility
- NIP-333 compatible output format

## Installation

```bash
# Install globally
npm install -g electrum-header-fetcher

# Or run directly with npx
npx electrum-header-fetcher
```

## Usage

### Fetch Headers

```bash
# Using global install
electrum-headers

# Using npx
npx electrum-header-fetcher

# Using node directly
node getHeaders.js
```

This will create two files in the current directory:

| File | Description |
|------|-------------|
| `btc.archive.bin` | All completed epochs (immutable, grows each epoch) |
| `btc.current.bin` | Current epoch in progress (up to 2016 headers) |

### Verify Headers

Verify that headers chain together correctly:

```bash
# Verify archive
electrum-headers --verify btc.archive.bin

# Verify current epoch
electrum-headers --verify btc.current.bin
```

## Output Format

Headers are stored as raw 80-byte binary concatenated together:

- Each header is exactly 80 bytes
- Headers are in ascending order by block height
- Archive contains complete epochs (multiples of 2016 blocks)
- Current contains the partial epoch in progress

### Bitcoin Header Structure

Each 80-byte header contains:

| Field | Bytes | Offset | Description |
|-------|-------|--------|-------------|
| Version | 4 | 0 | Block version (little-endian) |
| Previous Hash | 32 | 4 | Hash of previous block |
| Merkle Root | 32 | 36 | Transaction merkle root |
| Timestamp | 4 | 68 | Unix timestamp |
| Bits | 4 | 72 | Difficulty target (compact) |
| Nonce | 4 | 76 | Proof-of-work nonce |

## NIP-333 Compatibility

This tool produces binary files compatible with NIP-333 data sources:

```
{network}.archive.bin - All completed epochs
{network}.current.bin - Current epoch in progress
```

These files can be served via HTTP and referenced in NIP-333 events using the `u` tag.

## Programmatic Usage

```javascript
const { spawn } = require('child_process');
const fs = require('fs');

// Run the fetcher
const proc = spawn('node', ['getHeaders.js']);

proc.on('close', () => {
  // Read headers
  const archive = fs.readFileSync('btc.archive.bin');
  const headerCount = archive.length / 80;

  // Parse a specific header
  const height = 0; // genesis block
  const header = archive.slice(height * 80, (height + 1) * 80);

  // Extract fields
  const version = header.readUInt32LE(0);
  const prevHash = header.slice(4, 36).reverse().toString('hex');
  const merkleRoot = header.slice(36, 68).reverse().toString('hex');
  const timestamp = header.readUInt32LE(68);
  const bits = header.readUInt32LE(72);
  const nonce = header.readUInt32LE(76);

  console.log({ version, prevHash, merkleRoot, timestamp, bits, nonce });
});
```

## Electrum Servers

The tool tries these servers in order:

1. electrum.blockstream.info:50002
2. electrum.emzy.de:50002
3. electrum.bitaroo.net:50002
4. bolt.schulzemic.net:50002
5. electrum.jochen-hoenicke.de:50006

## File Sizes

Approximate sizes as of late 2024:

| File | Size | Headers |
|------|------|---------|
| `btc.archive.bin` | ~74 MB | ~927,000 |
| `btc.current.bin` | ~160 KB | ~2,000 |

## Sync Strategy

For clients implementing NIP-333:

```
1. Subscribe to kind:33333 → get tip (12 headers)
         ↓
2. GET btc.current.bin → current epoch
         ↓
3. GET btc.archive.bin → completed epochs (background)
         ↓
4. Stay subscribed for new blocks
```

## License

MIT
