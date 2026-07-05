const fs = require('fs')
const f = process.argv[2]
const b = fs.readFileSync(f)
const e = b.readUInt32LE(0x3C)         // e_lfanew -> PE header
const off = e + 4 + 20 + 68            // PE sig(4) + COFF(20) + OptHdr Subsystem(68)
const antes = b.readUInt16LE(off)
if (antes === 3) { b.writeUInt16LE(2, off); fs.writeFileSync(f, b) }
const depois = fs.readFileSync(f).readUInt16LE(off)
console.log('subsystem antes:', antes, '(3=console,2=gui)  depois:', depois)
