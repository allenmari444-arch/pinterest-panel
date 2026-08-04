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

// Раздаем статические файлы (интерфейс панели) из текущей корневой папки
app.use(express.static(__dirname));

// Проверка для Railway
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// === API ПУТЬ ===
app.get('/api/pinterest', (req, res) => {
    res.json({ message: '✅ Pinterest Panel API готов к работе!' });
});

// === ПАРСИНГ И САНИТАЙЗИНГ КУК ===
function parseCookiesInput(raw) {
    const cleaned = (raw || '').replace(/^\uFEFF/, '').replace(/^cookie:\s*/i, '').trim();
    if (!cleaned) return [];

    // Приводим одну куку к формату, который гарантированно примет Puppeteer/CDP
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

        // expires должен быть положительным Unix timestamp (в секундах).
        // Отрицательные значения (-1) или отсутствие поля = сессионная кука.
        if (typeof c.expirationDate === 'number' && isFinite(c.expirationDate) && c.expirationDate > 0) {
            cookieObj.expires = Math.floor(c.expirationDate);
        }

        // sameSite: Chrome требует secure=true, если sameSite = None
        if (c.sameSite && typeof c.sameSite === 'string') {
            const ss = c.sameSite.toLowerCase();
            if (ss === 'strict') {
                cookieObj.sameSite = 'Strict';
            } else if (ss === 'lax') {
                cookieObj.sameSite = 'Lax';
            } else if (ss === 'none' || ss === 'no_restriction') {
                cookieObj.sameSite = 'None';
                cookieObj.secure = true; // обязательно для SameSite=None
            }
            // любые другие/некорректные значения (например null, "unspecified") — просто не ставим sameSite
        }

        return cookieObj;
    };

    // Попытка распарсить как JSON (массив кук или объект { cookies: [...] })
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
    } catch (e) {
        // не JSON — пробуем разобрать как строку "name=value; name2=value2"
    }

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

// === УСТАНОВКА КУК ПО ОДНОЙ (чтобы одна битая кука не роняла всю сессию) ===
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

// === ПРОСТАЯ ДИАГНОСТИКА ПРОКСИ (открывается прямо в браузере, терминал не нужен) ===
// Использование: https://ваш-домен/api/proxy-check?proxy=http://user:pass@host:port
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

        // Шаг 1: проверяем что прокси вообще живой и отдаёт IP
        try {
            const ipResp = await page.goto('https://api.ipify.org?format=json', { waitUntil: 'networkidle2' });
            result.step1_proxyAlive = true;
            result.step1_outboundIp = JSON.parse(await ipResp.text()).ip;
        } catch (e) {
            result.step1_proxyAlive = false;
            result.step1_error = e.message;
        }

        // Шаг 2: проверяем, пускает ли Pinterest этот IP на главную страницу
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
        // Разбираем proxy, если передан. Форматы: "host:port", "host:port:user:pass",
        // "user:pass@host:port", либо объект { host, port, username, password }
        let proxyServerArg = null;
        let proxyAuth = null;

        if (proxy) {
            let proxyStr = typeof proxy === 'string' ? proxy.trim() : '';
            // Срезаем протокол, если он есть: http://, https://, socks5://
            proxyStr = proxyStr.replace(/^[a-zA-Z0-9]+:\/\//, '');
            let host, port, username, password;

            if (typeof proxy === 'object') {
                ({ host, port, username, password } = proxy);
            } else if (proxyStr.includes('@')) {
                // user:pass@host:port
                const [creds, hostPort] = proxyStr.split('@');
                [username, password] = creds.split(':');
                [host, port] = hostPort.split(':');
            } else {
                // host:port  ИЛИ  host:port:user:pass
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
            console.warn('⚠️ Прокси не передан или не распознан — запрос пойдёт с IP сервера (может блокироваться Pinterest).');
        }

        browser = await puppeteer.launch({
            args: launchArgs,
            headless: 'new',
        });

        const browserContext = typeof browser.createBrowserContext === 'function'
            ? await browser.createBrowserContext()
            : await browser.createIncognitoBrowserContext();
        const page = await browserContext.newPage();

        // Если у прокси есть логин/пароль — авторизуемся
        if (proxyAuth) {
            await page.authenticate(proxyAuth);
        }

        // Реалистичные заголовки/UA, чтобы меньше палиться как бот
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
        await page.setViewport({ width: 1366, height: 768 });

        // Устанавливаем куки по одной, с отловом ошибок на каждую
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

        // Диагностика: реально ли запросы идут через прокси
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
            return res.status(400).json({ success: false, error: '❌ Сессия не активна (нет куки авторизации или они устарели).' });
        }

        // csrftoken ставится Pinterest даже анонимным посетителям — это НЕ признак логина.
        // Реальный признак: кука _auth=1. Без неё аккаунт не залогинен, даже если csrftoken есть.
        if (authCheck.authValue !== '1') {
            await browser.close();
            return res.status(400).json({
                success: false,
                error: '❌ Куки устарели или невалидны: сессия анонимная (нет _auth=1). Экспортируйте куки заново, находясь залогиненной в аккаунт Pinterest в браузере.',
                debugOutboundIp: outboundIp,
                debugCookieNamesFound: authCheck.allCookieNames
            });
        }

        if (['add', 'update', 'info', 'token'].includes(action)) {
            // Не делаем отдельный fetch к внутреннему API (Pinterest режет такие запросы
            // отдельным антибот-фильтром). Вместо этого достаём имя пользователя
            // прямо из уже загруженной и подтверждённо залогиненной страницы.
            const domUserInfo = await page.evaluate(() => {
                // Способ 1: встроенное состояние приложения (если Pinterest его отдаёт)
                try {
                    const scripts = Array.from(document.querySelectorAll('script'));
                    for (const s of scripts) {
                        const text = s.textContent || '';
                        if (text.includes('"username"') && (text.includes('__PWS_DATA__') || text.includes('__INITIAL_STATE__'))) {
                            const match = text.match(/=\s*(\{[\s\S]*\})\s*;?\s*$/);
                            if (match) {
                                try {
                                    const data = JSON.parse(match[1]);
                                    const json = JSON.stringify(data);
                                    const unameMatch = json.match(/"username"\s*:\s*"([^"]+)"/);
                                    if (unameMatch) return unameMatch[1];
                                } catch (e) {}
                            }
                        }
                    }
                } catch (e) {}

                // Способ 2: ссылка на профиль в шапке сайта
                const profileLink = document.querySelector('a[href^="/"][data-test-id*="avatar" i]')
                    || document.querySelector('a[aria-label*="profile" i]')
                    || document.querySelector('a[data-test-id="header-profile"]');
                if (profileLink) {
                    const href = profileLink.getAttribute('href') || '';
                    const parts = href.split('/').filter(Boolean);
                    if (parts.length) return parts[0];
                }

                return null;
            });

            await browser.close();
            return res.json({
                success: true,
                message: `✅ Аккаунт подключен!`,
                username: domUserInfo || 'user'
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
