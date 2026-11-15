// ============================================
// ASAF - Legal Assistant Server
// ============================================
require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const path = require('path');
const crypto = require('crypto');

const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ----- Env check -----
const required = ['GEMINI_API_KEY', 'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_KEY'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error('❌ Missing env:', missing.join(', '));
  process.exit(1);
}

// ----- Clients -----
const app = express();
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
  model: 'gemini-1.5-flash',
  systemInstruction: `Sen ASAF adlı hukuk asistanısın. İstinaf dilekçesi yazımına yardımcı olursun.

KURALLAR:
1. Kullanıcının vermediği dosya numarası, tarih, isim veya kanun maddesi UYDURMA.
2. Eksik bilgi varsa [eksik] yaz.
3. Dilekçe yapısı:
   - Başlık (mahkeme, dosya no, taraflar)
   - İlk derece mahkemesi kararının özeti
   - İstinaf sebepleri (numaralı, her biri: hata + hukuki gerekçe + delil)
   - Sonuç ve talep
4. Kullanıcı Türkçe yazarsa Türkçe, Arapça yazarsa Arapça cevap ver.
5. Sona şu uyarıyı ekle: "⚠️ Bu bir taslaktır. Sunmadan önce avukata danışın. İstinaf süresi: 14 gün (hukuk/ceza) veya 30 gün (idari)."
6. Hukuki tavsiye verme, sadece taslak yaz.`
});

// ----- Middlewares -----
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '15mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/', rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Çok fazla istek, bir dakika bekleyin.' }
}));

// ----- Session -----
function signSession(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64');
  const hmac = crypto.createHmac('sha256', process.env.SUPABASE_SERVICE_KEY)
    .update(data).digest('hex');
  return `${data}.${hmac}`;
}

function verifySession(token) {
  if (!token) return null;
  try {
    const [data, hmac] = token.split('.');
    const expected = crypto.createHmac('sha256', process.env.SUPABASE_SERVICE_KEY)
      .update(data).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(expected))) return null;
    const payload = JSON.parse(Buffer.from(data, 'base64').toString());
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

function requireAuth(req, res, next) {
  const session = verifySession(req.cookies['asaf_session']);
  if (!session) return res.status(401).json({ error: 'Yetkisiz' });
  req.user = session;
  next();
}

// ----- Bootstrap owner -----
async function ensureOwner() {
  if (!process.env.OWNER_EMAIL || !process.env.OWNER_PASSWORD) return;
  const { data: list } = await supabaseAdmin.auth.admin.listUsers();
  const exists = list?.users?.some(u => u.email === process.env.OWNER_EMAIL.toLowerCase());
  if (!exists) {
    const { error } = await supabaseAdmin.auth.admin.createUser({
      email: process.env.OWNER_EMAIL.toLowerCase(),
      password: process.env.OWNER_PASSWORD,
      email_confirm: true
    });
    if (error) console.error('⚠️ createUser:', error.message);
    else console.log('✅ Owner created:', process.env.OWNER_EMAIL);
  }
}

// ----- Auth routes -----
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Eksik bilgi' });

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  const { data, error } = await sb.auth.signInWithPassword({
    email: email.toLowerCase(), password
  });
  if (error) return res.status(401).json({ error: 'E-posta veya şifre hatalı' });

  const token = signSession({
    uid: data.user.id,
    email: data.user.email,
    exp: Date.now() + 1000 * 60 * 60 * 24 * 7
  });

  res.cookie('asaf_session', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 7
  });

  res.json({ ok: true, email: data.user.email });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('asaf_session');
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ email: req.user.email });
});

// ----- Conversations -----
app.get('/api/conversations', requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('conversations')
    .select('id, title, created_at')
    .eq('user_id', req.user.uid)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get('/api/conversations/:id', requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('messages')
    .select('role, content')
    .eq('conversation_id', req.params.id)
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ----- Chat -----
app.post('/api/chat', requireAuth, async (req, res) => {
  try {
    const { message, image, conversationId, lang } = req.body || {};
    if (!message && !image) return res.status(400).json({ error: 'Boş mesaj' });

    let convId = conversationId;
    if (!convId) {
      const title = (message || 'Fotoğraflı sohbet').slice(0, 60);
      const { data: conv, error } = await supabaseAdmin
        .from('conversations')
        .insert({ user_id: req.user.uid, title })
        .select('id').single();
      if (error) throw error;
      convId = conv.id;
    }

    await supabaseAdmin.from('messages').insert({
      conversation_id: convId, role: 'user',
      content: message || '[Fotoğraf]'
    });

    const parts = [];
    const langHint = lang === 'ar'
      ? 'Kullanıcı Arapça tercih ediyor. Arapça cevap ver.'
      : 'Kullanıcı Türkçe tercih ediyor. Türkçe cevap ver.';
    parts.push({ text: langHint });

    if (message) parts.push({ text: message });
    if (image) {
      const m = /^data:(image\/\w+);base64,(.+)$/.exec(image);
      if (m) parts.push({ inlineData: { mimeType: m[1], data: m[2] } });
    }

    const { data: history } = await supabaseAdmin
      .from('messages')
      .select('role, content')
      .eq('conversation_id', convId)
      .order('created_at', { ascending: false })
      .limit(20);

    const ctx = (history || []).reverse()
      .map(m => `${m.role === 'user' ? 'Kullanıcı' : 'Asistan'}: ${m.content}`)
      .join('\n');

    const result = await model.generateContent([
      { text: `Önceki konuşma:\n${ctx}\n\nYeni talep:\n` },
      ...parts
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

// ----- SPA fallback -----
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ----- Start -----
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🚀 ASAF on port ${PORT}`);
  await ensureOwner();
});
