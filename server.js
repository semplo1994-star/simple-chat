require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.static(path.join(__dirname, 'public')));

// ===== ПОДКЛЮЧЕНИЕ К SUPABASE =====
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ===== MULTER (временное хранение файлов перед загрузкой в Supabase) =====
const upload = multer({
    storage: multer.memoryStorage(), // Храним в памяти, не на диске
    limits: { fileSize: 5 * 1024 * 1024 }, // 5 МБ
    fileFilter: (req, file, cb) => {
        const allowed = [
            'image/jpeg', 'image/png', 'image/gif', 'image/webp',
            'application/pdf', 'text/plain',
            'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'application/zip', 'application/x-rar-compressed'
        ];
        cb(null, allowed.includes(file.mimetype));
    }
});

// ===== ЗАГРУЗКА ФАЙЛА В SUPABASE STORAGE =====
app.post('/upload', upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Файл не получен' });
    }

    const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(req.file.originalname)}`;
    const isImage = req.file.mimetype.startsWith('image/');

    try {
        // Загружаем файл в Supabase Storage
        const { data, error } = await supabase.storage
            .from('chat-files')
            .upload(uniqueName, req.file.buffer, {
                contentType: req.file.mimetype,
                upsert: false
            });

        if (error) throw error;

        // Получаем публичную ссылку на файл
        const { data: urlData } = supabase.storage
            .from('chat-files')
            .getPublicUrl(uniqueName);

        res.json({
            success: true,
            filename: uniqueName,
            originalname: req.file.originalname,
            url: urlData.publicUrl,
            isImage: isImage,
            size: req.file.size
        });
    } catch (err) {
        console.error('Ошибка загрузки в Supabase:', err);
        res.status(500).json({ error: 'Ошибка загрузки файла' });
    }
});

// ===== ОНЛАЙН-ПОЛЬЗОВАТЕЛИ (в памяти сервера) =====
const onlineUsers = new Map();

function getOnlineUsernames() {
    const names = [];
    onlineUsers.forEach((data) => {
        if (!names.includes(data.username)) names.push(data.username);
    });
    return names;
}

io.on('connection', (socket) => {
    console.log('Подключился:', socket.id);

    // 1. Загружаем последние 100 сообщений
    supabase
        .from('messages')
        .select('*')
        .order('timestamp', { ascending: true })
        .limit(100)
        .then(({ data, error }) => {
            if (error) return console.error('Ошибка загрузки истории:', error);
            // Преобразуем в формат, который ожидает клиент
            const history = data.map(m => ({
                type: m.type,
                user: m.user_name,
                text: m.text,
                file: m.file_url ? {
                    url: m.file_url,
                    name: m.file_name,
                    size: m.file_size,
                    isImage: m.is_image
                } : null,
                isPrivate: m.is_private,
                to: m.recipient,
                timestamp: m.timestamp
            }));
            socket.emit('load history', history);
        });

    // 2. Вход / Регистрация
    socket.on('user login', async (data, callback) => {
        const { username, password } = data;
        if (!username || !password) {
            return callback({ success: false, error: 'Заполните все поля' });
        }

        try {
            const { data: existing } = await supabase
                .from('users')
                .select('*')
                .eq('username', username)
                .single();

            if (existing) {
                if (existing.password !== password) {
                    return callback({ success: false, error: 'Неверный пароль' });
                }
            } else {
                const { error: insertError } = await supabase
                    .from('users')
                    .insert({ username, password });
                if (insertError) throw insertError;
                console.log(`Зарегистрирован: ${username}`);
            }

            onlineUsers.set(socket.id, { username, password });

            // Системное сообщение о входе
            await supabase.from('messages').insert({
                type: 'system',
                text: `${username} вошёл в чат`
            });
            io.emit('chat message', { type: 'system', text: `${username} вошёл в чат` });
            io.emit('online users', getOnlineUsernames());

            callback({ success: true });
        } catch (err) {
            console.error(err);
            callback({ success: false, error: 'Ошибка сервера' });
        }
    });

    // 3. Публичное сообщение / файл
    socket.on('chat message', async (data) => {
        const user = onlineUsers.get(socket.id);
        if (!user) return;

        const msg = {
            type: data.type || 'message',
            user_name: user.username,
            text: data.text || '',
            is_private: false
        };

        if (data.file) {
            msg.file_url = data.file.url;
            msg.file_name = data.file.name;
            msg.file_size = data.file.size;
            msg.is_image = data.file.isImage;
        }

        const { data: saved } = await supabase.from('messages').insert(msg).select().single();

        const emitMsg = {
            type: saved.type,
            user: saved.user_name,
            text: saved.text,
            file: saved.file_url ? {
                url: saved.file_url,
                name: saved.file_name,
                size: saved.file_size,
                isImage: saved.is_image
            } : null
        };

        io.emit('chat message', emitMsg);
    });

    // 4. Личное сообщение / файл
    socket.on('private message', async (data) => {
        const sender = onlineUsers.get(socket.id);
        if (!sender) return;

        const { to, text, file, type } = data;

        let recipientSocketId = null;
        onlineUsers.forEach((userData, socketId) => {
            if (userData.username === to) recipientSocketId = socketId;
        });

        if (!recipientSocketId) {
            return socket.emit('error message', `Пользователь ${to} не найден`);
        }

        const msg = {
            type: type || 'message',
            user_name: sender.username,
            text: text || '',
            is_private: true,
            recipient: to
        };

        if (file) {
            msg.file_url = file.url;
            msg.file_name = file.name;
            msg.file_size = file.size;
            msg.is_image = file.isImage;
        }

        const { data: saved } = await supabase.from('messages').insert(msg).select().single();

        const emitMsg = {
            type: saved.type,
            user: saved.user_name,
            text: saved.text,
            file: saved.file_url ? {
                url: saved.file_url,
                name: saved.file_name,
                size: saved.file_size,
                isImage: saved.is_image
            } : null,
            to: saved.recipient,
            isPrivate: true
        };

        io.to(recipientSocketId).emit('chat message', emitMsg);
        socket.emit('chat message', { ...emitMsg, isMine: true });
    });

    // 5. Отключение
    socket.on('disconnect', async () => {
        const user = onlineUsers.get(socket.id);
        if (user) {
            await supabase.from('messages').insert({
                type: 'system',
                text: `${user.username} вышел из чата`
            });
            io.emit('chat message', { type: 'system', text: `${user.username} вышел из чата` });

            onlineUsers.delete(socket.id);
            io.emit('online users', getOnlineUsernames());
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Чат запущен на порту ${PORT}`);
});