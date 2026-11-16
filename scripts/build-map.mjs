import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

const ifAvailable = process.argv.includes('--if-available');

function resolveMapLibrePkg() {
    try {
        return require.resolve('maplibre-gl/package.json', { paths: [rootDir] });
    } catch {
        return null;
    }
}

function syncAppCacheBuster(version) {
    const appJsPath = path.join(rootDir, 'views', 'app.js');
    if (!fs.existsSync(appJsPath)) return false;

    const current = fs.readFileSync(appJsPath, 'utf8');
    const updated = current.replace(
        /(\/maplibre\/maplibre-gl(?:-worker)?\.(?:css|mjs))\?v=[^"'\s]+/g,
        `$1?v=${version}`,
    );

    if (updated === current) return false;
    fs.writeFileSync(appJsPath, updated);
    return true;
}

function main() {
    const maplibrePkgPath = resolveMapLibrePkg();
    if (!maplibrePkgPath) {
        if (ifAvailable) {
            console.log('Skipping MapLibre asset sync (maplibre-gl not installed; using committed public/maplibre).');
            return;
        }
        throw new Error('Could not resolve maplibre-gl/package.json. Run "npm install" first.');
    }

    const { version } = JSON.parse(fs.readFileSync(maplibrePkgPath, 'utf8'));
    const distDir = path.join(path.dirname(maplibrePkgPath), 'dist');
    const outDir = path.join(rootDir, 'public', 'maplibre');
    fs.mkdirSync(outDir, { recursive: true });

    const files = ['maplibre-gl.mjs', 'maplibre-gl-worker.mjs', 'maplibre-gl.css'];
    for (const file of files) {
        const srcPath = path.join(distDir, file);
        const destPath = path.join(outDir, file);
        if (file.endsWith('.mjs')) {
            // Strip trailing sourceMappingURL so browser DevTools never logs 404s for unshipped .map files.
            const source = fs.readFileSync(srcPath, 'utf8').replace(/\n\/\/# sourceMappingURL=[^\n]*\s*$/, '\n');
            fs.writeFileSync(destPath, source);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }

    const updatedVersion = syncAppCacheBuster(version);
    const versionNote = updatedVersion ? ` and updated views/app.js cache-buster to v=${version}` : '';
    console.log(`Synced MapLibre GL v${version} assets (${files.join(', ')}) to public/maplibre/${versionNote}.`);
}

main();
