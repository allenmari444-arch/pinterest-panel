// api/pinterest.js
import chromium from '@sparticuz/chromium';
import { chromium as playwrightChromium } from 'playwright-core';

export const config = {
    maxDuration: 60
};

function parseCookiesInput(raw) {
    const cleaned = (raw || '').replace(/^\uFEFF/, '').replace(/^cookie:\s*/i, '').trim();
    if (!cleaned) return [];

    try {
        const parsed = JSON.parse(cleaned);
        const arr = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.cookies) ? parsed.cookies : null);
        if (arr) {
            return arr
                .filter(c => c && c.name !== undefined && c.value !== undefined)
                .map(c => ({
                    name: c.name,
                    value: String(c.value),
                    domain: c.domain || (c.hostOnly ? 'www.pinterest.com' : '.pinterest.com'),
                    path: c.path || '/',
                    httpOnly: !!c.httpOnly,
                    secure: c.secure !== undefined ? !!c.secure : true,
                    sameSite: c.sameSite === 'no_restriction' ? 'None' : (c.sameSite || 'Lax'),
                    ...(c.expirationDate ? { expires: Math.floor(c.expirationDate) } : {})
                }));
        }
    } catch (e) {}

    return cleaned.split(';').map(part => part.trim()).filter(Boolean).map(pair => {
        const idx = pair.indexOf('=');
        if (idx === -1) return null;
        return {
            name: pair.slice(0, idx).trim(),
            value: pair.slice(idx + 1).trim(),
            domain: '.pinterest.com',
            path: '/',
            secure: true,
            sameSite: 'Lax'
        };
    }).filter(Boolean);
}

function parseProxy(proxyStr) {
    if (!proxyStr || !proxyStr.trim()) return null;
    let str = proxyStr.trim();
    if (!/^https?:\/\//.test(str) && !/^socks/.test(str)) str = 'http://' + str;
    try {
        const u = new URL(str);
        const server = `${u.protocol}//${u.hostname}:${u.port}`;
        const result = { server };
        if (u.username) result.username = decodeURIComponent(u.username);
        if (u.password) result.password = decodeURIComponent(u.password);
        return result;
    } catch (e) {
        return null;
    }
}

async function launchBrowser(proxy) {
    const launchOptions = {
        args: [
            ...chromium.args,
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
            '--window-size=1920,1080',
            '--disable-blink-features=AutomationControlled',
            '--disable-features=IsolateOrigins,site-per-process',
            '--disable-site-isolation-trials',
            '--disable-web-security',
            '--disable-features=BlockInsecurePrivateNetworkRequests',
        ],
        executablePath: await chromium.executablePath(),
        headless: true,
        ignoreDefaultArgs: ['--enable-automation'],
    };
    if (proxy) launchOptions.proxy = proxy;
    return await playwrightChromium.launch(launchOptions);
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, error: 'Method not allowed' });
    }

    const { action, proxy, cookies, board, title, description, link, alt, image } = req.body;

    const cookieObjects = parseCookiesInput(cookies);
    if (!cookieObjects.length) {
        return res.status(400).json({ 
            success: false, 
            error: '❌ Куки пустые или не распознаны.' 
        });
    }

    const hasSession = cookieObjects.some(c => 
        c.name === '_pinterest_sess' || c.name === '__Secure-s_a'
    );
    
    if (!hasSession) {
        return res.status(400).json({ 
            success: false, 
            error: '❌ В куках нет сессионных cookie. Переэкспортируйте куки из активной сессии.' 
        });
    }

    const proxyConfig = parseProxy(proxy);
    let browser = null;
    let page = null;

    try {
        browser = await launchBrowser(proxyConfig);
        
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
            viewport: { width: 1920, height: 1080 },
            locale: 'en-US',
            timezoneId: 'America/New_York',
            extraHTTPHeaders: {
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Sec-Fetch-User': '?1',
                'Cache-Control': 'max-age=0',
            }
        });
        
        await context.addCookies(cookieObjects);
        page = await context.newPage();

        await page.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
            Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en', 'es'] });
            window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} };
        });

        await page.goto('https://www.pinterest.com/', { 
            waitUntil: 'networkidle', 
            timeout: 60000 
        });
        
        await page.waitForTimeout(2000);

        const loginCheck = await page.evaluate(() => {
            const hasCsrf = document.cookie.includes('csrftoken');
            const hasProfile = !!document.querySelector('[data-test-id="profile-image"]');
            const hasAvatar = !!document.querySelector('img[alt*="profile"]');
            const hasUserMenu = !!document.querySelector('[data-test-id="user-menu"]');
            return { hasCsrf, hasProfile, hasAvatar, hasUserMenu };
        });

        if (!loginCheck.hasCsrf || !(loginCheck.hasProfile || loginCheck.hasAvatar || loginCheck.hasUserMenu)) {
            await browser.close();
            return res.status(400).json({ 
                success: false, 
                error: '❌ Сессия не активна. Выйдите и заново войдите в Pinterest, затем экспортируйте куки.' 
            });
        }

        const csrftoken = await page.evaluate(() => {
            const match = document.cookie.match(/csrftoken=([^;]+)/);
            return match ? match[1] : '';
        });

        if (['add', 'update', 'info', 'token'].includes(action)) {
            const userInfo = await page.evaluate(async (token) => {
                try {
                    const response = await fetch('https://www.pinterest.com/resource/UserResource/get/?source_url=/&data={"options":{"field_set_key":"profile"},"context":{}}', {
                        headers: {
                            'X-Requested-With': 'XMLHttpRequest',
                            'X-CSRFToken': token,
                            'Accept': 'application/json',
                        },
                        credentials: 'include'
                    });
                    return await response.json();
                } catch (e) {
                    return null;
                }
            }, csrftoken);

            if (!userInfo || !userInfo.resource_response) {
                await browser.close();
                return res.status(400).json({ 
                    success: false, 
                    error: '❌ Не удалось получить данные пользователя.' 
                });
            }

            const user = userInfo.resource_response.data;
            const username = user.username || user.id;

            let boards = [];
            try {
                const boardsData = await page.evaluate(async (uname, token) => {
                    try {
                        const url = `https://www.pinterest.com/resource/BoardsResource/get/?source_url=/${uname}/&data=${encodeURIComponent(JSON.stringify({
                            options: {
                                username: uname,
                                field_set_key: 'grid_item',
                                filter_stories: false
                            },
                            context: {}
                        }))}`;
                        const response = await fetch(url, {
                            headers: {
                                'X-Requested-With': 'XMLHttpRequest',
                                'X-CSRFToken': token,
                                'Accept': 'application/json',
                            },
                            credentials: 'include'
                        });
                        return await response.json();
                    } catch (e) {
                        return null;
                    }
                }, username, csrftoken);
                
                const list = boardsData?.resource_response?.data || [];
                boards = list.map(b => ({ 
                    id: b.id, 
                    name: b.name, 
                    pin_count: b.pin_count || 0,
                    description: b.description || ''
                }));
            } catch (e) {}

            await browser.close();

            let msg = `✅ Аккаунт @${username} успешно добавлен!`;
            if (action === 'update') msg = `✅ Данные @${username} обновлены!`;
            if (action === 'token') msg = `🔑 CSRF токен: ${csrftoken}`;
            if (action === 'info') msg = `📊 @${username}: ${boards.length} досок`;

            return res.status(200).json({
                success: true,
                message: msg,
                token: csrftoken,
                username,
                id: user.id || null,
                full_name: user.full_name || username,
                boards
            });
        }

        if (action === 'pin' || action === 'test') {
            if (!board) {
                await browser.close();
                return res.status(400).json({ success: false, error: '❌ Не указана доска!' });
            }
            if (!title) {
                await browser.close();
                return res.status(400).json({ success: false, error: '❌ Не указан заголовок!' });
            }
            if (!image) {
                await browser.close();
                return res.status(400).json({ success: false, error: '❌ Не указан Image URL!' });
            }

            try {
                const head = await fetch(image, { method: 'HEAD' });
                if (!head.ok) {
                    await browser.close();
                    return res.status(400).json({ 
                        success: false, 
                        error: `❌ Изображение недоступно (HTTP ${head.status})` 
                    });
                }
            } catch (e) {
                await browser.close();
                return res.status(400).json({ 
                    success: false, 
                    error: `❌ Не удалось проверить изображение: ${e.message}` 
                });
            }

            const result = await page.evaluate(async ({ board, title, description, link, alt, image, token }) => {
                try {
                    const payload = {
                        options: {
                            board_id: board,
                            title: title.substring(0, 100),
                            description: description ? description.substring(0, 600) : '',
                            link: link || '',
                            alt_text: alt || '',
                            media_source: {
                                source_type: 'image_url',
                                url: image
                            }
                        },
                        context: {}
                    };

                    const response = await fetch('https://www.pinterest.com/resource/PinResource/create/', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-Requested-With': 'XMLHttpRequest',
                            'X-CSRFToken': token,
                            'Accept': 'application/json',
                            'Origin': 'https://www.pinterest.com',
                            'Referer': 'https://www.pinterest.com/',
                        },
                        credentials: 'include',
                        body: JSON.stringify(payload)
                    });

                    const data = await response.json();
                    
                    if (data.resource_response?.data?.id) {
                        return { 
                            success: true, 
                            pin_id: data.resource_response.data.id 
                        };
                    }
                    
                    return { 
                        success: false, 
                        error: data.resource_response?.error?.message || 'Неизвестная ошибка' 
                    };
                } catch (e) {
                    return { success: false, error: e.message };
                }
            }, { board, title, description, link, alt, image, token: csrftoken });

            await browser.close();

            if (result.success) {
                return res.status(200).json({ 
                    success: true, 
                    message: `✅ Пин "${title}" успешно опубликован! (ID: ${result.pin_id})`,
                    pin_id: result.pin_id
                });
            } else {
                return res.status(400).json({ 
                    success: false, 
                    error: `❌ Ошибка публикации: ${result.error}` 
                });
            }
        }

        if (action === 'delete') {
            await browser.close();
            return res.status(200).json({ success: true, message: '✅ Аккаунт удалён.' });
        }

        await browser.close();
        return res.status(400).json({ success: false, error: '❌ Неизвестное действие.' });

    } catch (error) {
        if (browser) { 
            try { await browser.close(); } catch (e) {} 
        }
        console.error('Error:', error);
        return res.status(500).json({ 
            success: false, 
            error: '❌ Ошибка сервера: ' + error.message 
        });
    }
}
