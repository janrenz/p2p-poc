const fs = require('fs');
const path = require('path');

// Generate a 200MB test file
const FILE_SIZE = 200 * 1024 * 1024; // 200 MB
const CHUNK_SIZE = 1024 * 1024; // 1 MB chunks
const FILE_PATH = path.join(__dirname, 'public', 'test-file-200mb.bin');

console.log(`Generating ${FILE_SIZE / 1024 / 1024}MB test file...`);
console.log(`File path: ${FILE_PATH}`);

// Create a write stream
const writeStream = fs.createWriteStream(FILE_PATH);
let bytesWritten = 0;

// Generate data with a pattern (so we can verify it's correct)
function generateChunk(chunkIndex) {
    const buffer = Buffer.alloc(CHUNK_SIZE);
    // Fill with a pattern: chunk index repeated
    const pattern = Buffer.alloc(4);
    pattern.writeUInt32BE(chunkIndex, 0);
    
    for (let i = 0; i < CHUNK_SIZE; i += 4) {
        pattern.copy(buffer, i);
    }
    
    return buffer;
}

// Write chunks
let chunkIndex = 0;
function writeChunk() {
    if (bytesWritten >= FILE_SIZE) {
        writeStream.end();
        console.log(`✓ Test file generated successfully!`);
        console.log(`  Size: ${(fs.statSync(FILE_PATH).size / 1024 / 1024).toFixed(2)} MB`);
        console.log(`  Path: ${FILE_PATH}`);
        return;
    }
    
    const chunk = generateChunk(chunkIndex);
    const remainingBytes = FILE_SIZE - bytesWritten;
    const chunkToWrite = chunk.slice(0, Math.min(CHUNK_SIZE, remainingBytes));
    
    writeStream.write(chunkToWrite, (err) => {
        if (err) {
            console.error('Error writing chunk:', err);
            process.exit(1);
        }
        
        bytesWritten += chunkToWrite.length;
        chunkIndex++;
        
        // Progress update every 10MB
        if (bytesWritten % (10 * 1024 * 1024) === 0) {
            const progress = ((bytesWritten / FILE_SIZE) * 100).toFixed(1);
            console.log(`Progress: ${progress}% (${(bytesWritten / 1024 / 1024).toFixed(2)} MB)`);
        }
        
        // Continue writing
        setImmediate(writeChunk);
    });
}

// Start writing
writeChunk();

writeStream.on('finish', () => {
    console.log(`\n✓ File generation complete!`);
    console.log(`  Final size: ${(fs.statSync(FILE_PATH).size / 1024 / 1024).toFixed(2)} MB`);
    process.exit(0);
});

writeStream.on('error', (err) => {
    console.error('Stream error:', err);
    process.exit(1);
});


