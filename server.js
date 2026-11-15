// server.js
require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();

// إعداد Supabase (نستخدم SERVICE_KEY عشان نتجاوز تسجيل الدخول)
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: 'gemini-1.5-flash',
  systemInstruction: `Sen ASAF adlı hukuk asistanısın... (نفس التعليمات السابقة)`
});

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: true }));
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/', rateLimit({ windowMs: 60000, max: 30 }));

// معرف مستخدم وهمي ثابت (لأننا شلنا تسجيل الدخول)
const DEFAULT_USER_ID = '00000000-0000-0000-0000-000000000000';

// جلب المحادثات
app.get('/api/conversations', async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('conversations')
    .select('id, title, created_at')
    .eq('user_id', DEFAULT_USER_ID)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// جلب رسائل محادثة معينة
app.get('/api/conversations/:id', async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('messages')
    .select('role, content')
    .eq('conversation_id', req.params.id)
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// الدردشة
app.post('/api/chat', async (req, res) => {
  try {
    const { message, image, conversationId, lang } = req.body || {};
    if (!message && !image) return res.status(400).json({ error: 'Boş mesaj' });

    let convId = conversationId;
    if (!convId) {
      const title = (message || 'Fotoğraflı sohbet').slice(0, 60);
      const { data: conv, error } = await supabaseAdmin
        .from('conversations')
        .insert({ user_id: DEFAULT_USER_ID, title }) // نستخدم المعرف الثابت
        .select('id').single();
      if (error) throw error;
      convId = conv.id;
    }

    await supabaseAdmin.from('messages').insert({
      conversation_id: convId, role: 'user', content: message || '[Fotoğraf]'
    });

    const parts = [];
    if (message) parts.push({ text: message });
    if (image) {
      const m = /^data:(image\/\w+);base64,(.+)$/.exec(image);
      if (m) parts.push({ inlineData: { mimeType: m[1], data: m[2] } });
    }

    const { data: history } = await supabaseAdmin
      .from('messages').select('role, content').eq('conversation_id', convId)
      .order('created_at', { ascending: false }).limit(20);

    const ctx = (history || []).reverse()
      .map(m => `${m.role === 'user' ? 'Kullanıcı' : 'Asistan'}: ${m.content}`).join('\n');

    const result = await model.generateContent([
      { text: `Önceki konuşma:\n${ctx}\n\nYeni talep:\n` }, ...parts
    ]);

    const reply = result.response.text();
    await supabaseAdmin.from('messages').insert({
      conversation_id: convId, role: 'assistant', content: reply
    });

    res.json({ reply, conversationId: convId });
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: 'İşlem hatası' });
  }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 ASAF on port ${PORT} (No Auth)`));
