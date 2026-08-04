import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import express from 'express';

puppeteer.use(StealthPlugin());
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/pinterest', (req, res) => {
    res.json({ message: '✅ Pinterest Panel API готов к работе!' });
});

function parseCookiesInput(raw) {
    const cleaned = (raw || '').replace(/^\uFEFF/, '').replace(/^cookie:\s*/i, '').trim();
    if (!cleaned) return [];

    const sanitize = (c) => {
        if (!c || c.name === undefined) return null;

        const name = String(c.name).trim();
        const value = String(c.value ?? '').trim();
        if (!name) return null;

        const cookieObj = {
            name,
            value,
            domain: (c.domain && String(c.domain).trim()) || '.pinterest.com',
            path: (c.path && String(c.path).trim()) || '/'
        };

        if (c.secure === true) cookieObj.secure = true;
        if (c.httpOnly === true) cookieObj.httpOnly = true;

        if (typeof c.expirationDate === 'number' && isFinite(c.expirationDate) && c.expirationDate > 0) {
            cookieObj.expires = Math.floor(c.expirationDate);
        }

        if (c.sameSite && typeof c.sameSite === 'string') {
            const ss = c.sameSite.toLowerCase();
            if (ss === 'strict') {
                cookieObj.sameSite = 'Strict';
            } else if (ss === 'lax') {
                cookieObj.sameSite = 'Lax';
            } else if (ss === 'none' || ss === 'no_restriction') {
                cookieObj.sameSite = 'None';
                cookieObj.secure = true;
            }
        }

        return cookieObj;
    };

    try {
        const parsed = JSON.parse(cleaned);
        const arr = Array.isArray(parsed)
            ? parsed
            : (parsed && Array.isArray(parsed.cookies) ? parsed.cookies : null);

        if (arr) {
            return arr
                .filter(c => c && c.name !== undefined && c.value !== undefined)
                .map(sanitize)
                .filter(Boolean);
        }
    } catch (e) {}

    return cleaned.split(';').map(part => part.trim()).filter(Boolean).map(pair => {
        const idx = pair.indexOf('=');
        if (idx === -1) return null;
        return sanitize({
            name: pair.slice(0, idx).trim(),
            value: pair.slice(idx + 1).trim(),
            domain: '.pinterest.com',
            path: '/'
        });
    }).filter(Boolean);
}

async function setCookiesSafely(page, cookieObjects) {
    const failed = [];
    for (const cookie of cookieObjects) {
        try {
            await page.setCookie(cookie);
        } catch (err) {
            failed.push({ name: cookie.name, error: err.message });
        }
    }
    return failed;
}

app.get('/api/proxy-check', async (req, res) => {
    const proxy = req.query.proxy;
    if (!proxy) {
        return res.status(400).json({ success: false, error: 'Добавьте ?proxy=http://user:pass@host:port в адрес' });
    }

    let proxyStr = String(proxy).trim().replace(/^[a-zA-Z0-9]+:\/\//, '');
    let host, port, username, password;

    if (proxyStr.includes('@')) {
        const [creds, hostPort] = proxyStr.split('@');
        [username, password] = creds.split(':');
        [host, port] = hostPort.split(':');
    } else {
        const parts = proxyStr.split(':');
        if (parts.length === 4) [host, port, username, password] = parts;
        else if (parts.length === 2) [host, port] = parts;
    }

    if (!host || !port) {
        return res.status(400).json({ success: false, error: 'Не удалось разобрать proxy строку. Проверьте формат.' });
    }

    let browser = null;
    const result = { proxyHost: host, proxyPort: port };

    try {
        browser = await puppeteer.launch({
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', `--proxy-server=${host}:${port}`],
            headless: 'new',
        });
        const page = await browser.newPage();
        if (username && password) {
            await page.authenticate({ username, password });
        }
        page.setDefaultNavigationTimeout(15000);

        try {
            const ipResp = await page.goto('https://api.ipify.org?format=json', { waitUntil: 'networkidle2' });
            result.step1_proxyAlive = true;
            result.step1_outboundIp = JSON.parse(await ipResp.text()).ip;
        } catch (e) {
            result.step1_proxyAlive = false;
            result.step1_error = e.message;
        }

        if (result.step1_proxyAlive) {
            try {
                const pinResp = await page.goto('https://www.pinterest.com/', { waitUntil: 'networkidle2' });
                result.step2_pinterestStatus = pinResp.status();
                result.step2_pinterestOk = pinResp.status() < 400;
            } catch (e) {
                result.step2_pinterestOk = false;
                result.step2_error = e.message;
            }
        }

        await browser.close();
        return res.json({ success: true, result });
    } catch (error) {
        if (browser) try { await browser.close(); } catch (e) {}
        return res.status(500).json({ success: false, error: error.message, result });
    }
});

app.post('/api/pinterest', async (req, res) => {
    const { action, proxy, cookies, board, title, description, link, alt, image } = req.body;
    const cookieObjects = parseCookiesInput(cookies);
    if (!cookieObjects.length) return res.status(400).json({ success: false, error: '❌ Куки пустые или не распознаны.' });

    let browser = null;
    try {
        let proxyServerArg = null;
        let proxyAuth = null;

        if (proxy) {
            let proxyStr = typeof proxy === 'string' ? proxy.trim() : '';
            proxyStr = proxyStr.replace(/^[a-zA-Z0-9]+:\/\//, '');
            let host, port, username, password;

            if (typeof proxy === 'object') {
                ({ host, port, username, password } = proxy);
            } else if (proxyStr.includes('@')) {
                const [creds, hostPort] = proxyStr.split('@');
                [username, password] = creds.split(':');
                [host, port] = hostPort.split(':');
            } else {
                const parts = proxyStr.split(':');
                if (parts.length === 4) {
                    [host, port, username, password] = parts;
                } else if (parts.length === 2) {
                    [host, port] = parts;
                }
            }

            if (host && port) {
                proxyServerArg = `${host}:${port}`;
                if (username && password) {
                    proxyAuth = { username, password };
                }
            }
        }

        const launchArgs = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'];
        if (proxyServerArg) {
            launchArgs.push(`--proxy-server=${proxyServerArg}`);
        } else {
            console.warn('⚠️ Прокси не передан или не распознан — запрос пойдёт с IP сервера.');
        }

        browser = await puppeteer.launch({
            args: launchArgs,
            headless: 'new',
        });

        const browserContext = typeof browser.createBrowserContext === 'function'
            ? await browser.createBrowserContext()
            : await browser.createIncognitoBrowserContext();
        const page = await browserContext.newPage();

        if (proxyAuth) {
            await page.authenticate(proxyAuth);
        }

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
        await page.setViewport({ width: 1366, height: 768 });

        const failedCookies = await setCookiesSafely(page, cookieObjects);

        if (failedCookies.length) {
            console.warn('⚠️ Не удалось установить куки:', failedCookies);
        }

        if (failedCookies.length === cookieObjects.length) {
            await browser.close();
            return res.status(400).json({
                success: false,
                error: '❌ Ни одна кука не установлена: ' + JSON.stringify(failedCookies)
            });
        }

        let outboundIp = 'неизвестно';
        try {
            await page.goto('https://api.ipify.org?format=json', { waitUntil: 'networkidle2', timeout: 20000 });
            const ipBody = await page.evaluate(() => document.body.innerText);
            outboundIp = JSON.parse(ipBody).ip;
            console.log('🌐 Исходящий IP браузера:', outboundIp);
        } catch (e) {
            console.warn('⚠️ Не удалось проверить исходящий IP:', e.message);
        }

        await page.goto('https://www.pinterest.com/', { waitUntil: 'networkidle2', timeout: 60000 });

        const csrftoken = await page.evaluate(() => {
            const match = document.cookie.match(/csrftoken=([^;]+)/);
            return match ? match[1] : '';
        });

        if (!csrftoken) {
            await browser.close();
            return res.status(400).json({ success: false, error: '❌ Сессия не активна (нет куки авторизации или они устарели).' });
        }

        if (['add', 'update', 'info', 'token'].includes(action)) {
            const userInfo = await page.evaluate(async (token) => {
                const resp = await fetch('https://www.pinterest.com/resource/UserResource/get/?source_url=/&data={"options":{"field_set_key":"profile"},"context":{}}', {
                    headers: { 'X-Requested-With': 'XMLHttpRequest', 'X-CSRFToken': token }
                });

                const rawText = await resp.text();
                let parsed = null;
                try {
                    parsed = JSON.parse(rawText);
                } catch (e) {
                    return { ok: false, status: resp.status, rawText: rawText.slice(0, 300) };
                }

                return { ok: resp.ok, status: resp.status, data: parsed };
            }, csrftoken);

            if (!userInfo.ok || !userInfo.data) {
                await browser.close();
                return res.status(400).json({
                    success: false,
                    error: `❌ Pinterest вернул некорректный ответ (статус ${userInfo.status}): ${userInfo.rawText || 'нет тела ответа'}`,
                    debugOutboundIp: outboundIp
                });
            }

            const user = userInfo.data?.resource_response?.data || {};
            await browser.close();
            return res.json({ success: true, message: `✅ Аккаунт подключен!`, username: user.username || 'user' });
        }

        await browser.close();
        return res.status(400).json({ success: false, error: '❌ Неизвестное действие.' });
    } catch (error) {
        if (browser) try { await browser.close(); } catch (e) {}
        return res.status(500).json({ success: false, error: '❌ Ошибка: ' + error.message });
    }
});

const port = process.env.PORT || 8080;
app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Pinterest Panel запущен на порту ${port}`);
});
