// Copies SVG icons next to the compiled nodes and credentials.
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

function copy(dir) {
	for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
		const rel = path.join(dir, entry.name);
		if (entry.isDirectory()) copy(rel);
		else if (entry.name.endsWith('.svg')) {
			const out = path.join(root, 'dist', rel);
			fs.mkdirSync(path.dirname(out), { recursive: true });
			fs.copyFileSync(path.join(root, rel), out);
		}
	}
}

copy('nodes');
copy('credentials');
