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
            if (ss === 'strict') cookieObj.sameSite = 'Strict';
            else if (ss === 'lax') cookieObj.sameSite = 'Lax';
            else if (ss === 'none' || ss === 'no_restriction') {
                cookieObj.sameSite = 'None';
                cookieObj.secure = true;
            }
        }
        return cookieObj;
    };

    try {
        const parsed = JSON.parse(cleaned);
        const arr = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.cookies) ? parsed.cookies : null);
        if (arr) {
            return arr.filter(c => c && c.name !== undefined && c.value !== undefined).map(sanitize).filter(Boolean);
        }
    } catch (e) {}

    return cleaned.split(';').map(part => part.trim()).filter(Boolean).map(pair => {
        const idx = pair.indexOf('=');
        if (idx === -1) return null;
        return sanitize({ name: pair.slice(0, idx).trim(), value: pair.slice(idx + 1).trim(), domain: '.pinterest.com', path: '/' });
    }).filter(Boolean);
}

async function setCookiesSafely(page, cookieObjects) {
    const failed = [];
    for (const cookie of cookieObjects) {
        try { await page.setCookie(cookie); }
        catch (err) { failed.push({ name: cookie.name, error: err.message }); }
    }
    return failed;
}

app.get('/api/proxy-check', async (req, res) => {
    const proxy = req.query.proxy;
    if (!proxy) return res.status(400).json({ success: false, error: 'Добавьте ?proxy=http://user:pass@host:port в адрес' });

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

    if (!host || !port) return res.status(400).json({ success: false, error: 'Не удалось разобрать proxy строку.' });

    let browser = null;
    const result = { proxyHost: host, proxyPort: port };
    try {
        browser = await puppeteer.launch({
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', `--proxy-server=${host}:${port}`],
            headless: 'new',
        });
        const page = await browser.newPage();
        if (username && password) await page.authenticate({ username, password });
        page.setDefaultNavigationTimeout(15000);

        try {
            const ipResp = await page.goto('https://api.ipify.org?format=json', { waitUntil: 'domcontentloaded' });
            result.step1_proxyAlive = true;
            result.step1_outboundIp = JSON.parse(await ipResp.text()).ip;
        } catch (e) {
            result.step1_proxyAlive = false;
            result.step1_error = e.message;
        }

        if (result.step1_proxyAlive) {
            try {
                const pinResp = await page.goto('https://www.pinterest.com/', { waitUntil: 'domcontentloaded' });
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
                if (username && password) proxyAuth = { username, password };
            }
        }

        const launchArgs = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'];
        if (proxyServerArg) launchArgs.push(`--proxy-server=${proxyServerArg}`);
        else console.warn('⚠️ Прокси не передан или не распознан.');

        browser = await puppeteer.launch({ args: launchArgs, headless: 'new' });

        const browserContext = typeof browser.createBrowserContext === 'function'
            ? await browser.createBrowserContext()
            : await browser.createIncognitoBrowserContext();
        const page = await browserContext.newPage();

        if (proxyAuth) await page.authenticate(proxyAuth);

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
        await page.setViewport({ width: 1366, height: 768 });

        const failedCookies = await setCookiesSafely(page, cookieObjects);
        if (failedCookies.length) console.warn('⚠️ Не удалось установить куки:', failedCookies);
        if (failedCookies.length === cookieObjects.length) {
            await browser.close();
            return res.status(400).json({ success: false, error: '❌ Ни одна кука не установлена: ' + JSON.stringify(failedCookies) });
        }

        let outboundIp = 'неизвестно';
        try {
            await page.goto('https://api.ipify.org?format=json', { waitUntil: 'domcontentloaded', timeout: 20000 });
            const ipBody = await page.evaluate(() => document.body.innerText);
            outboundIp = JSON.parse(ipBody).ip;
        } catch (e) {
            console.warn('⚠️ Не удалось проверить исходящий IP:', e.message);
        }

        await page.goto('https://www.pinterest.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
        await new Promise(r => setTimeout(r, 2000));

        const authCheck = await page.evaluate(() => {
            const csrfMatch = document.cookie.match(/csrftoken=([^;]+)/);
            const authMatch = document.cookie.match(/_auth=([^;]+)/);
            return {
                csrftoken: csrfMatch ? csrfMatch[1] : '',
                authValue: authMatch ? authMatch[1] : '',
                allCookieNames: document.cookie.split(';').map(c => c.trim().split('=')[0])
            };
        });

        const csrftoken = authCheck.csrftoken;
        if (!csrftoken) {
            await browser.close();
            return res.status(400).json({ success: false, error: '❌ Сессия не активна.' });
        }

        if (authCheck.authValue !== '1') {
            await browser.close();
            return res.status(400).json({
                success: false,
                error: '❌ Куки устарели: сессия анонимная (нет _auth=1).',
                debugOutboundIp: outboundIp,
                debugCookieNamesFound: authCheck.allCookieNames
            });
        }

        async function callPinterestResourceGet(resourceName, dataObj, token) {
            return await page.evaluate(async (resourceName, dataObj, token) => {
                const url = `https://www.pinterest.com/resource/${resourceName}/get/?source_url=%2F&data=${encodeURIComponent(JSON.stringify(dataObj))}`;
                try {
                    const resp = await fetch(url, {
                        headers: {
                            'X-Requested-With': 'XMLHttpRequest',
                            'X-CSRFToken': token,
                            'Accept': 'application/json, text/javascript, */*, q=0.01'
                        },
                        credentials: 'same-origin'
                    });
                    const rawText = await resp.text();
                    try { return { ok: resp.ok, status: resp.status, data: JSON.parse(rawText) }; }
                    catch (e) { return { ok: false, status: resp.status, rawText: rawText.slice(0, 400) }; }
                } catch (e) {
                    return { ok: false, status: 0, rawText: e.message };
                }
            }, resourceName, dataObj, token);
        }

        async function callPinterestResourcePost(resourceName, dataObj, token) {
            return await page.evaluate(async (resourceName, dataObj, token) => {
                const url = `https://www.pinterest.com/resource/${resourceName}/create/`;
                const body = new URLSearchParams({
                    source_url: '/pin-builder/',
                    data: JSON.stringify(dataObj)
                });
                try {
                    const resp = await fetch(url, {
                        method: 'POST',
                        headers: {
                            'X-Requested-With': 'XMLHttpRequest',
                            'X-CSRFToken': token,
                            'Accept': 'application/json, text/javascript, */*, q=0.01',
                            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
                        },
                        credentials: 'same-origin',
                        body: body.toString()
                    });
                    const rawText = await resp.text();
                    try { return { ok: resp.ok, status: resp.status, data: JSON.parse(rawText) }; }
                    catch (e) { return { ok: false, status: resp.status, rawText: rawText.slice(0, 500) }; }
                } catch (e) {
                    return { ok: false, status: 0, rawText: e.message };
                }
            }, resourceName, dataObj, token);
        }

        if (action === 'test' || action === 'pin') {
            if (!board || !image) {
                await browser.close();
                return res.status(400).json({ success: false, error: '❌ Не хватает обязательных полей: board (Board ID) и image (URL картинки).' });
            }

            const pinResp = await callPinterestResourcePost('PinResource', {
                options: {
                    board_id: String(board),
                    title: title || '',
                    description: description || '',
                    link: link || '',
                    alt_text: alt || '',
                    image_url: image,
                    method: 'scraped'
                },
                context: {}
            }, csrftoken);

            await browser.close();

            if (pinResp.ok && pinResp.data?.resource_response?.data) {
                const pin = pinResp.data.resource_response.data;
                return res.json({
                    success: true,
                    message: '✅ Пин опубликован!',
                    pinId: pin.id,
                    pinUrl: pin.id ? `https://www.pinterest.com/pin/${pin.id}/` : undefined,
                    debugOutboundIp: outboundIp
                });
            } else {
                return res.status(400).json({
                    success: false,
                    error: `❌ Pinterest отклонил публикацию (статус ${pinResp.status}): ${pinResp.rawText || JSON.stringify(pinResp.data)?.slice(0, 400) || 'нет деталей'}`,
                    debugOutboundIp: outboundIp
                });
            }
        }

        if (['add', 'update', 'info', 'token'].includes(action)) {
            let username = null, fullAccount = {};
            let boards = [];
            let apiNote = null;

            const userResp = await callPinterestResourceGet('UserResource', { options: { field_set_key: 'profile' }, context: {} }, csrftoken);
            if (userResp.ok && userResp.data?.resource_response?.data) {
                const u = userResp.data.resource_response.data;
                username = u.username;
                fullAccount = {
                    id: u.id,
                    full_name: u.full_name,
                    profile_pic: u.image_xlarge_url || u.image_medium_url || null,
                    created_at: u.created_at,
                    pin_count: u.pin_count
                };
            } else {
                apiNote = `UserResource: статус ${userResp.status} — ${userResp.rawText || ''}`;
                username = await page.evaluate(() => {
                    const html = document.documentElement.innerHTML;
                    const m = html.match(/"username"\s*:\s*"([^"]+)"/);
                    return m ? m[1] : null;
                });
            }

            if (username) {
                const boardsResp = await callPinterestResourceGet('BoardsResource', {
                    options: { username, field_set_key: 'grid_item', filter_stories: false },
                    context: {}
                }, csrftoken);

                if (boardsResp.ok && Array.isArray(boardsResp.data?.resource_response?.data)) {
                    boards = boardsResp.data.resource_response.data.map(b => ({
                        id: b.id,
                        name: b.name,
                        url: `https://www.pinterest.com${b.url || '/' + username + '/' + (b.slug || '') + '/'}`,
                        cover: b.image_thumbnail_url || b.image_cover_url || null,
                        pin_count: b.pin_count ?? null
                    }));
                } else {
                    apiNote = (apiNote ? apiNote + ' | ' : '') + `BoardsResource: статус ${boardsResp.status} — ${boardsResp.rawText || ''}`;
                    try {
                        await page.goto(`https://www.pinterest.com/${username}/boards/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
                        await new Promise(r => setTimeout(r, 1500));
                        boards = await page.evaluate(() => {
                            const results = [];
                            const seen = new Set();
                            const links = Array.from(document.querySelectorAll('a[href]'));
                            for (const a of links) {
                                const href = a.getAttribute('href') || '';
                                const parts = href.split('/').filter(Boolean);
                                if (parts.length === 2) {
                                    const slug = parts[1];
                                    if (!seen.has(slug) && !['boards', 'pins', 'following', 'followers', '_saved', 'boards_feed'].includes(slug)) {
                                        seen.add(slug);
                                        const name = (a.textContent || '').trim() || slug;
                                        results.push({ id: slug, name, pin_count: null, url: `https://www.pinterest.com${href}` });
                                    }
                                }
                            }
                            return results.slice(0, 100);
                        });
                    } catch (e) {}
                }
            }

            await browser.close();
            return res.json({
                success: true,
                message: `✅ Аккаунт подключен!`,
                username: username || 'user',
                token: csrftoken,
                csrftoken,
                account: fullAccount,
                boards,
                debugOutboundIp: outboundIp,
                note: apiNote || undefined
            });
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
