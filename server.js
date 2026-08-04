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

function parseCookiesInput(raw) {
    const cleaned = (raw || '').replace(/^\uFEFF/, '').replace(/^cookie:\s*/i, '').trim();
    if (!cleaned) return [];
    
    try {
        const parsed = JSON.parse(cleaned);
        const arr = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.cookies) ? parsed.cookies : null);
        if (arr) {
            return arr.filter(c => c && c.name !== undefined && c.value !== undefined).map(c => {
                const name = String(c.name).trim();
                const value = String(c.value).trim();
                if (!name) return null;

                // Базовый набор полей, который гарантированно не вызовет ошибок в Puppeteer
                const cookieObj = {
                    name: name,
                    value: value,
                    domain: c.domain || '.pinterest.com',
                    path: c.path || '/'
                };

                if (c.secure === true) cookieObj.secure = true;
                if (c.httpOnly === true) cookieObj.httpOnly = true;
                if (typeof c.expirationDate === 'number') cookieObj.expires = c.expirationDate;

                // Обрабатываем sameSite, отбрасывая null и неверные значения
                if (c.sameSite && typeof c.sameSite === 'string') {
                    const ss = c.sameSite.toLowerCase();
                    if (ss === 'strict') cookieObj.sameSite = 'Strict';
                    else if (ss === 'lax') cookieObj.sameSite = 'Lax';
                    else if (ss === 'none' || ss === 'no_restriction') cookieObj.sameSite = 'None';
                }

                return cookieObj;
            }).filter(Boolean);
        }
    } catch (e) {}

    // Если это обычная строка через точку с запятой
    return cleaned.split(';').map(part => part.trim()).filter(Boolean).map(pair => {
        const idx = pair.indexOf('=');
        if (idx === -1) return null;
        return { 
            name: pair.slice(0, idx).trim(), 
            value: pair.slice(idx + 1).trim(), 
            domain: '.pinterest.com', 
            path: '/' 
        };
    }).filter(Boolean);
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
        
        // Устанавливаем куки массивом, отфильтровав всё лишнее
        await page.setCookie(...cookieObjects);

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
                const res = await fetch('https://www.pinterest.com/resource/UserResource/get/?source_url=/&data={"options":{"field_set_key":"profile"},"context":{}}', {
                    headers: { 'X-Requested-With': 'XMLHttpRequest', 'X-CSRFToken': token }
                });
                return await res.json();
            }, csrftoken);

            const user = userInfo?.resource_response?.data || {};
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
