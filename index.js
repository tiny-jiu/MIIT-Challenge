const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { PNG } = require('pngjs');
const CDP = require('chrome-remote-interface');

const OUT_DIR = __dirname;
const API_ORIGIN = 'https://hlwicpfwc.miit.gov.cn';
const TARGET_URL = 'https://beian.miit.gov.cn/#/Integrated/index';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function toGray(image) {
    const data = new Float32Array(image.width * image.height);
    for (let pixel = 0, offset = 0; pixel < data.length; pixel++, offset += 4) {
        data[pixel] = Math.round(
            0.299 * image.data[offset]
            + 0.587 * image.data[offset + 1]
            + 0.114 * image.data[offset + 2]
        );
    }
    return { data, width: image.width, height: image.height };
}

function regionStats(image, x, y, width, height) {
    let sum = 0;
    let squared = 0;
    for (let row = y; row < y + height; row++) {
        for (let column = x; column < x + width; column++) {
            const value = image.data[row * image.width + column];
            sum += value;
            squared += value * value;
        }
    }
    const count = width * height;
    const mean = sum / count;
    const variance = Math.max(0, squared / count - mean * mean);
    return { mean, std: Math.sqrt(variance) };
}

function reflectedPixel(image, x, y) {
    const reflectedX = x < 0 ? -x : x >= image.width ? image.width * 2 - x - 2 : x;
    const reflectedY = y < 0 ? -y : y >= image.height ? image.height * 2 - y - 2 : y;
    return image.data[reflectedY * image.width + reflectedX];
}

function sobelColumns(image, y, height) {
    const columns = new Float64Array(image.width);
    for (let row = y; row < y + height; row++) {
        for (let x = 0; x < image.width; x++) {
            const value = Math.abs(
                -reflectedPixel(image, x - 1, row - 1) + reflectedPixel(image, x + 1, row - 1)
                - 2 * reflectedPixel(image, x - 1, row) + 2 * reflectedPixel(image, x + 1, row)
                - reflectedPixel(image, x - 1, row + 1) + reflectedPixel(image, x + 1, row + 1)
            );
            columns[x] += value / height;
        }
    }
    return columns;
}

function findGap(backgroundBuffer, pieceBuffer, height) {
    const background = toGray(PNG.sync.read(backgroundBuffer));
    const piece = PNG.sync.read(pieceBuffer);
    const pieceWidth = piece.width;
    const pieceHeight = piece.height;
    if (height < 0 || height + pieceHeight > background.height) {
        throw new Error('The puzzle height falls outside the background image.');
    }
    if (pieceWidth > background.width) {
        throw new Error('The puzzle piece is wider than the background image.');
    }

    const candidates = [];
    for (let x = 0; x <= background.width - pieceWidth; x++) {
        const inner = regionStats(background, x, height, pieceWidth, pieceHeight);
        const neighbors = [];
        if (x >= 6) neighbors.push(regionStats(background, x - 6, height, 6, pieceHeight).mean);
        if (x + pieceWidth + 6 <= background.width) {
            neighbors.push(regionStats(background, x + pieceWidth, height, 6, pieceHeight).mean);
        }
        const ringMean = neighbors.length
            ? neighbors.reduce((sum, value) => sum + value, 0) / neighbors.length
            : inner.mean;
        const score = inner.mean - ringMean - inner.std * 0.8;
        candidates.push({ score, x });
    }
    candidates.sort((a, b) => b.score - a.score);

    const scoreLine = new Float64Array(background.width - pieceWidth + 1);
    for (const candidate of candidates) scoreLine[candidate.x] = candidate.score;
    const peak = candidates[0].score;
    const center = candidates[0].x;
    let low = center;
    while (low - 1 >= 0 && scoreLine[low - 1] > peak - 5) low--;
    let high = center;
    while (high + 1 < scoreLine.length && scoreLine[high + 1] > peak - 5) high++;
    let gapX = Math.round((low + high) / 2);

    const edgeColumns = sobelColumns(background, height, pieceHeight);
    const xLow = Math.max(0, gapX - 4);
    const xHigh = Math.min(background.width - 1, gapX + 4);
    let strongest = xLow;
    for (let x = xLow + 1; x <= xHigh; x++) {
        if (edgeColumns[x] > edgeColumns[strongest]) strongest = x;
    }
    gapX = strongest;
    return { value: Math.max(0, Math.min(gapX, 435)), gapX, score: peak };
}

function browserPath() {
    const candidates = [
        process.env.CHROME_PATH,
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ].filter(Boolean);
    const executable = candidates.find(candidate => fs.existsSync(candidate));
    if (!executable) throw new Error('Chrome or Edge was not found. Set CHROME_PATH to a Chromium-based browser.');
    return executable;
}

function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

async function startBrowser() {
    const port = await freePort();
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'miit_chrome_'));
    const browser = spawn(browserPath(), [
        '--headless=new',
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profile}`,
        '--window-size=1440,900',
        TARGET_URL,
    ], { stdio: 'ignore' });

    let launchError = null;
    browser.on('error', error => { launchError = error; });
    try {
        for (let attempt = 0; attempt < 40; attempt++) {
            if (launchError) throw launchError;
            try {
                const targets = await CDP.List({ port, host: '127.0.0.1' });
                const target = targets.find(item => item.type === 'page' && item.url.includes('beian'));
                if (target) {
                    console.log(`Browser started on CDP port ${port}.`);
                    return { browser, profile, port, target };
                }
            } catch (_) {}
            await sleep(500);
        }
        throw new Error('The MIIT page did not become ready on the CDP endpoint.');
    } catch (error) {
        browser.kill();
        try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
        throw error;
    }
}

async function main() {
    const session = await startBrowser();
    let client;
    try {
        client = await CDP({ port: session.port, host: '127.0.0.1', target: session.target });
        const { Runtime } = client;
        await Runtime.enable();

        const dimensions = await Runtime.evaluate({
            expression: `JSON.stringify((function(){const image=document.querySelector('#bgImg');return image?{natural:image.naturalWidth,client:image.clientWidth}:{noImg:true}})())`,
            returnByValue: true,
        });
        console.log(`Background dimensions: ${dimensions.result.value}`);

        const timestamp = Date.now();
        const authKey = crypto.createHash('md5').update(`testtest${timestamp}`).digest('hex');
        const auth = await Runtime.evaluate({
            expression: `(async function(){
                const response=await fetch('${API_ORIGIN}/icpproject_query/api/auth',{
                    method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
                    credentials:'include',body:'authKey=${authKey}&timeStamp=${timestamp}'});
                const body=await response.text();
                return JSON.stringify({status:response.status,body});
            })()`,
            awaitPromise: true,
            returnByValue: true,
        });
        if (typeof auth.result.value !== 'string') {
            throw new Error(`Unexpected auth evaluation result: ${JSON.stringify(auth.result).slice(0, 1000)}`);
        }
        const authResponse = JSON.parse(auth.result.value);
        let authData = null;
        try { authData = JSON.parse(authResponse.body); } catch (_) {}
        const safeAuthBody = authData
            ? JSON.stringify(authData).replace(/"(bussiness|refresh|refreshToken|token|sign)"\s*:\s*"[^"]*"/g, '"$1":"<redacted>"')
            : authResponse.body.slice(0, 1000);
        const token = authData?.params && typeof authData.params.bussiness === 'string'
            ? authData.params.bussiness.trim()
            : '';
        if (!token) throw new Error(`Auth failed: HTTP ${authResponse.status} ${safeAuthBody}`);
        console.log('Token acquired.');
        await sleep(5000);

        const challenge = await Runtime.evaluate({
            expression: `(async function(){
                const response=await fetch('${API_ORIGIN}/icpproject_query/api/image/getCheckImagePoint',{
                    method:'POST',headers:{'Content-Type':'application/json','token':${JSON.stringify(token)}},
                    credentials:'include',body:JSON.stringify({clientUid:'point-'+crypto.randomUUID()})});
                return await response.text();
            })()`,
            awaitPromise: true,
            returnByValue: true,
        });
        const challengeData = JSON.parse(challenge.result.value);
        if (!challengeData.params) throw new Error(`Challenge request failed: ${challenge.result.value.slice(0, 200)}`);

        const backgroundBuffer = Buffer.from(challengeData.params.bigImage, 'base64');
        const pieceBuffer = Buffer.from(challengeData.params.smallImage, 'base64');
        fs.writeFileSync(path.join(OUT_DIR, 'attempt_big.png'), backgroundBuffer);
        fs.writeFileSync(path.join(OUT_DIR, 'attempt_small.png'), pieceBuffer);
        console.log(`Challenge acquired. uuid=${challengeData.params.uuid} height=${challengeData.params.height}`);
        await sleep(5000);

        const detection = findGap(backgroundBuffer, pieceBuffer, challengeData.params.height);
        console.log(`RESULT value=${detection.value} gap_x=${detection.gapX} score=${detection.score.toFixed(1)}`);
        const offset = Number.parseInt(process.env.OFFSET || '0', 10);
        const value = String(detection.value + offset);
        if (offset) console.log(`Applying an offset of ${offset}px. Submitted value=${value}.`);
        await sleep(5000);

        const submission = await Runtime.evaluate({
            expression: `(async function(){
                const response=await fetch('${API_ORIGIN}/icpproject_query/api/image/checkImage',{
                    method:'POST',headers:{'Content-Type':'application/json','token':${JSON.stringify(token)}},
                    credentials:'include',body:JSON.stringify({key:'${challengeData.params.uuid}',value:'${value}'})});
                return response.status+'|'+await response.text();
            })()`,
            awaitPromise: true,
            returnByValue: true,
        });
        console.log(`checkImage value=${value} response=${submission.result.value}`);
        fs.appendFileSync(
            path.join(OUT_DIR, 'attempts.log'),
            `${new Date().toISOString()} value=${value} uuid=${challengeData.params.uuid} -> ${submission.result.value}\n`,
        );
    } finally {
        if (client) {
            try { await client.close(); } catch (_) {}
        }
        session.browser.kill();
        try { fs.rmSync(session.profile, { recursive: true, force: true }); } catch (_) {}
    }
}

module.exports = { findGap };

if (require.main === module) {
    main().catch(error => {
        console.error(error.message);
        process.exit(1);
    });
}
