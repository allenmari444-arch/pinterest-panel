import puppeteer from 'puppeteer';
import express from 'express';
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

app.post('/api/pinterest', async (req, res) => {
    const { action, proxy, cookies, board, title, description, link, alt, image } = req.body;
    const cookieObjects = parseCookiesInput(cookies);
    if (!cookieObjects.length) return res.status(400).json({ success: false, error: '❌ Куки пустые или не распознаны.' });

    let browser = null;
    try {
        browser = await puppeteer.launch({
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
            headless: 'new',
        });
        const page = await (await browser.createIncognitoBrowserContext()).newPage();

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
                    // Pinterest вернул не JSON (например, "Invalid Request" или HTML-страницу ошибки)
                    return { ok: false, status: resp.status, rawText: rawText.slice(0, 300) };
                }

                return { ok: resp.ok, status: resp.status, data: parsed };
            }, csrftoken);

            if (!userInfo.ok || !userInfo.data) {
                await browser.close();
                return res.status(400).json({
                    success: false,
                    error: `❌ Pinterest вернул некорректный ответ (статус ${userInfo.status}): ${userInfo.rawText || 'нет тела ответа'}`
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
