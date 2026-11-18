// Writes its pid to the file named in argv[2], then waits forever: stands in for a stuck `claude -p`.
import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[2], String(process.pid));
setInterval(() => {}, 1000);
