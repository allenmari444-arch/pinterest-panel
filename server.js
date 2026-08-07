import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import http from 'http';
import { URL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/pinterest', (req, res) => {
    res.json({ message: '✅ Pinterest Panel API готов к работе!' });
});

// Парсим куки из JSON-массива (экспорт Cookie-Editor) или строки name=value
function parseCookies(raw) {
    raw = (raw || '').replace(/^\uFEFF/, '').trim();
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        const arr = Array.isArray(parsed) ? parsed : (parsed?.cookies || null);
        if (arr) return arr.filter(c => c?.name && c?.value !== undefined).map(c => ({
            name: String(c.name).trim(),
            value: String(c.value ?? '').trim(),
            domain: String(c.domain || '.pinterest.com').trim(),
            path: String(c.path || '/').trim(),
            secure: c.secure === true,
            httpOnly: c.httpOnly === true,
            sameSite: c.sameSite || null,
            expirationDate: c.expirationDate || null
        }));
    } catch (e) {}
    return raw.split(';').map(p => p.trim()).filter(Boolean).map(pair => {
        const idx = pair.indexOf('=');
        if (idx === -1) return null;
        return { name: pair.slice(0, idx).trim(), value: pair.slice(idx + 1).trim(), domain: '.pinterest.com', path: '/' };
    }).filter(Boolean);
}

// Строка куки для заголовка Cookie
function cookieString(cookies) {
    return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

// Делаем HTTP запрос через прокси (нативный Node.js, без лишних пакетов)
function makeRequest(urlStr, options, body, proxy) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(urlStr);

        const doRequest = (reqOptions, reqBody) => {
            const proto = parsedUrl.protocol === 'https:' ? https : http;
            const req = proto.request(reqOptions, (resp) => {
                let data = '';
                resp.on('data', chunk => data += chunk);
                resp.on('end', () => resolve({ status: resp.statusCode, text: data, headers: resp.headers }));
            });
            req.on('error', reject);
            if (reqBody) req.write(reqBody);
            req.end();
        };

        if (proxy) {
            // Для HTTPS через прокси — сначала CONNECT тоннель
            const parsedProxy = new URL(proxy);
            const proxyPort = parseInt(parsedProxy.port) || (parsedProxy.protocol === 'https:' ? 443 : 80);
            const connectOpts = {
                host: parsedProxy.hostname,
                port: proxyPort,
                method: 'CONNECT',
                path: `${parsedUrl.hostname}:${parsedUrl.port || 443}`,
                headers: { 'Host': `${parsedUrl.hostname}:${parsedUrl.port || 443}` }
            };
            if (parsedProxy.username) {
                const auth = Buffer.from(`${decodeURIComponent(parsedProxy.username)}:${decodeURIComponent(parsedProxy.password)}`).toString('base64');
                connectOpts.headers['Proxy-Authorization'] = `Basic ${auth}`;
            }
            const connectProto = parsedProxy.protocol === 'https:' ? https : http;
            const connectReq = connectProto.request(connectOpts);
            connectReq.on('connect', (res, socket) => {
                const reqOptions = {
                    ...options,
                    host: parsedUrl.hostname,
                    port: parsedUrl.port || 443,
                    path: parsedUrl.pathname + (parsedUrl.search || ''),
                    socket,
                    agent: false
                };
                doRequest(reqOptions, body);
            });
            connectReq.on('error', reject);
            connectReq.end();
        } else {
            const reqOptions = {
                ...options,
                host: parsedUrl.hostname,
                port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
                path: parsedUrl.pathname + (parsedUrl.search || '')
            };
            doRequest(reqOptions, body);
        }
    });
}

async function pinterestGet(url, cookies, proxy, extraHeaders = {}) {
    const cookieStr = cookieString(cookies);
    const csrftoken = cookies.find(c => c.name === 'csrftoken')?.value || '';
    const result = await makeRequest(url, {
        method: 'GET',
        headers: {
            'Cookie': cookieStr,
            'X-CSRFToken': csrftoken,
            'X-Requested-With': 'XMLHttpRequest',
            'X-APP-VERSION': 'b49860d',
            'X-Pinterest-AppState': 'active',
            'Accept': 'application/json, text/javascript, */*; q=0.01',
            'Accept-Language': 'en-US,en;q=0.9',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
            'Referer': 'https://www.pinterest.com/',
            ...extraHeaders
        }
    }, null, proxy);
    try { return { ok: result.status < 400, status: result.status, data: JSON.parse(result.text), headers: result.headers }; }
    catch (e) { return { ok: false, status: result.status, raw: result.text.slice(0, 800), headers: result.headers }; }
}

async function pinterestPost(url, body, cookies, proxy, extraHeaders = {}) {
    const cookieStr = cookieString(cookies);
    const csrftoken = cookies.find(c => c.name === 'csrftoken')?.value || '';
    const bodyStr = typeof body === 'string' ? body : body.toString();
    const result = await makeRequest(url, {
        method: 'POST',
        headers: {
            'Cookie': cookieStr,
            'X-CSRFToken': csrftoken,
            'X-Requested-With': 'XMLHttpRequest',
            'X-APP-VERSION': 'b49860d',
            'X-Pinterest-AppState': 'active',
            'Accept': 'application/json, text/javascript, */*; q=0.01',
            'Accept-Language': 'en-US,en;q=0.9',
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'Content-Length': Buffer.byteLength(bodyStr),
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
            'Referer': 'https://www.pinterest.com/',
            ...extraHeaders
        }
    }, bodyStr, proxy);
    try { return { ok: result.status < 400, status: result.status, data: JSON.parse(result.text) }; }
    catch (e) { return { ok: false, status: result.status, raw: result.text.slice(0, 500) }; }
}

app.post('/api/pinterest', async (req, res) => {
    const { action, cookies: rawCookies, proxy, board, title, description, link, alt, image } = req.body;

    const cookies = parseCookies(rawCookies);
    if (!cookies.length) return res.status(400).json({ success: false, error: '❌ Куки пустые или не распознаны.' });

    const auth = cookies.find(c => c.name === '_auth');
    if (!auth || auth.value !== '1') {
        return res.status(400).json({ success: false, error: '❌ Куки устарели: нет _auth=1. Экспортируйте куки заново.' });
    }

    try {
        if (['add', 'update', 'info', 'token'].includes(action)) {
            let username = null, fullAccount = {}, boards = [];

            // Прогреваем сессию — сначала обычный GET на главную
            // Pinterest проверяет что перед API запросом была обычная навигация
            await pinterestGet('https://www.pinterest.com/', cookies, proxy, {
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Upgrade-Insecure-Requests': '1'
            }).catch(() => {});
            await new Promise(r => setTimeout(r, 1000));

            // Шаг 1: получаем инфо об аккаунте
            const userUrl = 'https://www.pinterest.com/resource/UserResource/get/?source_url=%2F&data=' +
                encodeURIComponent(JSON.stringify({ options: { field_set_key: 'profile' }, context: {} }));
            const userResp = await pinterestGet(userUrl, cookies, proxy);

            if (userResp.ok && userResp.data?.resource_response?.data) {
                const u = userResp.data.resource_response.data;
                username = u.username;
                fullAccount = {
                    id: u.id,
                    full_name: u.full_name,
                    username: u.username,
                    profile_pic: u.image_xlarge_url || u.image_medium_url || null,
                    created_at: u.created_at,
                    pin_count: u.pin_count
                };
            } else {
                return res.status(400).json({
                    success: false,
                    error: `❌ UserResource: статус ${userResp.status} — ${userResp.raw || JSON.stringify(userResp.data)?.slice(0, 300)}`,
                    debugHeaders: userResp.headers || null
                });
            }

            // Шаг 2: получаем доски с правильным Referer (страница досок)
            if (username) {
                const boardsUrl = 'https://www.pinterest.com/resource/BoardsResource/get/?source_url=' +
                    encodeURIComponent('/' + username + '/boards/') + '&data=' +
                    encodeURIComponent(JSON.stringify({ options: { username, field_set_key: 'grid_item', filter_stories: false }, context: {} }));

                const boardsResp = await pinterestGet(boardsUrl, cookies, proxy, {
                    'Referer': `https://www.pinterest.com/${username}/boards/`
                });

                if (boardsResp.ok && Array.isArray(boardsResp.data?.resource_response?.data)) {
                    boards = boardsResp.data.resource_response.data.map(b => ({
                        id: b.id,
                        name: b.name,
                        url: b.url ? `https://www.pinterest.com${b.url}` : `https://www.pinterest.com/${username}/${b.slug || ''}/`,
                        cover: b.image_thumbnail_url || b.image_cover_url || null,
                        pin_count: b.pin_count ?? null
                    }));
                } else {
                    return res.status(400).json({
                        success: false,
                        error: `❌ BoardsResource: статус ${boardsResp.status} — ${boardsResp.raw || JSON.stringify(boardsResp.data)?.slice(0, 300)}`
                    });
                }
            }

            return res.json({
                success: true,
                message: '✅ Аккаунт подключен!',
                username,
                token: cookies.find(c => c.name === 'csrftoken')?.value || '',
                csrftoken: cookies.find(c => c.name === 'csrftoken')?.value || '',
                account: fullAccount,
                boards
            });
        }

        if (action === 'test' || action === 'pin') {
            if (!board || !image) return res.status(400).json({ success: false, error: '❌ Нужны board (Board ID) и image (URL картинки).' });

            const csrftoken = cookies.find(c => c.name === 'csrftoken')?.value || '';
            const body = new URLSearchParams({
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
            }).toString();

            const pinResp = await pinterestPost(
                'https://www.pinterest.com/resource/PinResource/create/',
                body,
                cookies,
                proxy,
                { 'Referer': 'https://www.pinterest.com/pin-builder/' }
            );

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
                    error: `❌ Ошибка публикации (${pinResp.status}): ${pinResp.raw || JSON.stringify(pinResp.data)?.slice(0, 400)}`
                });
            }
        }

        return res.status(400).json({ success: false, error: '❌ Неизвестное действие.' });
    } catch (error) {
        return res.status(500).json({ success: false, error: '❌ Ошибка: ' + error.message });
    }
});

const port = process.env.PORT || 8080;
app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Pinterest Panel запущен на порту ${port}`);
});
