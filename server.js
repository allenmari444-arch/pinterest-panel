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
            name, value,
            domain: (c.domain && String(c.domain).trim()) || '.pinterest.com',
            path: (c.path && String(c.path).trim()) || '/'
        };
        if (c.secure === true) cookieObj.secure = true;
        if (c.httpOnly === true) cookieObj.httpOnly = true;
        if (typeof c.expirationDate === 'number' && isFinite(c.expirationDate) && c.expirationDate > 0)
            cookieObj.expires = Math.floor(c.expirationDate);
        if (c.sameSite && typeof c.sameSite === 'string') {
            const ss = c.sameSite.toLowerCase();
            if (ss === 'strict') cookieObj.sameSite = 'Strict';
            else if (ss === 'lax') cookieObj.sameSite = 'Lax';
            else if (ss === 'none' || ss === 'no_restriction') { cookieObj.sameSite = 'None'; cookieObj.secure = true; }
        }
        return cookieObj;
    };

    try {
        const parsed = JSON.parse(cleaned);
        const arr = Array.isArray(parsed) ? parsed : (parsed?.cookies || null);
        if (arr) return arr.filter(c => c?.name !== undefined && c?.value !== undefined).map(sanitize).filter(Boolean);
    } catch (e) {}

    return cleaned.split(';').map(p => p.trim()).filter(Boolean).map(pair => {
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

async function launchBrowser(proxy) {
    let proxyServerArg = null, proxyAuth = null;
    if (proxy) {
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
        if (host && port) {
            proxyServerArg = `${host}:${port}`;
            if (username && password) proxyAuth = { username, password };
        }
    }
    const args = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'];
    if (proxyServerArg) args.push(`--proxy-server=${proxyServerArg}`);
    const browser = await puppeteer.launch({ args, headless: 'new' });
    return { browser, proxyAuth };
}

async function setupPage(browser, proxyAuth, cookieObjects) {
    const ctx = typeof browser.createBrowserContext === 'function'
        ? await browser.createBrowserContext()
        : await browser.createIncognitoBrowserContext();
    const page = await ctx.newPage();
    if (proxyAuth) await page.authenticate(proxyAuth);
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    await page.setViewport({ width: 1366, height: 768 });
    await setCookiesSafely(page, cookieObjects);
    return page;
}

// Вызов Pinterest API изнутри страницы (браузерный контекст)
async function pinterestFetch(page, url, options = {}) {
    return await page.evaluate(async (url, options) => {
        try {
            const resp = await fetch(url, {
                ...options,
                credentials: 'same-origin'
            });
            const text = await resp.text();
            try { return { ok: resp.ok, status: resp.status, data: JSON.parse(text) }; }
            catch (e) { return { ok: false, status: resp.status, raw: text.slice(0, 500) }; }
        } catch (e) {
            return { ok: false, status: 0, raw: e.message };
        }
    }, url, options);
}

app.post('/api/pinterest', async (req, res) => {
    const { action, proxy, cookies, board, title, description, link, alt, image } = req.body;
    const cookieObjects = parseCookiesInput(cookies);
    if (!cookieObjects.length) return res.status(400).json({ success: false, error: '❌ Куки пустые или не распознаны.' });

    let browser = null;
    try {
        const { browser: b, proxyAuth } = await launchBrowser(proxy);
        browser = b;
        const page = await setupPage(browser, proxyAuth, cookieObjects);

        // Загружаем главную страницу Pinterest
        await page.goto('https://www.pinterest.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
        await new Promise(r => setTimeout(r, 2000));

        // Проверяем авторизацию
        const authCheck = await page.evaluate(() => {
            const csrfMatch = document.cookie.match(/csrftoken=([^;]+)/);
            const authMatch = document.cookie.match(/_auth=([^;]+)/);
            return {
                csrftoken: csrfMatch ? csrfMatch[1] : '',
                authValue: authMatch ? authMatch[1] : ''
            };
        });

        if (!authCheck.csrftoken) {
            await browser.close();
            return res.status(400).json({ success: false, error: '❌ Сессия не активна.' });
        }
        if (authCheck.authValue !== '1') {
            await browser.close();
            return res.status(400).json({ success: false, error: '❌ Куки устарели (нет _auth=1). Экспортируйте куки заново.' });
        }

        const csrf = authCheck.csrftoken;
        const baseHeaders = {
            'X-Requested-With': 'XMLHttpRequest',
            'X-CSRFToken': csrf,
            'Accept': 'application/json, text/javascript, */*; q=0.01',
            'X-APP-VERSION': 'b848fbb',
            'X-Pinterest-AppState': 'active'
        };

        if (['add', 'update', 'info', 'token'].includes(action)) {
            let username = null, fullAccount = {}, boards = [];

            // Шаг 1: получаем username из HTML страницы
            username = await page.evaluate(() => {
                const m = document.documentElement.innerHTML.match(/"username"\s*:\s*"([^"]+)"/);
                return m ? m[1] : null;
            });

            // Шаг 2: получаем инфо через UserResource с правильным source_url
            const userUrl = 'https://www.pinterest.com/resource/UserResource/get/?source_url=%2F&data=' +
                encodeURIComponent(JSON.stringify({ options: { field_set_key: 'profile' }, context: {} }));
            const userResp = await pinterestFetch(page, userUrl, { headers: baseHeaders });

            if (userResp.ok && userResp.data?.resource_response?.data) {
                const u = userResp.data.resource_response.data;
                username = u.username || username;
                fullAccount = {
                    id: u.id,
                    full_name: u.full_name,
                    username: u.username,
                    profile_pic: u.image_xlarge_url || u.image_medium_url || null,
                    created_at: u.created_at,
                    pin_count: u.pin_count
                };
            }

            // Шаг 3: получаем доски — сначала через API, потом через навигацию
            if (username) {
                const boardsUrl = 'https://www.pinterest.com/resource/BoardsResource/get/?source_url=' +
                    encodeURIComponent('/' + username + '/boards/') + '&data=' +
                    encodeURIComponent(JSON.stringify({ options: { username, field_set_key: 'grid_item', filter_stories: false }, context: {} }));

                // Переходим на страницу досок перед запросом (как это делает браузер)
                await page.goto(`https://www.pinterest.com/${username}/boards/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
                await new Promise(r => setTimeout(r, 2000));

                // Обновляем csrf после перехода
                const newCsrf = await page.evaluate(() => {
                    const m = document.cookie.match(/csrftoken=([^;]+)/);
                    return m ? m[1] : '';
                });
                const boardsHeaders = { ...baseHeaders, 'X-CSRFToken': newCsrf || csrf };

                const boardsResp = await pinterestFetch(page, boardsUrl, { headers: boardsHeaders });

                if (boardsResp.ok && Array.isArray(boardsResp.data?.resource_response?.data)) {
                    boards = boardsResp.data.resource_response.data.map(b => ({
                        id: b.id,
                        name: b.name,
                        url: `https://www.pinterest.com${b.url || '/' + username + '/' + (b.slug || '') + '/'}`,
                        cover: b.image_thumbnail_url || b.image_cover_url || null,
                        pin_count: b.pin_count ?? null
                    }));
                } else {
                    // Запасной: парсим доски прямо из HTML страницы досок
                    try {
                        await page.waitForFunction(() =>
                            Array.from(document.querySelectorAll('a[href]')).some(a => {
                                const p = (a.getAttribute('href') || '').split('/').filter(Boolean);
                                return p.length === 2 && !['boards','pins','following','followers'].includes(p[1]);
                            }), { timeout: 10000 });
                    } catch(e) {}
                    await new Promise(r => setTimeout(r, 1000));
                    boards = await page.evaluate(() => {
                        const results = [], seen = new Set();
                        for (const a of document.querySelectorAll('a[href]')) {
                            const href = a.getAttribute('href') || '';
                            const parts = href.split('/').filter(Boolean);
                            if (parts.length === 2) {
                                const slug = parts[1];
                                if (!seen.has(slug) && !['boards','pins','following','followers','_saved','boards_feed'].includes(slug)) {
                                    seen.add(slug);
                                    results.push({ id: slug, name: (a.textContent || '').trim() || slug, pin_count: null, url: `https://www.pinterest.com${href}` });
                                }
                            }
                        }
                        return results.slice(0, 100);
                    });
                }
            }

            await browser.close();
            return res.json({
                success: true,
                message: '✅ Аккаунт подключен!',
                username: username || 'user',
                token: csrf,
                csrftoken: csrf,
                account: fullAccount,
                boards
            });
        }

        if (action === 'test' || action === 'pin') {
            if (!board || !image) {
                await browser.close();
                return res.status(400).json({ success: false, error: '❌ Нужны board (Board ID) и image (URL картинки).' });
            }

            // Переходим на pin-builder как настоящий пользователь
            await page.goto('https://www.pinterest.com/pin-builder/', { waitUntil: 'domcontentloaded', timeout: 30000 });
            await new Promise(r => setTimeout(r, 1500));

            const newCsrf = await page.evaluate(() => {
                const m = document.cookie.match(/csrftoken=([^;]+)/);
                return m ? m[1] : '';
            });

            const pinResp = await pinterestFetch(page, 'https://www.pinterest.com/resource/PinResource/create/', {
                method: 'POST',
                headers: {
                    ...baseHeaders,
                    'X-CSRFToken': newCsrf || csrf,
                    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
                },
                body: new URLSearchParams({
                    source_url: '/pin-builder/',
                    data: JSON.stringify({
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
                    })
                }).toString()
            });

            await browser.close();

            if (pinResp.ok && pinResp.data?.resource_response?.data) {
                const pin = pinResp.data.resource_response.data;
                return res.json({
                    success: true,
                    message: '✅ Пин опубликован!',
                    pinId: pin.id,
                    pinUrl: pin.id ? `https://www.pinterest.com/pin/${pin.id}/` : undefined
                });
            } else {
                return res.status(400).json({
                    success: false,
                    error: `❌ Ошибка публикации (${pinResp.status}): ${pinResp.raw || JSON.stringify(pinResp.data)?.slice(0, 400) || 'нет деталей'}`
                });
            }
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
